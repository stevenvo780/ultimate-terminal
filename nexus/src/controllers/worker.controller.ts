
import { Request, Response } from 'express';
import { WorkerModel } from '../models/worker.model';
import { UserModel } from '../models/user.model';
import {
  evictUserSubscriptions,
  invalidateWorkerAccessCache,
  workers as connectedWorkers,
} from '../socket';
import { canCreateWorker, canShareWorker } from '../services/plan-limits';
import type { Server } from 'socket.io';

async function resolveRequester(userId: number) {
  const user = await UserModel.findById(userId);
  return {
    user,
    isGlobalAdmin: user?.is_admin === 1 && (user.tenant_id ?? null) === null,
  };
}

export class WorkerController {
  static async list(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const workers = await WorkerModel.getAccessibleWorkers(req.user.userId);
    res.json(workers.map((worker) => ({
      ...worker,
      status: connectedWorkers.has(worker.id) ? 'online' : 'offline',
    })));
  }

  static async join(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const { code, workerId } = req.body;
    const joinCode = String(code || workerId || '').trim();

    if (!joinCode) {
      res.status(400).json({ error: 'Código requerido' });
      return;
    }

    const worker = await WorkerModel.findById(joinCode);
    if (!worker) { res.status(404).json({ error: 'Código inválido' }); return; }

    if (worker.owner_id !== req.user.userId) {
      // A join code is only a locator, never an authorization capability.
      // Keep worker access tenant-local unless a global administrator performs
      // the operation explicitly. Resolve both tenants from the DB so a stale
      // JWT cannot retain access after a tenant reassignment.
      const { user: requester, isGlobalAdmin } = await resolveRequester(req.user.userId);
      if (!requester) { res.status(401).json({ error: 'Usuario no válido' }); return; }
      if (!isGlobalAdmin) {
        const owner = await UserModel.findById(worker.owner_id);
        const requesterTenant = requester?.tenant_id ?? null;
        const ownerTenant = owner?.tenant_id ?? null;
        if (!requesterTenant || !ownerTenant || requesterTenant !== ownerTenant) {
          res.status(403).json({ error: 'El worker pertenece a otro tenant' });
          return;
        }
        await WorkerModel.share(worker.id, req.user.userId, 'control');
        invalidateWorkerAccessCache(req.user.userId);
      }
    }

    res.json({ success: true });
  }
  static async create(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const { name } = req.body;
    if (!name) { res.status(400).json({ error: 'Nombre requerido' }); return; }

    // Verificar límite de workers por plan
    const check = await canCreateWorker(req.user.userId);
    if (!check.allowed) {
      res.status(403).json({
        error: check.reason,
        code: 'PLAN_LIMIT_WORKERS',
        current: check.current,
        max: check.max,
      });
      return;
    }

    const worker = await WorkerModel.create(req.user.userId, name);
    invalidateWorkerAccessCache();
    res.json(worker);
  }

  static async share(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const { workerId, targetUsername } = req.body;

    if (!targetUsername) { res.status(400).json({ error: 'Nombre de usuario requerido' }); return; }

    const { user: requester, isGlobalAdmin } = await resolveRequester(req.user.userId);
    if (!requester) { res.status(401).json({ error: 'Usuario no válido' }); return; }

    // Verificar que el plan permite compartir
    if (!isGlobalAdmin) {
      const shareCheck = await canShareWorker(req.user.userId);
      if (!shareCheck.allowed) {
        res.status(403).json({
          error: shareCheck.reason,
          code: 'PLAN_LIMIT_SHARE',
        });
        return;
      }
    }

    const worker = await WorkerModel.findById(workerId);
    if (!worker) { res.status(404).json({ error: 'Worker no encontrado' }); return; }

    const canManage = worker.owner_id === req.user.userId || isGlobalAdmin;

    if (!canManage) {
      res.status(403).json({ error: 'Solo el propietario o admin puede compartir' });
      return;
    }

    const targetUser = await UserModel.findByUsername(targetUsername);
    if (!targetUser) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

    if (targetUser.id === worker.owner_id) {
      res.status(400).json({ error: 'No puedes compartir con el propietario' });
      return;
    }

    // A global admin can already access every worker. Letting it create a
    // cross-tenant share would either bypass isolation or produce an inert
    // share that the access model intentionally ignores. Scope the target to
    // the worker owner's current tenant for every caller, including admins.
    const owner = await UserModel.findById(worker.owner_id);
    const ownerTenant = owner?.tenant_id ?? null;
    const targetTenant = targetUser.tenant_id ?? null;
    if (!ownerTenant || !targetTenant || ownerTenant !== targetTenant) {
      res.status(403).json({ error: 'No puedes compartir workers con otro tenant' });
      return;
    }

    const enforcedPermission = 'control' as const;
    await WorkerModel.share(workerId, targetUser.id, enforcedPermission);
    invalidateWorkerAccessCache(targetUser.id);

    // Notify target user via Socket.IO
    const io = req.app.get('io');
    if (io) {
      console.log(`[Share] Broadcasting share of ${workerId} to user ${targetUser.id} (${targetUser.username})`);
      io.sockets.sockets.forEach((socket: any) => {
        const socketUser = socket.data?.user;
        if (socket.data?.role === 'client' && socketUser?.userId === targetUser.id) {
          socket.emit('worker-shared', { workerId, name: worker.name, owner: req.user?.username });

          // Refresh worker list for the user
          WorkerModel.getAccessibleWorkers(targetUser.id).then((list) => {
            socket.emit('workers', list);
          });
        }
      });
    }

    const shares = await WorkerModel.getShares(workerId);
    res.json({
      success: true,
      user: { id: targetUser.id, username: targetUser.username, permission: enforcedPermission },
      shares
    });
  }

  static async getShares(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const workerId = req.params.id as string;

    const worker = await WorkerModel.findById(workerId);
    if (!worker) { res.status(404).json({ error: 'Worker no encontrado' }); return; }

    const { user: requester, isGlobalAdmin } = await resolveRequester(req.user.userId);
    if (!requester) { res.status(401).json({ error: 'Usuario no válido' }); return; }
    const canManage = worker.owner_id === req.user.userId || isGlobalAdmin;

    if (!canManage) {
      res.status(403).json({ error: 'Acceso denegado' });
      return;
    }

    const shares = await WorkerModel.getShares(workerId);
    res.json(shares);
  }

  static async unshare(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const { workerId, targetUserId } = req.body;
    const normalizedUserId = Number(targetUserId);

    const worker = await WorkerModel.findById(workerId);
    if (!worker) { res.status(404).json({ error: 'Worker no encontrado' }); return; }

    const { user: requester, isGlobalAdmin } = await resolveRequester(req.user.userId);
    if (!requester) { res.status(401).json({ error: 'Usuario no válido' }); return; }
    const canManage = worker.owner_id === req.user.userId || isGlobalAdmin;

    if (!canManage) {
      res.status(403).json({ error: 'Solo el propietario o admin puede quitar acceso' });
      return;
    }

    if (!Number.isFinite(normalizedUserId)) {
      res.status(400).json({ error: 'ID de usuario inválido' });
      return;
    }

    const changes = await WorkerModel.unshare(workerId, normalizedUserId);
    if (changes === 0) {
      res.status(404).json({ error: 'Compartición no encontrada' });
      return;
    }
    const io = req.app.get('io') as Server | undefined;
    evictUserSubscriptions(io, normalizedUserId, workerId);
    const shares = await WorkerModel.getShares(workerId);
    res.json({ success: true, shares });
  }

  static async delete(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const id = req.params.id as string;

    const worker = await WorkerModel.findById(id);
    if (!worker) { res.status(404).json({ error: 'Worker no encontrado' }); return; }

    const { user: requester, isGlobalAdmin } = await resolveRequester(req.user.userId);
    if (!requester) { res.status(401).json({ error: 'Usuario no válido' }); return; }
    if (worker.owner_id !== req.user.userId && !isGlobalAdmin) {
      res.status(403).json({ error: 'Acceso denegado' });
      return;
    }

    const io = req.app.get('io') as Server | undefined;
    const connected = connectedWorkers.get(worker.id);
    if (connected && io) {
      const workerSocket = io.sockets.sockets.get(connected.socketId);
      if (workerSocket) {
        workerSocket.disconnect(true);
      }
      connectedWorkers.delete(worker.id);
    }

    await WorkerModel.delete(id);
    invalidateWorkerAccessCache();
    res.json({ success: true, disconnected: Boolean(connected) });
  }
}


import crypto from 'crypto';
import db from '../config/database';
import { generateApiKey } from '../utils/crypto';

export interface Worker {
  id: string;
  owner_id: number;
  name: string;
  api_key: string;
  status: 'online' | 'offline';
  last_seen: number;
}

export interface WorkerShare {
  worker_id: string;
  user_id: number;
  permission: 'view' | 'control' | 'admin';
}

/**
 * Public worker shape used by every REST/Socket.IO listing. API keys are
 * provisioning credentials, not worker metadata, and must only leave Nexus in
 * the one-time create response.
 */
export type WorkerListItem = Omit<Worker, 'api_key'> & { permission: WorkerShare['permission'] };

export class WorkerModel {
  private static async getAccessPrincipal(userId: number): Promise<{
    tenantId: string | null;
    isGlobalAdmin: boolean;
  } | null> {
    const user = await db.get<{ is_admin: number; tenant_id: string | null }>(
      'SELECT is_admin, tenant_id FROM users WHERE id = ?',
      [userId]
    );
    if (!user) return null;
    const tenantId = user.tenant_id ?? null;
    return {
      tenantId,
      isGlobalAdmin: user.is_admin === 1 && tenantId === null,
    };
  }

  static async markAllOffline(): Promise<void> {
    await db.run(`UPDATE workers SET status = 'offline'`);
  }

  static async create(ownerId: number, name: string, id?: string, fixedApiKey?: string): Promise<Worker> {
    const workerId = id || crypto.randomUUID();
    const apiKey = fixedApiKey || generateApiKey();
    const now = Date.now();

    await db.run(`
      INSERT INTO workers (id, owner_id, name, api_key, status, last_seen)
      VALUES (?, ?, ?, ?, 'offline', ?)
    `, [workerId, ownerId, name, apiKey, now]);

    return {
      id: workerId,
      owner_id: ownerId,
      name,
      api_key: apiKey,
      status: 'offline',
      last_seen: now
    };
  }

  static async findByApiKey(apiKey: string): Promise<Worker | undefined> {
    const worker = await db.get<Worker>('SELECT * FROM workers WHERE api_key = ?', [apiKey]);
    if (worker) {
      worker.last_seen = Number(worker.last_seen);
    }
    return worker;
  }

  static async findById(id: string): Promise<Worker | undefined> {
    const worker = await db.get<Worker>('SELECT * FROM workers WHERE id = ?', [id]);
    if (worker) {
      worker.last_seen = Number(worker.last_seen);
    }
    return worker;
  }

  static async getAccessibleWorkers(userId: number): Promise<WorkerListItem[]> {
    const principal = await this.getAccessPrincipal(userId);
    if (!principal) return [];
    if (principal.isGlobalAdmin) {
      const result = await db.query<WorkerListItem>(`
        SELECT w.id, w.owner_id, w.name, w.status, w.last_seen,
               'admin' as permission
        FROM workers w
      `);
      return result.rows.map(w => ({
        ...w,
        last_seen: Number(w.last_seen)
      }));
    }

    const result = await db.query<WorkerListItem>(`
      SELECT w.id, w.owner_id, w.name, w.status, w.last_seen,
             'admin' as permission
      FROM workers w 
      WHERE w.owner_id = ?
      
      UNION
      
      SELECT w.id, w.owner_id, w.name, w.status, w.last_seen,
             ws.permission
      FROM workers w
      JOIN worker_shares ws ON w.id = ws.worker_id
      JOIN users owner ON owner.id = w.owner_id
      JOIN users requester ON requester.id = ws.user_id
      WHERE ws.user_id = ?
        AND requester.tenant_id IS NOT NULL
        AND requester.tenant_id = owner.tenant_id
    `, [userId, userId]);

    return result.rows.map(w => ({
      ...w,
      last_seen: Number(w.last_seen)
    }));
  }

  static async share(workerId: string, userId: number, permission: 'view' | 'control' | 'admin'): Promise<void> {
    await db.run(`
      INSERT INTO worker_shares (worker_id, user_id, permission)
      VALUES (?, ?, ?)
      ON CONFLICT(worker_id, user_id) DO UPDATE SET permission = excluded.permission
    `, [workerId, userId, permission]);
  }

  static async unshare(workerId: string, userId: number): Promise<number> {
    const result = await db.run('DELETE FROM worker_shares WHERE worker_id = ? AND user_id = ?', [workerId, userId]);
    return result.changes || 0;
  }

  static async updateStatus(id: string, status: 'online' | 'offline'): Promise<void> {
    await db.run('UPDATE workers SET status = ?, last_seen = ? WHERE id = ?', [status, Date.now(), id]);
  }

  static async updateName(id: string, name: string): Promise<void> {
    await db.run('UPDATE workers SET name = ? WHERE id = ?', [name, id]);
  }

  static async delete(id: string): Promise<void> {
    await db.run('DELETE FROM worker_shares WHERE worker_id = ?', [id]);
    await db.run('DELETE FROM workers WHERE id = ?', [id]);
  }

  static async hasAccess(userId: number, workerId: string, requiredPermission: 'view' | 'control' | 'admin' = 'view'): Promise<boolean> {
    const access = await db.get<{
      owner_id: number;
      requester_is_admin: number;
      requester_tenant: string | null;
      owner_tenant: string | null;
      permission: string | null;
    }>(`
      SELECT
        w.owner_id,
        requester.is_admin AS requester_is_admin,
        requester.tenant_id AS requester_tenant,
        owner.tenant_id AS owner_tenant,
        ws.permission
      FROM workers w
      JOIN users requester ON requester.id = ?
      JOIN users owner ON owner.id = w.owner_id
      LEFT JOIN worker_shares ws ON ws.worker_id = w.id AND ws.user_id = requester.id
      WHERE w.id = ?
    `, [userId, workerId]);
    if (!access) return false;
    if (access.requester_is_admin === 1 && (access.requester_tenant ?? null) === null) return true;
    if (Number(access.owner_id) === userId) return true;
    if (!access.requester_tenant || !access.owner_tenant
      || access.requester_tenant !== access.owner_tenant || !access.permission) return false;

    // Single share mode: treat view/control as the same permission level.
    const levels = { 'view': 1, 'control': 2, 'admin': 3 };
    return levels[access.permission as keyof typeof levels] >= levels[requiredPermission];
  }

  static async getShares(workerId: string): Promise<{ userId: number; username: string; permission: string }[]> {
    const result = await db.query<{ userId: number; username: string; permission: string }>(`
      SELECT ws.user_id as "userId", u.username, ws.permission
      FROM worker_shares ws
      JOIN users u ON ws.user_id = u.id
      WHERE ws.worker_id = ?
    `, [workerId]);
    return result.rows;
  }
}

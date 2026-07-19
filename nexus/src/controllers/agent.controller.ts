
import { Request, Response } from 'express';
import { AgentModel, VALID_HARNESS } from '../models/agent.model';
import { TenantModel } from '../models/tenant.model';
import { UserModel } from '../models/user.model';

// Resuelve el tenant_id efectivo del usuario DESDE la DB (robusto ante JWTs viejos
// que no traen tenantId — risk #2 del diseño).
async function resolveTenantId(userId: number): Promise<string | null> {
  const user = await UserModel.findById(userId);
  return user?.tenant_id ?? null;
}

async function isGlobalAdmin(userId: number): Promise<boolean> {
  const user = await UserModel.findById(userId);
  return user?.is_admin === 1 && (user.tenant_id ?? null) === null;
}

function isValidHarness(h: unknown): boolean {
  return typeof h === 'string' && (VALID_HARNESS as readonly string[]).includes(h);
}

export class AgentController {
  static async list(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }

    if (await isGlobalAdmin(req.user.userId)) {
      const agents = await AgentModel.list();
      res.json(agents);
      return;
    }

    const tenantId = await resolveTenantId(req.user.userId);
    if (!tenantId) { res.json([]); return; }

    const agents = await AgentModel.list(tenantId);
    res.json(agents);
  }

  static async get(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const agent = await AgentModel.findById(id);
    if (!agent) { res.status(404).json({ error: 'Agente no encontrado' }); return; }

    if (!(await isGlobalAdmin(req.user.userId))) {
      const tenantId = await resolveTenantId(req.user.userId);
      if (agent.tenantId !== tenantId) { res.status(403).json({ error: 'Acceso denegado' }); return; }
    }

    res.json(agent);
  }

  static async create(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const body = req.body || {};
    const { key, displayName, role, harness, tuiWorker, shellWorker, model, status, metadata } = body;

    if (!key || !displayName) {
      res.status(400).json({ error: 'key y displayName requeridos' });
      return;
    }
    if (harness !== undefined && !isValidHarness(harness)) {
      res.status(400).json({ error: `harness inválido; usar uno de: ${VALID_HARNESS.join(', ')}` });
      return;
    }

    // Scoping de tenant destino.
    let tenantId: string;
    if (await isGlobalAdmin(req.user.userId)) {
      if (!body.tenantId) { res.status(400).json({ error: 'tenantId requerido' }); return; }
      tenantId = String(body.tenantId);
    } else {
      const own = await resolveTenantId(req.user.userId);
      if (!own) { res.status(403).json({ error: 'Usuario sin tenant asignado' }); return; }
      if (body.tenantId && String(body.tenantId) !== own) {
        res.status(403).json({ error: 'No puedes crear agentes en otro tenant' });
        return;
      }
      tenantId = own;
    }

    if (!(await TenantModel.exists(tenantId))) {
      res.status(400).json({ error: 'Tenant no existe' });
      return;
    }

    if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
      res.status(400).json({ error: 'metadata debe ser un objeto' });
      return;
    }

    try {
      const agent = await AgentModel.create({
        tenantId,
        key: String(key),
        displayName: String(displayName),
        role,
        harness,
        tuiWorker: tuiWorker ?? null,
        shellWorker: shellWorker ?? null,
        model: model ?? null,
        status,
        metadata,
      });
      res.status(201).json(agent);
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (/UNIQUE|duplicate/i.test(msg)) {
        res.status(409).json({ error: 'Ya existe un agente con esa key en este tenant' });
        return;
      }
      res.status(500).json({ error: msg });
    }
  }

  static async update(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const agent = await AgentModel.findById(id);
    if (!agent) { res.status(404).json({ error: 'Agente no encontrado' }); return; }

    if (!(await isGlobalAdmin(req.user.userId))) {
      const tenantId = await resolveTenantId(req.user.userId);
      if (agent.tenantId !== tenantId) { res.status(403).json({ error: 'Acceso denegado' }); return; }
    }

    const body = req.body || {};

    // PROHIBIDO mover a otro tenant.
    if (body.tenantId !== undefined && String(body.tenantId) !== agent.tenantId) {
      res.status(403).json({ error: 'No se puede mover un agente a otro tenant' });
      return;
    }

    if (body.harness !== undefined && !isValidHarness(body.harness)) {
      res.status(400).json({ error: `harness inválido; usar uno de: ${VALID_HARNESS.join(', ')}` });
      return;
    }
    if (body.metadata !== undefined && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))) {
      res.status(400).json({ error: 'metadata debe ser un objeto' });
      return;
    }

    const updated = await AgentModel.update(id, {
      displayName: body.displayName,
      role: body.role,
      harness: body.harness,
      tuiWorker: body.tuiWorker,
      shellWorker: body.shellWorker,
      model: body.model,
      status: body.status,
      metadata: body.metadata,
    });
    res.json(updated);
  }

  static async remove(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const agent = await AgentModel.findById(id);
    if (!agent) { res.status(404).json({ error: 'Agente no encontrado' }); return; }

    if (!(await isGlobalAdmin(req.user.userId))) {
      const tenantId = await resolveTenantId(req.user.userId);
      if (agent.tenantId !== tenantId) { res.status(403).json({ error: 'Acceso denegado' }); return; }
    }

    await AgentModel.delete(id);
    res.json({ success: true });
  }
}

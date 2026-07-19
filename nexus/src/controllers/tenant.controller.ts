
import { Request, Response } from 'express';
import { TenantModel } from '../models/tenant.model';
import { UserModel } from '../models/user.model';

// Resuelve el tenant_id efectivo del usuario DESDE la DB (robusto ante JWTs viejos
// que no traen tenantId — risk #2 del diseño). +1 query, pero correcto.
async function resolveTenantId(userId: number): Promise<string | null> {
  const user = await UserModel.findById(userId);
  return user?.tenant_id ?? null;
}

async function isGlobalAdmin(userId: number): Promise<boolean> {
  const user = await UserModel.findById(userId);
  return user?.is_admin === 1 && (user.tenant_id ?? null) === null;
}

export class TenantController {
  static async list(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }

    if (await isGlobalAdmin(req.user.userId)) {
      const tenants = await TenantModel.list();
      res.json(tenants);
      return;
    }

    const tenantId = await resolveTenantId(req.user.userId);
    if (!tenantId) { res.json([]); return; }

    const tenant = await TenantModel.findById(tenantId);
    res.json(tenant ? [tenant] : []);
  }
}

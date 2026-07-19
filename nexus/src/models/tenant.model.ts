
import db from '../config/database';

export interface TenantRow {
  id: string;
  label: string;
  bus_group: string;
  open_to_all: number;
  created_at: string;
}

// Shape expuesto por la API — matchea EXACTO la interface Tenant del cliente
// (client/src/lib/agents.ts): { id, label, group, openToAll }.
export interface TenantJson {
  id: string;
  label: string;
  group: string;
  openToAll: boolean;
}

export function tenantToJson(row: TenantRow): TenantJson {
  return {
    id: row.id,
    label: row.label,
    group: row.bus_group,
    openToAll: Number(row.open_to_all) === 1,
  };
}

export class TenantModel {
  static async list(): Promise<TenantJson[]> {
    const result = await db.query<TenantRow>('SELECT * FROM tenants ORDER BY id ASC');
    return result.rows.map(tenantToJson);
  }

  static async findById(id: string): Promise<TenantJson | undefined> {
    const row = await db.get<TenantRow>('SELECT * FROM tenants WHERE id = ?', [id]);
    return row ? tenantToJson(row) : undefined;
  }

  static async exists(id: string): Promise<boolean> {
    const row = await db.get<{ id: string }>('SELECT id FROM tenants WHERE id = ?', [id]);
    return Boolean(row);
  }

  static async upsert(id: string, label: string, busGroup: string, openToAll: boolean): Promise<void> {
    await db.run(`
      INSERT INTO tenants (id, label, bus_group, open_to_all, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING
    `, [id, label, busGroup, openToAll ? 1 : 0, new Date().toISOString()]);
  }
}

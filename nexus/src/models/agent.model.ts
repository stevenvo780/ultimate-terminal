
import db from '../config/database';

export const VALID_HARNESS = ['claude-code', 'openclaw', 'codex', 'bot'] as const;
export type Harness = (typeof VALID_HARNESS)[number];

// Fila cruda: SELECT a.*, t.bus_group AS tenant_group FROM agents a LEFT JOIN tenants t ...
export interface AgentRow {
  id: number;
  tenant_id: string;
  key: string;
  display_name: string;
  role: string;
  harness: string;
  tui_worker: string | null;
  shell_worker: string | null;
  model: string | null;
  status: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  tenant_group?: string | null;
}

// Shape expuesto por la API — matchea la interface AgentDef del cliente (camelCase).
export interface AgentJson {
  id: number;
  tenantId: string;
  key: string;
  displayName: string;
  role: string;
  harness: string;
  group: string | null;
  tuiWorker: string | null;
  shellWorker: string | null;
  model: string | null;
  status: string;
  note: string | null;
  metadata: Record<string, any>;
}

export interface AgentCreateFields {
  tenantId: string;
  key: string;
  displayName: string;
  role?: string;
  harness?: string;
  tuiWorker?: string | null;
  shellWorker?: string | null;
  model?: string | null;
  status?: string;
  metadata?: Record<string, any>;
}

export interface AgentPatchFields {
  displayName?: string;
  role?: string;
  harness?: string;
  tuiWorker?: string | null;
  shellWorker?: string | null;
  model?: string | null;
  status?: string;
  metadata?: Record<string, any>;
}

function parseMetadata(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function rowToJson(row: AgentRow): AgentJson {
  const metadata = parseMetadata(row.metadata);
  return {
    id: Number(row.id),
    tenantId: row.tenant_id,
    key: row.key,
    displayName: row.display_name,
    role: row.role,
    harness: row.harness,
    group: row.tenant_group ?? null,
    tuiWorker: row.tui_worker ?? null,
    shellWorker: row.shell_worker ?? null,
    model: row.model ?? null,
    status: row.status,
    note: metadata.note ?? null,
    metadata,
  };
}

const SELECT_WITH_GROUP = `
  SELECT a.*, t.bus_group AS tenant_group
  FROM agents a
  LEFT JOIN tenants t ON a.tenant_id = t.id
`;

export class AgentModel {
  /** Lista agentes; si tenantId se pasa, filtra por tenant. Admin → sin filtro. */
  static async list(tenantId?: string | null): Promise<AgentJson[]> {
    let result;
    if (tenantId) {
      result = await db.query<AgentRow>(
        `${SELECT_WITH_GROUP} WHERE a.tenant_id = ? ORDER BY a.tenant_id ASC, a.id ASC`,
        [tenantId]
      );
    } else {
      result = await db.query<AgentRow>(
        `${SELECT_WITH_GROUP} ORDER BY a.tenant_id ASC, a.id ASC`
      );
    }
    return result.rows.map(rowToJson);
  }

  static async findById(id: number): Promise<AgentJson | undefined> {
    const row = await db.get<AgentRow>(`${SELECT_WITH_GROUP} WHERE a.id = ?`, [id]);
    return row ? rowToJson(row) : undefined;
  }

  private static async findByTenantKey(tenantId: string, key: string): Promise<AgentJson | undefined> {
    const row = await db.get<AgentRow>(
      `${SELECT_WITH_GROUP} WHERE a.tenant_id = ? AND a.key = ?`,
      [tenantId, key]
    );
    return row ? rowToJson(row) : undefined;
  }

  /** Idempotente: no pisa filas existentes (seed sólo rellena). */
  static async seedInsert(fields: AgentCreateFields & { createdAt?: string }): Promise<void> {
    const now = fields.createdAt || new Date().toISOString();
    await db.run(`
      INSERT INTO agents (tenant_id, key, display_name, role, harness, tui_worker, shell_worker, model, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, key) DO NOTHING
    `, [
      fields.tenantId,
      fields.key,
      fields.displayName,
      fields.role ?? '',
      fields.harness ?? 'claude-code',
      fields.tuiWorker ?? null,
      fields.shellWorker ?? null,
      fields.model ?? null,
      fields.status ?? 'active',
      JSON.stringify(fields.metadata ?? {}),
      now,
      now,
    ]);
  }

  /** Crea un agente y devuelve la fila resultante (robusto en SQLite y PG). */
  static async create(fields: AgentCreateFields): Promise<AgentJson> {
    const now = new Date().toISOString();
    await db.run(`
      INSERT INTO agents (tenant_id, key, display_name, role, harness, tui_worker, shell_worker, model, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      fields.tenantId,
      fields.key,
      fields.displayName,
      fields.role ?? '',
      fields.harness ?? 'claude-code',
      fields.tuiWorker ?? null,
      fields.shellWorker ?? null,
      fields.model ?? null,
      fields.status ?? 'active',
      JSON.stringify(fields.metadata ?? {}),
      now,
      now,
    ]);
    const created = await this.findByTenantKey(fields.tenantId, fields.key);
    if (!created) throw new Error('Failed to create agent');
    return created;
  }

  static async update(id: number, patch: AgentPatchFields): Promise<AgentJson | undefined> {
    const existing = await db.get<AgentRow>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!existing) return undefined;

    const sets: string[] = [];
    const params: any[] = [];
    const map: Record<string, string> = {
      displayName: 'display_name',
      role: 'role',
      harness: 'harness',
      tuiWorker: 'tui_worker',
      shellWorker: 'shell_worker',
      model: 'model',
      status: 'status',
    };
    for (const [field, col] of Object.entries(map)) {
      if (field in patch && (patch as any)[field] !== undefined) {
        sets.push(`${col} = ?`);
        params.push((patch as any)[field]);
      }
    }
    if ('metadata' in patch && patch.metadata !== undefined) {
      sets.push('metadata = ?');
      params.push(JSON.stringify(patch.metadata ?? {}));
    }

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    await db.run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.findById(id);
  }

  static async delete(id: number): Promise<number> {
    const result = await db.run('DELETE FROM agents WHERE id = ?', [id]);
    return result.changes || 0;
  }

  static async deleteByTenantKey(tenantId: string, key: string): Promise<number> {
    const result = await db.run(
      'DELETE FROM agents WHERE tenant_id = ? AND key = ?',
      [tenantId, key]
    );
    return result.changes || 0;
  }
}

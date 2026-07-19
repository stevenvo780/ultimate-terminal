
// Seed idempotente de la flota (tenants + agents). Se llama en index.ts justo
// después de initDatabase(). Usa INSERT ... ON CONFLICT DO NOTHING → sólo rellena
// lo faltante, NUNCA pisa ediciones hechas por la API (PATCH/POST /api/agents).
// Re-correr en cada boot es seguro.

import { TenantModel } from '../models/tenant.model';
import { AgentModel, AgentCreateFields } from '../models/agent.model';
import { UserModel } from '../models/user.model';

interface SeedTenant {
  id: string;
  label: string;
  group: string;
  openToAll: boolean;
}

const TENANTS: SeedTenant[] = [
  { id: 'steven', label: 'Steven', group: 'grp.steven', openToAll: true },
  { id: 'miguel', label: 'Miguel', group: 'grp.miguel', openToAll: false },
  { id: 'isa', label: 'Isa', group: 'grp.isa', openToAll: false },
  { id: 'jhon', label: 'Jhon', group: 'grp.jhon', openToAll: false },
  { id: 'pablo', label: 'Pablo', group: 'grp.pablo', openToAll: false },
];

// harness/tui/shell EXACTOS del spec de requisitos.
const AGENTS: AgentCreateFields[] = [
  // Steven
  { tenantId: 'steven', key: 'kant', displayName: 'Kant', role: 'Infra / credenciales', harness: 'claude-code', tuiWorker: 'ctrl-infra-kant-tui', shellWorker: 'ctrl-infra' },
  { tenantId: 'steven', key: 'socrates', displayName: 'Sócrates', role: 'Desarrollo', harness: 'claude-code', tuiWorker: 'ws-prizma-socrates-tui', shellWorker: 'ws-prizma' },
  { tenantId: 'steven', key: 'jarvis', displayName: 'Jarvis', role: 'Asistente personal', harness: 'openclaw', tuiWorker: 'jarvis-tui' },
  { tenantId: 'steven', key: 'argos', displayName: 'Argos', role: 'Asistente de equipo', harness: 'openclaw', tuiWorker: 'agv2-steven-argos-tui', shellWorker: 'agv2-steven-argos' },
  // Miguel
  { tenantId: 'miguel', key: 'janus', displayName: 'Janus', role: 'Asistente', harness: 'openclaw', tuiWorker: 'janus-tui' },
  { tenantId: 'miguel', key: 'kratos', displayName: 'Kratos', role: 'Desarrollo (OMS)', harness: 'claude-code', tuiWorker: 'kratos-tui' },
  // Isa
  { tenantId: 'isa', key: 'salva', displayName: 'Salva', role: 'Diseño / multimedia', harness: 'claude-code', tuiWorker: 'ws-isa-salva-tui', shellWorker: 'ws-isa' },
  // Jhon
  { tenantId: 'jhon', key: 'hegel', displayName: 'Hegel', role: 'Ventas', harness: 'openclaw', tuiWorker: 'agv2-jhon-hegel-tui', shellWorker: 'agv2-jhon-hegel' },
  // Pablo
  { tenantId: 'pablo', key: 'dedalo', displayName: 'Dédalo', role: 'Developer', harness: 'codex', shellWorker: 'ws-pablo-dev' },
  { tenantId: 'pablo', key: 'midas', displayName: 'Midas', role: 'Marcas', harness: 'openclaw', tuiWorker: 'agv2-pablo-marcas-tui', shellWorker: 'agv2-pablo-marcas' },
  { tenantId: 'pablo', key: 'seneca', displayName: 'Séneca', role: 'Personal', harness: 'openclaw', tuiWorker: 'agv2-pablo-personal-tui', shellWorker: 'agv2-pablo-personal' },
  { tenantId: 'pablo', key: 'vulcano', displayName: 'Vulcano', role: 'Infra', harness: 'claude-code', tuiWorker: 'ws-pablo-vulcano-tui', shellWorker: 'ws-pablo' },
];

// Aliases históricos retirados de la topología canónica. La limpieza es
// deliberadamente exacta para no tocar agentes creados por los usuarios.
const RETIRED_AGENTS = [
  { tenantId: 'steven', key: 'metafisica' },
  { tenantId: 'miguel', key: 'iza' },
  { tenantId: 'miguel', key: 'atlas' },
];

export async function seedFleet(): Promise<void> {
  // Tenants
  for (const t of TENANTS) {
    await TenantModel.upsert(t.id, t.label, t.group, t.openToAll);
  }

  // Agents (ON CONFLICT (tenant_id, key) DO NOTHING)
  for (const a of AGENTS) {
    await AgentModel.seedInsert(a);
  }

  let retired = 0;
  for (const agent of RETIRED_AGENTS) {
    retired += await AgentModel.deleteByTenantKey(agent.tenantId, agent.key);
  }

  console.log(
    `[Nexus] Seed flota: ${TENANTS.length} tenants, ${AGENTS.length} agents canónicos` +
    (retired ? `; ${retired} aliases retirados` : '')
  );

  // Usuarios por-tenant (opcional, gated). Sin esto no seedea secretos.
  if (process.env.SEED_TENANT_USERS === 'true') {
    const defaultPass = process.env.TENANT_DEFAULT_PASSWORD;
    if (!defaultPass) {
      console.warn('[Nexus] SEED_TENANT_USERS=true pero falta TENANT_DEFAULT_PASSWORD — omitiendo usuarios-tenant');
      return;
    }
    for (const t of TENANTS) {
      const existing = await UserModel.findByUsername(t.id);
      if (!existing) {
        const user = await UserModel.create(t.id, defaultPass, false, t.id);
        console.log(`[Nexus] Seed usuario-tenant '${t.id}' (id=${user.id})`);
      } else if (existing.tenant_id !== t.id) {
        await UserModel.updateTenant(existing.id, t.id);
        console.log(`[Nexus] Asignado tenant_id='${t.id}' a usuario existente '${t.id}'`);
      }
    }
  }
}

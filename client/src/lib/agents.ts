import type { Worker } from '../store/slices/workersSlice';
import {
  HARNESS_LABEL,
  type Harness,
  type TenantId,
  type Tenant,
  type AgentDef,
} from '../store/slices/agentsSlice';

// ── Registry de la flota ─────────────────────────────────────────────────────
// El registro (tenants + agentes) YA NO vive hardcodeado acá: es DB-backed y el
// cliente lo trae por fetch (/api/agents, /api/tenants) → Redux (agentsSlice).
// Este módulo solo aporta: (a) re-export de tipos/labels y (b) el cruce del
// registry contra los workers VIVOS del control plane para pintar el sidebar.
// El estado en vivo (online, botón habilitado) sale de cruzar el registry con
// los workers; así la web muestra SIEMPRE la estructura aunque un worker esté caído.

export { HARNESS_LABEL };
export type { Harness, TenantId, Tenant, AgentDef };

// ── Cruce registry × workers vivos ───────────────────────────────────────────

export interface ResolvedAgent extends AgentDef {
  tui?: Worker;        // worker TUI si existe en el control plane
  shell?: Worker;      // worker shell si existe
  online: boolean;     // hay presencia viva (tui o shell online)
}

export interface TenantGroup {
  tenant: Tenant;
  agents: ResolvedAgent[];
}

const isOnline = (w?: Worker) => !!w && w.status !== 'offline';

function resolve(agent: AgentDef, byName: Map<string, Worker>): ResolvedAgent {
  const tui = agent.tuiWorker ? byName.get(agent.tuiWorker.toLowerCase()) : undefined;
  const shell = agent.shellWorker ? byName.get(agent.shellWorker.toLowerCase()) : undefined;
  return { ...agent, tui, shell, online: isOnline(tui) || isOnline(shell) };
}

/** Agentes agrupados por tenant (los del registry) + workers "sueltos" (hosts/PCs). */
export function buildFleet(
  workers: Worker[],
  agents: AgentDef[],
  tenants: Tenant[],
): { groups: TenantGroup[]; plainWorkers: Worker[] } {
  const byName = new Map(workers.map((w) => [w.name.toLowerCase(), w]));

  const groups: TenantGroup[] = tenants.map((tenant) => ({
    tenant,
    agents: agents.filter((a) => a.tenantId === tenant.id).map((a) => resolve(a, byName)),
  }));

  // Workers reclamados por algún agente (su tui o shell) → no van a "Workers / PCs".
  const claimed = new Set<string>();
  for (const a of agents) {
    if (a.tuiWorker) claimed.add(a.tuiWorker.toLowerCase());
    if (a.shellWorker) claimed.add(a.shellWorker.toLowerCase());
  }
  const plainWorkers = workers.filter((w) => !claimed.has(w.name.toLowerCase()));
  return { groups, plainWorkers };
}

/** Solo los workers que NO pertenecen a ningún agente (para la sección Workers/PCs). */
export function plainWorkersOf(workers: Worker[], agents: AgentDef[]): Worker[] {
  const claimed = new Set<string>();
  for (const a of agents) {
    if (a.tuiWorker) claimed.add(a.tuiWorker.toLowerCase());
    if (a.shellWorker) claimed.add(a.shellWorker.toLowerCase());
  }
  return workers.filter((w) => !claimed.has(w.name.toLowerCase()));
}

export function agentMatches(a: ResolvedAgent, search: string): boolean {
  if (!search) return true;
  const s = search.toLowerCase();
  const harnessLabel = HARNESS_LABEL[a.harness] ?? a.harness;
  return (
    a.displayName.toLowerCase().includes(s) ||
    a.role.toLowerCase().includes(s) ||
    a.key.toLowerCase().includes(s) ||
    harnessLabel.toLowerCase().includes(s)
  );
}

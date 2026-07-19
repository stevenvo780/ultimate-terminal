import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

// ── Tipos del registry de la flota (antes hardcodeados en lib/agents.ts) ─────
// Ahora son DB-backed: el cliente los trae por fetch a /api/agents y /api/tenants.
// Esta slice es la ÚNICA fuente de verdad de estos tipos; lib/agents.ts los re-exporta.

export type Harness = 'claude-code' | 'openclaw' | 'codex' | 'bot';
// TenantId era un union cerrado; ahora el registry vive en la DB → id textual libre.
export type TenantId = string;

export interface Tenant {
  id: string;
  label: string;
  group: string;       // room del bus (bus_group)
  openToAll: boolean;  // grupo de Steven ↔ todos; clientes cerrados
}

export interface AgentDef {
  id?: number;             // PK en la DB (ausente en datos legacy/optimistas)
  key: string;             // alias en el bus / id lógico
  displayName: string;
  tenantId: string;        // tenant al que pertenece
  role: string;
  harness: Harness;
  group: string;           // grp.<tenant> (viene del LEFT JOIN tenants)
  tuiWorker?: string | null;   // worker que abre la TUI viva
  shellWorker?: string | null; // worker que abre el shell/PC del agente
  model?: string | null;
  status?: string;             // 'active' | 'paused' (estado provisional, NO presencia)
  note?: string | null;        // = metadata.note
  metadata?: Record<string, unknown>;
}

export const HARNESS_LABEL: Record<Harness, string> = {
  'claude-code': 'Claude Code',
  openclaw: 'OpenClaw',
  codex: 'Codex',
  bot: 'Bot',
};

interface AgentsState {
  list: AgentDef[];
  tenants: Tenant[];
  loaded: boolean;
}

const initialState: AgentsState = {
  list: [],
  tenants: [],
  loaded: false,
};

const agentsSlice = createSlice({
  name: 'agents',
  initialState,
  reducers: {
    setAgents: (state, action: PayloadAction<AgentDef[]>) => {
      state.list = action.payload;
      state.loaded = true;
    },
    setTenants: (state, action: PayloadAction<Tenant[]>) => {
      state.tenants = action.payload;
    },
    resetAgentsState: (state) => {
      state.list = [];
      state.tenants = [];
      state.loaded = false;
    },
  },
});

export const { setAgents, setTenants, resetAgentsState } = agentsSlice.actions;

export default agentsSlice.reducer;

// Selectors
export const selectAgents = (state: { agents: AgentsState }) => state.agents.list;
export const selectTenants = (state: { agents: AgentsState }) => state.agents.tenants;
export const selectAgentsLoaded = (state: { agents: AgentsState }) => state.agents.loaded;

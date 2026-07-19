import { useMemo } from 'react';
import { useAppSelector } from '../../../store/hooks';
import { selectAgents, selectTenants } from '../../../store';
import { buildFleet, agentMatches, HARNESS_LABEL, type ResolvedAgent } from '../../../lib/agents';
import { Bot, SquareTerminal, Users, Globe, Lock, Cpu, CircleSlash } from 'lucide-react';
import './AgentList.css';

interface AgentListProps {
  onOpenTui: (workerId: string) => void;
  onOpenShell: (workerId: string) => void;
}

// Control plane agente-céntrico: la flota agrupada por persona/grupo del bus.
// El registry es DB-backed (fetch /api/agents + /api/tenants → Redux) y viene
// ya tenant-scoped desde el server (un user no-admin solo ve lo suyo).
// Cada agente muestra su harness, estado y accesos (TUI viva / Shell).
export function AgentList({ onOpenTui, onOpenShell }: AgentListProps) {
  const workers = useAppSelector((s) => s.workers.workers);
  const query = useAppSelector((s) => s.workers.workerQuery);
  const agents = useAppSelector(selectAgents);
  const tenants = useAppSelector(selectTenants);

  const groups = useMemo(() => {
    const q = query.trim();
    return buildFleet(workers, agents, tenants).groups
      .map((g) => ({ ...g, agents: g.agents.filter((a) => agentMatches(a, q)) }))
      .filter((g) => g.agents.length > 0);
  }, [workers, agents, tenants, query]);

  if (groups.length === 0) return null;

  return (
    <div className="sidebar-section">
      <div className="section-title">Agentes</div>
      {groups.map(({ tenant, agents }) => {
        const onlineCount = agents.filter((a) => a.online).length;
        return (
          <div key={tenant.id} className="tenant-block">
            <div className="tenant-head" title={`Grupo del bus: ${tenant.group}`}>
              <Users className="tenant-icon" />
              <span className="tenant-name">{tenant.label}</span>
              <span className="tenant-count" title={`${onlineCount} de ${agents.length} en línea`}>
                {onlineCount}/{agents.length}
              </span>
              <span className={`tenant-scope ${tenant.openToAll ? 'open' : 'closed'}`}>
                {tenant.openToAll ? <Globe /> : <Lock />}
                {tenant.openToAll ? '↔ todos' : 'cerrado'}
              </span>
            </div>
            {agents.map((agent) => (
              <AgentRow key={agent.key} agent={agent} onOpenTui={onOpenTui} onOpenShell={onOpenShell} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function AgentRow({
  agent,
  onOpenTui,
  onOpenShell,
}: {
  agent: ResolvedAgent;
  onOpenTui: (workerId: string) => void;
  onOpenShell: (workerId: string) => void;
}) {
  const tuiOnline = !!agent.tui && agent.tui.status !== 'offline';
  const shellOnline = !!agent.shell && agent.shell.status !== 'offline';
  const isBot = agent.harness === 'bot';
  const harnessLabel = HARNESS_LABEL[agent.harness] ?? agent.harness;
  const paused = agent.status === 'paused';

  // Estado presencial nítido: en línea / fuera de línea / sin worker asignado.
  const hasAnyWorker = !!agent.tuiWorker || !!agent.shellWorker;
  const presence = agent.online ? 'online' : hasAnyWorker ? 'offline' : 'none';
  const presenceLabel =
    presence === 'online' ? 'En línea' : presence === 'offline' ? 'Fuera de línea' : 'Sin worker';

  return (
    <div className={`agent-item ${agent.online ? '' : 'offline'} ${paused ? 'paused' : ''}`}>
      <div
        className="agent-main"
        onClick={() => tuiOnline && agent.tui && onOpenTui(agent.tui.id)}
        title={agent.note || (tuiOnline ? 'Abrir la TUI viva del agente' : presenceLabel)}
      >
        <Bot className="agent-icon" />
        <div className="agent-text">
          <div className="agent-name-row">
            <span className="agent-name">{agent.displayName}</span>
            {paused && <span className="agent-flag paused">pausado</span>}
          </div>
          <div className="agent-sub">
            <span className={`harness-badge h-${agent.harness}`}>{harnessLabel}</span>
            <span className="agent-role">{agent.role}</span>
          </div>
          {agent.model && (
            <div className="agent-model" title="Modelo">
              <Cpu /> {agent.model}
            </div>
          )}
        </div>
        <span
          className={`agent-status ${presence}`}
          title={agent.note || presenceLabel}
        />
      </div>

      {!isBot && hasAnyWorker && (
        <div className="agent-actions">
          {agent.tuiWorker && (
            <button
              className="agent-btn tui"
              disabled={!tuiOnline}
              onClick={() => agent.tui && onOpenTui(agent.tui.id)}
              title={tuiOnline ? 'Abrir la TUI viva del agente' : 'TUI no disponible (worker offline)'}
              type="button"
            >
              <Bot /> TUI
            </button>
          )}
          {agent.shellWorker && (
            <button
              className="agent-btn shell"
              disabled={!shellOnline}
              onClick={() => agent.shell && onOpenShell(agent.shell.id)}
              title={shellOnline ? 'Abrir shell / PC del agente' : 'Shell no disponible (worker offline)'}
              type="button"
            >
              <SquareTerminal /> Shell
            </button>
          )}
        </div>
      )}

      {!isBot && !hasAnyWorker && (
        <div className="agent-note no-worker">
          <CircleSlash /> {agent.note || 'Sin worker asignado'}
        </div>
      )}

      {isBot && agent.note && <div className="agent-note">{agent.note}</div>}
    </div>
  );
}

import { useAppDispatch, useAppSelector } from '../../../store/hooks';
import { toggleSidebar, setEditingWorker, setShowWorkerModal, setShowMobileSidebar } from '../../../store';
import { useResizableSidebar } from '../../../hooks';
import { WorkerList } from './WorkerList';
import { AgentList } from './AgentList';
import { ChevronLeft, ChevronRight, Link2, Plus, X } from 'lucide-react';
import './Sidebar.css';

interface SidebarProps {
  onSelectWorker: (workerId: string) => void;
  onNewSession: (workerId: string) => void;
  onJoinWorker: () => void;
}

export function Sidebar({
  onSelectWorker,
  onNewSession,
  onJoinWorker,
}: SidebarProps) {
  const dispatch = useAppDispatch();
  const sidebarCollapsed = useAppSelector((state) => state.ui.sidebarCollapsed);
  const showMobileSidebar = useAppSelector((state) => state.ui.showMobileSidebar);
  const { width: sidebarWidth, isResizing, startResizing } = useResizableSidebar();
  const handleCreateWorker = () => {
    dispatch(setEditingWorker(null));
    dispatch(setShowWorkerModal(true));
  };

  const handleCloseMobile = () => {
    dispatch(setShowMobileSidebar(false));
  };

  const handleNewSessionMobile = (workerId: string) => {
    onNewSession(workerId);
    dispatch(setShowMobileSidebar(false));
  };

  const handleSelectWorkerMobile = (workerId: string) => {
    onSelectWorker(workerId);
    dispatch(setShowMobileSidebar(false));
  };

  return (
    <>
      {/* Desktop sidebar */}
      <div
        className={`sidebar sidebar-desktop ${sidebarCollapsed ? 'collapsed' : ''} ${isResizing ? 'resizing' : ''}`}
        style={sidebarCollapsed ? undefined : { width: sidebarWidth }}
      >
        <div className="sidebar-header">
          <h3>Agentes & Workers</h3>
          <div className="sidebar-header-actions">
            {!sidebarCollapsed && (
              <button
                className="worker-join-btn"
                onClick={onJoinWorker}
                title="Unirse por código"
                type="button"
              >
                <Link2 />
              </button>
            )}
            {!sidebarCollapsed && (
              <button
                className="worker-create-btn"
                onClick={handleCreateWorker}
                title="Crear worker"
                type="button"
              >
                <Plus />
              </button>
            )}
            <button
              className="collapse-btn"
              onClick={() => dispatch(toggleSidebar())}
              title={sidebarCollapsed ? 'Expandir' : 'Colapsar'}
              type="button"
            >
              {sidebarCollapsed ? <ChevronRight /> : <ChevronLeft />}
            </button>
          </div>
        </div>

        {!sidebarCollapsed && (
          <div className="sidebar-content">
            <AgentList
              onOpenTui={onSelectWorker}
              onOpenShell={onSelectWorker}
            />
            <WorkerList
              onSelectWorker={onSelectWorker}
              onNewSession={onNewSession}
            />
          </div>
        )}

        {/* Resize handle — drag to change the sidebar width */}
        {!sidebarCollapsed && (
          <div
            className={`sidebar-resize-handle ${isResizing ? 'active' : ''}`}
            onMouseDown={startResizing}
            onTouchStart={startResizing}
            role="separator"
            aria-orientation="vertical"
            aria-label="Redimensionar barra lateral"
            title="Arrastrar para redimensionar"
          />
        )}
      </div>

      {/* Mobile drawer overlay */}
      {showMobileSidebar && (
        <div className="mobile-sidebar-backdrop" onClick={handleCloseMobile} />
      )}
      <div className={`mobile-sidebar-drawer ${showMobileSidebar ? 'open' : ''}`}>
        <div className="mobile-sidebar-header">
          <h3>Agentes & Workers</h3>
          <div className="mobile-sidebar-header-actions">
            <button
              className="worker-join-btn"
              onClick={() => { onJoinWorker(); handleCloseMobile(); }}
              title="Unirse por código"
              type="button"
            >
              <Link2 />
            </button>
            <button
              className="worker-create-btn"
              onClick={() => { handleCreateWorker(); handleCloseMobile(); }}
              title="Crear worker"
              type="button"
            >
              <Plus />
            </button>
            <button
              className="mobile-sidebar-close"
              onClick={handleCloseMobile}
              title="Cerrar"
              type="button"
            >
              <X />
            </button>
          </div>
        </div>
        <div className="mobile-sidebar-content">
          <AgentList
            onOpenTui={handleSelectWorkerMobile}
            onOpenShell={handleSelectWorkerMobile}
          />
          <WorkerList
            onSelectWorker={handleSelectWorkerMobile}
            onNewSession={handleNewSessionMobile}
          />
        </div>
      </div>
    </>
  );
}

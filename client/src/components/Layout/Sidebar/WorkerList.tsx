import { useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '../../../store/hooks';
import {
  setWorkerQuery,
  selectFilteredWorkers,
  setShareModalWorker,
  setEditingWorker,
  setShowWorkerModal,
  openDialog,
  selectAgents,
} from '../../../store';
import type { Worker } from '../../../store/slices/workersSlice';
import { plainWorkersOf } from '../../../lib/agents';
import { Download, Link, Plus, Trash2 } from 'lucide-react';
import './WorkerList.css';

interface WorkerListProps {
  onSelectWorker: (workerId: string) => void;
  onNewSession: (workerId: string) => void;
}

export function WorkerList({ onSelectWorker, onNewSession }: WorkerListProps) {
  const dispatch = useAppDispatch();
  const workerQuery = useAppSelector((state) => state.workers.workerQuery);
  const workerTags = useAppSelector((state) => state.workers.workerTags);
  const filteredWorkers = useAppSelector(selectFilteredWorkers);
  const agents = useAppSelector(selectAgents);
  // Los workers que pertenecen a un agente (base + su -tui) se muestran en la
  // sección "Agentes"; aquí quedan solo los hosts/PCs.
  const plainWorkers = useMemo(() => plainWorkersOf(filteredWorkers, agents), [filteredWorkers, agents]);

  const normalizeWorkerKey = (name: string) => name.trim().toLowerCase();

  const handleDeleteConfirm = (worker: Worker) => {
    const isOnline = worker.status === 'online';
    dispatch(openDialog({
      title: 'Eliminar worker',
      message: isOnline
        ? `El worker ${worker.name} está en línea. Se desconectará y se eliminará. Esta acción no se puede deshacer.`
        : `¿Seguro que deseas eliminar ${worker.name}? Esta acción no se puede deshacer.`,
      tone: 'danger',
      actions: [
        { label: 'Cancelar', variant: 'ghost' },
        { label: 'Eliminar', variant: 'danger', actionId: `delete-worker-${worker.id}` },
      ],
    }));
  };

  const handleInstallWorker = (worker: Worker) => {
    dispatch(setEditingWorker(worker));
    dispatch(setShowWorkerModal(true));
  };


  return (
    <div className="sidebar-section">
      <div className="section-title">Workers / PCs</div>
      <div className="worker-tools">
        <input
          className="worker-search"
          placeholder="Buscar por nombre o tag..."
          value={workerQuery}
          onChange={(e) => dispatch(setWorkerQuery(e.target.value))}
        />
      </div>

      {plainWorkers.length === 0 && (
        <div className="empty-sessions">No hay workers</div>
      )}

      {plainWorkers.length > 0 && plainWorkers.map((worker: Worker) => {
        const workerKey = normalizeWorkerKey(worker.name);
        const tags = workerTags[workerKey] || [];
        const permission = worker.permission || 'admin';
        const canManage = permission === 'admin';
        const showInstall = canManage && worker.api_key && worker.status !== 'online';
        return (
          <div
            key={worker.id}
            className={`worker-item ${worker.status === 'offline' ? 'offline' : ''}`}
            onClick={() => onSelectWorker(worker.id)}
          >
            <div className="worker-main">
              <div className="worker-name">{worker.name}</div>
              <div className="worker-meta">
                <span className={`worker-status ${worker.status}`}>
                  {worker.status === 'offline' ? 'Offline' : 'Online'}
                </span>
              </div>
            </div>
            <div className="worker-tags">
              {tags.length > 0
                ? tags.map((tag) => (
                  <span key={`${worker.id}-${tag}`} className="tag-chip">
                    {tag}
                  </span>
                ))
                : <span className="tag-chip empty">Sin tags</span>}
            </div>
            <div className="worker-actions">
              {canManage && (
                <button
                  className="delete-worker-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteConfirm(worker);
                  }}
                  title="Eliminar worker"
                >
                  <Trash2 />
                </button>
              )}
              <button
                className="add-session-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewSession(worker.id);
                }}
                title="Nueva sesión en este worker"
              >
                <Plus />
              </button>
              {canManage && (
                <button
                  className="share-worker-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch(setShareModalWorker(worker));
                  }}
                  title="Compartir worker"
                >
                  <Link />
                </button>
              )}
              {showInstall && (
                <button
                  className="install-worker-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleInstallWorker(worker);
                  }}
                  title="API key e instalación"
                >
                  <Download />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

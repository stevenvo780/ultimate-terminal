import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './App.css';

interface Worker {
  id: string;
  socketId: string;
  name: string;
  status?: 'online' | 'offline';
  lastSeen?: string;
}

interface TerminalSession {
  id: string;
  workerId: string;
  displayName: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  containerRef: HTMLDivElement;
  resizeHandler: () => void;
}

// In production (served from nexus), use relative URL. In dev, use env or localhost.
const NEXUS_URL = import.meta.env.VITE_NEXUS_URL || (import.meta.env.PROD ? '' : 'http://localhost:3002');
const AUTH_KEY = 'ut-token';
const LAST_WORKER_KEY = 'ut-last-worker';
type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [offlineSessions, setOfflineSessions] = useState<Set<string>>(new Set());

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const sessionsRef = useRef<TerminalSession[]>([]);
  const activeSessionRef = useRef<string | null>(null);
  const lastWorkerRef = useRef<string | null>(null);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    const activeSession = sessions.find((s) => s.id === activeSessionId);
    if (activeSession) {
      localStorage.setItem(LAST_WORKER_KEY, activeSession.workerId);
      lastWorkerRef.current = activeSession.workerId;
    } else if (sessions.length === 0) {
      localStorage.removeItem(LAST_WORKER_KEY);
      lastWorkerRef.current = null;
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    const saved = localStorage.getItem(AUTH_KEY);
    if (saved) setToken(saved);
    if (!saved) setConnectionState('disconnected');
    const savedWorker = localStorage.getItem(LAST_WORKER_KEY);
    if (savedWorker) lastWorkerRef.current = savedWorker;
    fetch(`${NEXUS_URL}/api/auth/status`)
      .then((res) => res.json())
      .then((data) => setNeedsSetup(Boolean(data.needsSetup)))
      .catch(() => setNeedsSetup(true));
  }, []);

  useEffect(() => {
    if (!token) return;
    setConnectionState('connecting');
    const newSocket = io(NEXUS_URL, {
      auth: { token, type: 'client' },
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    setSocket(newSocket);

    newSocket.on('connect', () => {
      setConnectionState('connected');
      newSocket.emit('register', { type: 'client' });
      // Rehidrata la sesión activa al reconectar
      setTimeout(() => resumeActiveSession(), 100);
    });

    newSocket.on('reconnect_attempt', () => setConnectionState('reconnecting'));
    newSocket.on('reconnect', () => setConnectionState('connected'));
    newSocket.on('disconnect', () => setConnectionState('disconnected'));

    newSocket.on('worker-list', (list: Worker[]) => {
      setWorkers(list);
      setOfflineSessions(() => {
        const offline = new Set<string>();
        sessionsRef.current.forEach((session) => {
          const worker = list.find((w) => w.id === session.workerId);
          if (!worker || worker.status === 'offline') {
            offline.add(session.id);
          }
        });
        return offline;
      });

      const preferredWorker = lastWorkerRef.current && list.some((w) => w.id === lastWorkerRef.current)
        ? lastWorkerRef.current
        : null;

      const activeSession = sessionsRef.current.find((s) => s.id === activeSessionRef.current);
      const activeWorkerOnline = activeSession
        ? list.some((w) => w.id === activeSession.workerId && w.status !== 'offline')
        : false;

      if (!activeWorkerOnline) {
        if (preferredWorker) {
          focusOrCreateSession(preferredWorker);
        } else if (list.length > 0) {
          const firstOnline = list.find((w) => w.status !== 'offline') || list[0];
          focusOrCreateSession(firstOnline.id);
        } else {
          setActiveSessionId(null);
        }
      }
    });

    newSocket.on('output', (data: { workerId: string; data: string }) => {
      // Find all sessions for this worker and write output to them
      const workerSessions = sessionsRef.current.filter(s => s.workerId === data.workerId);
      workerSessions.forEach(session => {
        session.terminal.write(data.data);
      });
    });

    newSocket.on('connect_error', (err) => {
      setAuthError(err.message);
      setConnectionState('reconnecting');
    });

    return () => {
      newSocket.disconnect();
    };
  }, [token]);

  const createNewSession = (workerId: string) => {
    const worker = workers.find(w => w.id === workerId);
    if (!worker || !terminalContainerRef.current) return;
    localStorage.setItem(LAST_WORKER_KEY, workerId);
    lastWorkerRef.current = workerId;

    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    
    // Create terminal container
    const container = document.createElement('div');
    container.className = 'terminal-wrapper';
    container.style.display = 'none';
    container.dataset.sessionId = sessionId;
    terminalContainerRef.current.appendChild(container);

    // Create terminal
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"MesloLGS NF", "Fira Code", "JetBrains Mono", "Roboto Mono", "Monaco", "Courier New", monospace',
      fontSize: 14,
      cols: 80,
      rows: 24,
      allowTransparency: true,
      scrollback: 5000,
      theme: {
        background: '#0d0d0d',
        foreground: '#e7e7e7',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    // Handle terminal input
    term.onData((data) => {
      if (socketRef.current) {
        socketRef.current.emit('execute', {
          workerId: workerId,
          command: data,
        });
      }
    });

    // Handle resize
    const handleResize = () => {
      const charHeight = 17;
      const availableHeight = container.clientHeight - 12;
      const newRows = Math.max(10, Math.floor(availableHeight / charHeight));
      term.resize(80, newRows);
      
      if (socketRef.current) {
        socketRef.current.emit('resize', {
          workerId: workerId,
          cols: term.cols,
          rows: term.rows,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    const session: TerminalSession = {
      id: sessionId,
      workerId: workerId,
      displayName: worker.name,
      terminal: term,
      fitAddon: fitAddon,
      containerRef: container,
      resizeHandler: handleResize,
    };

    setSessions(prev => [...prev, session]);
    setActiveSessionId(sessionId);

    // Initial resize and trigger prompt
    setTimeout(() => {
      handleResize();
      if (socketRef.current) {
        socketRef.current.emit('execute', {
          workerId: workerId,
          command: '\n',
        });
      }
    }, 100);

    return session;
  };

  const closeSession = (sessionId: string) => {
    setSessions(prevSessions => {
      const session = prevSessions.find(s => s.id === sessionId);
      if (!session) return prevSessions;

      // Clean up resize event listener
      window.removeEventListener('resize', session.resizeHandler);

      // Dispose terminal
      session.terminal.dispose();
      session.containerRef.remove();

      // Filter out the closed session
      const newSessions = prevSessions.filter(s => s.id !== sessionId);

      // If closing active session, switch to another
      if (activeSessionId === sessionId) {
        if (newSessions.length > 0) {
          setActiveSessionId(newSessions[newSessions.length - 1].id);
        } else {
          setActiveSessionId(null);
        }
      }

      return newSessions;
    });
  };

  const switchSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
  };

  const renameSession = (sessionId: string) => {
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    if (!session) return;
    const newName = window.prompt('Nuevo nombre para la sesión', session.displayName);
    if (newName && newName.trim().length > 0) {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, displayName: newName.trim() } : s)),
      );
    }
  };

  const focusOrCreateSession = (workerId: string) => {
    localStorage.setItem(LAST_WORKER_KEY, workerId);
    lastWorkerRef.current = workerId;
    const existing = sessionsRef.current.find((session) => session.workerId === workerId);
    if (existing) {
      setActiveSessionId(existing.id);
      return existing;
    }
    return createNewSession(workerId);
  };

  const resumeActiveSession = () => {
    const session = sessionsRef.current.find((s) => s.id === activeSessionRef.current);
    if (!session || !socketRef.current) return;
    session.fitAddon.fit();
    socketRef.current.emit('resize', {
      workerId: session.workerId,
      cols: session.terminal.cols,
      rows: session.terminal.rows,
    });
    socketRef.current.emit('execute', {
      workerId: session.workerId,
      command: '\n',
    });
  };

  const activeWorkerId = sessions.find((session) => session.id === activeSessionId)?.workerId || '';

  useEffect(() => {
    // Show/hide terminal containers based on active session
    sessions.forEach(session => {
      session.containerRef.style.display = session.id === activeSessionId ? 'block' : 'none';
      if (session.id === activeSessionId) {
        setTimeout(() => session.fitAddon.fit(), 50);
      }
    });
  }, [activeSessionId, sessions]);

  const handleAuth = async (endpoint: 'setup' | 'login', password: string) => {
    setBusy(true);
    setAuthError(null);
    try {
      const res = await fetch(`${NEXUS_URL}/api/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Auth failed');
      const data = await res.json();
      localStorage.setItem(AUTH_KEY, data.token);
      setToken(data.token);
      setNeedsSetup(false);
    } catch (err: any) {
      setAuthError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleChangePassword = async (currentPassword: string, newPassword: string) => {
    if (!token) return;
    setBusy(true);
    setAuthError(null);
    try {
      const res = await fetch(`${NEXUS_URL}/api/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Password change failed');
    } catch (err: any) {
      setAuthError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(LAST_WORKER_KEY);
    setToken(null);
    setWorkers([]);
    setSessions([]);
    setActiveSessionId(null);
    socket?.disconnect();
    setSocket(null);
    setConnectionState('disconnected');
  };

  const Sidebar = () => (
    <div className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        <h3>Sesiones</h3>
        <button className="collapse-btn" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title={sidebarCollapsed ? 'Expandir' : 'Colapsar'}>
          {sidebarCollapsed ? '›' : '‹'}
        </button>
      </div>
      {!sidebarCollapsed && (
        <>
          <div className="sidebar-content">
            {sessions.map(session => (
              <div
                key={session.id}
                className={`session-item ${activeSessionId === session.id ? 'active' : ''} ${offlineSessions.has(session.id) ? 'offline' : ''}`}
                onClick={() => switchSession(session.id)}
              >
                <div className="session-info">
                  <div className="session-name">{session.displayName}</div>
                  {offlineSessions.has(session.id) && <span className="badge-offline">Offline</span>}
                  <div className="session-id">{session.id.substring(0, 12)}...</div>
                </div>
                <button
                  className="rename-session-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    renameSession(session.id);
                  }}
                  title="Renombrar sesión"
                >
                  ✎
                </button>
                <button
                  className="close-session-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(session.id);
                  }}
                  title="Cerrar sesión"
                >
                  ✕
                </button>
              </div>
            ))}
            {sessions.length === 0 && (
              <div className="empty-sessions">
                No hay sesiones activas
              </div>
            )}
          </div>
          <div className="sidebar-footer">
            <label>Nueva sesión en:</label>
            <select
              onChange={(e) => {
                if (e.target.value) {
                  focusOrCreateSession(e.target.value);
                  e.target.value = '';
                }
              }}
              defaultValue=""
              disabled={!workers.length}
            >
              <option value="">Seleccionar worker...</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}{w.status === 'offline' ? ' (offline)' : ''}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </div>
  );

  const Controls = () => (
    <div className="topbar">
      <div className="brand">Ultimate Terminal</div>
      <div className="control-group">
        <label>Worker</label>
        <select
          value={activeWorkerId}
          onChange={(e) => {
            if (e.target.value) {
              focusOrCreateSession(e.target.value);
            }
          }}
          disabled={!workers.length}
        >
          <option value="">Seleccionar worker</option>
          {workers.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}{w.status === 'offline' ? ' (offline)' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="topbar-stats">
        <span>{sessions.length} sesión{sessions.length !== 1 ? 'es' : ''}</span>
        <span>•</span>
        <span>{workers.length} worker{workers.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="topbar-right">
        {activeSessionId && (
          <button className="resume-btn" onClick={resumeActiveSession} title="Reanudar sesión activa">
            Reanudar
          </button>
        )}
        <div className={`status ${
          connectionState === 'connected'
            ? 'ok'
            : connectionState === 'reconnecting' || connectionState === 'connecting'
              ? 'warn'
              : 'bad'
        }`}>
          {connectionState === 'connected' && 'Conectado'}
          {connectionState === 'connecting' && 'Conectando...'}
          {connectionState === 'reconnecting' && 'Reconectando...'}
          {connectionState === 'disconnected' && 'Desconectado'}
        </div>
        {token && <button className="settings-btn" onClick={() => setShowSettings(true)}>⚙</button>}
      </div>
    </div>
  );

  const AuthForm = () => {
    const [password, setPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');

    if (token) {
      return (
        <div className="auth-panel">
          <div className="auth-row">
            <strong>Session</strong>
            <button onClick={handleLogout}>Cerrar sesion</button>
          </div>
          <div className="auth-row">
            <label>Contrasena actual</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="auth-row">
            <label>Nueva contrasena</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
          <button disabled={busy || !password || newPassword.length < 8} onClick={() => handleChangePassword(password, newPassword)}>
            Cambiar contrasena
          </button>
          {authError && <p className="error">{authError}</p>}
        </div>
      );
    }

    return (
      <div className="auth-panel">
        <div className="auth-row">
          <label>{needsSetup ? 'Define la contrasena inicial' : 'Contrasena'}</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button disabled={busy || password.length < 8} onClick={() => handleAuth(needsSetup ? 'setup' : 'login', password)}>
          {needsSetup ? 'Configurar y entrar' : 'Entrar'}
        </button>
        {authError && <p className="error">{authError}</p>}
      </div>
    );
  };

  return (
    <div className="layout">
      <Controls />
      {!token && (
        <div className="modal-overlay">
          <div className="modal">
            <AuthForm />
          </div>
        </div>
      )}
      {showSettings && token && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Configuracion</h3>
              <button className="close-btn" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <AuthForm />
          </div>
        </div>
      )}
      <div className="content">
        <Sidebar />
        <div className="terminal-container" ref={terminalContainerRef}>
          {sessions.length === 0 && token && (
            <div className="empty-state">
              <h2>No hay sesiones activas</h2>
              <p>Crea una nueva sesión desde el selector superior o el sidebar</p>
              {workers.length === 0 && <p className="muted">No hay workers conectados en este momento.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;

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
}

const NEXUS_URL = import.meta.env.VITE_NEXUS_URL || 'http://localhost:3002';
const AUTH_KEY = 'ut-token';

function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const selectedWorkerRef = useRef<string | null>(null);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    selectedWorkerRef.current = selectedWorkerId;
  }, [selectedWorkerId]);

  useEffect(() => {
    const saved = localStorage.getItem(AUTH_KEY);
    if (saved) setToken(saved);
    fetch(`${NEXUS_URL}/api/auth/status`)
      .then((res) => res.json())
      .then((data) => setNeedsSetup(Boolean(data.needsSetup)))
      .catch(() => setNeedsSetup(true));
  }, []);

  useEffect(() => {
    if (!token) return;
    const newSocket = io(NEXUS_URL, { auth: { token, type: 'client' } });
    setSocket(newSocket);

    newSocket.on('connect', () => {
      newSocket.emit('register', { type: 'client' });
    });

    newSocket.on('worker-list', (list: Worker[]) => {
      setWorkers(list);
      if (!selectedWorkerRef.current && list.length > 0) {
        setSelectedWorkerId(list[0].id);
      }
    });

    newSocket.on('output', (data: { workerId: string; data: string }) => {
      if (selectedWorkerRef.current && data.workerId === selectedWorkerRef.current) {
        xtermRef.current?.write(data.data);
      }
    });

    newSocket.on('connect_error', (err) => {
      setAuthError(err.message);
    });

    return () => {
      newSocket.disconnect();
    };
  }, [token]);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"MesloLGS NF", "Fira Code", "JetBrains Mono", "Roboto Mono", "Monaco", "Courier New", monospace',
      fontSize: 14,
      allowTransparency: true,
      theme: {
        background: '#0d0d0d',
        foreground: '#e7e7e7',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const handleResize = () => {
      fitAddon.fit();
      if (socketRef.current && selectedWorkerRef.current) {
        socketRef.current.emit('resize', {
          workerId: selectedWorkerRef.current,
          cols: term.cols,
          rows: term.rows,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    term.onData((data) => {
      if (socketRef.current && selectedWorkerRef.current) {
        socketRef.current.emit('execute', {
          workerId: selectedWorkerRef.current,
          command: data,
        });
      }
    });

    return () => {
      term.dispose();
      window.removeEventListener('resize', handleResize);
    };
  }, []);

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
    setToken(null);
    setWorkers([]);
    setSelectedWorkerId(null);
    socket?.disconnect();
    setSocket(null);
  };

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

  const Controls = () => (
    <div className="topbar">
      <div className="brand">Ultimate Terminal</div>
      <div className="control-group">
        <label>Worker</label>
        <select value={selectedWorkerId || ''} onChange={(e) => setSelectedWorkerId(e.target.value)} disabled={!workers.length}>
          <option value="" disabled>
            Selecciona un worker
          </option>
          {workers.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      <div className={`status ${socket?.connected ? 'ok' : 'bad'}`}>{socket?.connected ? 'Conectado' : 'Desconectado'}</div>
    </div>
  );

  return (
    <div className="layout">
      <Controls />
      <div className="content">
        <div className="sidebar">
          <AuthForm />
        </div>
        <div className="terminal-wrapper" ref={terminalRef} />
      </div>
    </div>
  );
}

export default App;
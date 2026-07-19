import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { store, persistor } from './store';
import { useAppDispatch, useAppSelector } from './store/hooks';
import {
  setConnectionState,
  setWorkers,
  addWorker,
  setAgents,
  setTenants,
  setCurrentUser,
  logoutAndReset,
  setNeedsSetup,
  setIsFullscreen,
  setShowDropOverlay,
  setDraggingSessionId,
  setActiveSession,
  removeSession,
  updateSession,
  removeWorker,
  addSession,
  setOfflineSessionIds,
  updateSessionOutput,
  setSessionOutput,
  setServerSessions,
  openDialog,
  closeDialog,
  setShowChangePasswordModal,
  setShowSubscriptionModal,
  toggleMobileSidebar,
} from './store';
import type { Worker } from './store/slices/workersSlice';
import type { StoredSession, ServerSession } from './store/slices/sessionsSlice';

import { TopBar } from './components/Layout/TopBar';
import { Sidebar } from './components/Layout/Sidebar/Sidebar';
import { TerminalGrid } from './components/Terminal/TerminalGrid';
import { MobileKeyBar } from './components/Terminal/MobileKeyBar';
import { LoginPage } from './components/Auth/LoginPage';
import { DialogModal } from './components/Dialogs/DialogModal';
import { RenameSessionModal } from './components/RenameSessionModal';
import { ShareModal } from './components/ShareModal';
import { InstallWorkerModal } from './components/InstallWorkerModal';
import { ChangePasswordModal } from './components/ChangePasswordModal';
import { SubscriptionModal } from './components/SubscriptionModal';
import { PaymentReturn } from './components/PaymentReturn';
import { Toast } from './components/Layout/Toast';
import { JoinWorkerModal } from './components/JoinWorkerModal';

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { io, Socket } from 'socket.io-client';
import '@xterm/xterm/css/xterm.css';
import './App.css';

const NEXUS_URL = import.meta.env.VITE_NEXUS_URL ||
  (import.meta.env.PROD ? window.location.origin : 'http://localhost:3002');
const MAX_OUTPUT_CHARS = 20000;
const SESSION_OUTPUT_KEY = 'ut-session-output-v1';
const OUTPUT_FLUSH_MS = 80;
const OUTPUT_PERSIST_MS = 800;
const TERMINAL_WRITE_FLUSH_MS = 16;
const INPUT_FLUSH_MS = 8;

export interface TerminalInstance {
  id: string;
  workerId: string;
  workerKey: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  containerRef: HTMLDivElement;
  resizeHandler: () => void;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function AppContent() {
  const dispatch = useAppDispatch();
  const token = useAppSelector((state) => state.auth.token);
  const sessions = useAppSelector((state) => state.sessions.sessions);
  const activeSessionId = useAppSelector((state) => state.sessions.activeSessionId);
  const sessionOutput = useAppSelector((state) => state.sessions.sessionOutput);
  const workers = useAppSelector((state) => state.workers.workers);
  const serverSessions = useAppSelector((state) => state.sessions.serverSessions);
  const connectionState = useAppSelector((state) => state.connection.connectionState);
  const renamingSessionId = useAppSelector((state) => state.ui.renamingSessionId);
  const shareModalWorker = useAppSelector((state) => state.ui.shareModalWorker);
  const showWorkerModal = useAppSelector((state) => state.ui.showWorkerModal);
  const editingWorker = useAppSelector((state) => state.ui.editingWorker);
  const showChangePasswordModal = useAppSelector((state) => state.ui.showChangePasswordModal);
  const showSubscriptionModal = useAppSelector((state) => state.ui.showSubscriptionModal);

  const [notification, setNotification] = useState<{ title: string; message: string } | null>(null);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [paymentReturnStatus, setPaymentReturnStatus] = useState<'success' | 'failure' | 'pending' | null>(() => {
    const path = window.location.pathname;
    if (path === '/payment/success') return 'success';
    if (path === '/payment/failure') return 'failure';
    if (path === '/payment/pending') return 'pending';
    return null;
  });

  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [instancesVersion, setInstancesVersion] = useState(0);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 1100);

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const terminalInstancesRef = useRef<Map<string, TerminalInstance>>(new Map());
  const pendingSessionIdsRef = useRef<Set<string>>(new Set());
  const joinedSessionIdsRef = useRef<Set<string>>(new Set());
  const closedSessionIdsRef = useRef<Set<string>>(new Set());
  const sessionOutputRef = useRef<Record<string, string>>({});
  const sessionsRef = useRef<StoredSession[]>([]);
  const outputBufferRef = useRef<Record<string, string>>({});
  const outputFlushTimerRef = useRef<number | null>(null);
  const outputPersistTimerRef = useRef<number | null>(null);
  const terminalWriteBufferRef = useRef<Record<string, string>>({});
  const terminalWriteTimerRef = useRef<number | null>(null);
  const inputBufferRef = useRef<Record<string, { workerId: string; data: string }>>({});
  const inputFlushTimerRef = useRef<number | null>(null);

  const normalizeWorkerKey = useCallback((name: string) => name.trim().toLowerCase(), []);
  const getAdaptiveFontSize = useCallback(() => (window.innerWidth <= 960 ? 13 : 14), []);
  const bumpInstancesVersion = useCallback(() => {
    setInstancesVersion((value) => value + 1);
  }, []);

  // Track mobile state
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 1100);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Mobile key bar: send key to active terminal session via socket
  const handleMobileKey = useCallback((data: string) => {
    if (!activeSessionId || !socketRef.current) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session) return;
    socketRef.current.emit('execute', {
      workerId: session.workerId,
      sessionId: session.id,
      command: data,
    });
  }, [activeSessionId, sessions]);

  useEffect(() => {
    sessionOutputRef.current = sessionOutput;
  }, [sessionOutput]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (outputPersistTimerRef.current) {
      window.clearTimeout(outputPersistTimerRef.current);
    }
    outputPersistTimerRef.current = window.setTimeout(() => {
      try {
        localStorage.setItem(SESSION_OUTPUT_KEY, JSON.stringify(sessionOutput));
      } catch {
        // ignore storage errors
      }
      outputPersistTimerRef.current = null;
    }, OUTPUT_PERSIST_MS);
    return () => {
      if (outputPersistTimerRef.current) {
        window.clearTimeout(outputPersistTimerRef.current);
        outputPersistTimerRef.current = null;
      }
    };
  }, [sessionOutput]);

  const flushOutputBuffer = useCallback(() => {
    const pending = outputBufferRef.current;
    outputBufferRef.current = {};
    const entries = Object.entries(pending);
    if (entries.length === 0) return;
    entries.forEach(([sessionId, chunk]) => {
      dispatch(updateSessionOutput({ sessionId, output: chunk }));
    });
  }, [dispatch]);

  const flushTerminalWriteBuffer = useCallback(() => {
    const pending = terminalWriteBufferRef.current;
    terminalWriteBufferRef.current = {};
    const entries = Object.entries(pending);
    if (entries.length === 0) return;
    entries.forEach(([sessionId, chunk]) => {
      const instance = terminalInstancesRef.current.get(sessionId);
      if (instance) {
        instance.terminal.write(chunk);
      }
    });
  }, []);

  const queueOutput = useCallback((sessionId: string, chunk: string) => {
    if (!chunk) return;
    outputBufferRef.current[sessionId] = (outputBufferRef.current[sessionId] || '') + chunk;
    if (outputFlushTimerRef.current !== null) return;
    outputFlushTimerRef.current = window.setTimeout(() => {
      outputFlushTimerRef.current = null;
      flushOutputBuffer();
    }, OUTPUT_FLUSH_MS);
  }, [flushOutputBuffer]);

  const queueTerminalWrite = useCallback((sessionId: string, chunk: string) => {
    if (!chunk) return;
    terminalWriteBufferRef.current[sessionId] = (terminalWriteBufferRef.current[sessionId] || '') + chunk;
    if (terminalWriteTimerRef.current !== null) return;
    terminalWriteTimerRef.current = window.setTimeout(() => {
      terminalWriteTimerRef.current = null;
      flushTerminalWriteBuffer();
    }, TERMINAL_WRITE_FLUSH_MS);
  }, [flushTerminalWriteBuffer]);

  const flushInputBuffer = useCallback(() => {
    const pending = inputBufferRef.current;
    inputBufferRef.current = {};
    const socket = socketRef.current;
    if (!socket) return;
    Object.entries(pending).forEach(([sessionId, { workerId, data }]) => {
      if (!data) return;
      socket.emit('execute', { workerId, sessionId, command: data });
    });
  }, []);

  const queueInput = useCallback((sessionId: string, workerId: string, chunk: string) => {
    if (!chunk) return;
    const existing = inputBufferRef.current[sessionId];
    inputBufferRef.current[sessionId] = {
      workerId,
      data: (existing?.data || '') + chunk,
    };
    if (inputFlushTimerRef.current !== null) return;
    inputFlushTimerRef.current = window.setTimeout(() => {
      inputFlushTimerRef.current = null;
      flushInputBuffer();
    }, INPUT_FLUSH_MS);
  }, [flushInputBuffer]);

  useEffect(() => {
    if (token) return;
    terminalInstancesRef.current.forEach((instance) => {
      window.removeEventListener('resize', instance.resizeHandler);
      instance.terminal.dispose();
      instance.containerRef.remove();
    });
    terminalInstancesRef.current.clear();
    pendingSessionIdsRef.current.clear();
    joinedSessionIdsRef.current.clear();
    closedSessionIdsRef.current.clear();
    outputBufferRef.current = {};
    terminalWriteBufferRef.current = {};
    inputBufferRef.current = {};
    if (outputFlushTimerRef.current !== null) {
      window.clearTimeout(outputFlushTimerRef.current);
      outputFlushTimerRef.current = null;
    }
    if (terminalWriteTimerRef.current !== null) {
      window.clearTimeout(terminalWriteTimerRef.current);
      terminalWriteTimerRef.current = null;
    }
    if (inputFlushTimerRef.current !== null) {
      window.clearTimeout(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
    }
  }, [token]);

  const createNewSession = useCallback((
    worker: Worker,
    options?: {
      sessionId?: string;
      displayName?: string;
      createdAt?: number;
      lastActiveAt?: number;
      initialOutput?: string;
      focus?: boolean;
    }
  ) => {
    const workerKey = normalizeWorkerKey(worker.name);
    const creationLockKey = `creating_${workerKey}`;

    if (options?.sessionId) {
      if (terminalInstancesRef.current.has(options.sessionId) || pendingSessionIdsRef.current.has(options.sessionId)) {
        return null;
      }
    }

    if (!options?.sessionId) {
      if (pendingSessionIdsRef.current.has(creationLockKey)) return null;
      pendingSessionIdsRef.current.add(creationLockKey);
      setTimeout(() => pendingSessionIdsRef.current.delete(creationLockKey), 1000);
    }

    if (!terminalContainerRef.current) return null;

    if (options?.sessionId) {
      pendingSessionIdsRef.current.add(options.sessionId);
    }

    const sessionId = options?.sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const displayName = options?.displayName || worker.name;
    const createdAt = options?.createdAt || Date.now();
    const lastActiveAt = options?.lastActiveAt || Date.now();

    const container = document.createElement('div');
    container.className = 'terminal-wrapper';
    container.style.display = 'none';
    container.dataset.sessionId = sessionId;
    terminalContainerRef.current.appendChild(container);

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"MesloLGS NF", "Fira Code", "JetBrains Mono", "Roboto Mono", "Monaco", monospace',
      fontSize: getAdaptiveFontSize(),
      cols: 80,
      rows: 24,
      allowTransparency: true,
      scrollback: 5000,
      theme: { background: '#0d0d0d', foreground: '#e7e7e7' },
    });

    const fitAddon = new FitAddon();
    const clipboardAddon = new ClipboardAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(clipboardAddon);
    term.open(container);
    fitAddon.fit();

    container.addEventListener('mousedown', () => {
      dispatch(setActiveSession(sessionId));
      setTimeout(() => term.focus(), 0);
    });

    // Touch scroll for mobile: convert vertical drags into terminal scroll.
    // xterm's screen captures touch events and prevents the viewport's
    // native overflow scroll, so we translate touchmove deltas manually.
    let touchY: number | null = null;
    let touchAccum = 0;
    let touchActiveTouchId: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        touchY = null;
        touchActiveTouchId = null;
        return;
      }
      const t = e.touches[0];
      touchActiveTouchId = t.identifier;
      touchY = t.clientY;
      touchAccum = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === null || touchActiveTouchId === null) return;
      const t = Array.from(e.touches).find((x) => x.identifier === touchActiveTouchId);
      if (!t) return;
      const dy = touchY - t.clientY;
      touchY = t.clientY;
      const lineHeight = Math.max(12, Math.round((term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })._core?._renderService?.dimensions?.css?.cell?.height ?? 18));
      touchAccum += dy;
      if (Math.abs(touchAccum) >= lineHeight) {
        const lines = Math.trunc(touchAccum / lineHeight);
        touchAccum -= lines * lineHeight;
        term.scrollLines(lines);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      const stillActive = Array.from(e.touches).some((x) => x.identifier === touchActiveTouchId);
      if (!stillActive) {
        touchY = null;
        touchActiveTouchId = null;
        touchAccum = 0;
      }
    };
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });

    term.onData((data) => {
      queueInput(sessionId, worker.id, data);
    });

    const handleResize = () => {
      const isVisible = container.offsetParent !== null && container.clientWidth > 0 && container.clientHeight > 0;
      if (!isVisible) return;
      term.options.fontSize = getAdaptiveFontSize();
      fitAddon.fit();
      if (socketRef.current && term.cols > 0 && term.rows > 0) {
        socketRef.current.emit('resize', { workerId: worker.id, sessionId, cols: term.cols, rows: term.rows });
      }
    };

    window.addEventListener('resize', handleResize);

    const instance: TerminalInstance = {
      id: sessionId,
      workerId: worker.id,
      workerKey,
      terminal: term,
      fitAddon,
      containerRef: container,
      resizeHandler: handleResize,
    };

    if (options?.initialOutput) {
      const output = options.initialOutput.slice(-MAX_OUTPUT_CHARS);
      term.write(output);
      dispatch(setSessionOutput({ sessionId, output }));
    }

    terminalInstancesRef.current.set(sessionId, instance);
    if (options?.sessionId) {
      pendingSessionIdsRef.current.delete(options.sessionId);
    }
    bumpInstancesVersion();

    const storedSession: StoredSession = {
      id: sessionId,
      workerId: worker.id,
      workerName: worker.name,
      workerKey,
      displayName,
      createdAt,
      lastActiveAt,
    };
    dispatch(addSession(storedSession));

    if (options?.focus !== false) {
      dispatch(setActiveSession(sessionId));
    }

    socketRef.current?.emit('subscribe', { workerId: worker.id });
    if (!options?.sessionId && socketRef.current) {
      socketRef.current.emit('create-session', { id: sessionId, workerName: worker.name, workerKey, displayName });
      pendingSessionIdsRef.current.add(sessionId);
      setTimeout(() => pendingSessionIdsRef.current.delete(sessionId), 10000);
    }

    setTimeout(() => handleResize(), 100);
    return instance;
  }, [dispatch, normalizeWorkerKey, getAdaptiveFontSize, bumpInstancesVersion, queueInput]);

  // Close session
  const handleCloseSession = useCallback((sessionId: string) => {
    // Mark as recently closed to prevent auto-join race condition
    closedSessionIdsRef.current.add(sessionId);
    setTimeout(() => closedSessionIdsRef.current.delete(sessionId), 15000);

    const instance = terminalInstancesRef.current.get(sessionId);
    const workerId = instance?.workerId ?? sessions.find((session) => session.id === sessionId)?.workerId;
    if (instance) {
      window.removeEventListener('resize', instance.resizeHandler);
      instance.terminal.dispose();
      instance.containerRef.remove();
      terminalInstancesRef.current.delete(sessionId);
      bumpInstancesVersion();
    }
    pendingSessionIdsRef.current.delete(sessionId);
    joinedSessionIdsRef.current.delete(sessionId);
    delete outputBufferRef.current[sessionId];
    delete terminalWriteBufferRef.current[sessionId];
    delete inputBufferRef.current[sessionId];
    if (workerId) socketRef.current?.emit('close-session', { workerId, sessionId });
    dispatch(removeSession(sessionId));
  }, [dispatch, bumpInstancesVersion, sessions]);

  // Select worker and create/focus session
  const handleSelectWorker = useCallback((workerId: string) => {
    const worker = workers.find((w) => w.id === workerId);
    if (!worker) return;

    const workerKey = normalizeWorkerKey(worker.name);
    // Check if we already have a local session for this worker
    const existing = sessions.find((s) => s.workerKey === workerKey);
    if (existing) {
      dispatch(setActiveSession(existing.id));
      return;
    }

    // Check if there's an active session from another user on this shared worker
    const remoteSession = serverSessions.find(
      (s) => s.workerId === workerId || s.workerKey === workerKey || s.workerName === worker.name
    );
    if (remoteSession) {
      // Join the existing session instead of creating a new one (collaborative view)
      createNewSession(worker, {
        sessionId: remoteSession.id,
        displayName: remoteSession.displayName,
        createdAt: remoteSession.createdAt,
        lastActiveAt: remoteSession.lastActiveAt,
      });
      return;
    }

    createNewSession(worker);
  }, [workers, sessions, serverSessions, dispatch, normalizeWorkerKey, createNewSession]);

  // Create new session on worker
  const handleNewSession = useCallback((workerId: string) => {
    const worker = workers.find((w) => w.id === workerId);
    if (worker) {
      createNewSession(worker);
    }
  }, [workers, createNewSession]);

  const refreshWorkers = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${NEXUS_URL}/api/workers`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) return;
      const list = await res.json();
      dispatch(setWorkers(list));
    } catch {
      // ignore refresh errors
    }
  }, [token, dispatch]);

  // Registry de la flota (DB-backed): agentes + tenants, tenant-scoped por el server.
  const refreshAgents = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${NEXUS_URL}/api/agents`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) return;
      const list = await res.json();
      dispatch(setAgents(Array.isArray(list) ? list : []));
    } catch {
      // ignore refresh errors
    }
  }, [token, dispatch]);

  const refreshTenants = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${NEXUS_URL}/api/tenants`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) return;
      const list = await res.json();
      dispatch(setTenants(Array.isArray(list) ? list : []));
    } catch {
      // ignore refresh errors
    }
  }, [token, dispatch]);

  // Delete worker
  const handleDeleteWorker = useCallback(async (worker: Worker) => {
    if (!token) return;
    try {
      const res = await fetch(`${NEXUS_URL}/api/workers/${worker.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const sessionsToClose = sessions.filter((session) => session.workerId === worker.id);
        sessionsToClose.forEach((session) => handleCloseSession(session.id));
        dispatch(removeWorker(worker.id));
        refreshWorkers();
        socketRef.current?.emit('register', { type: 'client' });
        dispatch(closeDialog());
      } else {
        const err = await res.json();
        dispatch(openDialog({
          title: 'Error',
          message: err.error || 'Error desconocido',
          tone: 'danger',
        }));
      }
    } catch {
      dispatch(openDialog({
        title: 'Error de red',
        message: 'No se pudo eliminar el worker',
        tone: 'danger',
      }));
    }
  }, [token, dispatch, sessions, handleCloseSession, refreshWorkers]);

  // Resume session
  const handleResume = useCallback(() => {
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session || !socketRef.current) return;

    const instance = terminalInstancesRef.current.get(session.id);
    if (instance) {
      instance.fitAddon.fit();
      socketRef.current.emit('resize', {
        workerId: session.workerId,
        sessionId: session.id,
        cols: instance.terminal.cols,
        rows: instance.terminal.rows,
      });
    }
    socketRef.current.emit('execute', { workerId: session.workerId, sessionId: session.id, command: '\n' });
  }, [sessions, activeSessionId]);

  // Fullscreen
  const handleFullscreen = useCallback(async () => {
    const target = terminalContainerRef.current || document.documentElement;
    try {
      if (!document.fullscreenElement) {
        await target.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch (err) {
      console.error('Fullscreen error:', err);
    }
  }, []);

  // PWA Install
  const handleInstallPWA = useCallback(async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setInstallPrompt(null);
      }
    } catch (err) {
      console.error('PWA install error:', err);
    }
  }, [installPrompt]);

  // Drag handlers
  const handleDragStart = useCallback((sessionId: string, _displayName: string, event: DragEvent<HTMLDivElement>) => {
    dispatch(setDraggingSessionId(sessionId));
    dispatch(setShowDropOverlay(true));
    event.dataTransfer.effectAllowed = 'move';
  }, [dispatch]);

  const handleDragEnd = useCallback(() => {
    dispatch(setDraggingSessionId(null));
    dispatch(setShowDropOverlay(false));
  }, [dispatch]);

  // Rename session
  const handleRenameSave = useCallback((newName: string) => {
    if (renamingSessionId && newName.trim()) {
      const workerId = sessions.find((session) => session.id === renamingSessionId)?.workerId;
      dispatch(updateSession({ id: renamingSessionId, displayName: newName.trim() }));
      if (workerId) {
        socketRef.current?.emit('rename-session', {
          workerId,
          sessionId: renamingSessionId,
          newName: newName.trim(),
        });
      }
    }
  }, [renamingSessionId, dispatch, sessions]);

  // Initialize socket
  useEffect(() => {
    if (!token) {
      dispatch(setNeedsSetup(true));
      return;
    }

    fetch(`${NEXUS_URL}/api/auth/me`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(res => { if (!res.ok) throw new Error('Invalid token'); return res.json(); })
      .then((data) => {
        if (data.user) dispatch(setCurrentUser(data.user));

        // Cargar el registry DB-backed (agentes + tenants), tenant-scoped en el server.
        refreshAgents();
        refreshTenants();

        const socket = io(NEXUS_URL, {
          auth: { token, type: 'client' },
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
        });

        socketRef.current = socket;
        dispatch(setConnectionState('connecting'));

        socket.on('connect', () => dispatch(setConnectionState('connected')));
        socket.on('reconnect', () => dispatch(setConnectionState('connected')));
        socket.on('disconnect', () => dispatch(setConnectionState('disconnected')));
        socket.on('workers', (list: Worker[]) => dispatch(setWorkers(list)));

        socket.on('session-list', (serverSessions: ServerSession[]) => {
          dispatch(setServerSessions(serverSessions || []));
        });

        socket.on('output', (data: { workerId: string; sessionId?: string; data: string }) => {
          if (data.sessionId) {
            const instance = terminalInstancesRef.current.get(data.sessionId);
            if (instance?.workerId === data.workerId) {
              queueTerminalWrite(data.sessionId, data.data);
            }
            if (sessionsRef.current.some((s) => s.id === data.sessionId && s.workerId === data.workerId)) {
              queueOutput(data.sessionId, data.data);
            }
            return;
          }

          const targetSessions = sessionsRef.current.filter((s) => s.workerId === data.workerId);
          targetSessions.forEach((session) => {
            const instance = terminalInstancesRef.current.get(session.id);
            if (instance) {
              queueTerminalWrite(session.id, data.data);
            }
            queueOutput(session.id, data.data);
          });
        });

        socket.on('connect_error', (err) => {
          const message = err?.message || 'Connection error';
          const isAuthIssue = [
            'invalid token',
            'missing token',
            'jwt expired',
            'invalid signature',
            'jwt malformed',
            'unauthorized',
            'authentication error',
          ].some(
            (needle) => message.toLowerCase().includes(needle)
          );
          if (isAuthIssue) {
            dispatch(logoutAndReset('Sesión expirada o inválida. Inicia sesión de nuevo.'));
          } else {
            dispatch(setConnectionState('reconnecting'));
          }
        });

        socket.on('worker-shared', (data: { workerId: string; name: string; owner: string }) => {
          setNotification({
            title: 'Worker compartido',
            message: `${data.owner} compartió "${data.name}" contigo. Se ha añadido a tu lista.`
          });
        });

        socket.on('plan-limit', (data: { code: string; message: string; current: number; max: number }) => {
          setNotification({
            title: 'Límite de plan',
            message: data.message,
          });
        });

        socket.on('session-closed', (data: { sessionId: string; workerId: string }) => {
          // A session was closed (possibly from another device)
          const currentSession = sessionsRef.current.find((session) => session.id === data.sessionId);
          if (!currentSession || currentSession.workerId !== data.workerId) return;
          closedSessionIdsRef.current.add(data.sessionId);
          setTimeout(() => closedSessionIdsRef.current.delete(data.sessionId), 15000);

          const instance = terminalInstancesRef.current.get(data.sessionId);
          if (instance) {
            window.removeEventListener('resize', instance.resizeHandler);
            instance.terminal.dispose();
            instance.containerRef.remove();
            terminalInstancesRef.current.delete(data.sessionId);
            bumpInstancesVersion();
          }
          pendingSessionIdsRef.current.delete(data.sessionId);
          joinedSessionIdsRef.current.delete(data.sessionId);
          delete outputBufferRef.current[data.sessionId];
          delete terminalWriteBufferRef.current[data.sessionId];
          delete inputBufferRef.current[data.sessionId];
          dispatch(removeSession(data.sessionId));
        });
      })
      .catch(() => {
        dispatch(logoutAndReset());
        dispatch(setNeedsSetup(true));
      });

    return () => { socketRef.current?.disconnect(); };
  }, [token, dispatch, queueOutput, queueTerminalWrite, refreshAgents, refreshTenants, bumpInstancesVersion]);

  useEffect(() => {
    if (!token) {
      joinedSessionIdsRef.current.clear();
      closedSessionIdsRef.current.clear();
    }
  }, [token]);

  useEffect(() => {
    if (connectionState === 'connected') {
      joinedSessionIdsRef.current.clear();
    }
  }, [connectionState]);

  useEffect(() => {
    if (!token) return;
    if (connectionState !== 'connected') return;
    if (!terminalContainerRef.current) return;
    const socket = socketRef.current;
    if (!socket) return;

    sessions.forEach((session) => {
      const worker = workers.find((w) =>
        w.id === session.workerId || normalizeWorkerKey(w.name) === session.workerKey
      );
      if (!worker) return;

      if (!terminalInstancesRef.current.has(session.id)) {
        const cachedOutput = sessionOutputRef.current[session.id] || '';
        const instance = createNewSession(worker, {
          sessionId: session.id,
          displayName: session.displayName,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          initialOutput: cachedOutput || undefined,
          focus: false,
        });
        if (!instance) return;
      }

      if (joinedSessionIdsRef.current.has(session.id)) return;

      socket.emit('join-session', {
        sessionId: session.id,
        workerId: session.workerId,
        displayName: session.displayName,
      });
      socket.emit('subscribe', { workerId: session.workerId });
      joinedSessionIdsRef.current.add(session.id);

      const cachedOutput = sessionOutputRef.current[session.id] || '';
      socket.emit('get-session-output', { workerId: session.workerId, sessionId: session.id }, (output: string) => {
        if (!output) return;
        if (output === cachedOutput) return;
        const instance = terminalInstancesRef.current.get(session.id);
        if (!instance) return;
        instance.terminal.reset();
        instance.terminal.write(output);
        dispatch(setSessionOutput({ sessionId: session.id, output }));
      });
    });
  }, [token, connectionState, sessions, workers, createNewSession, dispatch, normalizeWorkerKey]);

  // PWA install prompt
  useEffect(() => {
    const handler = (event: Event) => {
      const promptEvent = event as BeforeInstallPromptEvent;
      promptEvent.preventDefault();
      setInstallPrompt(promptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler as EventListener);
    return () => window.removeEventListener('beforeinstallprompt', handler as EventListener);
  }, []);

  // Payment return URL detection
  useEffect(() => {
    const path = window.location.pathname;
    if (path === '/payment/success' || path === '/payment/failure' || path === '/payment/pending') {
      window.history.replaceState({}, '', '/');
    }
  }, []);

  // Fullscreen change
  useEffect(() => {
    const handler = () => dispatch(setIsFullscreen(Boolean(document.fullscreenElement)));
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, [dispatch]);

  // Update offline sessions
  useEffect(() => {
    const offlineIds: string[] = [];
    sessions.forEach((session) => {
      const worker = workers.find(w => w.id === session.workerId || normalizeWorkerKey(w.name) === session.workerKey);
      if (!worker || worker.status === 'offline') {
        offlineIds.push(session.id);
      }
    });
    dispatch(setOfflineSessionIds(offlineIds));
  }, [sessions, workers, dispatch, normalizeWorkerKey]);

  // Cross-device session sync: auto-adopt server sessions belonging to current user
  useEffect(() => {
    if (connectionState !== 'connected') return;
    if (!terminalContainerRef.current) return;
    const socket = socketRef.current;
    if (!socket) return;
    const currentUser = store.getState().auth.currentUser;
    if (!currentUser) return;

    const localIds = new Set(sessions.map(s => s.id));
    const serverIds = new Set(serverSessions.map(s => s.id));

    // Auto-join: server sessions created by current user that aren't local yet
    serverSessions.forEach((serverSession) => {
      if (serverSession.creatorUserId !== currentUser.userId) return;
      if (localIds.has(serverSession.id)) return;
      if (pendingSessionIdsRef.current.has(serverSession.id)) return;
      if (closedSessionIdsRef.current.has(serverSession.id)) return;

      const worker = workers.find(w => w.id === serverSession.workerId);
      if (!worker || worker.status === 'offline') return;

      createNewSession(worker, {
        sessionId: serverSession.id,
        displayName: serverSession.displayName,
        createdAt: serverSession.createdAt,
        lastActiveAt: serverSession.lastActiveAt,
        focus: false,
      });
    });

    // Auto-remove: local sessions that no longer exist on server (closed from other device)
    sessions.forEach((session) => {
      if (serverIds.has(session.id)) return;
      // Only trust server list for online workers
      const worker = workers.find(w => w.id === session.workerId || normalizeWorkerKey(w.name) === session.workerKey);
      if (!worker || worker.status === 'offline') return;

      // Clean up locally without emitting close-session to server
      const instance = terminalInstancesRef.current.get(session.id);
      if (instance) {
        window.removeEventListener('resize', instance.resizeHandler);
        instance.terminal.dispose();
        instance.containerRef.remove();
        terminalInstancesRef.current.delete(session.id);
        bumpInstancesVersion();
      }
      pendingSessionIdsRef.current.delete(session.id);
      joinedSessionIdsRef.current.delete(session.id);
      dispatch(removeSession(session.id));
    });
  }, [serverSessions, sessions, workers, connectionState, createNewSession, dispatch, normalizeWorkerKey, bumpInstancesVersion]);

  // Terminal visibility is now handled by TerminalGrid's reparenting logic
  useEffect(() => {
    terminalInstancesRef.current.forEach(i => i.fitAddon.fit());
  }, [sessions.length, activeSessionId]);

  if (!token) {
    return <LoginPage />;
  }

  return (
    <div className="layout">
      <TopBar
        onResume={handleResume}
        onFullscreen={handleFullscreen}
        onInstallPWA={handleInstallPWA}
        installPromptAvailable={!!installPrompt}
        onCloseSession={handleCloseSession}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      />

      <DialogModal onAction={(actionId) => {
        if (actionId.startsWith('delete-worker-')) {
          const workerId = actionId.replace('delete-worker-', '');
          const worker = workers.find(w => w.id === workerId);
          if (worker) handleDeleteWorker(worker);
        }
      }} />

      {shareModalWorker && (
        <ShareModal
          worker={shareModalWorker}
          onClose={() => dispatch({ type: 'ui/setShareModalWorker', payload: null })}
          nexusUrl={NEXUS_URL}
          token={token}
        />
      )}

      <div className="content">
        <Sidebar
          onSelectWorker={handleSelectWorker}
          onNewSession={handleNewSession}
          onJoinWorker={() => setShowJoinModal(true)}
        />
        <TerminalGrid
          instancesRef={terminalInstancesRef}
          containerRef={terminalContainerRef}
          instancesVersion={instancesVersion}
        />

        {/* Mobile FAB to open workers drawer */}
        <button
          className="mobile-sidebar-fab"
          onClick={() => dispatch(toggleMobileSidebar())}
          title="Workers"
          type="button"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>
          {workers.filter(w => w.status === 'online').length > 0 && (
            <span className="fab-badge">{workers.filter(w => w.status === 'online').length}</span>
          )}
        </button>
      </div>

      {renamingSessionId && (
        <RenameSessionModal
          isOpen={!!renamingSessionId}
          initialName={sessions.find(s => s.id === renamingSessionId)?.displayName || ''}
          onClose={() => dispatch({ type: 'ui/setRenamingSessionId', payload: null })}
          onSave={handleRenameSave}
        />
      )}

      {showWorkerModal && (
        <InstallWorkerModal
          initialWorker={editingWorker}
          onClose={() => dispatch({ type: 'ui/setShowWorkerModal', payload: false })}
          onWorkerCreated={(worker) => {
            dispatch(addWorker(worker));
            refreshWorkers();
          }}
          nexusUrl={NEXUS_URL}
          token={token}
        />
      )}

      <JoinWorkerModal
        isOpen={showJoinModal}
        onClose={() => setShowJoinModal(false)}
        nexusUrl={NEXUS_URL}
        token={token}
        onJoined={refreshWorkers}
      />

      {showChangePasswordModal && token && (
        <ChangePasswordModal
          onClose={() => dispatch(setShowChangePasswordModal(false))}
          onSuccess={() => { }}
          nexusUrl={NEXUS_URL}
          token={token}
        />
      )}

      {showSubscriptionModal && token && (
        <SubscriptionModal
          onClose={() => dispatch(setShowSubscriptionModal(false))}
          nexusUrl={NEXUS_URL}
          token={token}
        />
      )}

      {paymentReturnStatus && (
        <PaymentReturn
          status={paymentReturnStatus}
          onBack={() => setPaymentReturnStatus(null)}
        />
      )}

      {notification && (
        <Toast
          title={notification.title}
          message={notification.message}
          onClose={() => setNotification(null)}
        />
      )}

      {/* Mobile special keys bar */}
      <MobileKeyBar
        onKey={handleMobileKey}
        visible={isMobile && !!activeSessionId && sessions.length > 0}
      />

    </div>
  );
}

function App() {
  return (
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <AppContent />
      </PersistGate>
    </Provider>
  );
}

export default App;

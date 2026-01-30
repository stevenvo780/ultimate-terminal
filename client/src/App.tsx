import { useEffect, useRef, useState, type DragEvent } from 'react';
import { io, Socket } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
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
  workerName: string;
  workerKey: string;
  displayName: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  containerRef: HTMLDivElement;
  resizeHandler: () => void;
  createdAt: number;
  lastActiveAt: number;
}

interface StoredSession {
  id: string;
  workerId?: string;
  workerName: string;
  workerKey: string;
  displayName: string;
  createdAt: number;
  lastActiveAt: number;
}

interface CommandSnippet {
  id: string;
  label: string;
  command: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

// In production (served from nexus), use relative URL. In dev, use env or localhost.
const NEXUS_URL = import.meta.env.VITE_NEXUS_URL || (import.meta.env.PROD ? '' : 'http://localhost:3002');
const AUTH_KEY = 'ut-token';
const LAST_WORKER_KEY = 'ut-last-worker';
const SESSION_STORE_KEY = 'ut-sessions-v1';
const SESSION_OUTPUT_KEY = 'ut-session-output-v1';
const ACTIVE_SESSION_KEY = 'ut-active-session';
const GRID_SLOTS_KEY = 'ut-grid-slots-v1';
const WORKER_TAGS_KEY = 'ut-worker-tags';
const WORKER_GROUPING_KEY = 'ut-worker-grouping';
const COMMAND_HISTORY_KEY = 'ut-command-history';
const COMMAND_SNIPPETS_KEY = 'ut-command-snippets';
const MAX_OUTPUT_CHARS = 20000;
const MAX_HISTORY_ITEMS = 60;
type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

function App() {
  const getAdaptiveFontSize = () => (window.innerWidth <= 960 ? 13 : 14);

  const [socket, setSocket] = useState<Socket | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [layoutMode, setLayoutMode] = useState<'single' | 'split-vertical' | 'quad'>('single');
  const [gridSessionIds, setGridSessionIds] = useState<string[]>([]);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [workerQuery, setWorkerQuery] = useState<string>('');
  const [workerGrouping, setWorkerGrouping] = useState<'none' | 'tag'>('none');
  const [workerTags, setWorkerTags] = useState<Record<string, string[]>>({});
  const [commandTab, setCommandTab] = useState<'history' | 'snippets'>('history');
  const [commandHistory, setCommandHistory] = useState<Record<string, string[]>>({});
  const [commandSnippets, setCommandSnippets] = useState<Record<string, CommandSnippet[]>>({});
  const [tagModalWorker, setTagModalWorker] = useState<Worker | null>(null);
  const [tagModalInput, setTagModalInput] = useState<string>('');
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showDropOverlay, setShowDropOverlay] = useState<boolean>(false);
  
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [offlineSessions, setOfflineSessions] = useState<Set<string>>(new Set());

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const sessionsRef = useRef<TerminalSession[]>([]);
  const activeSessionRef = useRef<string | null>(null);
  const lastWorkerRef = useRef<string | null>(null);
  const workersRef = useRef<Worker[]>([]);
  const storedActiveSessionRef = useRef<string | null>(null);
  const savedSessionsRef = useRef<StoredSession[]>([]);
  const hydratedSessionIdsRef = useRef<Set<string>>(new Set());
  const sessionOutputRef = useRef<Record<string, string>>({});
  const inputBuffersRef = useRef<Record<string, string>>({});
  const escapeInputRef = useRef<Record<string, boolean>>({});
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipPersistRef = useRef<boolean>(true);
  const hadSessionsRef = useRef<boolean>(false);

  const normalizeWorkerKey = (name: string) => name.trim().toLowerCase();

  const parseStored = <T,>(value: string | null, fallback: T): T => {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch (err) {
      console.warn('Failed to parse stored value:', err);
      return fallback;
    }
  };

  const schedulePersistSessions = () => {
    if (skipPersistRef.current) return;
    if (persistTimerRef.current) return;
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistSessions();
    }, 800);
  };

  const persistSessions = () => {
    const snapshot = sessionsRef.current.map((session) => ({
      id: session.id,
      workerId: session.workerId,
      workerName: session.workerName,
      workerKey: session.workerKey,
      displayName: session.displayName,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    }));
    savedSessionsRef.current = snapshot;
    localStorage.setItem(SESSION_STORE_KEY, JSON.stringify(snapshot));
    localStorage.setItem(SESSION_OUTPUT_KEY, JSON.stringify(sessionOutputRef.current));
    if (activeSessionRef.current) {
      localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionRef.current);
    } else {
      localStorage.removeItem(ACTIVE_SESSION_KEY);
    }
  };

  const resolveWorkerForSession = (session: { workerId: string; workerKey: string }, list: Worker[]) => {
    const byId = list.find((worker) => worker.id === session.workerId);
    if (byId) return byId;
    const sameKey = list.filter((worker) => normalizeWorkerKey(worker.name) === session.workerKey);
    if (sameKey.length === 0) return null;
    return sameKey.find((worker) => worker.status !== 'offline') || sameKey[0];
  };

  const rebindSessionsToWorkers = (list: Worker[]) => {
    setSessions((prev) =>
      prev.map((session) => {
        const resolved = resolveWorkerForSession(session, list);
        if (!resolved) return session;
        const nextKey = normalizeWorkerKey(resolved.name);
        if (resolved.id === session.workerId && nextKey === session.workerKey) return session;
        return {
          ...session,
          workerId: resolved.id,
          workerName: resolved.name,
          workerKey: nextKey,
        };
      }),
    );
  };

  const addCommandToHistory = (workerKey: string, command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    setCommandHistory((prev) => {
      const existing = prev[workerKey] || [];
      const next = [trimmed, ...existing.filter((item) => item !== trimmed)].slice(0, MAX_HISTORY_ITEMS);
      return { ...prev, [workerKey]: next };
    });
  };

  const trackInputForHistory = (sessionId: string, workerKey: string, data: string) => {
    let buffer = inputBuffersRef.current[sessionId] || '';
    let inEscape = escapeInputRef.current[sessionId] || false;
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (inEscape) {
        if (code >= 64 && code <= 126) {
          inEscape = false;
        }
        continue;
      }
      if (ch === '\x1b') {
        inEscape = true;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        if (buffer.trim().length > 0) {
          addCommandToHistory(workerKey, buffer);
        }
        buffer = '';
        continue;
      }
      if (ch === '\x7f') {
        buffer = buffer.slice(0, -1);
        continue;
      }
      if (code < 32) {
        continue;
      }
      buffer += ch;
    }
    inputBuffersRef.current[sessionId] = buffer;
    escapeInputRef.current[sessionId] = inEscape;
  };

  const sendCommandToSession = (session: TerminalSession, command: string) => {
    if (!socketRef.current) return;
    const payload = command.endsWith('\n') ? command : `${command}\n`;
    socketRef.current.emit('execute', {
      workerId: session.workerId,
      sessionId: session.id,
      command: payload,
    });
  };

  const sendCommandToActiveSession = (command: string) => {
    const session = sessionsRef.current.find((s) => s.id === activeSessionRef.current);
    if (!session) return;
    if (offlineSessions.has(session.id)) return;
    sendCommandToSession(session, command);
    addCommandToHistory(session.workerKey, command);
  };

  const addSnippet = (workerKey: string, label: string, command: string) => {
    const trimmedLabel = label.trim();
    const trimmedCommand = command.trim();
    if (!trimmedLabel || !trimmedCommand) return;
    const snippet: CommandSnippet = {
      id: `snip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label: trimmedLabel,
      command: trimmedCommand,
    };
    setCommandSnippets((prev) => {
      const existing = prev[workerKey] || [];
      return { ...prev, [workerKey]: [snippet, ...existing] };
    });
  };

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    sessionsRef.current = sessions;
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    schedulePersistSessions();
  }, [sessions]);

  useEffect(() => {
    localStorage.setItem(GRID_SLOTS_KEY, JSON.stringify(gridSessionIds));
  }, [gridSessionIds]);

  useEffect(() => {
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  const prevActiveSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevActiveSessionRef.current && prevActiveSessionRef.current !== activeSessionId && socketRef.current) {
      socketRef.current.emit('leave-session', { sessionId: prevActiveSessionRef.current });
    }
    
    if (activeSessionId) {
      storedActiveSessionRef.current = activeSessionId;
      localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
      const activeSession = sessionsRef.current.find((s) => s.id === activeSessionId);
      if (activeSession) {
        localStorage.setItem(LAST_WORKER_KEY, activeSession.workerKey);
        lastWorkerRef.current = activeSession.workerKey;
        setSessions((prev) =>
          prev.map((session) =>
            session.id === activeSessionId
              ? { ...session, lastActiveAt: Date.now() }
              : session,
          ),
        );
        if (socketRef.current && activeSession.terminal) {
          socketRef.current.emit('join-session', {
            sessionId: activeSessionId,
            cols: activeSession.terminal.cols || 80,
            rows: activeSession.terminal.rows || 24,
          });
        }
      }
    } else {
      storedActiveSessionRef.current = null;
      localStorage.removeItem(ACTIVE_SESSION_KEY);
    }
    
    prevActiveSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (sessions.length > 0) {
      hadSessionsRef.current = true;
      return;
    }
    if (hadSessionsRef.current) {
      localStorage.removeItem(LAST_WORKER_KEY);
      lastWorkerRef.current = null;
      hadSessionsRef.current = false;
    }
  }, [sessions.length]);

  useEffect(() => {
    localStorage.setItem(WORKER_TAGS_KEY, JSON.stringify(workerTags));
  }, [workerTags]);

  useEffect(() => {
    localStorage.setItem(WORKER_GROUPING_KEY, JSON.stringify(workerGrouping));
  }, [workerGrouping]);

  useEffect(() => {
    localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(commandHistory));
  }, [commandHistory]);

  useEffect(() => {
    localStorage.setItem(COMMAND_SNIPPETS_KEY, JSON.stringify(commandSnippets));
  }, [commandSnippets]);

  useEffect(() => {
    const offline = new Set<string>();
    sessions.forEach((session) => {
      const resolved = resolveWorkerForSession(session, workers);
      if (!resolved || resolved.status === 'offline') {
        offline.add(session.id);
      }
    });
    setOfflineSessions(offline);
  }, [sessions, workers]);

  useEffect(() => {
    const saved = localStorage.getItem(AUTH_KEY);
    if (saved) setToken(saved);
    if (!saved) setConnectionState('disconnected');
    const savedWorker = localStorage.getItem(LAST_WORKER_KEY);
    if (savedWorker) lastWorkerRef.current = savedWorker;
    const savedSessions = parseStored<StoredSession[]>(localStorage.getItem(SESSION_STORE_KEY), []);
    savedSessionsRef.current = savedSessions;
    const savedGrid = parseStored<string[]>(localStorage.getItem(GRID_SLOTS_KEY), []);
    setGridSessionIds(savedGrid.slice(0, 4));
    storedActiveSessionRef.current = localStorage.getItem(ACTIVE_SESSION_KEY);
    sessionOutputRef.current = parseStored<Record<string, string>>(
      localStorage.getItem(SESSION_OUTPUT_KEY),
      {},
    );
    setWorkerTags(parseStored<Record<string, string[]>>(localStorage.getItem(WORKER_TAGS_KEY), {}));
    const savedGrouping = parseStored<string>(localStorage.getItem(WORKER_GROUPING_KEY), 'none');
    setWorkerGrouping(savedGrouping === 'tag' ? 'tag' : 'none');
    setCommandHistory(parseStored<Record<string, string[]>>(localStorage.getItem(COMMAND_HISTORY_KEY), {}));
    setCommandSnippets(
      parseStored<Record<string, CommandSnippet[]>>(localStorage.getItem(COMMAND_SNIPPETS_KEY), {}),
    );
    fetch(`${NEXUS_URL}/api/auth/status`)
      .then((res) => res.json())
      .then((data) => setNeedsSetup(Boolean(data.needsSetup)))
      .catch(() => setNeedsSetup(true));
  }, []);

  useEffect(() => {
    const beforeInstallHandler = (event: Event) => {
      const promptEvent = event as BeforeInstallPromptEvent;
      promptEvent.preventDefault();
      setInstallPrompt(promptEvent);
    };

    const installedHandler = () => {
      setInstallPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', beforeInstallHandler as EventListener);
    window.addEventListener('appinstalled', installedHandler);

    return () => {
      window.removeEventListener('beforeinstallprompt', beforeInstallHandler as EventListener);
      window.removeEventListener('appinstalled', installedHandler);
    };
  }, []);

  useEffect(() => {
    setGridSessionIds((prev) => prev.filter((id) => sessionsRef.current.some((s) => s.id === id)));
  }, [sessions]);

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
      setTimeout(() => resumeActiveSession(), 100);
    });

    newSocket.on('reconnect_attempt', () => setConnectionState('reconnecting'));
    newSocket.on('reconnect', () => setConnectionState('connected'));
    newSocket.on('disconnect', () => setConnectionState('disconnected'));

    newSocket.on('worker-list', (list: Worker[]) => {
      workersRef.current = list;
      setWorkers(list);
      rebindSessionsToWorkers(list);
      newSocket.emit('get-session-list');

      const preferredWorker = lastWorkerRef.current
        ? list.find((w) => normalizeWorkerKey(w.name) === lastWorkerRef.current)
        : null;

      const activeSession = sessionsRef.current.find((s) => s.id === activeSessionRef.current);
      const resolvedActive = activeSession ? resolveWorkerForSession(activeSession, list) : null;
      const activeWorkerOnline = resolvedActive ? resolvedActive.status !== 'offline' : false;

      if (!activeWorkerOnline) {
        if (preferredWorker) {
          focusOrCreateSession(preferredWorker.id);
        } else if (list.length > 0) {
          const firstOnline = list.find((w) => w.status !== 'offline') || list[0];
          focusOrCreateSession(firstOnline.id);
        } else {
          setActiveSessionId(null);
        }
      }
    });

    newSocket.on('session-list', (serverSessions: Array<{
      id: string;
      workerName: string;
      workerKey: string;
      displayName: string;
      createdAt: number;
      lastActiveAt: number;
    }>) => {
      serverSessions.forEach(ss => {
        const existsLocally = sessionsRef.current.some(s => s.id === ss.id);
        if (!existsLocally) {
          const worker = workersRef.current.find(w => normalizeWorkerKey(w.name) === ss.workerKey);
          if (worker) {
            newSocket.emit('get-session-output', { sessionId: ss.id }, (output: string) => {
              createNewSession(worker, {
                sessionId: ss.id,
                displayName: ss.displayName,
                createdAt: ss.createdAt,
                lastActiveAt: ss.lastActiveAt,
                initialOutput: output || '',
                focus: false,
              });
            });
          }
        }
      });
      const serverSessionIds = new Set(serverSessions.map(s => s.id));
      const sessionsToRemove = sessionsRef.current.filter(s => !serverSessionIds.has(s.id));
      sessionsToRemove.forEach(session => {
        disposeSession(session);
        delete sessionOutputRef.current[session.id];
      });
      if (sessionsToRemove.length > 0) {
        setSessions(prev => prev.filter(s => serverSessionIds.has(s.id)));
      }
    });

    newSocket.on('session-closed', (data: { sessionId: string }) => {
      const session = sessionsRef.current.find(s => s.id === data.sessionId);
      if (session) {
        disposeSession(session);
        delete sessionOutputRef.current[session.id];
        setSessions(prev => prev.filter(s => s.id !== data.sessionId));
        if (activeSessionRef.current === data.sessionId) {
          const remaining = sessionsRef.current.filter(s => s.id !== data.sessionId);
          setActiveSessionId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
        }
      }
    });

    newSocket.on('output', (data: { workerId: string; sessionId?: string; data: string }) => {
      const targetSessions = data.sessionId
        ? sessionsRef.current.filter((session) => session.id === data.sessionId)
        : sessionsRef.current.filter((session) => session.workerId === data.workerId);
      targetSessions.forEach((session) => {
        session.terminal.write(data.data);
        const current = sessionOutputRef.current[session.id] || '';
        const next = `${current}${data.data}`.slice(-MAX_OUTPUT_CHARS);
        sessionOutputRef.current[session.id] = next;
      });
      if (targetSessions.length > 0) {
        schedulePersistSessions();
      }
    });

    newSocket.on('connect_error', (err) => {
      const message = err?.message || 'Connection error';
      const normalized = message.toLowerCase();
      const isAuthIssue = [
        'invalid token',
        'missing token',
        'jwt expired',
        'invalid signature',
        'unauthorized',
      ].some((needle) => normalized.includes(needle));
      if (isAuthIssue) {
        clearAuth('Sesion expirada o invalida. Inicia sesion de nuevo.');
        return;
      }
      setAuthError(message);
      setConnectionState('reconnecting');
    });

    return () => {
      newSocket.disconnect();
    };
  }, [token]);

  const disposeSession = (session: TerminalSession) => {
    window.removeEventListener('resize', session.resizeHandler);
    session.terminal.dispose();
    session.containerRef.remove();
  };

  const clearAllSessions = (options?: { preserveStorage?: boolean; resetHydration?: boolean }) => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    sessionsRef.current.forEach(disposeSession);
    sessionsRef.current = [];
    activeSessionRef.current = null;
    inputBuffersRef.current = {};
    escapeInputRef.current = {};
    setSessions([]);
    setActiveSessionId(null);
    setOfflineSessions(new Set());
    if (options?.resetHydration) {
      hydratedSessionIdsRef.current = new Set();
    }
    if (!options?.preserveStorage) {
      sessionOutputRef.current = {};
      schedulePersistSessions();
    }
  };

  const clearAuth = (message?: string) => {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(LAST_WORKER_KEY);
    lastWorkerRef.current = null;
    setToken(null);
    setWorkers([]);
    skipPersistRef.current = true;
    clearAllSessions({ preserveStorage: true, resetHydration: true });
    setShowSettings(false);
    setConnectionState('disconnected');
    setAuthError(message || null);
    socketRef.current?.disconnect();
    setSocket(null);
  };

  const fitAndResizeSession = (session: TerminalSession) => {
    const container = session.containerRef;
    const isVisible = container.offsetParent !== null && container.clientWidth > 0 && container.clientHeight > 0;
    if (!isVisible) return;
    session.fitAddon.fit();
    if (socketRef.current && session.terminal.cols > 0 && session.terminal.rows > 0) {
      socketRef.current.emit('resize', {
        workerId: session.workerId,
        sessionId: session.id,
        cols: session.terminal.cols,
        rows: session.terminal.rows,
      });
    }
  };

  const createNewSession = (
    worker: Worker,
    options?: {
      sessionId?: string;
      displayName?: string;
      createdAt?: number;
      lastActiveAt?: number;
      initialOutput?: string;
      focus?: boolean;
    },
  ) => {
    if (!terminalContainerRef.current) return;
    const workerKey = normalizeWorkerKey(worker.name);
    localStorage.setItem(LAST_WORKER_KEY, workerKey);
    lastWorkerRef.current = workerKey;

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
      fontFamily: '"MesloLGS NF", "Fira Code", "JetBrains Mono", "Roboto Mono", "Monaco", "Courier New", monospace',
      fontSize: getAdaptiveFontSize(),
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
    const clipboardAddon = new ClipboardAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(clipboardAddon);
    term.open(container);
    fitAddon.fit();
    term.onData((data) => {
      trackInputForHistory(sessionId, workerKey, data);
      if (socketRef.current) {
        socketRef.current.emit('execute', {
          workerId: worker.id,
          sessionId,
          command: data,
        });
      }
    });
    const handleResize = () => {
      const isVisible = container.offsetParent !== null && container.clientWidth > 0 && container.clientHeight > 0;
      if (!isVisible) return;
      term.options.fontSize = getAdaptiveFontSize();
      fitAddon.fit();
      if (socketRef.current && term.cols > 0 && term.rows > 0) {
        socketRef.current.emit('resize', {
          workerId: worker.id,
          sessionId,
          cols: term.cols,
          rows: term.rows,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    const session: TerminalSession = {
      id: sessionId,
      workerId: worker.id,
      workerName: worker.name,
      workerKey,
      displayName,
      terminal: term,
      fitAddon: fitAddon,
      containerRef: container,
      resizeHandler: handleResize,
      createdAt,
      lastActiveAt,
    };
    if (options?.initialOutput) {
      const output = options.initialOutput.slice(-MAX_OUTPUT_CHARS);
      term.write(output);
      sessionOutputRef.current[sessionId] = output;
    }

    setSessions(prev => [...prev, session]);
    if (options?.focus !== false) {
      setActiveSessionId(sessionId);
    }
    if (!options?.sessionId && socketRef.current) {
      socketRef.current.emit('create-session', {
        id: sessionId,
        workerName: worker.name,
        workerKey,
        displayName,
      });
    }
    setTimeout(() => {
      handleResize();
    }, 100);

    return session;
  };

  const closeSession = (sessionId: string) => {
    setGridSessionIds((prev) => prev.filter((id) => id !== sessionId));
    if (socketRef.current) {
      socketRef.current.emit('close-session', { sessionId });
    }
    
    setSessions(prevSessions => {
      const session = prevSessions.find(s => s.id === sessionId);
      if (!session) return prevSessions;

      disposeSession(session);
      delete sessionOutputRef.current[session.id];
      delete inputBuffersRef.current[session.id];
      delete escapeInputRef.current[session.id];
      schedulePersistSessions();

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
    const newName = window.prompt('Nuevo nombre para la sesion', session.displayName);
    if (newName && newName.trim().length > 0) {
      if (socketRef.current) {
        socketRef.current.emit('rename-session', { sessionId, displayName: newName.trim() });
      }
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, displayName: newName.trim() } : s)),
      );
    }
  };

  const focusOrCreateSession = (workerId: string) => {
    const worker = workers.find((w) => w.id === workerId);
    if (!worker) return;
    const workerKey = normalizeWorkerKey(worker.name);
    localStorage.setItem(LAST_WORKER_KEY, workerKey);
    lastWorkerRef.current = workerKey;
    return createNewSession(worker);
  };

  const focusWorkerSession = (workerId: string) => {
    const worker = workers.find((w) => w.id === workerId);
    if (!worker) return;
    const workerKey = normalizeWorkerKey(worker.name);
    localStorage.setItem(LAST_WORKER_KEY, workerKey);
    lastWorkerRef.current = workerKey;
    const existing = sessionsRef.current.find((session) => session.workerKey === workerKey);
    if (existing) {
      setActiveSessionId(existing.id);
      return existing;
    }
    return createNewSession(worker);
  };

  const resumeActiveSession = () => {
    const session = sessionsRef.current.find((s) => s.id === activeSessionRef.current);
    if (!session || !socketRef.current) return;
    fitAndResizeSession(session);
    socketRef.current.emit('execute', {
      workerId: session.workerId,
      sessionId: session.id,
      command: '\n',
    });
  };

  const toggleFullscreen = async () => {
    const target = terminalContainerRef.current || document.documentElement;
    try {
      if (!document.fullscreenElement) {
        await target.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch (err) {
      console.error('No se pudo cambiar a pantalla completa', err);
    }
  };

  const handleInstallPWA = async () => {
    if (!installPrompt) {
      alert('La instalacion como PWA no esta disponible en este dispositivo/navegador.');
      return;
    }
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setInstallPrompt(null);
      }
    } catch (err) {
      console.error('No se pudo lanzar la instalacion PWA', err);
    }
  };

  const activeSession = sessions.find((session) => session.id === activeSessionId) || null;
  const activeWorkerId = activeSession?.workerId || '';
  const activeWorkerKey = activeSession?.workerKey || '';
  const activeWorkerName = activeSession?.workerName || '';
  const activeHistory = activeWorkerKey ? commandHistory[activeWorkerKey] || [] : [];
  const activeSnippets = activeWorkerKey ? commandSnippets[activeWorkerKey] || [] : [];
  const activeSessionOffline = activeSessionId ? offlineSessions.has(activeSessionId) : false;

  const parseTagsInput = (value: string) =>
    value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);

  const editWorkerTags = (worker: Worker) => {
    const workerKey = normalizeWorkerKey(worker.name);
    const current = (workerTags[workerKey] || []).join(', ');
    setTagModalInput(current);
    setTagModalWorker(worker);
  };

  const saveWorkerTags = () => {
    if (!tagModalWorker) return;
    const workerKey = normalizeWorkerKey(tagModalWorker.name);
    const parsed = parseTagsInput(tagModalInput);
    setWorkerTags((prev) => ({ ...prev, [workerKey]: parsed }));
    setTagModalWorker(null);
    setTagModalInput('');
  };

  const deleteWorker = (worker: Worker) => {
    if (worker.status !== 'offline') {
      alert('Solo se pueden eliminar workers desconectados');
      return;
    }
    if (!confirm(`¿Eliminar worker "${worker.name}" de la lista?`)) return;
    socket?.emit('delete-worker', { workerId: worker.id });
    setWorkers((prev) => prev.filter((w) => w.id !== worker.id));
    const workerKey = normalizeWorkerKey(worker.name);
    setWorkerTags((prev) => {
      const next = { ...prev };
      delete next[workerKey];
      return next;
    });
    setTagModalWorker(null);
  };

  const clearActiveHistory = () => {
    if (!activeWorkerKey) return;
    setCommandHistory((prev) => ({ ...prev, [activeWorkerKey]: [] }));
  };

  const addSnippetForActive = (command?: string) => {
    if (!activeWorkerKey) return;
    const defaultCommand = command || '';
    const label = window.prompt('Nombre del snippet', defaultCommand.slice(0, 24) || 'Snippet');
    if (label === null) return;
    const cmd = command || window.prompt('Comando', defaultCommand);
    if (cmd === null) return;
    addSnippet(activeWorkerKey, label, cmd);
  };

  const removeSnippet = (snippetId: string) => {
    if (!activeWorkerKey) return;
    setCommandSnippets((prev) => {
      const existing = prev[activeWorkerKey] || [];
      return { ...prev, [activeWorkerKey]: existing.filter((item) => item.id !== snippetId) };
    });
  };

  const workerSearch = workerQuery.trim().toLowerCase();
  const filteredWorkers = workers.filter((worker) => {
    if (!workerSearch) return true;
    const workerKey = normalizeWorkerKey(worker.name);
    const tags = workerTags[workerKey] || [];
    return (
      worker.name.toLowerCase().includes(workerSearch) ||
      tags.some((tag) => tag.toLowerCase().includes(workerSearch))
    );
  });

  const groupedWorkers =
    workerGrouping === 'tag'
      ? filteredWorkers.reduce((acc, worker) => {
          const workerKey = normalizeWorkerKey(worker.name);
          const tags = workerTags[workerKey] || [];
          const groupLabel = tags[0] || 'Sin etiquetas';
          acc[groupLabel] = acc[groupLabel] || [];
          acc[groupLabel].push(worker);
          return acc;
        }, {} as Record<string, Worker[]>)
      : { Todos: filteredWorkers };

  const groupedWorkerEntries = Object.entries(groupedWorkers).sort(([a], [b]) => {
    if (a === 'Sin etiquetas') return 1;
    if (b === 'Sin etiquetas') return -1;
    return a.localeCompare(b);
  });

  const nextEmptySlot = () => {
    const idx = gridSessionIds.findIndex((id) => !id);
    return idx >= 0 ? idx : 0;
  };

  const assignGridSlot = (slotIndex: number, sessionId: string) => {
    if (layoutMode === 'single') setLayoutMode('quad');
    setGridSessionIds((prev) => {
      const next = [...prev];
      while (next.length < 4) next.push('');
      for (let i = 0; i < next.length; i += 1) {
        if (i !== slotIndex && next[i] === sessionId) {
          next[i] = '';
        }
      }
      next[slotIndex] = sessionId;
      return next.slice(0, 4);
    });
    setActiveSessionId(sessionId);
  };

  const pinSessionToGrid = (sessionId: string) => {
    assignGridSlot(nextEmptySlot(), sessionId);
  };



  const clearGrid = () => setGridSessionIds([]);

  const handleSessionDragStart = (sessionId: string, displayName: string) => (event: DragEvent<HTMLDivElement>) => {
    setDraggingSessionId(sessionId);
    setShowDropOverlay(true);
    event.dataTransfer.setData('text/plain', sessionId);
    event.dataTransfer.setData('application/x-session-name', displayName);
    event.dataTransfer.effectAllowed = 'move';
  };

  const handleDropOnSlot = (slotIndex: number) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const sessionId = event.dataTransfer.getData('text/plain');
    if (sessionId) {
      assignGridSlot(slotIndex, sessionId);
    }
    setDraggingSessionId(null);
    setShowDropOverlay(false);
  };

  const handleDragOverSlot = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const handleDragEnd = () => {
    setDraggingSessionId(null);
    setShowDropOverlay(false);
  };



  const handleDropOnHotspot = (hotspotIndex: number) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sessionId = event.dataTransfer.getData('text/plain');
    if (sessionId) {
      assignGridSlot(hotspotIndex, sessionId);
      if (layoutMode === 'single') {
         if (hotspotIndex === 1) setLayoutMode('split-vertical');
         else if (hotspotIndex > 1) setLayoutMode('quad');
      }
    }
    setDraggingSessionId(null);
    setShowDropOverlay(false);
  };

  const handleDragOverHotspot = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  useEffect(() => {
    const cleanupDrag = () => {
      if (draggingSessionId) {
        setDraggingSessionId(null);
        setShowDropOverlay(false);
      }
    };
    window.addEventListener('dragend', cleanupDrag);
    window.addEventListener('pointerup', cleanupDrag);
    window.addEventListener('touchend', cleanupDrag);

    return () => {
      window.removeEventListener('dragend', cleanupDrag);
      window.removeEventListener('pointerup', cleanupDrag);
      window.removeEventListener('touchend', cleanupDrag);
    };
  }, [draggingSessionId]);

  useEffect(() => {
    const visibleIds = new Set<string>();
    
    if (layoutMode === 'single') {
      if (activeSessionId) visibleIds.add(activeSessionId);
    } else {
      // Grid modes
      const slots = layoutMode === 'split-vertical' ? [0, 1] : [0, 1, 2, 3];
      slots.forEach(idx => {
        if (gridSessionIds[idx]) visibleIds.add(gridSessionIds[idx]);
      });
    }

    const orderMap: Record<string, number> = {};
    gridSessionIds.forEach((id, idx) => {
      if (id) orderMap[id] = idx;
    });

    sessions.forEach((session) => {
      const visible = visibleIds.has(session.id);
      session.containerRef.style.display = visible ? 'flex' : 'none';
      session.containerRef.style.order = orderMap[session.id]?.toString() || '0';
      
      if (session.id === activeSessionId) {
        session.containerRef.classList.add('active-slot');
      } else {
        session.containerRef.classList.remove('active-slot');
      }

      if (visible) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            fitAndResizeSession(session);
          });
        });
      }
    });
  }, [activeSessionId, sessions, layoutMode, gridSessionIds]);

  useEffect(() => {
    if (!terminalContainerRef.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const active = sessionsRef.current.find((s) => s.id === activeSessionRef.current);
      if (active) {
        fitAndResizeSession(active);
      }
    });
    observer.observe(terminalContainerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!token) return;
      if (!event.ctrlKey || !event.altKey) return;
      const key = event.key.toLowerCase();

      if (key === 'g') {
        if (layoutMode === 'single') {
          setLayoutMode('quad');
        }
        if (gridSessionIds.every((s) => !s) && activeSessionId) {
          assignGridSlot(0, activeSessionId);
        }
        event.preventDefault();
        return;
      }
      if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
        if (layoutMode === 'single') {
             setLayoutMode('quad');
        }
        const currentSlot = gridSessionIds.findIndex(id => id === activeSessionId);
        let nextSlot = currentSlot;

        if (currentSlot === -1) {
             setActiveSessionId(gridSessionIds[0]);
             return;
        }

        if (key === 'arrowleft') nextSlot = currentSlot === 1 ? 0 : (currentSlot === 3 ? 2 : currentSlot);
        if (key === 'arrowright') nextSlot = currentSlot === 0 ? 1 : (currentSlot === 2 ? 3 : currentSlot);
        if (key === 'arrowup') nextSlot = currentSlot === 2 ? 0 : (currentSlot === 3 ? 1 : currentSlot);
        if (key === 'arrowdown') nextSlot = currentSlot === 0 ? 2 : (currentSlot === 1 ? 3 : currentSlot);
        
        const targetId = gridSessionIds[nextSlot];
        if (targetId) {
            setActiveSessionId(targetId);
        }
        event.preventDefault();
        return;
      }
      if (/^[1-4]$/.test(key)) {
        const slotIndex = Number(key) - 1;
        const slotSession = gridSessionIds[slotIndex];
        if (slotSession) {
          if (layoutMode === 'single') setLayoutMode('quad');
          setActiveSessionId(slotSession);
          event.preventDefault();
        }
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [token, layoutMode, gridSessionIds, activeSessionId]);

  useEffect(() => {
    const active = sessionsRef.current.find((s) => s.id === activeSessionRef.current);
    if (!active) return;
    requestAnimationFrame(() => fitAndResizeSession(active));
  }, [sidebarCollapsed]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
      const active = sessionsRef.current.find((s) => s.id === activeSessionRef.current);
      if (active) {
        requestAnimationFrame(() => fitAndResizeSession(active));
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const handleAuth = async (endpoint: 'setup' | 'login', password: string, setupToken?: string) => {
    setBusy(true);
    setAuthError(null);
    try {
      const payload: { password: string; setupToken?: string } = { password };
      if (endpoint === 'setup' && setupToken) {
        payload.setupToken = setupToken;
      }
      const res = await fetch(`${NEXUS_URL}/api/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Auth failed');
      const data = await res.json();
      localStorage.setItem(AUTH_KEY, data.token);
      setToken(data.token);
      setNeedsSetup(false);
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : 'Error desconocido');
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
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = () => {
    clearAuth();
  };

  const renderSidebar = () => (
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
            <div className="sidebar-section">
              <div className="section-title">Sesiones</div>
              {sessions.map(session => (
                <div
                  key={session.id}
                  className={`session-item ${activeSessionId === session.id ? 'active' : ''} ${offlineSessions.has(session.id) ? 'offline' : ''}`}
                  onClick={() => switchSession(session.id)}
                  draggable
                  onDragStart={handleSessionDragStart(session.id, session.displayName)}
                  onDragEnd={handleDragEnd}
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
                      pinSessionToGrid(session.id);
                    }}
                    title="Enviar al grid"
                  >
                    ⬒
                  </button>
                  <button
                    className="rename-session-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      renameSession(session.id);
                    }}
                    title="Renombrar sesion"
                  >
                    ✎
                  </button>
                  <button
                    className="close-session-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeSession(session.id);
                    }}
                    title="Cerrar sesion"
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

            <div className="sidebar-divider" />

            <div className="sidebar-section">
              <div className="section-title">Workers</div>
              <div className="worker-tools">
                <input
                  className="worker-search"
                  placeholder="Buscar por nombre o tag..."
                  value={workerQuery}
                  onChange={(e) => setWorkerQuery(e.target.value)}
                />
                <select
                  className="worker-grouping"
                  value={workerGrouping}
                  onChange={(e) => setWorkerGrouping(e.target.value as 'none' | 'tag')}
                >
                  <option value="none">Sin agrupar</option>
                  <option value="tag">Agrupar por tag</option>
                </select>
              </div>
              {filteredWorkers.length === 0 && (
                <div className="empty-sessions">
                  No hay workers
                </div>
              )}
              {filteredWorkers.length > 0 && groupedWorkerEntries.map(([groupLabel, groupWorkers]) => (
                <div key={groupLabel} className="worker-group">
                  {workerGrouping === 'tag' && <div className="worker-group-title">{groupLabel}</div>}
                  {groupWorkers.map((worker) => {
                    const workerKey = normalizeWorkerKey(worker.name);
                    const tags = workerTags[workerKey] || [];
                    return (
                      <div
                        key={worker.id}
                        className={`worker-item ${worker.status === 'offline' ? 'offline' : ''}`}
                        onClick={() => focusWorkerSession(worker.id)}
                      >
                        <div className="worker-main">
                          <div className="worker-name">{worker.name}</div>
                          <div className="worker-meta">{worker.status === 'offline' ? 'Offline' : 'Online'}</div>
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
                        <button
                          className="add-session-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            focusOrCreateSession(worker.id);
                          }}
                          title="Nueva sesion en este worker"
                        >
                          +
                        </button>
                        <button
                          className="tag-edit-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            editWorkerTags(worker);
                          }}
                          title="Editar tags"
                        >
                          🏷
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="sidebar-divider" />

            <div className="sidebar-section">
              <div className="section-title">Comandos</div>
              <div className="command-header">
                <span className="command-target">
                  {activeWorkerName || 'Sin sesion activa'}
                </span>
                {activeSessionOffline && <span className="badge-offline">Offline</span>}
              </div>
              <div className="command-tabs">
                <button
                  className={commandTab === 'history' ? 'active' : ''}
                  onClick={() => setCommandTab('history')}
                >
                  Historial
                </button>
                <button
                  className={commandTab === 'snippets' ? 'active' : ''}
                  onClick={() => setCommandTab('snippets')}
                >
                  Snippets
                </button>
              </div>
              {!activeSession && (
                <div className="empty-sessions">
                  Selecciona una sesion para ver comandos
                </div>
              )}
              {activeSession && commandTab === 'history' && (
                <>
                  <div className="command-actions">
                    <button className="mini-btn" onClick={clearActiveHistory} disabled={!activeHistory.length}>
                      Limpiar
                    </button>
                  </div>
                  <div className="command-list">
                    {activeHistory.length === 0 && (
                      <div className="empty-sessions">Sin historial</div>
                    )}
                    {activeHistory.map((cmd, index) => (
                      <div key={`${cmd}-${index}`} className="command-item">
                        <button
                          className="command-run"
                          onClick={() => sendCommandToActiveSession(cmd)}
                          disabled={activeSessionOffline}
                          title="Ejecutar"
                        >
                          ▶
                        </button>
                        <div className="command-text" title={cmd}>{cmd}</div>
                        <button
                          className="command-star"
                          onClick={() => addSnippetForActive(cmd)}
                          disabled={activeSessionOffline}
                          title="Guardar como snippet"
                        >
                          ☆
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {activeSession && commandTab === 'snippets' && (
                <>
                  <div className="command-actions">
                    <button className="mini-btn" onClick={() => addSnippetForActive()} disabled={activeSessionOffline}>
                      Agregar
                    </button>
                  </div>
                  <div className="command-list">
                    {activeSnippets.length === 0 && (
                      <div className="empty-sessions">Sin snippets</div>
                    )}
                    {activeSnippets.map((snippet) => (
                      <div key={snippet.id} className="command-item">
                        <button
                          className="command-run"
                          onClick={() => sendCommandToActiveSession(snippet.command)}
                          disabled={activeSessionOffline}
                          title="Ejecutar"
                        >
                          ▶
                        </button>
                        <div className="command-text">
                          <div className="command-title">{snippet.label}</div>
                          <div className="command-subtext">{snippet.command}</div>
                        </div>
                        <button
                          className="command-remove"
                          onClick={() => removeSnippet(snippet.id)}
                          disabled={activeSessionOffline}
                          title="Eliminar"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );

  const renderControls = () => (
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
        <span>{sessions.length} sesion{sessions.length !== 1 ? 'es' : ''}</span>
        <span>•</span>
        <span>{workers.length} worker{workers.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="topbar-right">
        {activeSessionId && (
          <button className="resume-btn" onClick={resumeActiveSession} title="Reanudar sesion activa">
            Reanudar
          </button>
        )}
        <button
          className="ghost-btn fullscreen-btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
        >
          {isFullscreen ? '⤢' : '⛶'}
        </button>
        <button
          className="ghost-btn pwa-btn"
          onClick={handleInstallPWA}
          disabled={!installPrompt}
          title={installPrompt ? 'Descargar como PWA' : 'PWA no disponible'}
        >
          ⇩ PWA
        </button>
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
    const [setupToken, setSetupToken] = useState('');

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
        {needsSetup && (
          <div className="auth-row">
            <label>Setup token (si aplica)</label>
            <input type="password" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} />
          </div>
        )}
        <button
          disabled={busy || password.length < 8}
          onClick={() => handleAuth(needsSetup ? 'setup' : 'login', password, setupToken)}
        >
          {needsSetup ? 'Configurar y entrar' : 'Entrar'}
        </button>
        {authError && <p className="error">{authError}</p>}
      </div>
    );
  };

  return (
    <div className="layout">
      {renderControls()}
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
      {tagModalWorker && (
        <div className="modal-overlay" onClick={() => setTagModalWorker(null)}>
          <div className="modal tag-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Editar Worker</h3>
              <button className="close-btn" onClick={() => setTagModalWorker(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="worker-info">
                <strong>{tagModalWorker.name}</strong>
                <span className={`status-badge ${tagModalWorker.status}`}>
                  {tagModalWorker.status === 'offline' ? 'Desconectado' : 'Conectado'}
                </span>
              </div>
              <label className="form-label">
                Tags (separadas por coma)
                <input
                  type="text"
                  className="form-input"
                  value={tagModalInput}
                  onChange={(e) => setTagModalInput(e.target.value)}
                  placeholder="produccion, backend, aws..."
                  onKeyDown={(e) => e.key === 'Enter' && saveWorkerTags()}
                />
              </label>
              <div className="modal-actions">
                <button className="btn-primary" onClick={saveWorkerTags}>
                  Guardar Tags
                </button>
                {tagModalWorker.status === 'offline' && (
                  <button 
                    className="btn-danger" 
                    onClick={() => deleteWorker(tagModalWorker)}
                  >
                    Eliminar Worker
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="content">
        {renderSidebar()}
        <div className={`terminal-container layout-${layoutMode} ${layoutMode !== 'single' ? 'grid-layout' : ''}`} ref={terminalContainerRef}>
          <div className="terminal-toolbar">
            <div className="layout-toggle">
              <button
                className={`layout-icon-btn ${layoutMode === 'single' ? 'active' : ''}`}
                onClick={() => setLayoutMode('single')}
                title="Vista unica"
              >
                <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" fill="none" strokeWidth="2"/></svg>
              </button>
              <button
                className={`layout-icon-btn ${layoutMode === 'split-vertical' ? 'active' : ''}`}
                onClick={() => {
                  if (layoutMode === 'single' && activeSessionId && !gridSessionIds[0]) {
                    assignGridSlot(0, activeSessionId);
                  }
                  setLayoutMode('split-vertical');
                }}
                title="Vista Dividida"
              >
                <svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z M12 4v16" stroke="currentColor" fill="none" strokeWidth="2"/></svg>
              </button>
              <button
                className={`layout-icon-btn ${layoutMode === 'quad' ? 'active' : ''}`}
                onClick={() => {
                  if (layoutMode === 'single' && activeSessionId && !gridSessionIds[0]) {
                    assignGridSlot(0, activeSessionId);
                  }
                  setLayoutMode('quad');
                }}
                title="Vista Cuadruple"
              >
                <svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z M12 4v16M4 12h16" stroke="currentColor" fill="none" strokeWidth="2"/></svg>
              </button>
            </div>
            {layoutMode !== 'single' && (
               <div style={{ flex: 1 }}></div> 
            )}
            {layoutMode !== 'single' && (
              <button 
                className="ghost-btn" 
                onClick={clearGrid} 
                title="Limpiar grid"
                style={{ fontSize: '0.8em', padding: '2px 8px' }}
              >
                Limpiar
              </button>
            )}
          </div>
          {layoutMode !== 'single' && (
            <>
              {(layoutMode === 'split-vertical' ? [0, 1] : [0, 1, 2, 3]).map((idx) => {
                if (gridSessionIds[idx]) return null; // Session exists here (imperative)
                return (
                  <div
                    key={`placeholder-${idx}`}
                    className={`empty-slot-target ${draggingSessionId ? 'droppable' : ''}`}
                    style={{ order: idx }}
                    onDrop={handleDropOnSlot(idx)}
                    onDragOver={handleDragOverSlot}
                  >
                    <div className="sc-icon">
                       {draggingSessionId ? '⤓' : '+'}
                    </div>
                    <span>{draggingSessionId ? 'Soltar aquí' : 'Vacío'}</span>
                  </div>
                );
              })}
            </>
          )}

          {sessions.length === 0 && token && (
            <div className="empty-state">
              <h2>No hay sesiones activas</h2>
              <p>Crea una nueva sesion desde el selector superior o el sidebar</p>
              {workers.length === 0 && <p className="muted">No hay workers conectados en este momento.</p>}
            </div>
          )}
          {showDropOverlay && layoutMode === 'single' && (
            <div className="drop-overlay" onDragOver={handleDragOverHotspot} onDrop={handleDragEnd}>
              {['Izquierda', 'Derecha', 'Abajo', 'Arriba'].map((label, idx) => (
                <div
                  key={`hotspot-${idx}`}
                  className={`drop-zone drop-${idx}`}
                  onDrop={handleDropOnHotspot(idx)}
                  onDragOver={handleDragOverHotspot}
                >
                  {label}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;

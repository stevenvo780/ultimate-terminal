import { useCallback, useRef, useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import {
  addSession,
  removeSession,
  updateSession,
  setActiveSession,
  updateSessionOutput,
  setSessionOutput,
  setOfflineSessionIds,
} from '../store';
import type { StoredSession } from '../store';
import { addCommandToHistory } from '../store/slices/commandsSlice';
import type { Worker } from '../store/slices/workersSlice';

interface TerminalInstance {
  id: string;
  workerId: string;
  workerKey: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  containerRef: HTMLDivElement;
  resizeHandler: () => void;
}

interface UseTerminalSessionReturn {
  terminalInstances: React.MutableRefObject<Map<string, TerminalInstance>>;
  createSession: (
    worker: Worker,
    containerParent: HTMLDivElement,
    socket: {
      emit: (event: string, data: unknown) => void;
    },
    options?: {
      sessionId?: string;
      displayName?: string;
      createdAt?: number;
      lastActiveAt?: number;
      initialOutput?: string;
      focus?: boolean;
    }
  ) => TerminalInstance | null;
  closeSession: (sessionId: string, socket: { emit: (event: string, data: unknown) => void }) => void;
  renameSession: (sessionId: string, newName: string, socket: { emit: (event: string, data: unknown) => void }) => void;
  fitAndResizeSession: (sessionId: string, socket: { emit: (event: string, data: unknown) => void }) => void;
  getTerminalInstance: (sessionId: string) => TerminalInstance | undefined;
  writeToTerminal: (sessionId: string, data: string) => void;
  disposeAllSessions: () => void;
}

const MAX_OUTPUT_CHARS = 20000;

export function useTerminalSession(): UseTerminalSessionReturn {
  const dispatch = useAppDispatch();
  const sessions = useAppSelector((state) => state.sessions.sessions);
  const workers = useAppSelector((state) => state.workers.workers);
  const terminalInstances = useRef<Map<string, TerminalInstance>>(new Map());
  const inputBuffersRef = useRef<Record<string, string>>({});
  const escapeInputRef = useRef<Record<string, boolean>>({});
  const pendingSessionIdsRef = useRef<Set<string>>(new Set());

  const normalizeWorkerKey = useCallback((name: string) => name.trim().toLowerCase(), []);

  const getAdaptiveFontSize = useCallback(() => (window.innerWidth <= 960 ? 13 : 14), []);

  const trackInputForHistory = useCallback((sessionId: string, workerKey: string, data: string) => {
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
          dispatch(addCommandToHistory({ workerKey, command: buffer }));
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
  }, [dispatch]);

  const createSession = useCallback((
    worker: Worker,
    containerParent: HTMLDivElement,
    socket: { emit: (event: string, data: unknown) => void },
    options?: {
      sessionId?: string;
      displayName?: string;
      createdAt?: number;
      lastActiveAt?: number;
      initialOutput?: string;
      focus?: boolean;
    }
  ): TerminalInstance | null => {
    const workerKey = normalizeWorkerKey(worker.name);
    const creationLockKey = `creating_${workerKey}`;

    // Deduplication for specific sessionId
    if (options?.sessionId) {
      if (terminalInstances.current.has(options.sessionId) || pendingSessionIdsRef.current.has(options.sessionId)) {
        return null;
      }
      pendingSessionIdsRef.current.add(options.sessionId);
    }

    // Worker-level lock for new sessions
    if (!options?.sessionId) {
      if (pendingSessionIdsRef.current.has(creationLockKey)) {
        return null;
      }
      pendingSessionIdsRef.current.add(creationLockKey);
      setTimeout(() => {
        pendingSessionIdsRef.current.delete(creationLockKey);
      }, 1000);
    }

    const sessionId = options?.sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const displayName = options?.displayName || worker.name;
    const createdAt = options?.createdAt || Date.now();
    const lastActiveAt = options?.lastActiveAt || Date.now();

    // Create DOM container
    const container = document.createElement('div');
    container.className = 'terminal-wrapper';
    container.style.display = 'none';
    container.dataset.sessionId = sessionId;
    containerParent.appendChild(container);

    // Create terminal
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

    // Click handler
    container.addEventListener('mousedown', () => {
      dispatch(setActiveSession(sessionId));
      setTimeout(() => term.focus(), 0);
    });

    // Data handler
    term.onData((data) => {
      trackInputForHistory(sessionId, workerKey, data);
      socket.emit('execute', {
        workerId: worker.id,
        sessionId,
        command: data,
      });
    });

    // Resize handler
    const handleResize = () => {
      const isVisible = container.offsetParent !== null && container.clientWidth > 0 && container.clientHeight > 0;
      if (!isVisible) return;
      term.options.fontSize = getAdaptiveFontSize();
      fitAddon.fit();
      if (term.cols > 0 && term.rows > 0) {
        socket.emit('resize', {
          workerId: worker.id,
          sessionId,
          cols: term.cols,
          rows: term.rows,
        });
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

    // Write initial output
    if (options?.initialOutput) {
      const output = options.initialOutput.slice(-MAX_OUTPUT_CHARS);
      term.write(output);
      dispatch(setSessionOutput({ sessionId, output }));
    }

    // Store instance
    terminalInstances.current.set(sessionId, instance);

    // Add to Redux store
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

    // Subscribe and create session on server
    socket.emit('subscribe', { workerId: worker.id });
    if (!options?.sessionId) {
      socket.emit('create-session', {
        id: sessionId,
        workerName: worker.name,
        workerKey,
        displayName,
      });
      pendingSessionIdsRef.current.add(sessionId);
      setTimeout(() => {
        pendingSessionIdsRef.current.delete(sessionId);
      }, 10000);
    }

    setTimeout(() => handleResize(), 100);

    return instance;
  }, [dispatch, normalizeWorkerKey, getAdaptiveFontSize, trackInputForHistory]);

  const closeSession = useCallback((sessionId: string, socket: { emit: (event: string, data: unknown) => void }) => {
    const instance = terminalInstances.current.get(sessionId);
    const workerId = instance?.workerId ?? sessions.find((session) => session.id === sessionId)?.workerId;
    if (instance) {
      window.removeEventListener('resize', instance.resizeHandler);
      instance.terminal.dispose();
      instance.containerRef.remove();
      terminalInstances.current.delete(sessionId);
    }

    pendingSessionIdsRef.current.delete(sessionId);
    delete inputBuffersRef.current[sessionId];
    delete escapeInputRef.current[sessionId];

    if (workerId) socket.emit('close-session', { workerId, sessionId });
    dispatch(removeSession(sessionId));
  }, [dispatch, sessions]);

  const renameSession = useCallback((sessionId: string, newName: string, socket: { emit: (event: string, data: unknown) => void }) => {
    const trimmedName = newName.trim();
    if (!trimmedName) return;
    const workerId = terminalInstances.current.get(sessionId)?.workerId
      ?? sessions.find((session) => session.id === sessionId)?.workerId;

    dispatch(updateSession({ id: sessionId, displayName: trimmedName }));
    if (workerId) socket.emit('rename-session', { workerId, sessionId, newName: trimmedName });
  }, [dispatch, sessions]);

  const fitAndResizeSession = useCallback((sessionId: string, socket: { emit: (event: string, data: unknown) => void }) => {
    const instance = terminalInstances.current.get(sessionId);
    if (!instance) return;

    const container = instance.containerRef;
    const isVisible = container.offsetParent !== null && container.clientWidth > 0 && container.clientHeight > 0;
    if (!isVisible) return;

    instance.fitAddon.fit();
    const term = instance.terminal;
    if (term.cols > 0 && term.rows > 0) {
      socket.emit('resize', {
        workerId: instance.workerId,
        sessionId,
        cols: term.cols,
        rows: term.rows,
      });
    }
  }, []);

  const getTerminalInstance = useCallback((sessionId: string) => {
    return terminalInstances.current.get(sessionId);
  }, []);

  const writeToTerminal = useCallback((sessionId: string, data: string) => {
    const instance = terminalInstances.current.get(sessionId);
    if (instance) {
      instance.terminal.write(data);
      dispatch(updateSessionOutput({ sessionId, output: data }));
    }
  }, [dispatch]);

  const disposeAllSessions = useCallback(() => {
    terminalInstances.current.forEach((instance) => {
      window.removeEventListener('resize', instance.resizeHandler);
      instance.terminal.dispose();
      instance.containerRef.remove();
    });
    terminalInstances.current.clear();
    inputBuffersRef.current = {};
    escapeInputRef.current = {};
  }, []);

  // Update offline sessions based on worker status
  useEffect(() => {
    const offlineIds: string[] = [];
    sessions.forEach((session) => {
      const worker = workers.find(w =>
        w.id === session.workerId ||
        normalizeWorkerKey(w.name) === session.workerKey
      );
      if (!worker || worker.status === 'offline') {
        offlineIds.push(session.id);
      }
    });
    dispatch(setOfflineSessionIds(offlineIds));
  }, [sessions, workers, dispatch, normalizeWorkerKey]);

  return {
    terminalInstances,
    createSession,
    closeSession,
    renameSession,
    fitAndResizeSession,
    getTerminalInstance,
    writeToTerminal,
    disposeAllSessions,
  };
}

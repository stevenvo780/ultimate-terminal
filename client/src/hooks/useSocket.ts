import { useCallback, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import {
  setConnectionState,
  setWorkers,
  setCurrentUser,
  logoutAndReset,
  setNeedsSetup,
} from '../store';
import type { Worker } from '../store/slices/workersSlice';
import type { ConnectionState } from '../store/slices/connectionSlice';

const NEXUS_URL = import.meta.env.VITE_NEXUS_URL ||
  (import.meta.env.PROD ? window.location.origin : 'http://localhost:3002');

interface UseSocketReturn {
  getSocket: () => Socket | null;
  connectionState: ConnectionState;
  nexusUrl: string;
  emit: (event: string, data?: unknown, callback?: (response: unknown) => void) => void;
  subscribe: (workerId: string) => void;
  joinSession: (workerId: string, sessionId: string, cols: number, rows: number) => void;
  leaveSession: (workerId: string, sessionId: string) => void;
  execute: (workerId: string, sessionId: string, command: string) => void;
  resize: (workerId: string, sessionId: string, cols: number, rows: number) => void;
  createSession: (id: string, workerName: string, workerKey: string, displayName: string) => void;
  closeSession: (workerId: string, sessionId: string) => void;
  renameSession: (workerId: string, sessionId: string, newName: string) => void;
  getSessionOutput: (workerId: string, sessionId: string, callback: (output: string) => void) => void;
}

export function useSocket(
  onOutput?: (data: { workerId: string; sessionId?: string; data: string }) => void,
  onSessionList?: (sessions: Array<{
    id: string;
    workerName: string;
    workerKey: string;
    displayName: string;
    createdAt: number;
    lastActiveAt: number;
  }>) => void,
  onSessionClosed?: (sessionId: string, workerId: string) => void
): UseSocketReturn {
  const dispatch = useAppDispatch();
  const token = useAppSelector((state) => state.auth.token);
  const connectionState = useAppSelector((state) => state.connection.connectionState);
  const socketRef = useRef<Socket | null>(null);

  const initSocket = useCallback((authToken: string) => {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    const newSocket = io(NEXUS_URL, {
      auth: { token: authToken, type: 'client' },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socketRef.current = newSocket;
    dispatch(setConnectionState('connecting'));

    newSocket.on('connect', () => {
      dispatch(setConnectionState('connected'));
    });

    newSocket.on('reconnect', () => {
      dispatch(setConnectionState('connected'));
    });

    newSocket.on('disconnect', () => {
      dispatch(setConnectionState('disconnected'));
    });

    newSocket.on('workers', (list: Worker[]) => {
      dispatch(setWorkers(list));
    });

    newSocket.on('session-list', (serverSessions) => {
      onSessionList?.(serverSessions);
    });

    newSocket.on('session-closed', (data: { sessionId: string; workerId: string }) => {
      onSessionClosed?.(data.sessionId, data.workerId);
    });

    newSocket.on('output', (data: { workerId: string; sessionId?: string; data: string }) => {
      onOutput?.(data);
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
        'authentication error',
      ].some((needle) => normalized.includes(needle));

      if (isAuthIssue) {
        dispatch(logoutAndReset('Sesión expirada o inválida. Inicia sesión de nuevo.'));
        return;
      }
      dispatch(setConnectionState('reconnecting'));
    });

    return newSocket;
  }, [dispatch, onOutput, onSessionList, onSessionClosed]);

  useEffect(() => {
    if (!token) {
      dispatch(setNeedsSetup(true));
      return;
    }

    // Validate token with server
    fetch(`${NEXUS_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => {
        if (!res.ok) throw new Error('Invalid token');
        return res.json();
      })
      .then((data) => {
        if (data.user) {
          dispatch(setCurrentUser(data.user));
        }
        initSocket(token);
      })
      .catch(() => {
        dispatch(logoutAndReset());
        dispatch(setNeedsSetup(true));
      });

    return () => {
      socketRef.current?.disconnect();
    };
  }, [token, dispatch, initSocket]);

  const emit = useCallback((event: string, data?: unknown, callback?: (response: unknown) => void) => {
    if (socketRef.current) {
      if (callback) {
        socketRef.current.emit(event, data, callback);
      } else {
        socketRef.current.emit(event, data);
      }
    }
  }, []);

  const subscribe = useCallback((workerId: string) => {
    emit('subscribe', { workerId });
  }, [emit]);

  const joinSession = useCallback((workerId: string, sessionId: string, cols: number, rows: number) => {
    emit('join-session', { workerId, sessionId, cols, rows });
  }, [emit]);

  const leaveSession = useCallback((workerId: string, sessionId: string) => {
    emit('leave-session', { workerId, sessionId });
  }, [emit]);

  const execute = useCallback((workerId: string, sessionId: string, command: string) => {
    emit('execute', { workerId, sessionId, command });
  }, [emit]);

  const resize = useCallback((workerId: string, sessionId: string, cols: number, rows: number) => {
    emit('resize', { workerId, sessionId, cols, rows });
  }, [emit]);

  const createSession = useCallback((id: string, workerName: string, workerKey: string, displayName: string) => {
    emit('create-session', { id, workerName, workerKey, displayName });
  }, [emit]);

  const closeSession = useCallback((workerId: string, sessionId: string) => {
    emit('close-session', { workerId, sessionId });
  }, [emit]);

  const renameSession = useCallback((workerId: string, sessionId: string, newName: string) => {
    emit('rename-session', { workerId, sessionId, newName });
  }, [emit]);

  const getSessionOutput = useCallback((workerId: string, sessionId: string, callback: (output: string) => void) => {
    emit('get-session-output', { workerId, sessionId }, callback as (response: unknown) => void);
  }, [emit]);

  const getSocket = useCallback(() => socketRef.current, []);

  return {
    getSocket,
    connectionState,
    nexusUrl: NEXUS_URL,
    emit,
    subscribe,
    joinSession,
    leaveSession,
    execute,
    resize,
    createSession,
    closeSession,
    renameSession,
    getSessionOutput,
  };
}

export { NEXUS_URL };

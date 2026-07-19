
import { Server, Socket } from 'socket.io';
import { verifyToken, JwtPayload } from './utils/jwt';
import { WorkerModel, Worker } from './models/worker.model';
import { UserModel } from './models/user.model';
import { getUserPlan, canOpenSession } from './services/plan-limits';
import { OrderedRelayQueue } from './services/ordered-relay';
import db from './config/database';

/**
 * Data attached to the socket instance.
 */
interface SocketData {
  role: 'client' | 'worker';
  user?: JwtPayload;
  workerId?: string;
}

export const workers: Map<string, Worker & { socketId: string }> = new Map();

const applyRuntimeWorkerStatus = <T extends Pick<Worker, 'id' | 'status'>>(workerList: T[]): Array<T & { status: 'online' | 'offline' }> => {
  return workerList.map((worker) => ({
    ...worker,
    status: workers.has(worker.id) ? 'online' : 'offline',
  }));
};

/**
 * Represents an active terminal session.
 */
interface ActiveSession {
  id: string;
  workerId: string;
  output: string;
  displayName: string;
  workerName: string;
  workerKey: string;
  createdAt: number;
  lastActive: number;
  creatorUserId?: number;
}
interface PendingOutput {
  workerId: string;
  sessionId: string;
  output: string;
}
const activeSessions: Map<string, ActiveSession> = new Map();
const sessionSubscribers: Map<string, Set<string>> = new Map();
const outputRelay = new OrderedRelayQueue<PendingOutput>();
const SESSION_LIST_DEBOUNCE_MS = Number(process.env.SESSION_LIST_DEBOUNCE_MS || 500);
const ACCESS_CACHE_TTL_MS = Number(process.env.ACCESS_CACHE_TTL_MS || 2000);
let sessionListDirty = false;
let sessionListTimer: NodeJS.Timeout | null = null;
const workerAccessCache = new Map<number, { ts: number; workerIds: Set<string> }>();

const sessionKey = (workerId: string, sessionId: string) => `${workerId}:${sessionId}`;

const normalizeSessionId = (sessionId?: string) => {
  const trimmed = sessionId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'default';
};

const addSessionSubscriber = (workerId: string, sessionId: string, socketId: string) => {
  const key = sessionKey(workerId, sessionId);
  const set = sessionSubscribers.get(key) || new Set<string>();
  set.add(socketId);
  sessionSubscribers.set(key, set);
};

const removeSessionSubscriber = (workerId: string, sessionId: string, socketId: string) => {
  const key = sessionKey(workerId, sessionId);
  const set = sessionSubscribers.get(key);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) {
    sessionSubscribers.delete(key);
  }
};

const removeSocketFromAllSessions = (socketId: string) => {
  const removedSessionKeys: string[] = [];
  for (const [key, set] of sessionSubscribers.entries()) {
    if (set.has(socketId)) {
      set.delete(socketId);
      removedSessionKeys.push(key);
      if (set.size === 0) {
        sessionSubscribers.delete(key);
      }
    }
  }
  return removedSessionKeys;
};

export const invalidateWorkerAccessCache = (userId?: number): void => {
  if (userId === undefined) {
    workerAccessCache.clear();
    return;
  }
  workerAccessCache.delete(userId);
};

export const evictUserSubscriptions = (
  io: Server | undefined,
  userId: number,
  workerId?: string
): void => {
  invalidateWorkerAccessCache(userId);
  if (!io) return;
  for (const [key, set] of sessionSubscribers.entries()) {
    const session = activeSessions.get(key);
    if (!session || (workerId && session.workerId !== workerId)) continue;
    for (const socketId of Array.from(set)) {
      const socket = io.sockets.sockets.get(socketId);
      const socketData = socket?.data as SocketData | undefined;
      if (socketData?.role === 'client' && socketData.user?.userId === userId) {
        set.delete(socketId);
      }
    }
    if (set.size === 0) sessionSubscribers.delete(key);
  }
};

/**
 * Initializes the Socket.IO server and handles connection logic.
 * @param httpServer - The HTTP server instance to attach to.
 * @returns The initialized Socket.IO server instance.
 */
export const initSocket = (httpServer: any) => {
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    // Enforce compression for terminal streams
    perMessageDeflate: {
      threshold: 1024,
    },
    httpCompression: true,
  });

  const emitWorkerList = (socket: Socket, list: any[]) => {
    socket.emit('workers', list);
    socket.emit('worker-list', list);
  };

  const sendWorkerListToSocket = async (socket: Socket) => {
    const socketData = socket.data as SocketData;
    if (socketData.role === 'client' && socketData.user) {
      const list = await WorkerModel.getAccessibleWorkers(socketData.user.userId);
      emitWorkerList(socket, applyRuntimeWorkerStatus(list));
    }
  };

  const revalidateSubscribers = async (
    workerId: string,
    subscriberKey: string,
    requiredPermission: 'view' | 'control' = 'view'
  ): Promise<string[]> => {
    const subscribers = sessionSubscribers.get(subscriberKey);
    if (!subscribers || subscribers.size === 0) return [];

    const allowed = await Promise.all(Array.from(subscribers).map(async (socketId) => {
      const client = io.sockets.sockets.get(socketId);
      const socketData = client?.data as SocketData | undefined;
      if (!client || socketData?.role !== 'client' || !socketData.user) return null;
      const hasAccess = await WorkerModel.hasAccess(socketData.user.userId, workerId, requiredPermission);
      return hasAccess ? socketId : null;
    }));

    const allowedIds = allowed.filter((socketId): socketId is string => Boolean(socketId));
    const allowedSet = new Set(allowedIds);
    for (const socketId of Array.from(subscribers)) {
      if (!allowedSet.has(socketId)) subscribers.delete(socketId);
    }
    if (subscribers.size === 0) sessionSubscribers.delete(subscriberKey);
    return allowedIds;
  };

  const broadcastWorkerUpdates = () => {
    io.sockets.sockets.forEach((socket) => {
      sendWorkerListToSocket(socket).catch(console.error);
    });
  };


  const broadcastSessionList = async () => {
    const sessionsByWorker = new Map<string, ActiveSession[]>();
    for (const session of activeSessions.values()) {
      const list = sessionsByWorker.get(session.workerId) || [];
      list.push(session);
      sessionsByWorker.set(session.workerId, list);
    }

    const sockets = Array.from(io.sockets.sockets.values());
    await Promise.all(sockets.map(async (socket) => {
      const socketData = socket.data as SocketData;
      if (socketData.role !== 'client' || !socketData.user) return;

      const userId = socketData.user.userId;
      const cached = workerAccessCache.get(userId);
      let allowedWorkerIds: Set<string>;
      if (cached && Date.now() - cached.ts < ACCESS_CACHE_TTL_MS) {
        allowedWorkerIds = cached.workerIds;
      } else {
        const accessibleWorkers = await WorkerModel.getAccessibleWorkers(userId);
        allowedWorkerIds = new Set(accessibleWorkers.map((w) => w.id));
        workerAccessCache.set(userId, { ts: Date.now(), workerIds: allowedWorkerIds });
      }

      const filtered: Array<{
        id: string;
        workerId: string;
        workerName: string;
        workerKey: string;
        displayName: string;
        createdAt: number;
        lastActiveAt: number;
        creatorUserId?: number;
      }> = [];

      for (const [workerId, sessions] of sessionsByWorker.entries()) {
        if (!allowedWorkerIds.has(workerId)) continue;
        sessions.forEach((s) => {
          filtered.push({
            id: s.id,
            workerId,
            workerName: s.workerName,
            workerKey: s.workerKey,
            displayName: s.displayName,
            createdAt: s.createdAt,
            lastActiveAt: s.lastActive,
            creatorUserId: s.creatorUserId,
          });
        });
      }

      socket.emit('session-list', filtered);
    }));
  };

  const scheduleSessionListBroadcast = (force = false) => {
    sessionListDirty = true;
    if (force) {
      if (sessionListTimer) {
        clearTimeout(sessionListTimer);
        sessionListTimer = null;
      }
      sessionListDirty = false;
      broadcastSessionList().catch(console.error);
      return;
    }

    if (sessionListTimer) return;
    sessionListTimer = setTimeout(() => {
      sessionListTimer = null;
      if (!sessionListDirty) return;
      sessionListDirty = false;
      broadcastSessionList().catch(console.error);
    }, SESSION_LIST_DEBOUNCE_MS);
  };

  const ensureActiveSession = async (workerId: string, sessionIdRaw?: string, displayName?: string, userId?: number) => {
    const sessionId = normalizeSessionId(sessionIdRaw);
    const key = sessionKey(workerId, sessionId);
    let existing = activeSessions.get(key);
    if (existing) {
      // Update creatorUserId if not set yet and we have it now
      if (!existing.creatorUserId && userId) existing.creatorUserId = userId;
      return existing;
    }

    // Try to get name from connected workers cache first (sync)
    let workerName = 'Worker';
    const connectedWorker = workers.get(workerId);
    if (connectedWorker) {
      workerName = connectedWorker.name;
    } else {
      const worker = await WorkerModel.findById(workerId);
      if (worker) workerName = worker.name;
    }

    const workerKey = workerName.toLowerCase();
    existing = {
      id: sessionId,
      workerId,
      output: '',
      displayName: displayName || sessionId,
      workerName,
      workerKey,
      createdAt: Date.now(),
      lastActive: Date.now(),
      creatorUserId: userId,
    };
    activeSessions.set(key, existing);
    return existing;
  };

  io.use(async (socket, next) => {
    const { token, type, apiKey, workerName } = (socket.handshake.auth || {}) as any;


    try {
      if (type === 'client') {
        if (!token) return next(new Error('Missing token'));
        const payload = verifyToken(token);

        /** Validate that the user still exists in the database. */
        const userExists = await UserModel.findById(payload.userId);
        if (!userExists) {
          return next(new Error('User invalid or no longer exists'));
        }

        socket.data = { role: 'client', user: payload } as SocketData;
        console.log(`[Socket] Client connected: ${payload.username} (${payload.userId})`);
        return next();
      }

      if (type === 'worker') {
        if (!apiKey) {
          return next(new Error('Missing API Key'));
        }
        const worker = await WorkerModel.findByApiKey(apiKey);

        if (!worker) {
          return next(new Error('Invalid API Key'));
        }

        if (workerName && typeof workerName === 'string' && workerName.trim() && workerName.trim() !== worker.name) {
          await WorkerModel.updateName(worker.id, workerName.trim());
          worker.name = workerName.trim();
        }

        socket.data = { role: 'worker', workerId: worker.id } as SocketData;

        workers.set(worker.id, { ...worker, socketId: socket.id, status: 'online' });

        await WorkerModel.updateStatus(worker.id, 'online');

        return next();
      }

      return next(new Error('Invalid connection type'));
    } catch (err: any) {
      console.error('[AuthDebug] Error in middleware:', err);
      return next(new Error('Authentication error: ' + err.message));
    }
  });

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;


    if (data.role === 'worker' && data.workerId) {

      broadcastWorkerUpdates();
    }

    if (data.role === 'client' && data.user) {
      sendWorkerListToSocket(socket);
      scheduleSessionListBroadcast(true);
    }

    socket.on('disconnect', async () => {
      if (data.role === 'worker' && data.workerId) {
        workers.delete(data.workerId);
        await WorkerModel.updateStatus(data.workerId, 'offline');
        scheduleSessionListBroadcast(true);
        broadcastWorkerUpdates();
      }
      const removedSessionKeys = removeSocketFromAllSessions(socket.id);
      if (data.role === 'client' && removedSessionKeys.length > 0) {
        const workerIds = new Set<string>();
        for (const key of removedSessionKeys) {
          const session = activeSessions.get(key);
          if (session) workerIds.add(session.workerId);
        }
        for (const workerId of workerIds) {
          const worker = workers.get(workerId);
          if (worker) {
            io.to(worker.socketId).emit('client-disconnect', { clientId: socket.id });
          }
        }
      }
    });

    socket.on('heartbeat', async () => {
      if (data.role === 'worker' && data.workerId) {
        await WorkerModel.updateStatus(data.workerId, 'online');
      }
    });

    socket.on('register', (msg: { type?: string }) => {
      if (msg?.type === 'client' && data.role === 'client') {
        sendWorkerListToSocket(socket);
        scheduleSessionListBroadcast(true);
      }
    });

    socket.on('execute', async (msg: { workerId: string; command: string; sessionId?: string }) => {
      if (data.role !== 'client' || !data.user) return;
      const sessionId = normalizeSessionId(msg.sessionId || socket.id);

      const hasAccess = await WorkerModel.hasAccess(data.user.userId, msg.workerId, 'control');
      if (!hasAccess) {
        socket.emit('error', 'Acceso denegado al worker');
        return;
      }

      // Verificar límite de sesiones por plan
      const key = sessionKey(msg.workerId, sessionId);
      if (!activeSessions.has(key)) {
        // Es una sesión nueva — contar las del usuario
        const userPlan = await getUserPlan(data.user.userId);
        let userSessionCount = 0;
        for (const [, sess] of activeSessions) {
          const subs = sessionSubscribers.get(sessionKey(sess.workerId, sess.id));
          if (subs && subs.has(socket.id)) {
            userSessionCount++;
          }
        }
        const sessionCheck = canOpenSession(userPlan, userSessionCount);
        if (!sessionCheck.allowed) {
          socket.emit('plan-limit', {
            code: 'PLAN_LIMIT_SESSIONS',
            message: sessionCheck.reason,
            current: sessionCheck.current,
            max: sessionCheck.max,
          });
          return;
        }
      }

      const worker = workers.get(msg.workerId);
      if (!worker) {
        socket.emit('error', 'Worker no disponible (offline)');
        return;
      }

      const session = await ensureActiveSession(msg.workerId, sessionId, undefined, data.user.userId);
      session.lastActive = Date.now();
      addSessionSubscriber(msg.workerId, sessionId, socket.id);
      io.to(worker.socketId).emit('execute', {
        clientId: socket.id,
        command: msg.command,
        sessionId
      });

      scheduleSessionListBroadcast(true);
    });

    socket.on('resize', async (msg: { workerId: string; cols: number; rows: number; sessionId?: string }) => {
      if (data.role !== 'client' || !data.user) return;
      const sessionId = normalizeSessionId(msg.sessionId || socket.id);

      const hasAccess = await WorkerModel.hasAccess(data.user.userId, msg.workerId, 'control');
      if (!hasAccess) {
        socket.emit('error', 'Acceso denegado al worker');
        return;
      }
      const worker = workers.get(msg.workerId);
      if (!worker) {
        socket.emit('error', 'Worker no disponible (offline)');
        return;
      }
      await ensureActiveSession(msg.workerId, sessionId, undefined, data.user.userId);
      addSessionSubscriber(msg.workerId, sessionId, socket.id);
      io.to(worker.socketId).emit('resize', {
        clientId: socket.id,
        sessionId,
        cols: msg.cols,
        rows: msg.rows,
      });
    });

    socket.on('output', (msg: { sessionId?: string; output: string }) => {
      if (data.role !== 'worker' || !data.workerId) return;
      const sessionId = normalizeSessionId(msg.sessionId);
      const workerId = data.workerId;
      const subscriberKey = sessionKey(workerId, sessionId);
      void outputRelay.enqueue(subscriberKey, {
        workerId,
        sessionId,
        output: msg.output,
      }, async (batch) => {
        const session = await ensureActiveSession(workerId, sessionId);
        for (const item of batch) {
          session.output = `${session.output}${item.output}`.slice(-20000);
        }
        session.lastActive = Date.now();

        // One current-state authorization pass per ordered batch avoids a DB
        // query per chunk without introducing a revocation window.
        const authorizedSocketIds = await revalidateSubscribers(workerId, subscriberKey, 'view');
        const currentSubscribers = sessionSubscribers.get(subscriberKey);
        const liveAuthorizedIds = authorizedSocketIds.filter((socketId) => currentSubscribers?.has(socketId));
        if (liveAuthorizedIds.length > 0) {
          for (const item of batch) {
            io.to(liveAuthorizedIds).emit('output', {
              workerId,
              sessionId,
              data: item.output,
            });
          }
        }
        // Debounced session list updates to avoid heavy fan-out on every chunk.
        scheduleSessionListBroadcast();
      }).catch((error) => console.error('[Socket] Output relay error:', error));
    });

    socket.on('session-shell-exited', async (msg: { sessionId?: string }) => {
      if (data.role !== 'worker' || !data.workerId) return;
      const sessionId = normalizeSessionId(msg.sessionId);
      const key = sessionKey(data.workerId, sessionId);
      activeSessions.delete(key);
      const subscriberKey = sessionKey(data.workerId, sessionId);
      const authorizedSocketIds = await revalidateSubscribers(data.workerId, subscriberKey, 'view');
      if (authorizedSocketIds.length > 0) {
        io.to(authorizedSocketIds).emit('session-closed', { sessionId, workerId: data.workerId });
      }
      sessionSubscribers.delete(subscriberKey);
      scheduleSessionListBroadcast(true);
    });

    socket.on('subscribe', async (msg: { workerId: string }) => {
      if (data.role !== 'client' || !data.user) return;
      const hasAccess = await WorkerModel.hasAccess(data.user.userId, msg.workerId, 'view');
      if (hasAccess) {
        socket.join(`worker:${msg.workerId}`);
      } else {
        socket.emit('error', 'Acceso denegado');
      }
    });

    socket.on('create-session', async (msg: { id: string; workerName?: string; workerKey?: string; displayName?: string }) => {
      if (data.role !== 'client' || !data.user) return;
      const sessionId = normalizeSessionId(msg.id);

      // Find workerId by workerName/workerKey
      let workerId: string | undefined;
      if (msg.workerKey || msg.workerName) {
        const key = (msg.workerKey || msg.workerName || '').toLowerCase();
        for (const [wId, w] of workers.entries()) {
          if (w.name.toLowerCase() === key) {
            workerId = wId;
            break;
          }
        }
      }

      if (workerId) {
        const hasAccess = await WorkerModel.hasAccess(data.user.userId, workerId, 'control');
        if (!hasAccess) return;

        await ensureActiveSession(workerId, sessionId, msg.displayName, data.user.userId);
        addSessionSubscriber(workerId, sessionId, socket.id);
        scheduleSessionListBroadcast(true);
      }
    });

    socket.on('join-session', async (msg: { sessionId: string; workerId: string; displayName?: string }) => {
      if (data.role !== 'client' || !data.user) return;
      const sessionId = normalizeSessionId(msg.sessionId || socket.id);
      const workerId = String(msg.workerId || '').trim();
      if (!workerId) {
        socket.emit('error', 'workerId requerido');
        return;
      }

      const hasAccess = await WorkerModel.hasAccess(data.user.userId, workerId, 'view');
      if (!hasAccess) {
        socket.emit('error', 'Acceso denegado al worker');
        return;
      }
      const session = await ensureActiveSession(workerId, sessionId, msg.displayName, data.user.userId);
      session.lastActive = Date.now();
      // Register only after authorization. Adding the socket before this
      // check let a caller receive future output from another tenant.
      addSessionSubscriber(workerId, sessionId, socket.id);
      scheduleSessionListBroadcast(true);
    });

    socket.on('leave-session', (msg: { workerId: string; sessionId: string }) => {
      if (data.role !== 'client' || !data.user) return;
      const workerId = String(msg.workerId || '').trim();
      if (!workerId) {
        socket.emit('error', 'workerId requerido');
        return;
      }
      const sessionId = normalizeSessionId(msg.sessionId || socket.id);
      removeSessionSubscriber(workerId, sessionId, socket.id);
    });

    socket.on('rename-session', async (msg: { workerId: string; sessionId: string; newName: string }) => {
      if (data.role !== 'client' || !data.user) return;
      const workerId = String(msg.workerId || '').trim();
      if (!workerId) {
        socket.emit('error', 'workerId requerido');
        return;
      }
      const sessionId = normalizeSessionId(msg.sessionId);
      const newName = (msg.newName || '').trim();
      if (!newName) return;

      const session = activeSessions.get(sessionKey(workerId, sessionId));
      if (!session) return;

      const hasAccess = await WorkerModel.hasAccess(data.user.userId, workerId, 'control');
      if (!hasAccess) return;

      session.displayName = newName;
      try {
        await db.run('UPDATE sessions SET display_name = ? WHERE id = ? AND worker_id = ?', [newName, sessionId, workerId]);
      } catch (err) {
        console.error('Failed to update session name in DB:', err);
      }
      scheduleSessionListBroadcast(true);
    });

    socket.on('close-session', async (msg: { workerId: string; sessionId: string }) => {
      if (data.role !== 'client' || !data.user) return;
      const workerId = String(msg.workerId || '').trim();
      if (!workerId) {
        socket.emit('error', 'workerId requerido');
        return;
      }
      const sessionId = normalizeSessionId(msg.sessionId);

      const session = activeSessions.get(sessionKey(workerId, sessionId));
      if (!session) return;

      const hasAccess = await WorkerModel.hasAccess(data.user.userId, workerId, 'control');
      if (!hasAccess) return;

      const worker = workers.get(session.workerId);
      if (worker) {
        const workerSocket = io.sockets.sockets.get(worker.socketId);
        if (workerSocket) {
          workerSocket.emit('kill-session', { sessionId });
        }
      }

      const key = sessionKey(session.workerId, sessionId);
      activeSessions.delete(key);

      // Notify ALL subscribers that this session was closed (cross-device sync)
      const subscriberKey = sessionKey(session.workerId, sessionId);
      const authorizedSocketIds = await revalidateSubscribers(session.workerId, subscriberKey, 'view');
      if (authorizedSocketIds.length > 0) {
        io.to(authorizedSocketIds).emit('session-closed', { sessionId, workerId: session.workerId });
      }
      sessionSubscribers.delete(subscriberKey);
      scheduleSessionListBroadcast(true);
    });

    socket.on('get-session-output', async (msg: { workerId: string; sessionId: string }, cb?: (output: string) => void) => {
      if (data.role !== 'client' || !data.user) return;
      const workerId = String(msg.workerId || '').trim();
      if (!workerId) {
        if (cb) cb('');
        socket.emit('error', 'workerId requerido');
        return;
      }
      const sessionId = normalizeSessionId(msg.sessionId);

      const session = activeSessions.get(sessionKey(workerId, sessionId));
      if (session) {
        const hasAccess = await WorkerModel.hasAccess(data.user!.userId, workerId, 'view');
        if (hasAccess && cb) {
          cb(session.output || '');
        }
      } else if (cb) {
        cb('');
      }
    });
  });

  return io;
};

import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';

interface Worker {
  id: string;
  socketId: string;
  name: string;
  lastSeen: number;
  status: 'online' | 'offline';
}

interface AuthState {
  passwordHash: string;
  salt: string;
  iterations: number;
  updatedAt: string;
}

interface SharedSession {
  id: string;
  workerName: string;
  workerKey: string;
  displayName: string;
  createdAt: number;
  lastActiveAt: number;
  output: string;
}

const app = express();
const httpServer = createServer(app);

const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = clientOrigin.split(',').map((o) => o.trim());
const corsOrigin = allowedOrigins.includes('*') ? '*' : allowedOrigins;

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
  },
});

// Database setup
const dataDir = path.resolve(process.cwd(), '.qodo');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'nexus.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    iterations INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    worker_name TEXT NOT NULL,
    worker_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    output TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event TEXT NOT NULL,
    data TEXT NOT NULL
  );
`);

const auditFilePath = path.join(dataDir, 'audit.log');

// In-memory sessions store
let sharedSessions: Map<string, SharedSession> = new Map();
const MAX_OUTPUT_CHARS = 50000;
const SESSION_SAVE_DEBOUNCE_MS = 2000;
let sessionSaveTimer: NodeJS.Timeout | null = null;

// Track clients connected to each session with their viewport sizes
// sessionId -> Map<clientSocketId, {cols, rows}>
const sessionClients: Map<string, Map<string, { cols: number; rows: number }>> = new Map();
// Track current PTY size for each session
const sessionPtySizes: Map<string, { cols: number; rows: number }> = new Map();

// Calculate the maximum size needed for a session based on all connected clients
function getMaxSessionSize(sessionId: string): { cols: number; rows: number } {
  const clients = sessionClients.get(sessionId);
  if (!clients || clients.size === 0) {
    return { cols: 80, rows: 24 }; // Default
  }
  let maxCols = 80, maxRows = 24;
  clients.forEach(size => {
    maxCols = Math.max(maxCols, size.cols);
    maxRows = Math.max(maxRows, size.rows);
  });
  return { cols: maxCols, rows: maxRows };
}

const rawJwtSecret = (process.env.NEXUS_JWT_SECRET || '').trim();
const jwtSecret = resolveJwtSecret(rawJwtSecret);
const workerSharedToken = (process.env.WORKER_TOKEN || '').trim();
const setupToken = (process.env.NEXUS_SETUP_TOKEN || '').trim();

const normalizeWorkerKey = (name: string) => name.trim().toLowerCase();
const allowInsecureWorkers = /^(true|1|yes)$/i.test(process.env.ALLOW_UNAUTHENTICATED_WORKERS || '');
const workers: Map<string, Worker> = new Map();
const HEALTH_TIMEOUT_MS = Number(process.env.WORKER_HEALTH_TIMEOUT_MS || 15000);
const HEALTH_CHECK_INTERVAL_MS = 5000;

if (!setupToken) {
  console.log('[Nexus] Setup is restricted to localhost. Set NEXUS_SETUP_TOKEN to allow remote setup.');
}
if (!workerSharedToken) {
  if (allowInsecureWorkers) {
    console.warn('[Nexus] WORKER_TOKEN is empty. Accepting unauthenticated workers because ALLOW_UNAUTHENTICATED_WORKERS=true.');
  } else {
    console.warn('[Nexus] WORKER_TOKEN is empty. Workers will be rejected unless ALLOW_UNAUTHENTICATED_WORKERS=true.');
  }
}

setInterval(() => {
  let changed = false;
  const now = Date.now();
  workers.forEach((worker) => {
    const offline = now - worker.lastSeen > HEALTH_TIMEOUT_MS;
    const desiredStatus: Worker['status'] = offline ? 'offline' : 'online';
    if (worker.status !== desiredStatus) {
      worker.status = desiredStatus;
      changed = true;
    }
  });
  if (changed) broadcastWorkerList();
}, HEALTH_CHECK_INTERVAL_MS);

function hashPassword(password: string, salt?: string, iterations = 150000) {
  const resolvedSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, resolvedSalt, iterations, 64, 'sha512').toString('hex');
  return { hash, salt: resolvedSalt, iterations };
}

function safeEqual(a: string, b: string) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyPassword(password: string, state: AuthState) {
  const { hash } = hashPassword(password, state.salt, state.iterations);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(state.passwordHash, 'hex'));
}

function resolveJwtSecret(secret: string) {
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXUS_JWT_SECRET must be set in production.');
  }
  const generated = crypto.randomBytes(48).toString('hex');
  console.warn('[Nexus] NEXUS_JWT_SECRET is not set. Using a random secret for this run.');
  return generated;
}

function isLoopbackRequest(req: Request) {
  const ip = req.ip || req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isSetupAllowed(req: Request) {
  if (!setupToken) return isLoopbackRequest(req);
  const token = req.header('x-setup-token') || (req.body?.setupToken as string | undefined);
  if (!token) return false;
  return safeEqual(token, setupToken);
}

async function appendAudit(entry: Record<string, any>) {
  try {
    const stmt = db.prepare('INSERT INTO audit (ts, event, data) VALUES (?, ?, ?)');
    stmt.run(new Date().toISOString(), entry.event || 'unknown', JSON.stringify(entry));
  } catch (err) {
    console.error('Failed to write audit entry', err);
  }
}

function loadSessionsFromDb(): Map<string, SharedSession> {
  const rows = db.prepare('SELECT * FROM sessions').all() as Array<{
    id: string; worker_name: string; worker_key: string; display_name: string;
    created_at: number; last_active_at: number; output: string;
  }>;
  return new Map(rows.map(r => [r.id, {
    id: r.id,
    workerName: r.worker_name,
    workerKey: r.worker_key,
    displayName: r.display_name,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    output: r.output,
  }]));
}

function saveSessionToDb(session: SharedSession) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, worker_name, worker_key, display_name, created_at, last_active_at, output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(session.id, session.workerName, session.workerKey, session.displayName, 
           session.createdAt, session.lastActiveAt, session.output);
}

function deleteSessionFromDb(sessionId: string) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function scheduleSessionSave(session: SharedSession) {
  // Debounce writes per session
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    saveSessionToDb(session);
    sessionSaveTimer = null;
  }, SESSION_SAVE_DEBOUNCE_MS);
}

function broadcastSessionList() {
  const sessions = Array.from(sharedSessions.values()).map(s => ({
    ...s,
    output: undefined // Don't send full output in list
  }));
  io.emit('session-list', sessions);
}

function serializeWorkers() {
  return Array.from(workers.values()).map((w) => ({
    ...w,
    lastSeen: w.lastSeen,
  }));
}

function broadcastWorkerList() {
  io.emit('worker-list', serializeWorkers());
}

async function loadAuthState(): Promise<AuthState | null> {
  const row = db.prepare('SELECT * FROM auth WHERE id = 1').get() as {
    password_hash: string; salt: string; iterations: number; updated_at: string;
  } | undefined;
  if (!row) return null;
  return {
    passwordHash: row.password_hash,
    salt: row.salt,
    iterations: row.iterations,
    updatedAt: row.updated_at,
  };
}

async function saveAuthState(state: AuthState) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO auth (id, password_hash, salt, iterations, updated_at)
    VALUES (1, ?, ?, ?, ?)
  `);
  stmt.run(state.passwordHash, state.salt, state.iterations, state.updatedAt);
}

function signToken() {
  return jwt.sign({ role: 'admin' }, jwtSecret, { expiresIn: '12h' });
}

async function bootstrapInitialPassword() {
  const existing = await loadAuthState();
  if (existing) return;
  const envPassword = process.env.ADMIN_PASSWORD;
  if (!envPassword) return;
  const { hash, salt, iterations } = hashPassword(envPassword);
  await saveAuthState({ passwordHash: hash, salt, iterations, updatedAt: new Date().toISOString() });
}

function extractToken(req: Request) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.substring('Bearer '.length);
  return undefined;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    jwt.verify(token, jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/api/auth/status', async (_req, res) => {
  const state = await loadAuthState();
  res.json({ needsSetup: !state });
});

app.post('/api/auth/setup', async (req, res) => {
  const state = await loadAuthState();
  if (state) return res.status(400).json({ error: 'Already configured' });
  if (!isSetupAllowed(req)) {
    return res.status(403).json({
      error: setupToken ? 'Invalid setup token' : 'Setup allowed only from localhost',
    });
  }
  const { password } = req.body as { password?: string };
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const { hash, salt, iterations } = hashPassword(password);
  await saveAuthState({ passwordHash: hash, salt, iterations, updatedAt: new Date().toISOString() });
  const token = signToken();
  res.json({ token });
});

app.post('/api/auth/login', async (req, res) => {
  const state = await loadAuthState();
  if (!state) return res.status(400).json({ error: 'Not configured' });
  const { password } = req.body as { password?: string };
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!verifyPassword(password, state)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signToken();
  res.json({ token });
});

app.post('/api/auth/password', requireAuth, async (req, res) => {
  const state = await loadAuthState();
  if (!state) return res.status(400).json({ error: 'Not configured' });
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (!verifyPassword(currentPassword, state)) return res.status(401).json({ error: 'Invalid credentials' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password too short' });
  const { hash, salt, iterations } = hashPassword(newPassword);
  await saveAuthState({ passwordHash: hash, salt, iterations, updatedAt: new Date().toISOString() });
  res.json({ ok: true });
});

io.use(async (socket, next) => {
  const { token, type, workerToken } = (socket.handshake.auth || {}) as {
    token?: string;
    type?: string;
    workerToken?: string;
  };
  try {
    if (type === 'client') {
      if (!token) return next(new Error('Missing token'));
      jwt.verify(token, jwtSecret);
      socket.data.role = 'client';
      return next();
    }
    if (type === 'worker') {
      if (workerSharedToken) {
        if (!workerToken || !safeEqual(workerToken, workerSharedToken)) {
          return next(new Error('Unauthorized worker'));
        }
      } else if (!allowInsecureWorkers) {
        return next(new Error('Worker auth required'));
      }
      socket.data.role = 'worker';
      return next();
    }
    return next(new Error('Missing type'));
  } catch (err) {
    return next(err as Error);
  }
});

io.on('connection', (socket: Socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on('register', (data: { type: 'worker' | 'client'; name?: string; workerToken?: string }) => {
    if (data.type === 'worker') {
      if (socket.data.role !== 'worker') return;
      const worker: Worker = {
        id: socket.id,
        socketId: socket.id,
        name: data.name || `Worker-${socket.id.substring(0, 4)}`,
        lastSeen: Date.now(),
        status: 'online',
      };
      workers.set(socket.id, worker);
      console.log(`Worker registered: ${worker.name}`);
      broadcastWorkerList();
    } else {
      if (socket.data.role !== 'client') return;
      console.log(`Client registered: ${socket.id}`);
      socket.emit('worker-list', serializeWorkers());
      // Client will request session-list via 'get-session-list' after processing workers
    }
  });

  // Session management events
  socket.on('create-session', (data: { id: string; workerName: string; workerKey: string; displayName: string }) => {
    if (socket.data.role !== 'client') return;
    const session: SharedSession = {
      id: data.id,
      workerName: data.workerName,
      workerKey: data.workerKey,
      displayName: data.displayName,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      output: '',
    };
    sharedSessions.set(data.id, session);
    saveSessionToDb(session);
    broadcastSessionList();
  });

  socket.on('close-session', (data: { sessionId: string }) => {
    if (socket.data.role !== 'client') return;
    const session = sharedSessions.get(data.sessionId);
    if (session) {
      // Find the worker for this session and tell it to kill the PTY
      const worker = Array.from(workers.values()).find(w => 
        normalizeWorkerKey(w.name) === session.workerKey
      );
      if (worker) {
        io.to(worker.socketId).emit('kill-session', { sessionId: data.sessionId });
      }
      
      sharedSessions.delete(data.sessionId);
      deleteSessionFromDb(data.sessionId);
      broadcastSessionList();
      io.emit('session-closed', { sessionId: data.sessionId });
    }
  });

  socket.on('rename-session', (data: { sessionId: string; displayName: string }) => {
    if (socket.data.role !== 'client') return;
    const session = sharedSessions.get(data.sessionId);
    if (session) {
      session.displayName = data.displayName;
      saveSessionToDb(session);
      broadcastSessionList();
    }
  });

  socket.on('get-session-output', (data: { sessionId: string }, callback: (output: string) => void) => {
    if (socket.data.role !== 'client') return;
    const session = sharedSessions.get(data.sessionId);
    if (session && typeof callback === 'function') {
      callback(session.output);
    }
  });

  socket.on('get-session-list', () => {
    if (socket.data.role !== 'client') return;
    const sessions = Array.from(sharedSessions.values()).map(s => ({
      ...s,
      output: undefined
    }));
    socket.emit('session-list', sessions);
  });

  socket.on('execute', (data: { workerId: string; sessionId?: string; command: string }) => {
    if (socket.data.role !== 'client') return;
    if (!data.command || data.command.length > 4096) return;
    const worker = workers.get(data.workerId);
    if (worker) {
      if (data.command.includes('\n') || data.command.includes('\r') || data.command.trim().length > 1) {
        void appendAudit({
          event: 'execute',
          workerId: worker.id,
          workerName: worker.name,
          clientId: socket.id,
          commandPreview: data.command.slice(0, 200),
          length: data.command.length,
        });
      }
      io.to(worker.socketId).emit('execute', {
        clientId: socket.id,
        sessionId: data.sessionId,
        command: data.command,
      });
    }
  });

  socket.on('heartbeat', () => {
    if (socket.data.role !== 'worker') return;
    const worker = workers.get(socket.id);
    if (worker) {
      worker.lastSeen = Date.now();
      worker.status = 'online';
    }
  });

  socket.on('resize', (data: { workerId: string; sessionId?: string; cols: number; rows: number }) => {
    if (socket.data.role !== 'client') return;
    const worker = workers.get(data.workerId);
    if (!worker || !data.sessionId) return;
    
    // Track this client's viewport size for the session
    if (!sessionClients.has(data.sessionId)) {
      sessionClients.set(data.sessionId, new Map());
    }
    sessionClients.get(data.sessionId)!.set(socket.id, { cols: data.cols, rows: data.rows });
    
    // Calculate max size needed across all clients viewing this session
    const maxSize = getMaxSessionSize(data.sessionId);
    const currentPtySize = sessionPtySizes.get(data.sessionId) || { cols: 80, rows: 24 };
    
    // Only resize PTY if the new max is larger than current
    // (we never shrink while clients are connected)
    if (maxSize.cols > currentPtySize.cols || maxSize.rows > currentPtySize.rows) {
      const newCols = Math.max(maxSize.cols, currentPtySize.cols);
      const newRows = Math.max(maxSize.rows, currentPtySize.rows);
      sessionPtySizes.set(data.sessionId, { cols: newCols, rows: newRows });
      
      console.log(`[Nexus] Session ${data.sessionId.slice(-8)} resize: ${currentPtySize.cols}x${currentPtySize.rows} -> ${newCols}x${newRows} (client ${socket.id.slice(-6)}: ${data.cols}x${data.rows})`);
      
      io.to(worker.socketId).emit('resize', { 
        clientId: socket.id,
        sessionId: data.sessionId,
        cols: newCols, 
        rows: newRows 
      });
    }
  });

  // Client joining a session - track their viewport
  socket.on('join-session', (data: { sessionId: string; cols: number; rows: number }) => {
    if (socket.data.role !== 'client') return;
    if (!sessionClients.has(data.sessionId)) {
      sessionClients.set(data.sessionId, new Map());
    }
    sessionClients.get(data.sessionId)!.set(socket.id, { cols: data.cols, rows: data.rows });
    console.log(`[Nexus] Client ${socket.id.slice(-6)} joined session ${data.sessionId.slice(-8)} with viewport ${data.cols}x${data.rows}`);
  });

  // Client leaving a session
  socket.on('leave-session', (data: { sessionId: string }) => {
    if (socket.data.role !== 'client') return;
    const clients = sessionClients.get(data.sessionId);
    if (clients) {
      clients.delete(socket.id);
      // If no more clients, we could shrink the PTY, but we'll leave it for now
      // to avoid disrupting any background processes
      console.log(`[Nexus] Client ${socket.id.slice(-6)} left session ${data.sessionId.slice(-8)}`);
    }
  });

  socket.on('output', (data: { clientId?: string; sessionId?: string; output: string }) => {
    if (socket.data.role !== 'worker') return;
    
    // Store output in shared session
    if (data.sessionId) {
      const session = sharedSessions.get(data.sessionId);
      if (session) {
        session.output = (session.output + data.output).slice(-MAX_OUTPUT_CHARS);
        session.lastActiveAt = Date.now();
        scheduleSessionSave(session);
      }
    }
    
    // Broadcast to all clients so everyone sees the output
    io.emit('output', {
      workerId: socket.id,
      sessionId: data.sessionId,
      data: data.output,
    });
  });

  socket.on('disconnect', () => {
    if (workers.has(socket.id)) {
      console.log(`Worker disconnected: ${workers.get(socket.id)?.name}`);
      workers.delete(socket.id);
      broadcastWorkerList();
    } else if (socket.data.role === 'client') {
      // Remove client from all session tracking
      sessionClients.forEach((clients, sessionId) => {
        if (clients.has(socket.id)) {
          clients.delete(socket.id);
          console.log(`[Nexus] Client ${socket.id.slice(-6)} removed from session ${sessionId.slice(-8)} tracking`);
          
          // Recalculate and potentially shrink PTY if this was the largest client
          if (clients.size > 0) {
            const newMax = getMaxSessionSize(sessionId);
            const currentSize = sessionPtySizes.get(sessionId);
            if (currentSize && (newMax.cols < currentSize.cols || newMax.rows < currentSize.rows)) {
              // Find the worker for this session and resize
              const session = sharedSessions.get(sessionId);
              if (session) {
                const worker = Array.from(workers.values()).find(w => 
                  normalizeWorkerKey(w.name) === session.workerKey
                );
                if (worker) {
                  sessionPtySizes.set(sessionId, newMax);
                  console.log(`[Nexus] Session ${sessionId.slice(-8)} shrink: ${currentSize.cols}x${currentSize.rows} -> ${newMax.cols}x${newMax.rows}`);
                  io.to(worker.socketId).emit('resize', {
                    clientId: socket.id,
                    sessionId: sessionId,
                    cols: newMax.cols,
                    rows: newMax.rows
                  });
                }
              }
            }
          }
        }
      });
      
      // Notify all workers that this client has disconnected
      console.log(`Client disconnected: ${socket.id}`);
      workers.forEach((worker) => {
        io.to(worker.socketId).emit('client-disconnect', { clientId: socket.id });
      });
    }
    console.log(`Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3002;

// Serve static client files
const clientDistPath = path.resolve(process.cwd(), 'public');
if (existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  // SPA fallback - serve index.html for all non-API routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
  console.log(`Serving client from ${clientDistPath}`);
}

// Load sessions from SQLite and start server
sharedSessions = loadSessionsFromDb();
console.log(`[Nexus] Loaded ${sharedSessions.size} sessions from database`);

bootstrapInitialPassword()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Nexus running on port ${PORT}`);
      console.log(`[Nexus] Database: ${dbPath}`);
      if (!process.env.ADMIN_PASSWORD) {
        console.log('If first run, call /api/auth/setup to configure the admin password.');
      }
    });
  })
  .catch((err) => {
    console.error('Failed to start Nexus:', err);
    process.exit(1);
  });

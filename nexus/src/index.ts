import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

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

const authFilePath = path.resolve(process.cwd(), '.qodo', 'auth.json');
const auditFilePath = path.resolve(process.cwd(), '.qodo', 'audit.log');
const rawJwtSecret = (process.env.NEXUS_JWT_SECRET || '').trim();
const jwtSecret = resolveJwtSecret(rawJwtSecret);
const workerSharedToken = (process.env.WORKER_TOKEN || '').trim();
const setupToken = (process.env.NEXUS_SETUP_TOKEN || '').trim();
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

async function ensureAuthDir() {
  const dir = path.dirname(authFilePath);
  await fs.mkdir(dir, { recursive: true });
}

async function appendAudit(entry: Record<string, any>) {
  try {
    await ensureAuthDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    await fs.appendFile(auditFilePath, `${line}\n`, 'utf-8');
  } catch (err) {
    console.error('Failed to write audit entry', err);
  }
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
  try {
    const data = await fs.readFile(authFilePath, 'utf-8');
    return JSON.parse(data) as AuthState;
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function saveAuthState(state: AuthState) {
  await ensureAuthDir();
  await fs.writeFile(authFilePath, JSON.stringify(state, null, 2), 'utf-8');
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
    }
  });

  socket.on('execute', (data: { workerId: string; command: string }) => {
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

  socket.on('resize', (data: { workerId: string; cols: number; rows: number }) => {
    if (socket.data.role !== 'client') return;
    const worker = workers.get(data.workerId);
    if (worker) {
      io.to(worker.socketId).emit('resize', { 
        clientId: socket.id,
        cols: data.cols, 
        rows: data.rows 
      });
    }
  });

  socket.on('output', (data: { clientId?: string; output: string }) => {
    if (socket.data.role !== 'worker') return;
    if (data.clientId) {
      io.to(data.clientId).emit('output', {
        workerId: socket.id,
        data: data.output,
      });
    } else {
      io.emit('output', {
        workerId: socket.id,
        data: data.output,
      });
    }
  });

  socket.on('disconnect', () => {
    if (workers.has(socket.id)) {
      console.log(`Worker disconnected: ${workers.get(socket.id)?.name}`);
      workers.delete(socket.id);
      broadcastWorkerList();
    } else if (socket.data.role === 'client') {
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

bootstrapInitialPassword()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Nexus running on port ${PORT}`);
      if (!process.env.ADMIN_PASSWORD) {
        console.log('If first run, call /api/auth/setup to configure the admin password.');
      }
    });
  })
  .catch((err) => {
    console.error('Failed to start Nexus:', err);
    process.exit(1);
  });

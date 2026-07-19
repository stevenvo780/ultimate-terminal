import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'http';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { io, type Socket } from 'socket.io-client';
import Database from 'better-sqlite3';
import { OrderedRelayQueue } from '../nexus/src/services/ordered-relay';

const ADMIN_PASSWORD = 'audit-admin-dummy-only';
const TENANT_PASSWORD = 'audit-tenant-dummy-only';
const SETUP_TOKEN = 'audit-setup-dummy-only';

interface CreatedWorker {
  id: string;
  api_key: string;
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('No se pudo reservar un puerto'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url: string, process: ChildProcess, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (process.exitCode !== null) throw new Error(`Nexus terminó con ${process.exitCode}`);
    try {
      const response = await fetch(`${url}/api/auth/status`);
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Nexus no inició a tiempo');
}

async function connect(socket: Socket): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket no conectó a tiempo')), 4_000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isolatedSqliteEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.API_KEY;
  delete env.DATABASE_URL;
  return env;
}

describe('aislamiento multitenant', () => {
  let nexusProcess: ChildProcess;
  let dataDir: string;
  let nexusUrl: string;
  let adminToken: string;
  let miguelToken: string;
  let pabloToken: string;
  let pabloPeerToken: string;
  let pabloRevokedToken: string;

  const sockets: Socket[] = [];

  async function request(pathname: string, init: RequestInit = {}) {
    return fetch(`${nexusUrl}${pathname}`, init);
  }

  async function login(username: string, password: string): Promise<string> {
    const response = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { token: string };
    return body.token;
  }

  async function createWorker(token: string, name: string): Promise<CreatedWorker> {
    const response = await request('/api/workers', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<CreatedWorker>;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'ultimate-terminal-tenant-'));
    const port = await reservePort();
    nexusUrl = `http://127.0.0.1:${port}`;

    nexusProcess = spawn('npx', ['ts-node', 'nexus/src/index.ts'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...isolatedSqliteEnv(),
        PORT: String(port),
        NODE_ENV: 'test',
        NEXUS_DATA_DIR: dataDir,
        NEXUS_JWT_SECRET: 'audit-jwt-dummy-only',
        NEXUS_SETUP_TOKEN: SETUP_TOKEN,
        ADMIN_PASSWORD,
        SEED_TENANT_USERS: 'true',
        TENANT_DEFAULT_PASSWORD: TENANT_PASSWORD,
      },
      stdio: 'ignore',
    });

    await waitForServer(nexusUrl, nexusProcess);
    adminToken = await login('admin', ADMIN_PASSWORD);
    miguelToken = await login('miguel', TENANT_PASSWORD);
    pabloToken = await login('pablo', TENANT_PASSWORD);

    for (const username of ['miguel', 'pablo']) {
      const upgrade = await request('/api/admin/upgrade-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPassword: ADMIN_PASSWORD, username, plan: 'enterprise' }),
      });
      expect(upgrade.status).toBe(200);
    }

    const register = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'pablo-peer',
        password: TENANT_PASSWORD,
        setupToken: SETUP_TOKEN,
      }),
    });
    expect(register.status).toBe(200);

    const assignTenant = await request('/api/admin/upgrade-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminPassword: ADMIN_PASSWORD,
        username: 'pablo-peer',
        plan: 'enterprise',
        tenant: 'pablo',
      }),
    });
    expect(assignTenant.status).toBe(200);
    pabloPeerToken = await login('pablo-peer', TENANT_PASSWORD);

    const registerRevoked = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'pablo-revoked',
        password: TENANT_PASSWORD,
        setupToken: SETUP_TOKEN,
      }),
    });
    expect(registerRevoked.status).toBe(200);
    const assignRevokedTenant = await request('/api/admin/upgrade-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminPassword: ADMIN_PASSWORD,
        username: 'pablo-revoked',
        plan: 'enterprise',
        tenant: 'pablo',
      }),
    });
    expect(assignRevokedTenant.status).toBe(200);
    pabloRevokedToken = await login('pablo-revoked', TENANT_PASSWORD);
  }, 15_000);

  afterAll(async () => {
    sockets.forEach((socket) => socket.disconnect());
    nexusProcess?.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  });

  it('serializa bursts con latencias invertidas y agrupa chequeos de acceso', async () => {
    const relay = new OrderedRelayQueue<number>();
    const delivered: number[] = [];
    let authorizationChecks = 0;
    const consume = async (batch: number[]) => {
      authorizationChecks += 1;
      // El primer chequeo es deliberadamente más lento que el siguiente.
      await delay(batch[0] === 1 ? 80 : 0);
      delivered.push(...batch);
    };

    const first = relay.enqueue('worker:session', 1, consume);
    await delay(5);
    const rest = [2, 3, 4].map((value) => relay.enqueue('worker:session', value, consume));
    await Promise.all([first, ...rest]);

    expect(delivered).toEqual([1, 2, 3, 4]);
    expect(authorizationChecks).toBe(2);
  });

  it('mantiene el roster canónico de 12 agentes e incluye Argos con workers estables', async () => {
    const response = await request('/api/agents', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const agents = await response.json() as Array<Record<string, unknown>>;
    expect(agents).toContainEqual(expect.objectContaining({
      tenantId: 'steven',
      key: 'argos',
      displayName: 'Argos',
      tuiWorker: 'agv2-steven-argos-tui',
      shellWorker: 'agv2-steven-argos',
    }));
    expect(agents).toHaveLength(12);
    expect(agents.map((agent) => agent.key).sort()).toEqual([
      'argos', 'dedalo', 'hegel', 'janus', 'jarvis', 'kant',
      'kratos', 'midas', 'salva', 'seneca', 'socrates', 'vulcano',
    ]);
  });

  it('rechaza join de worker entre tenants y permite join dentro del mismo tenant', async () => {
    const miguelWorker = await createWorker(miguelToken, 'audit-miguel-worker');
    const denied = await request('/api/workers/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pabloToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: miguelWorker.id }),
    });
    expect(denied.status).toBe(403);

    const pabloWorker = await createWorker(pabloToken, 'audit-pablo-worker');
    const allowed = await request('/api/workers/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pabloPeerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: pabloWorker.id }),
    });
    expect(allowed.status).toBe(200);

    const peerWorkers = await request('/api/workers', {
      headers: { Authorization: `Bearer ${pabloPeerToken}` },
    });
    expect(peerWorkers.status).toBe(200);
    const workers = await peerWorkers.json() as Array<{ id: string; permission: string }>;
    expect(workers).toContainEqual(expect.objectContaining({ id: pabloWorker.id, permission: 'control' }));
    expect(workers.some((worker) => worker.id === miguelWorker.id)).toBe(false);
  });

  it('rechaza share entre tenants incluso para admin global y permite el mismo tenant', async () => {
    const pabloWorker = await createWorker(pabloToken, 'audit-pablo-share-worker');
    const crossTenant = await request('/api/workers/share', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pabloToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: pabloWorker.id, targetUsername: 'miguel' }),
    });
    expect(crossTenant.status).toBe(403);

    const sameTenant = await request('/api/workers/share', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pabloToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: pabloWorker.id, targetUsername: 'pablo-peer' }),
    });
    expect(sameTenant.status).toBe(200);

    const miguelWorker = await createWorker(miguelToken, 'audit-admin-share-worker');
    const globalAdmin = await request('/api/workers/share', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: miguelWorker.id, targetUsername: 'pablo' }),
    });
    expect(globalAdmin.status).toBe(403);

    const sharesAfterReject = await request(`/api/workers/${miguelWorker.id}/shares`, {
      headers: { Authorization: `Bearer ${miguelToken}` },
    });
    expect(sharesAfterReject.status).toBe(200);
    const rejectedShares = await sharesAfterReject.json() as Array<{ username: string }>;
    expect(rejectedShares.some((entry) => entry.username === 'pablo')).toBe(false);
  });

  it('mantiene api_key fuera de listados REST/Socket y no deja una credencial reutilizable al compartido', async () => {
    const worker = await createWorker(pabloToken, 'audit-public-worker-shape');
    expect(worker.api_key).toBeTypeOf('string');

    const share = await request('/api/workers/share', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pabloToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: worker.id, targetUsername: 'pablo-peer' }),
    });
    expect(share.status).toBe(200);

    const peerListResponse = await request('/api/workers', {
      headers: { Authorization: `Bearer ${pabloPeerToken}` },
    });
    expect(peerListResponse.status).toBe(200);
    const peerList = await peerListResponse.json() as Array<Record<string, unknown>>;
    const peerWorker = peerList.find((item) => item.id === worker.id);
    expect(peerWorker).toBeDefined();
    expect(peerWorker).not.toHaveProperty('api_key');

    const adminListResponse = await request('/api/workers', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(adminListResponse.status).toBe(200);
    const adminList = await adminListResponse.json() as Array<Record<string, unknown>>;
    expect(adminList.every((item) => !Object.hasOwn(item, 'api_key'))).toBe(true);

    const peerSocket = io(nexusUrl, {
      autoConnect: false,
      auth: { type: 'client', token: pabloPeerToken },
    });
    sockets.push(peerSocket);
    const socketListPromise = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No llegó el listado Socket.IO')), 2_000);
      peerSocket.once('workers', (list) => {
        clearTimeout(timeout);
        resolve(list as Array<Record<string, unknown>>);
      });
    });
    peerSocket.connect();
    await connect(peerSocket);
    const socketList = await socketListPromise;
    const socketWorker = socketList.find((item) => item.id === worker.id);
    expect(socketWorker).toBeDefined();
    expect(socketWorker).not.toHaveProperty('api_key');

    // The shared user's only worker representations are the public REST/Socket
    // shapes. Reusing the absent field as a worker credential must fail closed.
    const unavailableKey = socketWorker?.api_key;
    expect(unavailableKey).toBeUndefined();
    const impersonationSocket = io(nexusUrl, {
      autoConnect: false,
      reconnection: false,
      auth: {
        type: 'worker',
        apiKey: unavailableKey,
        workerName: 'audit-impersonation-attempt',
      },
    });
    sockets.push(impersonationSocket);
    const rejected = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('La suplantación no fue rechazada')), 2_000);
      impersonationSocket.once('connect', () => {
        clearTimeout(timeout);
        reject(new Error('Una credencial ausente autenticó un worker'));
      });
      impersonationSocket.once('connect_error', (error) => {
        clearTimeout(timeout);
        resolve(error.message);
      });
    });
    impersonationSocket.connect();
    await expect(rejected).resolves.toMatch(/missing api key/i);
  });

  it('da al admin global listado y control socket de todos los workers', async () => {
    const miguelWorker = await createWorker(miguelToken, 'audit-admin-control-worker');
    const listResponse = await request('/api/workers', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(listResponse.status).toBe(200);
    const listedWorkers = await listResponse.json() as Array<{ id: string; permission: string }>;
    expect(listedWorkers).toContainEqual(expect.objectContaining({
      id: miguelWorker.id,
      permission: 'admin',
    }));

    const workerSocket = io(nexusUrl, {
      auth: { type: 'worker', apiKey: miguelWorker.api_key, workerName: 'audit-admin-control-worker' },
    });
    const adminSocket = io(nexusUrl, { auth: { type: 'client', token: adminToken } });
    sockets.push(workerSocket, adminSocket);
    await Promise.all([connect(workerSocket), connect(adminSocket)]);

    const resizeReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Admin no obtuvo control del worker')), 2_000);
      workerSocket.once('resize', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    adminSocket.emit('resize', {
      workerId: miguelWorker.id,
      sessionId: 'audit-admin-session',
      cols: 80,
      rows: 24,
    });
    await resizeReceived;
  });

  it('valida join-session antes de suscribir y no filtra output a otro tenant', async () => {
    const miguelWorker = await createWorker(miguelToken, 'audit-miguel-session-worker');
    const workerSocket = io(nexusUrl, {
      auth: { type: 'worker', apiKey: miguelWorker.api_key, workerName: 'audit-miguel-session-worker' },
    });
    const ownerSocket = io(nexusUrl, { auth: { type: 'client', token: miguelToken } });
    const intruderSocket = io(nexusUrl, { auth: { type: 'client', token: pabloToken } });
    sockets.push(workerSocket, ownerSocket, intruderSocket);
    await Promise.all([connect(workerSocket), connect(ownerSocket), connect(intruderSocket)]);

    const sessionId = 'audit-cross-tenant-session';
    ownerSocket.emit('resize', { workerId: miguelWorker.id, sessionId, cols: 80, rows: 24 });
    await delay(100);

    let leaked = false;
    intruderSocket.on('output', (message) => {
      if (message?.data === 'AUDIT_CROSS_TENANT_MARKER') leaked = true;
    });
    const denied = new Promise<void>((resolve) => {
      intruderSocket.once('error', () => resolve());
    });
    intruderSocket.emit('join-session', { workerId: miguelWorker.id, sessionId });
    await denied;

    workerSocket.emit('output', { sessionId, output: 'AUDIT_CROSS_TENANT_MARKER' });
    await delay(200);
    expect(leaked).toBe(false);
  });

  it('mantiene join-session funcional para usuarios del mismo tenant', async () => {
    const pabloWorker = await createWorker(pabloToken, 'audit-pablo-session-worker');
    const share = await request('/api/workers/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pabloPeerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: pabloWorker.id }),
    });
    expect(share.status).toBe(200);

    const workerSocket = io(nexusUrl, {
      auth: { type: 'worker', apiKey: pabloWorker.api_key, workerName: 'audit-pablo-session-worker' },
    });
    const ownerSocket = io(nexusUrl, { auth: { type: 'client', token: pabloToken } });
    const peerSocket = io(nexusUrl, { auth: { type: 'client', token: pabloPeerToken } });
    sockets.push(workerSocket, ownerSocket, peerSocket);
    await Promise.all([connect(workerSocket), connect(ownerSocket), connect(peerSocket)]);

    const sessionId = 'audit-same-tenant-session';
    ownerSocket.emit('resize', { workerId: pabloWorker.id, sessionId, cols: 80, rows: 24 });
    await delay(100);
    peerSocket.emit('join-session', { workerId: pabloWorker.id, sessionId });
    await delay(100);

    const received = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('El peer no recibió output')), 2_000);
      peerSocket.on('output', (message) => {
        if (message?.data !== 'AUDIT_SAME_TENANT_MARKER') return;
        clearTimeout(timeout);
        resolve();
      });
    });
    workerSocket.emit('output', { sessionId, output: 'AUDIT_SAME_TENANT_MARKER' });
    await received;
  });

  it('acota rename, close, get-output y leave por workerId con sessionId repetido', async () => {
    const miguelWorker = await createWorker(miguelToken, 'audit-miguel-ops-worker');
    const pabloWorker = await createWorker(pabloToken, 'audit-pablo-ops-worker');
    const miguelWorkerSocket = io(nexusUrl, {
      auth: { type: 'worker', apiKey: miguelWorker.api_key, workerName: 'audit-miguel-ops-worker' },
    });
    const pabloWorkerSocket = io(nexusUrl, {
      auth: { type: 'worker', apiKey: pabloWorker.api_key, workerName: 'audit-pablo-ops-worker' },
    });
    const miguelClient = io(nexusUrl, { auth: { type: 'client', token: miguelToken } });
    const pabloClient = io(nexusUrl, { auth: { type: 'client', token: pabloToken } });
    sockets.push(miguelWorkerSocket, pabloWorkerSocket, miguelClient, pabloClient);
    await Promise.all([
      connect(miguelWorkerSocket), connect(pabloWorkerSocket), connect(miguelClient), connect(pabloClient),
    ]);

    const sessionId = 'audit-shared-ops-session';
    miguelClient.emit('resize', { workerId: miguelWorker.id, sessionId, cols: 80, rows: 24 });
    pabloClient.emit('resize', { workerId: pabloWorker.id, sessionId, cols: 80, rows: 24 });
    await delay(150);
    miguelWorkerSocket.emit('output', { sessionId, output: 'MIGUEL_OUTPUT' });
    pabloWorkerSocket.emit('output', { sessionId, output: 'PABLO_OUTPUT' });
    await delay(100);

    const readOutput = (socket: Socket, workerId: string) => new Promise<string>((resolve) => {
      socket.emit('get-session-output', { workerId, sessionId }, (output: string) => resolve(output));
    });
    expect(await readOutput(miguelClient, miguelWorker.id)).toContain('MIGUEL_OUTPUT');
    expect(await readOutput(miguelClient, miguelWorker.id)).not.toContain('PABLO_OUTPUT');
    expect(await readOutput(pabloClient, pabloWorker.id)).toContain('PABLO_OUTPUT');
    expect(await readOutput(pabloClient, pabloWorker.id)).not.toContain('MIGUEL_OUTPUT');

    const renamed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Rename no se reflejó')), 2_000);
      const onList = (sessions: Array<{ workerId: string; id: string; displayName: string }>) => {
        if (!sessions.some((session) => session.workerId === pabloWorker.id
          && session.id === sessionId && session.displayName === 'Pablo Renamed')) return;
        clearTimeout(timeout);
        pabloClient.off('session-list', onList);
        resolve();
      };
      pabloClient.on('session-list', onList);
    });
    pabloClient.emit('rename-session', {
      workerId: pabloWorker.id,
      sessionId,
      newName: 'Pablo Renamed',
    });
    await renamed;
    expect(await readOutput(miguelClient, miguelWorker.id)).toContain('MIGUEL_OUTPUT');

    pabloClient.emit('leave-session', { workerId: pabloWorker.id, sessionId });
    await delay(100);
    let pabloReceivedAfterLeave = false;
    pabloClient.on('output', (message) => {
      if (message?.data === 'PABLO_AFTER_LEAVE') pabloReceivedAfterLeave = true;
    });
    pabloWorkerSocket.emit('output', { sessionId, output: 'PABLO_AFTER_LEAVE' });
    await delay(200);
    expect(pabloReceivedAfterLeave).toBe(false);

    const killed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Close no llegó al worker correcto')), 2_000);
      pabloWorkerSocket.once('kill-session', (message) => {
        if (message?.sessionId !== sessionId) return;
        clearTimeout(timeout);
        resolve();
      });
    });
    pabloClient.emit('close-session', { workerId: pabloWorker.id, sessionId });
    await killed;

    const miguelStillOpen = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Close afectó al worker vecino')), 2_000);
      miguelClient.on('output', (message) => {
        if (message?.data !== 'MIGUEL_STILL_OPEN') return;
        clearTimeout(timeout);
        resolve();
      });
    });
    miguelWorkerSocket.emit('output', { sessionId, output: 'MIGUEL_STILL_OPEN' });
    await miguelStillOpen;
  });

  it('revoca en caliente output y control tras unshare y cambio de tenant', async () => {
    const worker = await createWorker(pabloToken, 'audit-hot-revoke-worker');
    const initialShare = await request('/api/workers/share', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pabloToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: worker.id, targetUsername: 'pablo-revoked' }),
    });
    expect(initialShare.status).toBe(200);

    const sharesResponse = await request(`/api/workers/${worker.id}/shares`, {
      headers: { Authorization: `Bearer ${pabloToken}` },
    });
    const shares = await sharesResponse.json() as Array<{ userId: number; username: string }>;
    const revokedUserId = shares.find((share) => share.username === 'pablo-revoked')?.userId;
    expect(revokedUserId).toBeTypeOf('number');

    const workerSocket = io(nexusUrl, {
      auth: { type: 'worker', apiKey: worker.api_key, workerName: 'audit-hot-revoke-worker' },
    });
    const ownerSocket = io(nexusUrl, { auth: { type: 'client', token: pabloToken } });
    const revokedSocket = io(nexusUrl, { auth: { type: 'client', token: pabloRevokedToken } });
    sockets.push(workerSocket, ownerSocket, revokedSocket);
    await Promise.all([connect(workerSocket), connect(ownerSocket), connect(revokedSocket)]);

    const sessionId = 'audit-hot-revoke-session';
    ownerSocket.emit('resize', { workerId: worker.id, sessionId, cols: 80, rows: 24 });
    revokedSocket.emit('join-session', { workerId: worker.id, sessionId });
    await delay(150);

    const beforeRevoke = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Share inicial no funcionó')), 2_000);
      revokedSocket.on('output', (message) => {
        if (message?.data !== 'BEFORE_REVOKE') return;
        clearTimeout(timeout);
        resolve();
      });
    });
    workerSocket.emit('output', { sessionId, output: 'BEFORE_REVOKE' });
    await beforeRevoke;

    const unshare = await request('/api/workers/unshare', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pabloToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: worker.id, targetUserId: revokedUserId }),
    });
    expect(unshare.status).toBe(200);

    let outputAfterUnshare = false;
    let controlAfterUnshare = false;
    revokedSocket.on('output', (message) => {
      if (message?.data === 'AFTER_UNSHARE') outputAfterUnshare = true;
    });
    workerSocket.on('resize', (message) => {
      if (message?.sessionId === 'unauthorized-after-unshare') controlAfterUnshare = true;
    });
    workerSocket.emit('output', { sessionId, output: 'AFTER_UNSHARE' });
    revokedSocket.emit('resize', {
      workerId: worker.id,
      sessionId: 'unauthorized-after-unshare',
      cols: 90,
      rows: 30,
    });
    await delay(250);
    expect(outputAfterUnshare).toBe(false);
    expect(controlAfterUnshare).toBe(false);

    const reshare = await request('/api/workers/share', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pabloToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: worker.id, targetUsername: 'pablo-revoked' }),
    });
    expect(reshare.status).toBe(200);
    revokedSocket.emit('join-session', { workerId: worker.id, sessionId });
    await delay(100);

    const moveTenant = await request('/api/admin/upgrade-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminPassword: ADMIN_PASSWORD,
        username: 'pablo-revoked',
        plan: 'enterprise',
        tenant: 'miguel',
      }),
    });
    expect(moveTenant.status).toBe(200);

    let outputAfterMove = false;
    let controlAfterMove = false;
    revokedSocket.on('output', (message) => {
      if (message?.data === 'AFTER_TENANT_MOVE') outputAfterMove = true;
    });
    workerSocket.on('resize', (message) => {
      if (message?.sessionId === 'unauthorized-after-move') controlAfterMove = true;
    });
    workerSocket.emit('output', { sessionId, output: 'AFTER_TENANT_MOVE' });
    revokedSocket.emit('resize', {
      workerId: worker.id,
      sessionId: 'unauthorized-after-move',
      cols: 100,
      rows: 35,
    });
    await delay(250);
    expect(outputAfterMove).toBe(false);
    expect(controlAfterMove).toBe(false);
  });

  it('no confía en isAdmin obsoleto del JWT para agentes ni workers', async () => {
    const register = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'audit-stale-admin',
        password: TENANT_PASSWORD,
        setupToken: SETUP_TOKEN,
      }),
    });
    expect(register.status).toBe(200);
    const promote = await request('/api/admin/upgrade-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminPassword: ADMIN_PASSWORD,
        username: 'audit-stale-admin',
        plan: 'enterprise',
        makeAdmin: true,
        tenant: null,
      }),
    });
    expect(promote.status).toBe(200);
    const staleAdminToken = await login('audit-stale-admin', TENANT_PASSWORD);

    const demote = await request('/api/admin/upgrade-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminPassword: ADMIN_PASSWORD,
        username: 'audit-stale-admin',
        plan: 'enterprise',
        makeAdmin: false,
        tenant: 'pablo',
      }),
    });
    expect(demote.status).toBe(200);

    const agentsResponse = await request('/api/agents', {
      headers: { Authorization: `Bearer ${staleAdminToken}` },
    });
    const agents = await agentsResponse.json() as Array<{ tenantId: string }>;
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((agent) => agent.tenantId === 'pablo')).toBe(true);

    const miguelWorker = await createWorker(miguelToken, 'audit-stale-admin-worker');
    const workersResponse = await request('/api/workers', {
      headers: { Authorization: `Bearer ${staleAdminToken}` },
    });
    const visibleWorkers = await workersResponse.json() as Array<{ id: string }>;
    expect(visibleWorkers.some((worker) => worker.id === miguelWorker.id)).toBe(false);
  });

  it('rechaza todo REST protegido si el usuario del JWT ya fue borrado', async () => {
    const register = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'audit-deleted-user',
        password: TENANT_PASSWORD,
        setupToken: SETUP_TOKEN,
      }),
    });
    expect(register.status).toBe(200);
    const assign = await request('/api/admin/upgrade-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminPassword: ADMIN_PASSWORD,
        username: 'audit-deleted-user',
        plan: 'enterprise',
        tenant: 'pablo',
      }),
    });
    expect(assign.status).toBe(200);
    const deletedToken = await login('audit-deleted-user', TENANT_PASSWORD);

    const agentsBeforeDelete = await request('/api/agents', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const existingAgentId = ((await agentsBeforeDelete.json()) as Array<{ id: number; tenantId: string }>)
      .find((agent) => agent.tenantId === 'pablo')?.id;
    expect(existingAgentId).toBeTypeOf('number');

    const sqlite = new Database(path.join(dataDir, 'nexus.db'));
    sqlite.pragma('busy_timeout = 2000');
    const deletedUser = sqlite.prepare('SELECT id FROM users WHERE username = ?')
      .get('audit-deleted-user') as { id: number } | undefined;
    expect(deletedUser?.id).toBeTypeOf('number');
    sqlite.prepare('DELETE FROM users WHERE id = ?').run(deletedUser!.id);
    sqlite.close();

    const authorization = { Authorization: `Bearer ${deletedToken}` };
    const jsonAuthorization = { ...authorization, 'Content-Type': 'application/json' };
    const protectedRequests = await Promise.all([
      request('/api/agents', { headers: authorization }),
      request(`/api/agents/${existingAgentId}`, { headers: authorization }),
      request('/api/agents', {
        method: 'POST',
        headers: jsonAuthorization,
        body: JSON.stringify({ tenantId: 'pablo', key: 'orphan', displayName: 'Orphan' }),
      }),
      request(`/api/agents/${existingAgentId}`, {
        method: 'PATCH',
        headers: jsonAuthorization,
        body: JSON.stringify({ displayName: 'No autorizado' }),
      }),
      request(`/api/agents/${existingAgentId}`, {
        method: 'DELETE',
        headers: authorization,
      }),
      request('/api/tenants', { headers: authorization }),
      request('/api/workers', {
        method: 'POST',
        headers: jsonAuthorization,
        body: JSON.stringify({ name: 'orphan-worker' }),
      }),
    ]);
    expect(protectedRequests.map((response) => response.status)).toEqual([
      401, 401, 401, 401, 401, 401, 401,
    ]);

    const verify = new Database(path.join(dataDir, 'nexus.db'), { readonly: true });
    const orphanWorkers = verify.prepare('SELECT COUNT(*) AS count FROM workers WHERE owner_id = ?')
      .get(deletedUser!.id) as { count: number };
    const orphanAgents = verify.prepare("SELECT COUNT(*) AS count FROM agents WHERE key = 'orphan'")
      .get() as { count: number };
    verify.close();
    expect(Number(orphanWorkers.count)).toBe(0);
    expect(Number(orphanAgents.count)).toBe(0);
  });

  it('aísla suscriptores aunque dos tenants usen el mismo sessionId', async () => {
    const miguelWorker = await createWorker(miguelToken, 'audit-miguel-collision-worker');
    const pabloWorker = await createWorker(pabloToken, 'audit-pablo-collision-worker');
    const miguelWorkerSocket = io(nexusUrl, {
      auth: { type: 'worker', apiKey: miguelWorker.api_key, workerName: 'audit-miguel-collision-worker' },
    });
    const pabloWorkerSocket = io(nexusUrl, {
      auth: { type: 'worker', apiKey: pabloWorker.api_key, workerName: 'audit-pablo-collision-worker' },
    });
    const miguelClient = io(nexusUrl, { auth: { type: 'client', token: miguelToken } });
    const pabloClient = io(nexusUrl, { auth: { type: 'client', token: pabloToken } });
    sockets.push(miguelWorkerSocket, pabloWorkerSocket, miguelClient, pabloClient);
    await Promise.all([
      connect(miguelWorkerSocket),
      connect(pabloWorkerSocket),
      connect(miguelClient),
      connect(pabloClient),
    ]);

    const sessionId = 'audit-shared-session-id';
    miguelClient.emit('resize', { workerId: miguelWorker.id, sessionId, cols: 80, rows: 24 });
    pabloClient.emit('resize', { workerId: pabloWorker.id, sessionId, cols: 80, rows: 24 });
    await delay(150);

    let leaked = false;
    pabloClient.on('output', (message) => {
      if (message?.data === 'AUDIT_COLLISION_MARKER') leaked = true;
    });
    miguelWorkerSocket.emit('output', { sessionId, output: 'AUDIT_COLLISION_MARKER' });
    await delay(200);
    expect(leaked).toBe(false);
  });
});

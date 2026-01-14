import { io, Socket } from 'socket.io-client';
import * as pty from 'node-pty';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

const NEXUS_URL = process.env.NEXUS_URL || 'http://localhost:3002';
const WORKER_NAME = process.env.WORKER_NAME || os.hostname();
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS || 5000);

if (!WORKER_TOKEN) {
  console.warn('[Worker] No WORKER_TOKEN provided. Registration will be rejected by Nexus.');
}

console.log(`[Worker] Connecting to Nexus at ${NEXUS_URL}...`);

// Connection state management
let socket: Socket;
// Map of sessionId -> PTY instance (persistent sessions, not tied to clientId)
const sessionShells = new Map<string, pty.IPty>();

const normalizeSessionId = (sessionId?: string) => {
  const trimmed = sessionId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

let retryDelay = 1000;
const MAX_RETRY_DELAY = 30000;
let heartbeatInterval: NodeJS.Timeout | null = null;

function connect() {
  socket = io(NEXUS_URL, {
    reconnection: false,
    auth: { type: 'worker', workerToken: WORKER_TOKEN }
  });

  socket.on('connect', () => {
    console.log('[Worker] Connected to Nexus.');
    retryDelay = 1000; // Reset backoff
    socket.emit('register', { type: 'worker', name: WORKER_NAME, workerToken: WORKER_TOKEN });
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (socket.connected) {
        socket.emit('heartbeat');
      }
    }, HEARTBEAT_MS);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Worker] Disconnected: ${reason}`);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    scheduleReconnect();
  });

  socket.on('connect_error', (err) => {
    console.log(`[Worker] Connection error: ${err.message}`);
    scheduleReconnect();
  });

  socket.on('execute', (data: { clientId: string; sessionId?: string; command: string }) => {
    const sessionId = normalizeSessionId(data.sessionId);
    if (!sessionId) {
      console.log('[Worker] Ignoring execute without sessionId');
      return;
    }
    let shell = sessionShells.get(sessionId);
    if (!shell) {
      shell = createShellForSession(sessionId);
      sessionShells.set(sessionId, shell);
    }
    if (shell) {
      shell.write(data.command);
    }
  });
  
  // Handle terminal resize events from client
  socket.on('resize', (data: { clientId: string; sessionId?: string; cols: number; rows: number }) => {
    const sessionId = normalizeSessionId(data.sessionId);
    if (!sessionId) return;
    let shell = sessionShells.get(sessionId);
    if (!shell) {
      shell = createShellForSession(sessionId, data.cols, data.rows);
      sessionShells.set(sessionId, shell);
    } else {
      try {
        shell.resize(data.cols, data.rows);
      } catch (err) {
        // Ignore resize errors if shell is dead
      }
    }
  });

  // Handle explicit session close from client
  socket.on('kill-session', (data: { sessionId: string }) => {
    const sessionId = normalizeSessionId(data.sessionId);
    if (!sessionId) return;
    const shell = sessionShells.get(sessionId);
    if (shell) {
      console.log(`[Worker] Killing PTY for session ${sessionId}`);
      try {
        shell.kill();
      } catch (e) {
        // Ignore errors during cleanup
      }
      sessionShells.delete(sessionId);
    }
  });

  // Client disconnect - sessions persist, don't kill PTYs
  socket.on('client-disconnect', (data: { clientId: string }) => {
    console.log(`[Worker] Client ${data.clientId} disconnected - sessions persist`);
    // Sessions are persistent, we don't kill PTYs when clients disconnect
  });
}

function scheduleReconnect() {
  if (socket.connected) return;
  const jitter = Math.floor(Math.random() * 250);
  const delay = retryDelay + jitter;
  console.log(`[Worker] Reconnecting in ${delay}ms...`);
  setTimeout(() => {
    connect();
  }, delay);

  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
}

function createShellForSession(
  sessionId: string,
  cols: number = 80,
  rows: number = 30,
): pty.IPty {
  const shellCmd = process.env.SHELL || 'bash';
  
  console.log(`[Worker] Spawning persistent PTY for session ${sessionId} (${shellCmd}) with dimensions ${cols}x${rows}...`);

  const baseEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'en_US.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  } as Record<string, string | undefined>;

  const shell = pty.spawn(shellCmd, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME,
    env: baseEnv as any
  });

  shell.onData((data) => {
    if (socket && socket.connected) {
      // Broadcast to all clients - nexus will route to appropriate clients
      socket.emit('output', {
        sessionId,
        output: data,
      });
    }
  });

  shell.onExit(({ exitCode, signal }) => {
    console.log(`[Worker] Shell for session ${sessionId} exited (Code: ${exitCode}, Signal: ${signal}).`);
    sessionShells.delete(sessionId);
    // Notify nexus that this session's shell has exited
    if (socket && socket.connected) {
      socket.emit('session-shell-exited', { sessionId, exitCode, signal });
    }
  });

  return shell;
}

connect();

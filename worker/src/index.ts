import { io, Socket } from 'socket.io-client';
import * as pty from 'node-pty';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

const NEXUS_URL = process.env.NEXUS_URL || 'http://localhost:3002';
const WORKER_NAME = process.env.WORKER_NAME || os.hostname();
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';

if (!WORKER_TOKEN) {
  console.warn('[Worker] No WORKER_TOKEN provided. Registration will be rejected by Nexus.');
}

console.log(`[Worker] Connecting to Nexus at ${NEXUS_URL}...`);

// Connection state management
let socket: Socket;
// Map of clientId -> PTY instance
const clientShells = new Map<string, pty.IPty>();
let retryDelay = 1000;
const MAX_RETRY_DELAY = 30000;

function connect() {
  socket = io(NEXUS_URL, {
    reconnection: false,
    auth: { type: 'worker', workerToken: WORKER_TOKEN }
  });

  socket.on('connect', () => {
    console.log('[Worker] Connected to Nexus.');
    retryDelay = 1000; // Reset backoff
    socket.emit('register', { type: 'worker', name: WORKER_NAME, workerToken: WORKER_TOKEN });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Worker] Disconnected: ${reason}`);
    scheduleReconnect();
  });

  socket.on('connect_error', (err) => {
    console.log(`[Worker] Connection error: ${err.message}`);
    scheduleReconnect();
  });

  socket.on('execute', (data: { clientId: string, command: string }) => {
    // Get or create PTY for this client
    let shell = clientShells.get(data.clientId);
    if (!shell) {
      shell = createShellForClient(data.clientId);
      clientShells.set(data.clientId, shell);
    }
    if (shell) {
      shell.write(data.command);
    }
  });
  
  // Handle terminal resize events from client
  socket.on('resize', (data: { clientId: string, cols: number, rows: number }) => {
    const shell = clientShells.get(data.clientId);
    if (shell) {
      try {
        shell.resize(data.cols, data.rows);
      } catch (err) {
        // Ignore resize errors if shell is dead
      }
    }
  });

  // Handle client disconnection
  socket.on('client-disconnect', (data: { clientId: string }) => {
    const shell = clientShells.get(data.clientId);
    if (shell) {
      console.log(`[Worker] Cleaning up PTY for client ${data.clientId}`);
      try {
        shell.kill();
      } catch (e) {
        // Ignore errors during cleanup
      }
      clientShells.delete(data.clientId);
    }
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

function createShellForClient(clientId: string): pty.IPty {
  const shellCmd = process.env.SHELL || 'bash';
  
  console.log(`[Worker] Spawning PTY for client ${clientId} (${shellCmd})...`);

  const baseEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'en_US.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  } as Record<string, string | undefined>;

  const shell = pty.spawn(shellCmd, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: baseEnv as any
  });

  shell.onData((data) => {
    if (socket && socket.connected) {
      socket.emit('output', {
        clientId: clientId,
        output: data
      });
    }
  });

  shell.onExit(({ exitCode, signal }) => {
    console.log(`[Worker] Shell for client ${clientId} exited (Code: ${exitCode}, Signal: ${signal}).`);
    clientShells.delete(clientId);
  });

  return shell;
}

connect();
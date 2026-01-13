import { io, Socket } from 'socket.io-client';
import * as pty from 'node-pty';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

const NEXUS_URL = process.env.NEXUS_URL || 'http://localhost:3002';
const WORKER_NAME = process.env.WORKER_NAME || os.hostname();

console.log(`[Worker] Connecting to Nexus at ${NEXUS_URL}...`);

// Connection state management
let socket: Socket;
let shell: pty.IPty | null = null;
let retryDelay = 1000;
const MAX_RETRY_DELAY = 30000;

function connect() {
  socket = io(NEXUS_URL, {
    reconnection: false // We handle reconnection manually for better control
  });

  socket.on('connect', () => {
    console.log('[Worker] Connected to Nexus.');
    retryDelay = 1000; // Reset backoff
    socket.emit('register', { type: 'worker', name: WORKER_NAME });
    
    if (!shell) {
      startShell();
    }
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
    if (shell) {
      shell.write(data.command);
    }
  });
  
  // Handle terminal resize events from client
  socket.on('resize', (data: { cols: number, rows: number }) => {
    if (shell) {
      try {
        shell.resize(data.cols, data.rows);
      } catch (err) {
        // Ignore resize errors if shell is dead
      }
    }
  });
}

function scheduleReconnect() {
  if (socket.connected) return;
  
  console.log(`[Worker] Reconnecting in ${retryDelay}ms...`);
  setTimeout(() => {
    connect();
  }, retryDelay);

  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
}

function startShell() {
  if (shell) {
    try {
      shell.kill();
    } catch (e) {}
  }

  const shellCmd = process.env.SHELL || 'bash';
  
  console.log(`[Worker] Spawning PTY (${shellCmd})...`);

  shell = pty.spawn(shellCmd, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    } as any
  });

  shell.onData((data) => {
    if (socket && socket.connected) {
      socket.emit('output', {
        output: data
      });
    }
  });

  shell.onExit(({ exitCode, signal }) => {
    console.log(`[Worker] Shell exited (Code: ${exitCode}, Signal: ${signal}). Restarting PTY...`);
    // Restart shell after a brief pause
    setTimeout(startShell, 1000);
  });
}

connect();
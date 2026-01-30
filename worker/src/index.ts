import { io, Socket } from 'socket.io-client';
import os from 'os';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// Setup native module paths for packaged binary
const setupNativeModulePaths = () => {
  // Add system lib path for native modules when running as packaged binary
  const systemLibPath = '/usr/lib/ultimate-terminal';
  if (fs.existsSync(systemLibPath)) {
    const Module = require('module');
    const originalResolveFilename = Module._resolveFilename;
    Module._resolveFilename = function(request: string, parent: any, isMain: boolean, options: any) {
      // Intercept node-pty native module loading
      if (request.includes('pty.node') || request.includes('prebuilds/linux-x64')) {
        const nativePath = path.join(systemLibPath, 'prebuilds/linux-x64/pty.node');
        if (fs.existsSync(nativePath)) {
          return nativePath;
        }
      }
      return originalResolveFilename.call(this, request, parent, isMain, options);
    };
  }
};

setupNativeModulePaths();

import * as pty from 'node-pty';

const NEXUS_URL = process.env.NEXUS_URL || 'http://localhost:3002';
const API_KEY = process.env.API_KEY || process.env.WORKER_TOKEN || ''; 
const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS || 5000);
const AUTO_RESTART_SHELL = process.env.AUTO_RESTART_SHELL !== 'false';

if (!API_KEY) {
  console.warn('[Worker] No API_KEY provided. Registration will likely be rejected by Nexus.');
}

console.log(`[Worker] Connecting to Nexus at ${NEXUS_URL}...`);

let socket: Socket;
const sessionShells = new Map<string, pty.IPty>();
const sessionDimensions = new Map<string, { cols: number; rows: number }>();
const sessionClientViewports = new Map<string, Map<string, { cols: number; rows: number }>>();
const killedSessions = new Set<string>();

const normalizeSessionId = (sessionId?: string) => {
  const trimmed = sessionId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

function calculateSessionDimensions(sessionId: string): { cols: number; rows: number } | null {
  const viewports = sessionClientViewports.get(sessionId);
  if (!viewports || viewports.size === 0) {
    return sessionDimensions.get(sessionId) || { cols: 80, rows: 30 };
  }

  let minCols = Infinity;
  let minRows = Infinity;

  for (const dims of viewports.values()) {
    if (dims.cols < minCols) minCols = dims.cols;
    if (dims.rows < minRows) minRows = dims.rows;
  }

  if (minCols === Infinity || minRows === Infinity) return null;

  return { cols: minCols, rows: minRows };
}

let retryDelay = 1000;
const MAX_RETRY_DELAY = 30000;
let heartbeatInterval: NodeJS.Timeout | null = null;

function connect() {
  socket = io(NEXUS_URL, {
    reconnection: false,
    auth: { type: 'worker', apiKey: API_KEY }
  });

  socket.on('connect', () => {
    console.log('[Worker] Connected to Nexus.');
    retryDelay = 1000;
    
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

  const newlyCreatedShells = new Set<string>();

  socket.on('execute', (data: { clientId: string; sessionId?: string; command: string }) => {
    const sessionId = normalizeSessionId(data.sessionId);
    if (!sessionId) {
      console.log('[Worker] Ignoring execute without sessionId');
      return;
    }
    
    let shell = sessionShells.get(sessionId);
    if (!shell) {
      const dims = sessionDimensions.get(sessionId) || { cols: 80, rows: 30 };
      shell = createShellForSession(sessionId, dims.cols, dims.rows);
      sessionShells.set(sessionId, shell);
      newlyCreatedShells.add(sessionId);
      setTimeout(() => newlyCreatedShells.delete(sessionId), 500);
    }
    if (!sessionClientViewports.has(sessionId)) {
      sessionClientViewports.set(sessionId, new Map());
    }
    if (newlyCreatedShells.has(sessionId) && data.command === '\n') {
      console.log(`[Worker] Skipping initial \\n for new shell ${sessionId.slice(-8)}`);
      return;
    }
    
    if (shell) {
      shell.write(data.command);
    }
  });

  socket.on('resize', (data: { clientId: string; sessionId?: string; cols: number; rows: number }) => {
    const sessionId = normalizeSessionId(data.sessionId);
    if (!sessionId) return;
    if (!sessionClientViewports.has(sessionId)) {
      sessionClientViewports.set(sessionId, new Map());
    }
    sessionClientViewports.get(sessionId)!.set(data.clientId, { cols: data.cols, rows: data.rows });
    const targetDims = calculateSessionDimensions(sessionId);
    const finalCols = targetDims ? targetDims.cols : data.cols;
    const finalRows = targetDims ? targetDims.rows : data.rows;
    sessionDimensions.set(sessionId, { cols: finalCols, rows: finalRows });
    let shell = sessionShells.get(sessionId);
    if (shell) {
      try {
        if (shell.cols !== finalCols || shell.rows !== finalRows) {
          shell.resize(finalCols, finalRows);
        }
      } catch (err) {
        console.warn(`[Worker] Resize error for session ${sessionId.slice(-8)}:`, err);
      }
    } else {
      console.log(`[Worker] Creating shell for session ${sessionId.slice(-8)} on resize (${finalCols}x${finalRows})`);
      shell = createShellForSession(sessionId, finalCols, finalRows);
      sessionShells.set(sessionId, shell);
    }
  });

  socket.on('kill-session', (data: { sessionId: string }) => {
    const sessionId = normalizeSessionId(data.sessionId);
    if (!sessionId) return;
    killedSessions.add(sessionId);
    sessionDimensions.delete(sessionId);
    sessionClientViewports.delete(sessionId);
    const shell = sessionShells.get(sessionId);
    if (shell) {
      console.log(`[Worker] Killing PTY for session ${sessionId} (explicit close)`);
      try {
        shell.kill();
      } catch (e) {
        console.warn(`[Worker] Error killing PTY for session ${sessionId}:`, e);
      }
      sessionShells.delete(sessionId);
    }
  });

  socket.on('client-disconnect', (data: { clientId: string }) => {
    console.log(`[Worker] Client ${data.clientId} disconnected - sessions persist`);
    for (const [sessionId, viewports] of sessionClientViewports.entries()) {
      if (viewports.delete(data.clientId)) {
        const newDims = calculateSessionDimensions(sessionId);
        if (newDims) {
          sessionDimensions.set(sessionId, newDims);
          const shell = sessionShells.get(sessionId);
          if (shell && (shell.cols !== newDims.cols || shell.rows !== newDims.rows)) {
            try {
              shell.resize(newDims.cols, newDims.rows);
              console.log(`[Worker] Resizing session ${sessionId.slice(-8)} after client disconnect: ${newDims.cols}x${newDims.rows}`);
            } catch (e) {
              console.warn(`[Worker] Resize error after disconnect:`, e);
            }
          }
        }
      }
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

interface UserInfo {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

function getTargetUser(): UserInfo | null {
  const runAsUser = process.env.RUN_AS_USER;
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
    const lines = passwd.split('\n').filter(l => l.trim());
    if (runAsUser) {
      for (const line of lines) {
        const parts = line.split(':');
        if (parts[0] === runAsUser) {
          return {
            username: parts[0],
            uid: parseInt(parts[2]),
            gid: parseInt(parts[3]),
            home: parts[5],
            shell: parts[6] || '/bin/bash'
          };
        }
      }
      console.warn(`[Worker] RUN_AS_USER="${runAsUser}" not found, falling back to auto-detect`);
    }
    for (const line of lines) {
      const parts = line.split(':');
      const uid = parseInt(parts[2]);
      const username = parts[0];
      if (uid >= 1000 && uid < 65534 &&
          !['nobody', 'nogroup', 'nfsnobody'].includes(username)) {
        return {
          username: parts[0],
          uid,
          gid: parseInt(parts[3]),
          home: parts[5],
          shell: parts[6] || '/bin/bash'
        };
      }
    }
  } catch (e) {
    console.error('[Worker] Failed to read /etc/passwd:', e);
  }
  return null;
}

const targetUser = getTargetUser();
if (targetUser) {
  console.log(`[Worker] Will spawn shells as user: ${targetUser.username} (uid=${targetUser.uid}, shell=${targetUser.shell})`);
} else {
  console.warn('[Worker] No target user found, will run shells as current user');
}

function createShellForSession(
  sessionId: string,
  cols: number = 80,
  rows: number = 30,
): pty.IPty {
  sessionDimensions.set(sessionId, { cols, rows });
  let shellCmd: string;
  let shellArgs: string[] = [];
  let shellEnv: Record<string, string | undefined>;
  let shellCwd: string;
  if (targetUser) {
    shellCmd = '/bin/su';
    shellArgs = ['-l', targetUser.username, '-s', targetUser.shell];
    shellCwd = targetUser.home;
    shellEnv = {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
      PROMPT_EOL_MARK: '',
    };
    console.log(`[Worker] Spawning PTY for session ${sessionId} as ${targetUser.username} (${targetUser.shell}) with dimensions ${cols}x${rows}...`);
  } else {
    const shells = ['/usr/bin/zsh', '/bin/zsh', '/usr/bin/bash', '/bin/bash', '/bin/sh'];
    shellCmd = shells.find(s => fs.existsSync(s)) || 'bash';
    shellCwd = process.env.HOME || '/tmp';
    shellEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG || 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    };
    console.log(`[Worker] Spawning PTY for session ${sessionId} (${shellCmd}) with dimensions ${cols}x${rows}...`);
  }

  const shell = pty.spawn(shellCmd, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: shellCwd,
    env: shellEnv as any
  });

  shell.onData((data) => {
    if (socket && socket.connected) {
      socket.emit('output', { sessionId, output: data });
    }
  });

  shell.onExit(({ exitCode, signal }) => {
    console.log(`[Worker] Shell for session ${sessionId} exited (Code: ${exitCode}, Signal: ${signal}).`);
    sessionShells.delete(sessionId);
    if (killedSessions.has(sessionId)) {
      killedSessions.delete(sessionId);
      sessionDimensions.delete(sessionId);
      if (socket && socket.connected) {
        socket.emit('session-shell-exited', { sessionId, exitCode, signal });
      }
      return;
    }
    if (AUTO_RESTART_SHELL && socket && socket.connected) {
      const dims = sessionDimensions.get(sessionId) || { cols: 80, rows: 30 };
      console.log(`[Worker] Auto-respawning shell for session ${sessionId}...`);
      setTimeout(() => {
        if (!killedSessions.has(sessionId) && socket && socket.connected) {
          const newShell = createShellForSession(sessionId, dims.cols, dims.rows);
          sessionShells.set(sessionId, newShell);
          socket.emit('output', {
            sessionId,
            output: `\r\n\x1b[33m[Shell exited with code ${exitCode}. New shell started.]\x1b[0m\r\n\r\n`,
          });
        }
      }, 500);
    } else {
      sessionDimensions.delete(sessionId);
      if (socket && socket.connected) {
        socket.emit('session-shell-exited', { sessionId, exitCode, signal });
      }
    }
  });

  return shell;
}

connect();

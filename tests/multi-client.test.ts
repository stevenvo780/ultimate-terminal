import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as Client } from 'socket.io-client';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const NEXUS_PORT = 3004;
const NEXUS_URL = `http://localhost:${NEXUS_PORT}`;
const ADMIN_PASSWORD = 'test-pass-multi-456';
const WORKER_TOKEN = 'worker-token-test-multi';
const JWT_SECRET = 'test-secret-token-multi';
let dataDir: string;

function isolatedSqliteEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Host credentials must not override this test's isolated worker/SQLite.
  delete env.API_KEY;
  delete env.DATABASE_URL;
  return env;
}

async function waitForServer(url: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/auth/status`);
      if (res.ok) return;
    } catch (e) {
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not become ready`);
}

describe('Multiple Clients - Independent Terminal Views', () => {
  let nexusProcess: ChildProcess;
  let workerProcess: ChildProcess;
  let client1Socket: any;
  let client2Socket: any;
  let token: string;

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultimate-terminal-multi-'));

    nexusProcess = spawn('npx', ['ts-node', 'nexus/src/index.ts'], {
      env: {
        ...isolatedSqliteEnv(),
        PORT: NEXUS_PORT.toString(),
        NEXUS_JWT_SECRET: JWT_SECRET,
        ADMIN_PASSWORD,
        WORKER_TOKEN,
        CLIENT_ORIGIN: '*',
        NEXUS_DATA_DIR: dataDir
      },
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe'
    });

    await waitForServer(NEXUS_URL);

    workerProcess = spawn('npx', ['ts-node', 'worker/src/index.ts'], {
      env: { ...isolatedSqliteEnv(), NEXUS_URL, WORKER_NAME: 'Test-Multi-Worker', WORKER_TOKEN },
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe'
    });

    workerProcess.stdout?.on('data', (d) => console.log(`[Worker]: ${d.toString().trim()}`));

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const login = await fetch(`${NEXUS_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    const data = await login.json();
    token = data.token;
  }, 20000);

  afterAll(async () => {
    nexusProcess.kill();
    workerProcess.kill();
    if (client1Socket) client1Socket.disconnect();
    if (client2Socket) client2Socket.disconnect();
    await fs.rm(dataDir, { force: true, recursive: true });
  });

  it('should allow two clients with different terminal sizes', async () => {
    return new Promise<void>((resolve, reject) => {
      let workerId: string;
      let client1Output = '';
      let client2Output = '';
      let client1Ready = false;
      let client2Ready = false;

      client1Socket = Client(NEXUS_URL, { auth: { token, type: 'client' } });
      
      client1Socket.on('connect', () => {
        console.log('[Test] Client 1 connected');
        client1Socket.emit('register', { type: 'client' });
      });

      client1Socket.on('worker-list', (workers: any[]) => {
        if (!workerId && workers.length > 0) {
          workerId = workers[0].id;
          console.log('[Test] Got worker ID:', workerId);
          
          client1Socket.emit('resize', {
            workerId,
            cols: 100,
            rows: 30
          });

          setTimeout(() => {
            client1Socket.emit('execute', {
              workerId,
              command: 'stty size\n'
            });
          }, 500);
        }
      });

      client1Socket.on('output', (data: any) => {
        client1Output += data.data;
        console.log('[Test] Client 1 output:', data.data.trim());
        
        if (client1Output.includes('30 100') || client1Output.includes('30  100')) {
          console.log('[Test] Client 1 terminal size confirmed: 30 rows x 100 cols');
          client1Ready = true;
          
          if (!client2Socket) {
            setupClient2();
          }
        }
      });

      function setupClient2() {
        client2Socket = Client(NEXUS_URL, { auth: { token, type: 'client' } });
        
        client2Socket.on('connect', () => {
          console.log('[Test] Client 2 connected');
          client2Socket.emit('register', { type: 'client' });
        });

        client2Socket.on('worker-list', (workers: any[]) => {
          if (workers.length > 0) {
            client2Socket.emit('resize', {
              workerId,
              cols: 80,
              rows: 24
            });

            setTimeout(() => {
              client2Socket.emit('execute', {
                workerId,
                command: 'stty size\n'
              });
            }, 500);
          }
        });

        client2Socket.on('output', (data: any) => {
          client2Output += data.data;
          console.log('[Test] Client 2 output:', data.data.trim());
          
          if (client2Output.includes('24 80') || client2Output.includes('24  80')) {
            console.log('[Test] Client 2 terminal size confirmed: 24 rows x 80 cols');
            client2Ready = true;
            
            if (client1Ready && client2Ready) {
              console.log('[Test] SUCCESS: Both clients have independent terminal sizes!');
              resolve();
            }
          }
        });
      }

      setTimeout(() => {
        if (!client1Ready || !client2Ready) {
          reject(new Error(`Timeout: client1Ready=${client1Ready}, client2Ready=${client2Ready}`));
        }
      }, 15000);
    });
  }, 20000);

  it('should not share output between clients', async () => {
    return new Promise<void>((resolve, reject) => {
      let workerId: string;
      let client1Received = false;
      let client2Received = false;

      client1Socket.on('output', (data: any) => {
        if (data.data.includes('CLIENT1_MARKER')) {
          console.log('[Test] Client 1 received its own output');
          client1Received = true;
        }
        if (data.data.includes('CLIENT2_MARKER')) {
          reject(new Error('Client 1 should not receive Client 2 output!'));
        }
      });

      client2Socket.on('output', (data: any) => {
        if (data.data.includes('CLIENT2_MARKER')) {
          console.log('[Test] Client 2 received its own output');
          client2Received = true;
        }
        if (data.data.includes('CLIENT1_MARKER')) {
          reject(new Error('Client 2 should not receive Client 1 output!'));
        }

        if (client1Received && client2Received) {
          console.log('[Test] SUCCESS: Clients have independent output streams!');
          resolve();
        }
      });

      client1Socket.emit('register', { type: 'client' });
      client1Socket.once('worker-list', (workers: any[]) => {
        if (workers.length > 0) {
          workerId = workers[0].id;

          setTimeout(() => {
            client1Socket.emit('execute', {
              workerId,
              command: 'echo CLIENT1_MARKER\n'
            });
          }, 500);

          setTimeout(() => {
            client2Socket.emit('execute', {
              workerId,
              command: 'echo CLIENT2_MARKER\n'
            });
          }, 1000);
        }
      });

      setTimeout(() => {
        if (!client1Received || !client2Received) {
          reject(new Error(`Timeout: client1Received=${client1Received}, client2Received=${client2Received}`));
        }
      }, 10000);
    });
  }, 15000);
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as Client } from 'socket.io-client';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

// Configuration
const NEXUS_PORT = 3004; // Use a different port to avoid conflicts
const NEXUS_URL = `http://localhost:${NEXUS_PORT}`;
const ADMIN_PASSWORD = 'test-pass-multi-456';
const WORKER_TOKEN = 'worker-token-test-multi';
const JWT_SECRET = 'test-secret-token-multi';

describe('Multiple Clients - Independent Terminal Views', () => {
  let nexusProcess: ChildProcess;
  let workerProcess: ChildProcess;
  let client1Socket: any;
  let client2Socket: any;
  let token: string;

  beforeAll(async () => {
    await fs.rm(path.resolve(__dirname, '..', '.qodo'), { force: true, recursive: true });

    nexusProcess = spawn('npx', ['ts-node', 'nexus/src/index.ts'], {
      env: {
        ...process.env,
        PORT: NEXUS_PORT.toString(),
        NEXUS_JWT_SECRET: JWT_SECRET,
        ADMIN_PASSWORD,
        WORKER_TOKEN,
        CLIENT_ORIGIN: '*'
      },
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe'
    });

    await new Promise((resolve) => setTimeout(resolve, 3000));

    workerProcess = spawn('npx', ['ts-node', 'worker/src/index.ts'], {
      env: { ...process.env, NEXUS_URL, WORKER_NAME: 'Test-Multi-Worker', WORKER_TOKEN },
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe'
    });

    workerProcess.stdout?.on('data', (d) => console.log(`[Worker]: ${d.toString().trim()}`));

    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Get auth token
    const login = await fetch(`${NEXUS_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    const data = await login.json();
    token = data.token;
  }, 20000);

  afterAll(() => {
    nexusProcess.kill();
    workerProcess.kill();
    if (client1Socket) client1Socket.disconnect();
    if (client2Socket) client2Socket.disconnect();
  });

  it('should allow two clients with different terminal sizes', async () => {
    return new Promise<void>((resolve, reject) => {
      let workerId: string;
      let client1Output = '';
      let client2Output = '';
      let client1Ready = false;
      let client2Ready = false;

      // Setup client 1
      client1Socket = Client(NEXUS_URL, { auth: { token, type: 'client' } });
      
      client1Socket.on('connect', () => {
        console.log('[Test] Client 1 connected');
        client1Socket.emit('register', { type: 'client' });
      });

      client1Socket.on('worker-list', (workers: any[]) => {
        if (!workerId && workers.length > 0) {
          workerId = workers[0].id;
          console.log('[Test] Got worker ID:', workerId);
          
          // Resize client 1 to 100x30
          client1Socket.emit('resize', {
            workerId,
            cols: 100,
            rows: 30
          });

          setTimeout(() => {
            // Execute stty size command on client 1
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
        
        // Check if we got the stty size output
        if (client1Output.includes('30 100') || client1Output.includes('30  100')) {
          console.log('[Test] Client 1 terminal size confirmed: 30 rows x 100 cols');
          client1Ready = true;
          
          // Now setup client 2
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
            // Resize client 2 to 80x24 (different from client 1)
            client2Socket.emit('resize', {
              workerId,
              cols: 80,
              rows: 24
            });

            setTimeout(() => {
              // Execute stty size command on client 2
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
          
          // Check if we got the stty size output
          if (client2Output.includes('24 80') || client2Output.includes('24  80')) {
            console.log('[Test] Client 2 terminal size confirmed: 24 rows x 80 cols');
            client2Ready = true;
            
            // Both clients ready with different sizes
            if (client1Ready && client2Ready) {
              console.log('[Test] SUCCESS: Both clients have independent terminal sizes!');
              resolve();
            }
          }
        });
      }

      // Timeout after 15 seconds
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

      // Client 1 should receive its own output
      client1Socket.on('output', (data: any) => {
        if (data.data.includes('CLIENT1_MARKER')) {
          console.log('[Test] Client 1 received its own output');
          client1Received = true;
        }
        if (data.data.includes('CLIENT2_MARKER')) {
          reject(new Error('Client 1 should not receive Client 2 output!'));
        }
      });

      // Client 2 should receive its own output
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

      // Get worker ID
      client1Socket.emit('register', { type: 'client' });
      client1Socket.once('worker-list', (workers: any[]) => {
        if (workers.length > 0) {
          workerId = workers[0].id;

          // Send different commands to each client
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

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!client1Received || !client2Received) {
          reject(new Error(`Timeout: client1Received=${client1Received}, client2Received=${client2Received}`));
        }
      }, 10000);
    });
  }, 15000);
});

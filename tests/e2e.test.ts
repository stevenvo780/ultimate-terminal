import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as Client } from 'socket.io-client';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

// Configuration
const NEXUS_PORT = 3003; // Use a different port for testing to avoid conflicts
const NEXUS_URL = `http://localhost:${NEXUS_PORT}`;

describe('Ultimate Terminal E2E', () => {
  let nexusProcess: ChildProcess;
  let workerProcess: ChildProcess;
  let clientSocket: any;

  beforeAll(async () => {
    // 1. Start Nexus
    // We run it with a custom port env var
    nexusProcess = spawn('npx', ['ts-node', 'nexus/src/index.ts'], {
      env: { ...process.env, PORT: NEXUS_PORT.toString() },
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe' // Silent but captured
    });
    
    // Wait for Nexus to start
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 2. Start Worker
    workerProcess = spawn('npx', ['ts-node', 'worker/src/index.ts'], {
      env: { ...process.env, NEXUS_URL, WORKER_NAME: 'Test-Worker' },
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe'
    });
    
    // Pipe worker logs for debugging
    workerProcess.stdout?.on('data', (d) => console.log(`[Worker Output]: ${d}`));

    // Wait for Worker to register
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }, 15000);

  afterAll(() => {
    nexusProcess.kill();
    workerProcess.kill();
    if (clientSocket) clientSocket.disconnect();
  });

  it('should allow a client to connect and receive worker list', async () => {
    return new Promise<void>((resolve, reject) => {
      clientSocket = Client(NEXUS_URL);
      
      clientSocket.on('connect', () => {
        clientSocket.emit('register', { type: 'client' });
      });

      clientSocket.on('worker-list', (workers: any[]) => {
        try {
          expect(workers).toBeDefined();
          expect(Array.isArray(workers)).toBe(true);
          // We expect at least our Test-Worker
          const found = workers.find(w => w.name === 'Test-Worker');
          expect(found).toBeDefined();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it('should execute a command and return PTY output', async () => {
    // We assume the previous test passed and we have the worker list logic implicitly
    // We need the worker ID. Since we can't easily share state across async socket callbacks nicely in this simple setup,
    // we'll ask for the list again or just assume the worker is registered.
    
    return new Promise<void>((resolve, reject) => {
        // Wait for output
        let outputBuffer = '';
        
        clientSocket.on('output', (data: any) => {
            outputBuffer += data.data;
            if (outputBuffer.includes('uid=')) {
                // Success! 'id' command worked
                resolve();
            }
        });

        // Get the worker ID first
        clientSocket.emit('register', { type: 'client' });
        clientSocket.once('worker-list', (workers: any[]) => {
            const target = workers.find(w => w.name === 'Test-Worker');
            if (!target) return reject(new Error('Worker not found'));

            // Send 'id' command
            console.log('Sending command to', target.id);
            clientSocket.emit('execute', {
                workerId: target.id,
                command: 'id\n'
            });
        });
    });
  }, 10000);
});

import { Server, Socket } from 'socket.io';
import { createServer } from 'http';
import { verifyToken, JwtPayload } from './utils/jwt';
import { WorkerModel, Worker } from './models/worker.model';
import db from './config/database';

interface SocketData {
  role: 'client' | 'worker';
  user?: JwtPayload;
  workerId?: string; // If role is worker
}

// In-memory state
export const workers: Map<string, Worker & { socketId: string }> = new Map();
// We can cache sessions in memory or query DB. Let's keep a cache for performance if needed, 
// but for now let's rely on DB + memory for active connections.

// Sessions map to keep track of outputs in memory (for performance vs writing to DB every char)
interface ActiveSession {
  id: string;
  workerId: string;
  output: string;
  lastActive: number;
  debounceTimer?: NodeJS.Timeout;
}
const activeSessions: Map<string, ActiveSession> = new Map();

export const initSocket = (httpServer: any) => {
  const io = new Server(httpServer, {
    cors: {
      origin: '*', // Configure properly in production
      methods: ['GET', 'POST'],
    },
  });

  io.use(async (socket, next) => {
    const { token, type, apiKey } = (socket.handshake.auth || {}) as any;
    
    try {
      if (type === 'client') {
        if (!token) return next(new Error('Missing token'));
        const payload = verifyToken(token);
        socket.data = { role: 'client', user: payload } as SocketData;
        return next();
      }
      
      if (type === 'worker') {
        if (!apiKey) return next(new Error('Missing API Key'));
        const worker = WorkerModel.findByApiKey(apiKey);
        if (!worker) return next(new Error('Invalid API Key'));
        
        socket.data = { role: 'worker', workerId: worker.id } as SocketData;
        
        // Register worker in memory immediately
        workers.set(worker.id, { ...worker, socketId: socket.id, status: 'online' });
        WorkerModel.updateStatus(worker.id, 'online');
        
        return next();
      }
      
      return next(new Error('Invalid connection type'));
    } catch (err: any) {
      return next(new Error('Authentication error: ' + err.message));
    }
  });

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    console.log(`New connection: ${socket.id} (${data.role})`);

    // Worker Life-cycle
    if (data.role === 'worker' && data.workerId) {
        // Broadcast online status?
        // In this new model, clients poll or we push to relevant clients.
        // For simplicity, let's just log.
        console.log(`Worker ${data.workerId} connected`);
    }

    socket.on('disconnect', () => {
       if (data.role === 'worker' && data.workerId) {
           workers.delete(data.workerId);
           WorkerModel.updateStatus(data.workerId, 'offline');
           console.log(`Worker ${data.workerId} disconnected`);
       }
    });

    // Client Commands
    socket.on('execute', async (msg: { workerId: string; command: string }) => {
       if (data.role !== 'client' || !data.user) return;
       
       if (!WorkerModel.hasAccess(data.user.userId, msg.workerId, 'control')) {
           socket.emit('error', 'Access denied to worker');
           return;
       }
       
       const worker = workers.get(msg.workerId);
       if (!worker) {
           socket.emit('error', 'Worker is offline');
           return;
       }
       
       // Send to worker
       io.to(worker.socketId).emit('execute', {
           clientId: socket.id,
           command: msg.command,
           sessionId: 'default' // Simple session management for now
       });
    });
    
    // Output from worker
    socket.on('output', (msg: { sessionId?: string; output: string }) => {
        if (data.role !== 'worker' || !data.workerId) return;
        
        // We broadcast to all clients who are listening to this worker/session
        // Ideally we use rooms: `io.to(`session:${sessionId}`).emit(...)`
        // For now, simple broadcast to everyone? No, security risk.
        // We need to know which clients are watching.
        
        // This part requires a bit more protocol design. 
        // Let's assume clients join a room "worker:ID".
        io.to(`worker:${data.workerId}`).emit('output', {
            workerId: data.workerId,
            data: msg.output
        });
    });
    
    // Client joining room
    socket.on('subscribe', (msg: { workerId: string }) => {
        if (data.role !== 'client' || !data.user) return;
        if (WorkerModel.hasAccess(data.user.userId, msg.workerId, 'view')) {
            socket.join(`worker:${msg.workerId}`);
        } else {
            socket.emit('error', 'Access denied');
        }
    });
  });
  
  return io;
};

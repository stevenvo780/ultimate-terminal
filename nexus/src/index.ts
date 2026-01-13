import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow all for prototype
    methods: ["GET", "POST"]
  }
});

interface Worker {
  id: string;
  socketId: string;
  name: string;
}

const workers: Map<string, Worker> = new Map();

io.on('connection', (socket: Socket) => {
  console.log(`New connection: ${socket.id}`);

  // Identification
  socket.on('register', (data: { type: 'worker' | 'client', name?: string }) => {
    if (data.type === 'worker') {
      const worker: Worker = {
        id: socket.id,
        socketId: socket.id,
        name: data.name || `Worker-${socket.id.substr(0, 4)}`
      };
      workers.set(socket.id, worker);
      console.log(`Worker registered: ${worker.name}`);
      io.emit('worker-list', Array.from(workers.values()));
    } else {
      console.log(`Client registered: ${socket.id}`);
      socket.emit('worker-list', Array.from(workers.values()));
    }
  });

  // Client -> Worker (Command)
  socket.on('execute', (data: { workerId: string, command: string }) => {
    const worker = workers.get(data.workerId);
    if (worker) {
      io.to(worker.socketId).emit('execute', {
        clientId: socket.id,
        command: data.command
      });
    }
  });

  // Worker -> Client (Output)
  socket.on('output', (data: { clientId?: string, output: string }) => {
    // If clientId is provided, send to specific client, else broadcast (or handle appropriately)
    // For now, let's broadcast to all clients if no specific client, or just to the specific one
    if (data.clientId) {
      io.to(data.clientId).emit('output', {
        workerId: socket.id,
        data: data.output
      });
    } else {
      // Broadcast to all clients (e.g. status updates)
      io.emit('output', {
         workerId: socket.id,
         data: data.output
      });
    }
  });

  socket.on('disconnect', () => {
    if (workers.has(socket.id)) {
      console.log(`Worker disconnected: ${workers.get(socket.id)?.name}`);
      workers.delete(socket.id);
      io.emit('worker-list', Array.from(workers.values()));
    }
    console.log(`Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3002;
httpServer.listen(PORT, () => {
  console.log(`Nexus running on port ${PORT}`);
});

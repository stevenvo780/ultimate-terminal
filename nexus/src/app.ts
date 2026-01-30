import express from 'express';
import cors from 'cors';
import path from 'path';
import { existsSync } from 'fs';
import authRoutes from './routes/auth.routes';
import workerRoutes from './routes/worker.routes';

const app = express();

const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = clientOrigin.split(',').map((o) => o.trim());
const corsOrigin = allowedOrigins.includes('*') ? '*' : allowedOrigins;

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/workers', workerRoutes);

// Static files (Client)
const clientPaths = [
  path.resolve(process.cwd(), 'client/dist'),
  path.resolve(process.cwd(), '../client/dist'),
  path.resolve(process.cwd(), 'public'),
  '/usr/share/ultimate-terminal/public',
  path.resolve(__dirname, '../public'),
];
const clientDistPath = clientPaths.find(p => existsSync(p));

if (clientDistPath) {
  app.use(express.static(clientDistPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
  console.log(`Serving client from ${clientDistPath}`);
}

export default app;

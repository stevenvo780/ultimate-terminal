import dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import app from './app';
import { initSocket } from './socket';
import { initDatabase } from './config/database';
import { UserModel } from './models/user.model';
import { WorkerModel } from './models/worker.model';

const PORT = process.env.PORT || 3002;

// Initialize Database
console.log('[Nexus] Initializing database...');
initDatabase();

// Bootstrap Admin if env var is set and no users exist
const adminPassword = process.env.ADMIN_PASSWORD;
let adminId: number | undefined;

if (adminPassword) {
    const adminUser = UserModel.findByUsername('admin');
    if (!adminUser) {
        console.log('[Nexus] Creating default admin user...');
        const newAdmin = UserModel.create('admin', adminPassword, true);
        adminId = newAdmin.id;
    } else {
        adminId = adminUser.id;
    }
}

// Bootstrap Dev Worker if WORKER_TOKEN env var is set (Dev/Docker environment)
const devWorkerToken = process.env.WORKER_TOKEN;
if (devWorkerToken && adminId) {
    const existingWorker = WorkerModel.findByApiKey(devWorkerToken);
    if (!existingWorker) {
        console.log('[Nexus] Creating default dev worker from WORKER_TOKEN...');
        WorkerModel.create(adminId, 'Docker-Dev-Worker', undefined, devWorkerToken);
    }
}

const httpServer = createServer(app);
const io = initSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`[Nexus] Server running on port ${PORT}`);
});

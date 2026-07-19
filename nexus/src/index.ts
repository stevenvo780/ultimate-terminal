
import dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import app from './app';
import { initSocket } from './socket';
import { initDatabase } from './config/database';
import { seedFleet } from './config/seed';
import { UserModel } from './models/user.model';
import { WorkerModel } from './models/worker.model';
import { PaymentService } from './services/payment.service';

const PORT = process.env.PORT || 3002;
const BILLING_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface DevWorkerSpec {
    name: string;
    apiKey: string;
}

const parseDevWorkerSpecs = (): DevWorkerSpec[] => {
    const specsRaw = process.env.DEV_WORKER_SPECS || '';
    const specs = specsRaw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const [name, apiKey] = entry.split(':').map((part) => part?.trim());
            if (!name || !apiKey) return null;
            return { name, apiKey };
        })
        .filter((spec): spec is DevWorkerSpec => Boolean(spec));

    if (specs.length > 0) {
        return specs;
    }

    const devWorkerToken = process.env.WORKER_TOKEN;
    return devWorkerToken
        ? [{ name: 'Docker-Dev-Worker-01', apiKey: devWorkerToken }]
        : [];
};

const startServer = async () => {
    console.log('[Nexus] Initializing database...');
    await initDatabase();
    await seedFleet();
    await WorkerModel.markAllOffline();

    const adminPassword = process.env.ADMIN_PASSWORD;
    let adminId: number | undefined;

    if (adminPassword) {
        const adminUser = await UserModel.findByUsername('admin');
        if (!adminUser) {
            console.log('[Nexus] Creating default admin user...');
            const newAdmin = await UserModel.create('admin', adminPassword, true);
            adminId = newAdmin.id;
        } else {
            adminId = adminUser.id;
        }
    }

    if (adminId) {
        const devWorkers = parseDevWorkerSpecs();
        for (const workerSpec of devWorkers) {
            const existingWorker = await WorkerModel.findByApiKey(workerSpec.apiKey);
            if (!existingWorker) {
                console.log(`[Nexus] Creating dev worker ${workerSpec.name}...`);
                await WorkerModel.create(adminId, workerSpec.name, undefined, workerSpec.apiKey);
                continue;
            }

            if (existingWorker.name !== workerSpec.name) {
                console.log(`[Nexus] Updating dev worker name ${existingWorker.name} -> ${workerSpec.name}`);
                await WorkerModel.updateName(existingWorker.id, workerSpec.name);
            }
        }
    }

    const httpServer = createServer(app);
    // Initialize Socket.IO server
    const io = initSocket(httpServer);
    app.set('io', io);

    httpServer.listen(PORT, () => {
        console.log(`[Nexus] Server running on port ${PORT}`);
    });

    // --- Internal billing scheduler ---
    // Run once on startup (after a short delay to let DB settle)
    setTimeout(async () => {
        try {
            console.log('[Billing] Running startup billing check...');
            const result = await PaymentService.processExpiredSubscriptions();
            console.log('[Billing] Startup result:', JSON.stringify(result));
        } catch (err: any) {
            console.error('[Billing] Startup check error:', err.message);
        }
    }, 10_000); // 10 seconds after boot

    // Run every 24 hours
    setInterval(async () => {
        try {
            console.log('[Billing] Running scheduled billing check...');
            const result = await PaymentService.processExpiredSubscriptions();
            console.log('[Billing] Scheduled result:', JSON.stringify(result));
        } catch (err: any) {
            console.error('[Billing] Scheduled check error:', err.message);
        }
    }, BILLING_INTERVAL_MS);

    console.log(`[Billing] Internal scheduler active (every ${BILLING_INTERVAL_MS / 3600000}h)`);
};

startServer().catch(err => {
    console.error('[Nexus] Failed to start server:', err);
    process.exit(1);
});

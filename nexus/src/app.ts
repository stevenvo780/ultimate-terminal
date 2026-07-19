import express from 'express';
import cors from 'cors';
import path from 'path';
import fs, { existsSync } from 'fs';
import { spawn } from 'child_process';
import authRoutes from './routes/auth.routes';
import workerRoutes from './routes/worker.routes';
import paymentRoutes from './routes/payment.routes';
import agentRoutes from './routes/agent.routes';
import tenantRoutes from './routes/tenant.routes';
import { evictUserSubscriptions } from './socket';

const app = express();

const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = clientOrigin.split(',').map((o) => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                     // same-origin / curl
    if (allowedOrigins.includes('*')) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Accept any Vercel preview deploy for this project
    if (/^https:\/\/.*stevenvo780.*\.vercel\.app$/.test(origin)) return cb(null, true);
    if (/^https:\/\/ultimate-terminal.*\.vercel\.app$/.test(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
}));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/tenants', tenantRoutes);

// --- Admin bootstrap endpoint (protected by ADMIN_PASSWORD) ---
app.post('/api/admin/upgrade-plan', async (req, res) => {
  const { adminPassword, username, plan, makeAdmin, tenant } = req.body;
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || adminPassword !== expected) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  try {
    const dbMod = (await import('./config/database')).default;
    if (tenant !== undefined) {
      // tenant: string para asignar, null para desasignar (global/admin).
      await dbMod.run("UPDATE users SET plan = ?, is_admin = ?, tenant_id = ? WHERE username = ?",
        [plan || 'enterprise', makeAdmin ? 1 : 0, tenant, username]);
    } else {
      await dbMod.run("UPDATE users SET plan = ?, is_admin = ? WHERE username = ?",
        [plan || 'enterprise', makeAdmin ? 1 : 0, username]);
    }
    const user = await dbMod.get<any>("SELECT id, username, is_admin, plan, tenant_id FROM users WHERE username = ?", [username]);
    if (user?.id) {
      evictUserSubscriptions(app.get('io'), Number(user.id));
    }
    res.json({ success: true, user });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

const installScriptPaths = [
  path.join(__dirname, 'scripts/install-worker.sh'),
  path.resolve(process.cwd(), 'nexus/src/scripts/install-worker.sh'),
  path.resolve(process.cwd(), 'src/scripts/install-worker.sh')
];

const workerSourceRoots = [
  path.resolve(process.cwd(), 'worker'),
  path.resolve(process.cwd(), '../worker'),
  path.resolve(__dirname, '../../worker')
];

const downloadRoots = [
  path.resolve(process.cwd(), 'dist/packages'),
  path.resolve(process.cwd(), '../dist/packages'),
  '/usr/share/ultimate-terminal/downloads'
];

app.get('/install.sh', (_req, res) => {
  const filePath = installScriptPaths.find((p) => existsSync(p));
  if (!filePath) {
    res.status(500).type('text/plain').send('install-worker.sh no encontrado en el servidor');
    return;
  }
  res.type('text/x-shellscript').send(fs.readFileSync(filePath, 'utf-8'));
});

// Tarball con el código fuente del worker para que el instalador pueda compilar
// localmente sin depender de GitHub.
app.get('/api/downloads/source', (_req, res) => {
  const workerDir = workerSourceRoots.find((p) => existsSync(p));
  if (!workerDir) {
    res.status(404).type('text/plain').send('Worker source not found on server');
    return;
  }
  const parent = path.dirname(workerDir);
  const base = path.basename(workerDir);
  res.type('application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="worker-source.tar.gz"');
  const tar = spawn('tar', [
    '--exclude=node_modules',
    '--exclude=dist',
    '--exclude=*.log',
    '--exclude=worker-dist.*',
    '-czf', '-', '-C', parent, base
  ]);
  tar.stdout.pipe(res);
  tar.stderr.on('data', (chunk) => console.error('[source.tar.gz]', chunk.toString()));
  tar.on('error', (err) => {
    console.error('[source.tar.gz] spawn error', err);
    if (!res.headersSent) res.status(500).end();
  });
});

// Compatibilidad: si existen paquetes pre-compilados, se siguen sirviendo.
// Si no existen, devolvemos un mensaje claro recomendando el instalador
// universal (source build), en lugar del 404 confuso original.
app.get('/api/downloads/latest/worker-linux.:ext', (req, res) => {
  const { ext } = req.params;
  const allowed = ext === 'deb' || ext === 'rpm';
  if (!allowed) {
    res.status(400).send('Formato no soportado. Usa .deb o .rpm');
    return;
  }
  const os = typeof req.query.os === 'string' ? req.query.os : '';
  const version = typeof req.query.version === 'string' ? req.query.version : '';
  const arch = typeof req.query.arch === 'string' ? req.query.arch : '';

  const normalizeToken = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const osKey = normalizeToken(os);
  const versionKey = normalizeToken(version);
  const versionCompact = versionKey.replace(/[^0-9]+/g, '');
  const archKey = normalizeToken(arch);

  const candidates = downloadRoots.flatMap((root) => {
    if (!existsSync(root)) return [];
    return fs.readdirSync(root)
      .filter((name) => (
        (name.startsWith('ultimate-terminal-worker') || name.startsWith('worker-linux')) &&
        name.endsWith(`.${ext}`)
      ))
      .map((name) => ({
        name,
        path: path.join(root, name),
        score: (() => {
          const key = normalizeToken(name);
          let score = 0;
          if (osKey && key.includes(osKey)) score += 4;
          if (versionKey && key.includes(versionKey)) score += 3;
          if (versionCompact && key.includes(versionCompact)) score += 2;
          if (archKey && key.includes(archKey)) score += 1;
          if (key.includes('compat') || key.includes('glibc')) score += 1;
          return score;
        })(),
      }));
  });

  const file = candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.name.length - a.name.length;
  })[0];

  if (!file) {
    res.status(410)
      .type('text/plain')
      .send(
        'No hay paquetes prebuilt .deb/.rpm en este Nexus.\n' +
        'Usa el instalador universal (source build):\n' +
        `  curl -fsSL "${process.env.NEXUS_PUBLIC_URL || process.env.NEXUS_URL || ''}/install.sh" | sudo NEXUS_URL="${process.env.NEXUS_PUBLIC_URL || process.env.NEXUS_URL || ''}" WORKER_NAME=<nombre> bash -s -- <API_KEY>\n`
      );
    return;
  }

  const filename = ext === 'deb' ? 'worker-linux.deb' : 'worker-linux.rpm';
  res.download(file.path, filename);
});

// Health / root endpoint (client is served separately via Vercel)
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'ultimate-terminal-nexus' });
});

export default app;

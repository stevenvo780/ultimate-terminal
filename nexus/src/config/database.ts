
import path from 'path';
import fs from 'fs';
import { DBAdapter, BetterSqliteAdapter, PostgresAdapter } from './db-adapter';

const customDataDir = (process.env.NEXUS_DATA_DIR || '').trim();
const dataDir = customDataDir ? path.resolve(customDataDir) : path.resolve(process.cwd(), '.qodo');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'nexus.db');

const SYSTEM_NATIVE_BINDING = '/usr/lib/ultimate-terminal/prebuilds/linux-x64/better_sqlite3.node';
const dbOptions = fs.existsSync(SYSTEM_NATIVE_BINDING)
  ? { nativeBinding: SYSTEM_NATIVE_BINDING }
  : {};

let db: DBAdapter;

if (process.env.DATABASE_URL) {
  console.log('[Nexus] Using PostgreSQL connection');
  db = new PostgresAdapter(process.env.DATABASE_URL);
} else {
  console.log('[Nexus] Using SQLite connection');
  db = new BetterSqliteAdapter(dbPath, dbOptions);
  // Enable WAL mode for SQLite
  db.exec('PRAGMA journal_mode = WAL').catch(err => console.error('Failed to set WAL mode:', err));
}

export const initDatabase = async () => {
  const isPg = db instanceof PostgresAdapter;
  const AUTO_INC = isPg ? 'SERIAL' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  console.log(`[Nexus] Initializing DB (PG=${isPg})`);

  // Users
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id ${AUTO_INC},
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      plan TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL${isPg ? ', PRIMARY KEY (id)' : ''}
    );
  `);

  // Migration: add plan column if missing (existing DBs)
  try {
    await db.exec(`ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`);
    console.log('[Nexus] Added plan column to users table');
  } catch (_e) {
    // Column already exists — ignore
  }

  // Migration: scope de usuario a un tenant (NULL = global/admin, no rompe users existentes)
  try {
    await db.exec(`ALTER TABLE users ADD COLUMN tenant_id TEXT`);
    console.log('[Nexus] Added tenant_id column to users table');
  } catch (_e) { /* ya existe — ignorar */ }

  // Tenants (personas / grupos de bus). PK textual (slug) → NO usa AUTO_INC.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      bus_group TEXT NOT NULL,
      open_to_all INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  // Agents (registry de la flota, ex-array estático de client/src/lib/agents.ts).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id ${AUTO_INC},
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      harness TEXT NOT NULL DEFAULT 'claude-code',
      tui_worker TEXT,
      shell_worker TEXT,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      UNIQUE(tenant_id, key)${isPg ? ', PRIMARY KEY (id)' : ''}
    );
  `);

  // Workers
  await db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'offline',
      last_seen ${isPg ? 'BIGINT' : 'INTEGER'},
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Worker Shares
  await db.exec(`
    CREATE TABLE IF NOT EXISTS worker_shares (
      id ${AUTO_INC},
      worker_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      permission TEXT DEFAULT 'view',
      FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(worker_id, user_id)${isPg ? ', PRIMARY KEY (id)' : ''}
    );
  `);

  // Sessions
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      user_id INTEGER,
      display_name TEXT NOT NULL,
      created_at ${isPg ? 'BIGINT' : 'INTEGER'} NOT NULL,
      last_active_at ${isPg ? 'BIGINT' : 'INTEGER'} NOT NULL,
      output TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // Audit
  await db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id ${AUTO_INC},
      ts TEXT NOT NULL,
      event TEXT NOT NULL,
      data TEXT NOT NULL,
      user_id INTEGER,
      worker_id TEXT${isPg ? ', PRIMARY KEY (id)' : ''}
    );
  `);

  // Payments (Mercado Pago)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id ${AUTO_INC},
      user_id INTEGER NOT NULL,
      preference_id TEXT NOT NULL,
      mp_payment_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      plan TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'COP',
      subscription_start TEXT,
      subscription_end TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE${isPg ? ', PRIMARY KEY (id)' : ''}
    );
  `);

  // Migration: add subscription columns if missing (existing DBs)
  try {
    await db.exec(`ALTER TABLE payments ADD COLUMN subscription_start TEXT`);
    console.log('[Nexus] Added subscription_start column to payments table');
  } catch (_e) { /* already exists */ }
  try {
    await db.exec(`ALTER TABLE payments ADD COLUMN subscription_end TEXT`);
    console.log('[Nexus] Added subscription_end column to payments table');
  } catch (_e) { /* already exists */ }
};

export default db;

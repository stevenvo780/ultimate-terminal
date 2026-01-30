import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = path.resolve(process.cwd(), '.qodo');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'nexus.db');

// Use system native binding if available (for packaged binary)
const SYSTEM_NATIVE_BINDING = '/usr/lib/ultimate-terminal/prebuilds/linux-x64/better_sqlite3.node';
const dbOptions = fs.existsSync(SYSTEM_NATIVE_BINDING)
  ? { nativeBinding: SYSTEM_NATIVE_BINDING }
  : {};

const db = new Database(dbPath, dbOptions);
db.pragma('journal_mode = WAL');

export const initDatabase = () => {
  // Users Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  // Workers Table (Devices)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'offline',
      last_seen INTEGER,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Shared access to workers
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      permission TEXT DEFAULT 'view',
      FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(worker_id, user_id)
    );
  `);

  // Sessions (Terminal sessions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      user_id INTEGER,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      output TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // Audit Log
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      event TEXT NOT NULL,
      data TEXT NOT NULL,
      user_id INTEGER,
      worker_id TEXT
    );
  `);
};

export default db;

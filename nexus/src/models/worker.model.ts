import crypto from 'crypto';
import db from '../config/database';
import { generateApiKey } from '../utils/crypto';

export interface Worker {
  id: string;
  owner_id: number;
  name: string;
  api_key: string;
  status: 'online' | 'offline';
  last_seen: number;
}

export interface WorkerShare {
  worker_id: string;
  user_id: number;
  permission: 'view' | 'control' | 'admin';
}

export class WorkerModel {
  static create(ownerId: number, name: string, id?: string, fixedApiKey?: string): Worker {
    const workerId = id || crypto.randomUUID();
    const apiKey = fixedApiKey || generateApiKey();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO workers (id, owner_id, name, api_key, status, last_seen)
      VALUES (?, ?, ?, ?, 'offline', ?)
    `);

    stmt.run(workerId, ownerId, name, apiKey, now);


    return {
      id: workerId,
      owner_id: ownerId,
      name,
      api_key: apiKey,
      status: 'offline',
      last_seen: now
    };
  }

  static findByApiKey(apiKey: string): Worker | undefined {
    return db.prepare('SELECT * FROM workers WHERE api_key = ?').get(apiKey) as Worker | undefined;
  }
  
  static findById(id: string): Worker | undefined {
    return db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as Worker | undefined;
  }

  static getAccessibleWorkers(userId: number): (Worker & { permission: string })[] {
    // Return workers owned by user AND shared with user
    const stmt = db.prepare(`
      SELECT w.*, 'admin' as permission 
      FROM workers w 
      WHERE w.owner_id = ?
      
      UNION
      
      SELECT w.*, ws.permission
      FROM workers w
      JOIN worker_shares ws ON w.id = ws.worker_id
      WHERE ws.user_id = ?
    `);
    
    return stmt.all(userId, userId) as (Worker & { permission: string })[];
  }

  static share(workerId: string, userId: number, permission: 'view' | 'control' | 'admin') {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO worker_shares (worker_id, user_id, permission)
      VALUES (?, ?, ?)
    `);
    stmt.run(workerId, userId, permission);
  }

  static unshare(workerId: string, userId: number) {
    db.prepare('DELETE FROM worker_shares WHERE worker_id = ? AND user_id = ?').run(workerId, userId);
  }

  static updateStatus(id: string, status: 'online' | 'offline') {
    db.prepare('UPDATE workers SET status = ?, last_seen = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }
  
  static hasAccess(userId: number, workerId: string, requiredPermission: 'view' | 'control' | 'admin' = 'view'): boolean {
     const worker = this.findById(workerId);
     if (!worker) return false;
     if (worker.owner_id === userId) return true;
     
     const share = db.prepare('SELECT permission FROM worker_shares WHERE worker_id = ? AND user_id = ?').get(workerId, userId) as { permission: string } | undefined;
     if (!share) return false;
     
     const levels = { 'view': 1, 'control': 2, 'admin': 3 };
     return levels[share.permission as keyof typeof levels] >= levels[requiredPermission];
  }
}

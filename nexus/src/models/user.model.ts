
import db from '../config/database';
import { hashPassword } from '../utils/crypto';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
  is_admin: number;
  created_at: string;
  tenant_id?: string | null;
}

export class UserModel {
  static async create(username: string, password: string, isAdmin: boolean = false, tenantId?: string | null): Promise<User> {
    const { hash, salt } = hashPassword(password);
    const createdAt = new Date().toISOString();

    const result = await db.run(`
      INSERT INTO users (username, password_hash, salt, is_admin, created_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [username, hash, salt, isAdmin ? 1 : 0, createdAt, tenantId ?? null]);

    const id = Number(result.lastInsertId);

    return {
      id,
      username,
      password_hash: hash,
      salt,
      is_admin: isAdmin ? 1 : 0,
      created_at: createdAt,
      tenant_id: tenantId ?? null
    };
  }

  static async updateTenant(id: number, tenantId: string | null): Promise<void> {
    await db.run('UPDATE users SET tenant_id = ? WHERE id = ?', [tenantId, id]);
  }

  static async findByUsername(username: string): Promise<User | undefined> {
    return db.get<User>('SELECT * FROM users WHERE username = ?', [username]);
  }

  static async findById(id: number): Promise<User | undefined> {
    return db.get<User>('SELECT * FROM users WHERE id = ?', [id]);
  }

  static async findFirstAdmin(): Promise<User | undefined> {
    return db.get<User>('SELECT * FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1');
  }

  static async findFirstUser(): Promise<User | undefined> {
    return db.get<User>('SELECT * FROM users ORDER BY id ASC LIMIT 1');
  }

  static async count(): Promise<number> {
    const row = await db.get<{ count: number | string }>('SELECT COUNT(*) as count FROM users');
    return row ? Number(row.count) : 0;
  }

  static async updatePassword(id: number, newPassword: string): Promise<void> {
    const { hash, salt } = hashPassword(newPassword);
    await db.run('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [hash, salt, id]);
  }
}

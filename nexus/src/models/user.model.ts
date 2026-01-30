import db from '../config/database';
import { hashPassword } from '../utils/crypto';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
  is_admin: number;
  created_at: string;
}

export class UserModel {
  static create(username: string, password: string, isAdmin: boolean = false): User {
    const { hash, salt } = hashPassword(password);
    const createdAt = new Date().toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO users (username, password_hash, salt, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const info = stmt.run(username, hash, salt, isAdmin ? 1 : 0, createdAt);
    
    return {
      id: info.lastInsertRowid as number,
      username,
      password_hash: hash,
      salt,
      is_admin: isAdmin ? 1 : 0,
      created_at: createdAt
    };
  }

  static findByUsername(username: string): User | undefined {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  }

  static findById(id: number): User | undefined {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  }
}

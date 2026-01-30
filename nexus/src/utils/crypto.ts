import crypto from 'crypto';

export interface PasswordData {
  hash: string;
  salt: string;
}

export function hashPassword(password: string, salt?: string, iterations = 150000): PasswordData {
  const resolvedSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, resolvedSalt, iterations, 64, 'sha512').toString('hex');
  return { hash, salt: resolvedSalt };
}

export function verifyPassword(password: string, storedHash: string, salt: string): boolean {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

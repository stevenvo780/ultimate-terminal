import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// Get secret from env or generate a random one (warn in production)
const rawJwtSecret = (process.env.NEXUS_JWT_SECRET || '').trim();

function resolveJwtSecret(secret: string) {
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXUS_JWT_SECRET must be set in production.');
  }
  return 'dev-secret-do-not-use-in-prod'; // Fallback for dev to avoid random restarts invalidating tokens
}

export const JWT_SECRET = resolveJwtSecret(rawJwtSecret);

export interface JwtPayload {
  userId: number;
  username: string;
  isAdmin: boolean;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

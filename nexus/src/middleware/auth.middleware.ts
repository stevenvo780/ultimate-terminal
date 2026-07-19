import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/jwt';
import { UserModel } from '../models/user.model';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'Malformed token' });
    return;
  }

  try {
    const payload = verifyToken(token);
    const currentUser = await UserModel.findById(payload.userId);
    if (!currentUser) {
      res.status(401).json({ error: 'User invalid or no longer exists' });
      return;
    }
    // Never authorize from role/tenant claims that may be stale for up to the
    // JWT lifetime. Keep identity from the signed token, but refresh all mutable
    // authorization fields from the database on every protected REST request.
    req.user = {
      userId: currentUser.id,
      username: currentUser.username,
      isAdmin: currentUser.is_admin === 1,
      tenantId: currentUser.tenant_id ?? null,
    };
    next();
  } catch (_err) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
}

export function roleMiddleware(requiredRole: 'admin') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || (requiredRole === 'admin' && !req.user.isAdmin)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

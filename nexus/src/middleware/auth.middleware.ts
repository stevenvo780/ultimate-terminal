import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/jwt';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
     res.status(401).json({ error: 'No token provided' });
     return;
  }

  const token = authHeader.split(' ')[1]; // Bearer <token>
  if (!token) {
     res.status(401).json({ error: 'Malformed token' });
     return;
  }

  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch (err) {
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

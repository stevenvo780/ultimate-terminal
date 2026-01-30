import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';

export class AuthController {
  static async login(req: Request, res: Response) {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        res.status(400).json({ error: 'Username and password required' });
        return;
      }
      const result = await AuthService.login(username, password);
      res.json(result);
    } catch (err: any) {
      res.status(401).json({ error: err.message });
    }
  }

  static async register(req: Request, res: Response) {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
          res.status(400).json({ error: 'Username and password required' });
          return;
      }
      if (password.length < 6) {
          res.status(400).json({ error: 'Password too short' });
          return;
      }
      
      const result = await AuthService.register(username, password);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
  
  static async getMe(req: Request, res: Response) {
      res.json({ user: req.user });
  }
}

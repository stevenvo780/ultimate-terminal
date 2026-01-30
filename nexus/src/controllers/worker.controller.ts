import { Request, Response } from 'express';
import { WorkerModel } from '../models/worker.model';

export class WorkerController {
  static async list(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const workers = WorkerModel.getAccessibleWorkers(req.user.userId);
    res.json(workers);
  }

  static async create(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const { name } = req.body;
    if (!name) { res.status(400).json({error: 'Name required'}); return; }
    
    const worker = WorkerModel.create(req.user.userId, name);
    res.json(worker);
  }
  
  static async share(req: Request, res: Response) {
    if (!req.user) { res.status(401).send(); return; }
    const { workerId, targetUserId, permission } = req.body;
    
    const worker = WorkerModel.findById(workerId);
    if (!worker) { res.status(404).json({error: 'Worker not found'}); return; }
    
    if (worker.owner_id !== req.user.userId && !req.user.isAdmin) {
        res.status(403).json({error: 'Only owner can share'}); 
        return;
    }
    
    WorkerModel.share(workerId, targetUserId, permission || 'view');
    res.json({ success: true });
  }
}

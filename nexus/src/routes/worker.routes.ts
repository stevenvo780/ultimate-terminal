import { Router } from 'express';
import { WorkerController } from '../controllers/worker.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', WorkerController.list);
router.post('/', WorkerController.create);
router.post('/share', WorkerController.share);

export default router;

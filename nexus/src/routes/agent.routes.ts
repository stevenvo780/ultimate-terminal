import { Router } from 'express';
import { AgentController } from '../controllers/agent.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', AgentController.list);
router.get('/:id', AgentController.get);
router.post('/', AgentController.create);
router.patch('/:id', AgentController.update);
router.delete('/:id', AgentController.remove);

export default router;

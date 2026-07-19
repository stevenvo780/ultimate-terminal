import { Router } from 'express';
import { TenantController } from '../controllers/tenant.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', TenantController.list);

export default router;

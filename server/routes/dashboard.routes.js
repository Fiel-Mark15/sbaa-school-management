import { Router } from 'express';
import { summary, context } from '../controllers/dashboard.controller.js';
import { authenticate } from '../middleware/auth.js';
const router = Router(); router.get('/summary', authenticate, summary); router.get('/context',authenticate,context); export default router;

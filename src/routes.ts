import { Router } from 'express';
import authRoutes from '@/modules/auth/auth.routes';
import memberRoutes from '@/modules/members/members.routes';
import settingsRoutes from '@/modules/settings/settings.routes';
import paymentRoutes from '@/modules/payments/payments.routes';
import wsRoutes from '@/modules/ws/ws.routes';
import pushRoutes from '@/modules/push/push.routes';
import uploadRoutes from '@/modules/uploads/uploads.routes';
import adminMembersRoutes from '@/modules/admin/members/admin-members.routes';
import adminRetentionRoutes from '@/modules/admin/retention/admin-retention.routes';
import adminDashboardRoutes from '@/modules/admin/dashboard/admin-dashboard.routes';
import adminSettingsRoutes from '@/modules/admin/settings/admin-settings.routes';

const router = Router();

router.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

router.use('/auth', authRoutes);
router.use('/members', memberRoutes);
router.use('/settings', settingsRoutes);
router.use('/payments', paymentRoutes);
router.use('/ws', wsRoutes);
router.use('/push', pushRoutes);
router.use('/uploads', uploadRoutes);
router.use('/admin/members', adminMembersRoutes);
router.use('/admin/retention', adminRetentionRoutes);
router.use('/admin/settings', adminSettingsRoutes);
router.use('/admin', adminDashboardRoutes);

export default router;

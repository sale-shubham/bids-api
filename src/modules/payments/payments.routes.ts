import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { verifySchema } from './payments.validation';

// Handlers lazy-load the payment service + response helpers via dynamic import()
// (defers init -> tighter Lambda cold start). Routes stay statically registered.
const router = Router();

// Razorpay webhook — UNAUTHENTICATED (called by Razorpay). Signature is verified
// against the RAW request body: app.ts's express.json() verify callback exposes
// the raw bytes on req.rawBody; without it verification fails closed.
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./payments.service');
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const rawBody = Buffer.isBuffer(raw) ? raw.toString('utf8') : JSON.stringify(req.body ?? {});
    const signature = req.header('x-razorpay-signature') ?? '';
    const eventId = req.header('x-razorpay-event-id') ?? '';
    return ok(res, await svc.handleWebhook(rawBody, signature, eventId));
  }),
);

// Browser callback after Razorpay Checkout: verify signature + gateway payment, settle.
router.post(
  '/verify',
  authenticate,
  requireActiveMember,
  validate(verifySchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./payments.service');
    return ok(res, await svc.verifyPayment(req.user!.sub, req.body));
  }),
);

export default router;

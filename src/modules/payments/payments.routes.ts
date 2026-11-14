import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';

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

// TODO(Phase 1+): authenticated routes — POST /commissions/:id/checkout, POST /payments/verify.

export default router;

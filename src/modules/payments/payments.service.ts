import { Prisma } from '@prisma/client';
import { prisma } from '@/core/prisma/client';
import { BadRequest } from '@/core/errors/AppError';
import { logger } from '@/core/logger/logger';
import crypto from 'node:crypto';

// The payment provider is lazy-loaded inside each function (dynamic import) so
// it only initializes when a payment path is hit — keeps Lambda cold start tight.

// TODO(Phase 1+): commission checkout (create PaymentOrder + gateway order) and
// POST /payments/verify (HMAC check + fetchPayment amount check -> mark PAID,
// decrement Member.unpaidCommissionPaise). Handle `payment.captured` /
// `order.paid` webhook events in handleWebhook below.

/**
 * Razorpay webhook handler. Signature-verified against the RAW request body
 * (HMAC, fail-closed) and idempotent on the gateway event id (re-delivery -> skipped).
 */
export async function handleWebhook(rawBody: string, signature: string, eventId: string) {
  const { paymentProvider } = await import('@/providers/payment');
  if (!paymentProvider.verifyWebhook(rawBody, signature)) {
    throw BadRequest('Invalid webhook signature');
  }

  let event: { event?: string; payload?: { payment?: { entity?: { id?: string } } } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw BadRequest('Invalid webhook payload');
  }

  const type = event.event ?? 'unknown';
  // Razorpay sends x-razorpay-event-id for dedup; fall back to the entity id.
  const dedupId = eventId || event.payload?.payment?.entity?.id || `${type}:${crypto.randomUUID()}`;

  const seen = await prisma.webhookEvent.findUnique({ where: { gatewayEventId: dedupId } });
  if (seen) return { skipped: true };

  logger.info({ type }, 'Unhandled webhook event type');

  // Record the event last so a processing failure doesn't permanently swallow it.
  try {
    await prisma.webhookEvent.create({ data: { gatewayEventId: dedupId, type, payload: event as object } });
  } catch (e) {
    // Concurrent delivery already recorded it.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
  }

  return { processed: true };
}

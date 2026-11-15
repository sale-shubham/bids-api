import { Prisma } from '@prisma/client';
import { prisma } from '@/core/prisma/client';
import { AppError, BadRequest } from '@/core/errors/AppError';
import { logger } from '@/core/logger/logger';
import { toPaise } from '@/core/money';
import crypto from 'node:crypto';
import { getCommissionDTO, markCommissionPaid } from '@/modules/commissions/commissions.service';

// The payment provider is lazy-loaded inside each function (dynamic import) so
// it only initializes when a payment path is hit — keeps Lambda cold start tight.

/**
 * POST /payments/verify — browser callback after Razorpay Checkout succeeds.
 * order belongs to member -> HMAC signature -> gateway says captured/authorized
 * with the same amount -> settle (idempotent, shared with the webhook).
 */
export async function verifyPayment(
  memberId: string,
  input: { orderId: string; paymentId: string; signature: string },
) {
  const order = await prisma.paymentOrder.findFirst({
    where: { gatewayOrderId: input.orderId, memberId },
  });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Payment order not found');

  const { paymentProvider } = await import('@/providers/payment');
  // Stub driver accepts only signature === 'stub' (and only exists when PAYMENT_DRIVER=stub).
  if (!paymentProvider.verifyPaymentSignature(input)) {
    throw new AppError(400, 'INVALID_SIGNATURE', 'Invalid payment signature');
  }

  const payment = await paymentProvider.fetchPayment(input.paymentId);
  if (payment.status !== 'captured' && payment.status !== 'authorized') {
    throw new AppError(409, 'PAYMENT_NOT_CAPTURED', 'Payment has not been captured');
  }
  if (payment.amountPaise !== null && payment.amountPaise !== toPaise(order.amountPaise)) {
    throw new AppError(409, 'AMOUNT_MISMATCH', 'Paid amount does not match the order');
  }

  const { commissionId } = await markCommissionPaid({ paymentOrderId: order.id, gatewayPaymentId: input.paymentId });
  if (!commissionId) throw new AppError(404, 'COMMISSION_NOT_FOUND', 'Commission not found');
  return { commission: await getCommissionDTO(commissionId) };
}

type WebhookEvent = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; notes?: unknown } };
    order?: { entity?: { id?: string; notes?: unknown } };
  };
};

const noteCommissionId = (notes: unknown): string | undefined => {
  const v = (notes as { commissionId?: unknown } | null | undefined)?.commissionId;
  return typeof v === 'string' ? v : undefined;
};

// Resolve our PaymentOrder from the event: Razorpay order id first, then the
// commissionId note (latest order for that commission).
async function findOrderForEvent(event: WebhookEvent) {
  const pay = event.payload?.payment?.entity;
  const ord = event.payload?.order?.entity;
  const gatewayOrderId = pay?.order_id ?? ord?.id;
  if (gatewayOrderId) {
    const byId = await prisma.paymentOrder.findUnique({ where: { gatewayOrderId } });
    if (byId) return byId;
  }
  const commissionId = noteCommissionId(pay?.notes) ?? noteCommissionId(ord?.notes);
  if (commissionId) {
    return prisma.paymentOrder.findFirst({
      where: { referenceType: 'COMMISSION', referenceId: commissionId },
      orderBy: { createdAt: 'desc' },
    });
  }
  return null;
}

async function processEvent(event: WebhookEvent) {
  const type = event.event ?? 'unknown';
  if (type !== 'payment.captured' && type !== 'order.paid' && type !== 'payment.failed') {
    logger.info({ type }, 'Unhandled webhook event type');
    return;
  }
  const order = await findOrderForEvent(event);
  if (!order) {
    logger.warn({ type }, 'webhook: no matching payment order');
    return;
  }
  const paymentId = event.payload?.payment?.entity?.id ?? null;
  if (type === 'payment.failed') {
    // Only an unsettled order may fail; a later successful retry still settles via captured.
    await prisma.paymentOrder.updateMany({ where: { id: order.id, status: 'CREATED' }, data: { status: 'FAILED' } });
    return;
  }
  await markCommissionPaid({ paymentOrderId: order.id, gatewayPaymentId: paymentId });
}

/**
 * Razorpay webhook handler. Signature-verified against the RAW request body
 * (HMAC, fail-closed) and idempotent on the gateway event id (re-delivery -> skipped).
 * Always answers 200 for a valid signature, even when there is nothing to do.
 */
export async function handleWebhook(rawBody: string, signature: string, eventId: string) {
  const { paymentProvider } = await import('@/providers/payment');
  if (!paymentProvider.verifyWebhook(rawBody, signature)) {
    throw BadRequest('Invalid webhook signature');
  }

  let event: WebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw BadRequest('Invalid webhook payload');
  }

  const type = event.event ?? 'unknown';
  // Razorpay sends x-razorpay-event-id for dedup; fall back to type + entity id.
  const entityId = event.payload?.payment?.entity?.id ?? event.payload?.order?.entity?.id;
  const dedupId = eventId || (entityId ? `${type}:${entityId}` : `${type}:${crypto.randomUUID()}`);

  const seen = await prisma.webhookEvent.findUnique({ where: { gatewayEventId: dedupId } });
  if (seen) return { skipped: true };

  await processEvent(event);

  // Record the event last so a processing failure doesn't permanently swallow it
  // (markCommissionPaid is itself idempotent, so a retry is safe).
  try {
    await prisma.webhookEvent.create({ data: { gatewayEventId: dedupId, type, payload: event as object } });
  } catch (e) {
    // Concurrent delivery already recorded it.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
  }

  return { processed: true };
}

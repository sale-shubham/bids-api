import { Prisma } from '@prisma/client';
import { prisma } from '@/core/prisma/client';
import { AppError, BadRequest } from '@/core/errors/AppError';
import { logger } from '@/core/logger/logger';
import { toPaise } from '@/core/money';
import crypto from 'node:crypto';
import { getCommissionDTO, markCommissionPaid } from '@/modules/commissions/commissions.service';
import { getSaleDTO, markSalePaid, storeTransferId } from '@/modules/sales/sales.service';
import { getDepositDTO, markDepositHeld } from '@/modules/deposits/deposits.service';
import { mapActivationStatus } from '@/providers/payment/route-status';
import { refreshSellerVerification } from '@/modules/members/verification.service';

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

  if (order.referenceType === 'SALE') {
    const { saleId } = await markSalePaid({ paymentOrderId: order.id, gatewayPaymentId: input.paymentId });
    if (!saleId) throw new AppError(404, 'SALE_NOT_FOUND', 'Sale not found');
    return { referenceType: 'SALE' as const, sale: await getSaleDTO(saleId, { id: memberId }) };
  }
  if (order.referenceType === 'DEPOSIT') {
    const { depositId } = await markDepositHeld({ paymentOrderId: order.id, gatewayPaymentId: input.paymentId });
    const deposit = depositId ? await getDepositDTO(depositId) : null;
    if (!deposit) throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Deposit not found');
    return { referenceType: 'DEPOSIT' as const, deposit };
  }
  if (order.referenceType !== 'COMMISSION') {
    throw new AppError(409, 'ORDER_REFERENCE_UNKNOWN', 'This payment order cannot be settled');
  }
  const { commissionId } = await markCommissionPaid({ paymentOrderId: order.id, gatewayPaymentId: input.paymentId });
  if (!commissionId) throw new AppError(404, 'COMMISSION_NOT_FOUND', 'Commission not found');
  return { referenceType: 'COMMISSION' as const, commission: await getCommissionDTO(commissionId) };
}

type WebhookEvent = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; notes?: unknown } };
    order?: { entity?: { id?: string; notes?: unknown } };
    transfer?: { entity?: { id?: string; source?: string } };
    'product.route'?: ProductEntity;
    product?: ProductEntity;
  };
  account_id?: string;
};

type ProductEntity = {
  entity?: {
    id?: string;
    account_id?: string;
    activation_status?: string;
    requirements?: { field_reference?: string; reason_code?: string; resolution_url?: string }[];
  };
};

const noteString = (notes: unknown, key: 'commissionId' | 'saleId' | 'depositId'): string | undefined => {
  const v = (notes as Record<string, unknown> | null | undefined)?.[key];
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
  const commissionId = noteString(pay?.notes, 'commissionId') ?? noteString(ord?.notes, 'commissionId');
  if (commissionId) {
    return prisma.paymentOrder.findFirst({
      where: { referenceType: 'COMMISSION', referenceId: commissionId },
      orderBy: { createdAt: 'desc' },
    });
  }
  const saleId = noteString(pay?.notes, 'saleId') ?? noteString(ord?.notes, 'saleId');
  if (saleId) {
    return prisma.paymentOrder.findFirst({
      where: { referenceType: 'SALE', referenceId: saleId },
      orderBy: { createdAt: 'desc' },
    });
  }
  const depositId = noteString(pay?.notes, 'depositId') ?? noteString(ord?.notes, 'depositId');
  if (depositId) {
    return prisma.paymentOrder.findFirst({
      where: { referenceType: 'DEPOSIT', referenceId: depositId },
      orderBy: { createdAt: 'desc' },
    });
  }
  return null;
}

// Route product events: keep SellerPayoutAccount.status in step with Razorpay's activation.
// VERIFY in Razorpay test mode: exact event names, payload key ('product.route') and account_id location.
async function processProductEvent(event: WebhookEvent) {
  const type = event.event ?? '';
  const entity = (event.payload?.['product.route'] ?? event.payload?.product)?.entity;
  const accountId = event.account_id ?? entity?.account_id;
  if (!accountId) {
    logger.warn({ type }, 'webhook: product event without account id');
    return;
  }
  const suffix = type.replace(/^product\.route\./, '');
  const status = mapActivationStatus(entity?.activation_status ?? suffix);
  const reasons = (entity?.requirements ?? []).map((r) => r.reason_code ?? r.field_reference).filter((r): r is string => !!r);
  const statusReason = status === 'NEEDS_CLARIFICATION' && reasons.length ? reasons.join(', ').slice(0, 500) : null;
  const accounts = await prisma.sellerPayoutAccount.findMany({ where: { razorpayAccountId: accountId }, select: { sellerId: true } });
  const { count } = await prisma.sellerPayoutAccount.updateMany({
    where: { razorpayAccountId: accountId },
    data: { status, statusReason },
  });
  if (count === 0) logger.warn({ type, accountId }, 'webhook: no payout account for product event');
  for (const a of accounts) await refreshSellerVerification(a.sellerId);
}

async function processTransferProcessed(event: WebhookEvent) {
  const t = event.payload?.transfer?.entity;
  // VERIFY in Razorpay test mode: transfer.source is the payment id for payment-linked transfers.
  if (!t?.id || !t.source) return;
  await prisma.sale.updateMany({ where: { gatewayPaymentId: t.source, transferId: null }, data: { transferId: t.id } });
}

async function processEvent(event: WebhookEvent) {
  const type = event.event ?? 'unknown';
  if (type.startsWith('product.route.')) return processProductEvent(event);
  if (type === 'transfer.processed') return processTransferProcessed(event);
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
  if (order.referenceType === 'SALE') {
    const { saleId } = await markSalePaid({ paymentOrderId: order.id, gatewayPaymentId: paymentId });
    // A redelivery after a failed transfer lookup still gets the transfer id stored.
    if (saleId) await storeTransferId(saleId, paymentId);
    return;
  }
  if (order.referenceType === 'DEPOSIT') {
    await markDepositHeld({ paymentOrderId: order.id, gatewayPaymentId: paymentId });
    return;
  }
  if (order.referenceType !== 'COMMISSION') {
    logger.warn({ type, orderId: order.id, referenceType: order.referenceType }, 'webhook: order has an unknown reference type');
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
  const entityId =
    event.payload?.payment?.entity?.id ??
    event.payload?.order?.entity?.id ??
    event.payload?.transfer?.entity?.id ??
    (event.payload?.['product.route'] ?? event.payload?.product)?.entity?.id;
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

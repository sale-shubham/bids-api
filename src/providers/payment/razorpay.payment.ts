import crypto from 'node:crypto';
import { env } from '@/core/config/env';
import type {
  CreatedGatewayOrder,
  GatewayPayment,
  PaymentProvider,
  VerifyPaymentInput,
} from './payment.provider';

// Razorpay's error body shape: { error: { code, description, field? } }.
// Surfacing `description` in the thrown message makes a 400 diagnosable from logs.
async function describeError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { description?: string } };
    return body.error?.description ? `${res.status} — ${body.error.description}` : String(res.status);
  } catch {
    return String(res.status);
  }
}

function safeEqualHex(expected: string, actual: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual || ''));
  } catch {
    return false;
  }
}

// Razorpay implementation — wired when PAYMENT_DRIVER=razorpay and keys are set.
// Uses the REST API directly to avoid an extra SDK dependency.
export class RazorpayPayment implements PaymentProvider {
  private auth = Buffer.from(`${env.payment.razorpay.keyId}:${env.payment.razorpay.keySecret}`).toString('base64');
  readonly publicKey = env.payment.razorpay.keyId;

  // Cross-check the actual payment entity: only captured/authorized payments for
  // the exact expected amount should mark an order PAID.
  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Basic ${this.auth}` },
    });
    if (!res.ok) throw new Error(`Razorpay payment fetch failed: ${await describeError(res)}`);
    const p = (await res.json()) as { status?: string; amount?: number };
    return { status: p.status ?? 'unknown', amountPaise: typeof p.amount === 'number' ? p.amount : null };
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    const expected = crypto
      .createHmac('sha256', env.payment.razorpay.webhookSecret)
      .update(rawBody)
      .digest('hex');
    return safeEqualHex(expected, signature);
  }

  async createOrder(params: { amountPaise: number; receipt: string; notes?: Record<string, string> }): Promise<CreatedGatewayOrder> {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${this.auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: params.amountPaise, currency: 'INR', receipt: params.receipt, notes: params.notes ?? {} }),
    });
    if (!res.ok) throw new Error(`Razorpay order create failed: ${await describeError(res)}`);
    const order = (await res.json()) as { id: string };
    return { gatewayOrderId: order.id, keyId: env.payment.razorpay.keyId };
  }

  verifyPaymentSignature(input: VerifyPaymentInput): boolean {
    const expected = crypto
      .createHmac('sha256', env.payment.razorpay.keySecret)
      .update(`${input.orderId}|${input.paymentId}`)
      .digest('hex');
    return safeEqualHex(expected, input.signature);
  }
}

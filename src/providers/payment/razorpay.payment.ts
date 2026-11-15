import crypto from 'node:crypto';
import { env } from '@/core/config/env';
import { mapActivationStatus } from './route-status';
import type {
  CreatedGatewayOrder,
  CreatedRouteAccount,
  GatewayPayment,
  GatewayTransfer,
  OrderTransfer,
  PaymentProvider,
  RouteAccountInput,
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

  private async call<T>(method: string, path: string, body: unknown, what: string): Promise<T> {
    const res = await fetch(`https://api.razorpay.com${path}`, {
      method,
      headers: { Authorization: `Basic ${this.auth}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`Razorpay ${what} failed: ${await describeError(res)}`);
    return (await res.json()) as T;
  }

  async createOrder(params: {
    amountPaise: number;
    receipt: string;
    notes?: Record<string, string>;
    transfers?: OrderTransfer[];
  }): Promise<CreatedGatewayOrder> {
    const body: Record<string, unknown> = {
      amount: params.amountPaise,
      currency: 'INR',
      receipt: params.receipt,
      notes: params.notes ?? {},
    };
    if (params.transfers?.length) {
      body.partial_payment = false;
      body.transfers = params.transfers.map((t) => ({
        account: t.account,
        amount: t.amountPaise,
        currency: 'INR',
        notes: t.notes ?? {},
        on_hold: t.onHold, // VERIFY in Razorpay test mode: boolean vs 1/0 accepted
      }));
    }
    const order = await this.call<{ id: string }>('POST', '/v1/orders', body, 'order create');
    return { gatewayOrderId: order.id, keyId: env.payment.razorpay.keyId };
  }

  async fetchPaymentTransfers(paymentId: string): Promise<GatewayTransfer[]> {
    // VERIFY in Razorpay test mode: GET /v1/payments/:id/transfers response shape ({ items } vs { transfers })
    const res = await this.call<{
      items?: { id: string; recipient?: string; amount?: number; on_hold?: boolean }[];
      transfers?: { id: string; recipient?: string; amount?: number; on_hold?: boolean }[];
    }>('GET', `/v1/payments/${paymentId}/transfers`, undefined, 'payment transfers fetch');
    const list = res.items ?? res.transfers ?? [];
    return list.map((t) => ({
      id: t.id,
      account: t.recipient ?? '',
      amountPaise: typeof t.amount === 'number' ? t.amount : 0,
      onHold: t.on_hold === true,
    }));
  }

  async releaseTransfer(transferId: string): Promise<void> {
    // VERIFY in Razorpay test mode: PATCH /v1/transfers/:id { on_hold: false } releases the hold
    await this.call('PATCH', `/v1/transfers/${transferId}`, { on_hold: false }, 'transfer release');
  }

  async refundPayment(paymentId: string, opts: { amountPaise: number; reverseAll: boolean }): Promise<{ id: string }> {
    const r = await this.call<{ id: string }>(
      'POST',
      `/v1/payments/${paymentId}/refund`,
      { amount: opts.amountPaise, ...(opts.reverseAll ? { reverse_all: 1 } : {}) },
      'refund',
    );
    return { id: r.id };
  }

  async createRouteAccount(input: RouteAccountInput): Promise<CreatedRouteAccount> {
    // VERIFY in Razorpay test mode: category/subcategory values accepted for individual sellers.
    const account = await this.call<{ id: string }>(
      'POST',
      '/v2/accounts',
      {
        email: input.email,
        phone: input.phone,
        type: 'route',
        reference_id: input.referenceId,
        legal_business_name: input.legalName,
        business_type: input.businessType,
        contact_name: input.contactName,
        profile: {
          category: 'ecommerce',
          subcategory: 'ecommerce_marketplace',
          addresses: {
            registered: {
              street1: input.address.street1,
              street2: input.address.street1,
              city: input.address.city,
              state: input.address.state,
              postal_code: input.address.postalCode,
              country: 'IN',
            },
          },
        },
        legal_info: { pan: input.pan },
      },
      'linked account create',
    );
    await this.call(
      'POST',
      `/v2/accounts/${account.id}/stakeholders`,
      { name: input.contactName, email: input.email },
      'stakeholder create',
    );
    const product = await this.call<{ id: string; activation_status?: string }>(
      'POST',
      `/v2/accounts/${account.id}/products`,
      { product_name: 'route', tnc_accepted: true },
      'route product request',
    );
    const updated = await this.call<{ activation_status?: string }>(
      'PATCH',
      `/v2/accounts/${account.id}/products/${product.id}`,
      {
        settlements: {
          account_number: input.bank.accountNumber,
          ifsc_code: input.bank.ifsc,
          beneficiary_name: input.bank.beneficiaryName,
        },
        tnc_accepted: true,
      },
      'route product update',
    );
    return {
      accountId: account.id,
      productId: product.id,
      status: mapActivationStatus(updated.activation_status ?? product.activation_status),
    };
  }

  verifyPaymentSignature(input: VerifyPaymentInput): boolean {
    const expected = crypto
      .createHmac('sha256', env.payment.razorpay.keySecret)
      .update(`${input.orderId}|${input.paymentId}`)
      .digest('hex');
    return safeEqualHex(expected, input.signature);
  }
}

import crypto from 'node:crypto';
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

// Dev stub — no real gateway. Payments auto-"succeed" on verify.
export class StubPayment implements PaymentProvider {
  readonly publicKey = 'stub';
  // Linked account of the last order with transfers, so fetchPaymentTransfers can echo it (dev only).
  private lastTransfer: OrderTransfer | null = null;

  verifyWebhook(): boolean {
    return true;
  }

  // amountPaise null → callers skip the amount cross-check for the stub.
  async fetchPayment(): Promise<GatewayPayment> {
    return { status: 'captured', amountPaise: null };
  }

  async createOrder(params?: { transfers?: OrderTransfer[] }): Promise<CreatedGatewayOrder> {
    if (params?.transfers?.[0]) this.lastTransfer = params.transfers[0];
    return { gatewayOrderId: `stub_order_${crypto.randomUUID()}`, keyId: 'stub' };
  }

  // Stub accepts only the literal signature 'stub' (frontend simulates success).
  // This driver is only active when PAYMENT_DRIVER=stub, so 'stub' can never
  // pass verification against real Razorpay.
  verifyPaymentSignature(input: VerifyPaymentInput): boolean {
    return Boolean(input.orderId && input.paymentId && input.signature === 'stub');
  }

  async fetchPaymentTransfers(paymentId: string): Promise<GatewayTransfer[]> {
    const t = this.lastTransfer;
    return [
      {
        id: `trf_stub_${paymentId.replace(/[^a-zA-Z0-9]/g, '').slice(-14)}`,
        account: t?.account ?? 'acc_stub_unknown',
        amountPaise: t?.amountPaise ?? 0,
        onHold: true,
      },
    ];
  }

  async releaseTransfer(): Promise<void> {}

  async refundPayment(paymentId: string): Promise<{ id: string }> {
    return { id: `rfnd_stub_${paymentId.replace(/[^a-zA-Z0-9]/g, '').slice(-14)}` };
  }

  async createRouteAccount(input: RouteAccountInput): Promise<CreatedRouteAccount> {
    const key = crypto.createHash('sha1').update(input.referenceId).digest('hex').slice(0, 14);
    return { accountId: `acc_stub_${key}`, productId: `acc_prd_stub_${key}`, status: 'ACTIVE' };
  }
}

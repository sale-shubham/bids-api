import crypto from 'node:crypto';
import type {
  CreatedGatewayOrder,
  GatewayPayment,
  PaymentProvider,
  VerifyPaymentInput,
} from './payment.provider';

// Dev stub — no real gateway. Payments auto-"succeed" on verify.
export class StubPayment implements PaymentProvider {
  readonly publicKey = 'stub';

  verifyWebhook(): boolean {
    return true;
  }

  // amountPaise null → callers skip the amount cross-check for the stub.
  async fetchPayment(): Promise<GatewayPayment> {
    return { status: 'captured', amountPaise: null };
  }

  async createOrder(): Promise<CreatedGatewayOrder> {
    return { gatewayOrderId: `stub_order_${crypto.randomUUID()}`, keyId: 'stub' };
  }

  // Stub accepts any non-empty order/payment id (frontend simulates success).
  verifyPaymentSignature(input: VerifyPaymentInput): boolean {
    return Boolean(input.orderId && input.paymentId);
  }
}

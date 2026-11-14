import { env } from '@/core/config/env';
import { StubPayment } from './stub.payment';
import { RazorpayPayment } from './razorpay.payment';
import type { PaymentProvider } from './payment.provider';

export const paymentProvider: PaymentProvider =
  env.payment.driver === 'razorpay' ? new RazorpayPayment() : new StubPayment();

export type {
  PaymentProvider,
  GatewayPayment,
  CreatedGatewayOrder,
  VerifyPaymentInput,
} from './payment.provider';

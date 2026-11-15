// Payment abstraction — stub or Razorpay. Swap by PAYMENT_DRIVER env.
// One-time Orders API (commission payments, winner checkout) + Route (linked accounts, held transfers); no subscriptions.

import type { PayoutStatus } from '@prisma/client';

// Authoritative payment entity from the gateway — used to cross-check a client
// verify callback (defence in depth beyond the signature).
export interface GatewayPayment {
  status: string; // e.g. 'captured' | 'authorized' | 'failed'
  amountPaise: number | null; // null when the driver cannot report it (stub)
}

export interface CreatedGatewayOrder {
  gatewayOrderId: string;
  keyId: string; // public key for checkout (empty/'stub' when not razorpay)
}

export interface VerifyPaymentInput {
  orderId: string;
  paymentId: string;
  signature: string;
}

// A Route transfer attached to an order: `onHold` keeps the funds with the platform until released.
export interface OrderTransfer {
  account: string;
  amountPaise: number;
  onHold: boolean;
  notes?: Record<string, string>;
}

export interface GatewayTransfer {
  id: string;
  account: string;
  amountPaise: number;
  onHold: boolean;
}

export interface RouteAccountInput {
  email: string;
  phone: string;
  legalName: string;
  businessType: 'individual' | 'proprietorship';
  contactName: string;
  referenceId: string;
  pan: string;
  address: { street1: string; city: string; state: string; postalCode: string };
  bank: { accountNumber: string; ifsc: string; beneficiaryName: string };
}

export interface CreatedRouteAccount {
  accountId: string;
  productId: string;
  status: PayoutStatus;
}

export interface PaymentProvider {
  // Public checkout key for the browser SDK (empty/'stub' when not razorpay).
  readonly publicKey: string;
  verifyWebhook(rawBody: string, signature: string): boolean;
  // Fetch a payment entity to confirm it was really captured for the right amount.
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  // Orders API: create a one-time order for `amountPaise`. `receipt` is our own reference.
  createOrder(params: {
    amountPaise: number;
    receipt: string;
    notes?: Record<string, string>;
    transfers?: OrderTransfer[];
  }): Promise<CreatedGatewayOrder>;
  // Checkout signature: HMAC-SHA256(orderId|paymentId) with the key secret.
  verifyPaymentSignature(input: VerifyPaymentInput): boolean;
  // Route transfers created for a captured payment (held ones until releaseTransfer).
  fetchPaymentTransfers(paymentId: string): Promise<GatewayTransfer[]>;
  // Release a held transfer to the linked account.
  releaseTransfer(transferId: string): Promise<void>;
  // Refund a payment; reverseAll also reverses the linked-account transfers.
  refundPayment(paymentId: string, opts: { amountPaise: number; reverseAll: boolean }): Promise<{ id: string }>;
  // Onboard a seller as a Route linked account (account + stakeholder + product + settlements).
  createRouteAccount(input: RouteAccountInput): Promise<CreatedRouteAccount>;
}

// Payment abstraction — stub or Razorpay. Swap by PAYMENT_DRIVER env.
// One-time Orders API only (commission payments); no subscriptions.

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

export interface PaymentProvider {
  // Public checkout key for the browser SDK (empty/'stub' when not razorpay).
  readonly publicKey: string;
  verifyWebhook(rawBody: string, signature: string): boolean;
  // Fetch a payment entity to confirm it was really captured for the right amount.
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  // Orders API: create a one-time order for `amountPaise`. `receipt` is our own reference.
  createOrder(params: { amountPaise: number; receipt: string }): Promise<CreatedGatewayOrder>;
  // Checkout signature: HMAC-SHA256(orderId|paymentId) with the key secret.
  verifyPaymentSignature(input: VerifyPaymentInput): boolean;
}

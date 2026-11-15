export const CHECKOUT_MODES = ['off', 'optional', 'required'] as const;
export type CheckoutMode = (typeof CHECKOUT_MODES)[number];
export const CHECKOUT_MODE_KEY = 'checkout.mode';
export const DEFAULT_CHECKOUT_MODE: CheckoutMode = 'optional';

export function parseCheckoutMode(raw: string | null | undefined): CheckoutMode {
  return (CHECKOUT_MODES as readonly string[]).includes(raw ?? '') ? (raw as CheckoutMode) : DEFAULT_CHECKOUT_MODE;
}

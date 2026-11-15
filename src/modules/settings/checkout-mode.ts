import { getSetting } from './settings.service';
import { CHECKOUT_MODE_KEY, parseCheckoutMode, type CheckoutMode } from './checkout-mode.constants';

/** The stored checkout mode ('off' | 'optional' | 'required'); 'optional' when unset or invalid. */
export async function getCheckoutMode(): Promise<CheckoutMode> {
  return parseCheckoutMode(await getSetting(CHECKOUT_MODE_KEY));
}

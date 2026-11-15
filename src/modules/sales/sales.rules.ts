export const SALE_PAY_DAYS = 3;
export const AUTO_CONFIRM_DAYS = 7;
export const DAY_MS = 86_400_000;

export type SaleStatus = 'AWAITING_PAYMENT' | 'PAID' | 'SHIPPED' | 'DELIVERED' | 'RELEASED' | 'DISPUTED' | 'REFUNDED' | 'CANCELLED';

/** The buyer may confirm delivery (and so trigger the payout) from these states. */
export const CONFIRMABLE: readonly SaleStatus[] = ['PAID', 'SHIPPED'];
/** The buyer may open a dispute until the payout is released. */
export const DISPUTABLE: readonly SaleStatus[] = ['PAID', 'SHIPPED', 'DELIVERED'];
/** Admin may release held funds to the seller. */
export const ADMIN_RELEASABLE: readonly SaleStatus[] = ['DISPUTED', 'DELIVERED'];
/** Admin may refund the buyer (funds not yet released). */
export const REFUNDABLE: readonly SaleStatus[] = ['PAID', 'SHIPPED', 'DELIVERED', 'DISPUTED'];

export const payByFrom = (now: Date) => new Date(now.getTime() + SALE_PAY_DAYS * DAY_MS);

/** What the seller receives: the order total minus the platform commission. */
export const payoutPaise = (amountPaise: number, commissionPaise: number) => amountPaise - commissionPaise;

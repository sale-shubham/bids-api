import { logger } from '@/core/logger/logger';

/** Runs a side effect that must never fail the caller (notifications, invoices, referral rewards); failures are logged. */
export async function bestEffort(label: string, fn: () => Promise<unknown>, ctx: Record<string, unknown> = {}): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn({ err, ...ctx }, `${label} failed (best-effort, ignored)`);
  }
}

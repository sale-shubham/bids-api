// Pure strike rules - no I/O, unit-tested.

export const STRIKE_TTL_MONTHS = 12;
export const SUSPEND_AT_STRIKES = 3;

export type StrikeAction = 'WARN' | 'DEPOSITS_REQUIRED' | 'SUSPEND';

/** What follows the Nth active strike: 1 warn, 2 deposits required on every bid, 3+ suspend. */
export function strikeAction(activeCount: number): StrikeAction {
  if (activeCount >= SUSPEND_AT_STRIKES) return 'SUSPEND';
  return activeCount === 2 ? 'DEPOSITS_REQUIRED' : 'WARN';
}

export function strikeExpiry(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() + STRIKE_TTL_MONTHS);
  return d;
}

export const isStrikeActive = (s: { removedAt: Date | null; expiresAt: Date }, now: Date) =>
  s.removedAt === null && s.expiresAt.getTime() > now.getTime();

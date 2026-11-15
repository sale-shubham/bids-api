import crypto from 'node:crypto';

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** Asia/Kolkata calendar day of an instant, as YYYY-MM-DD. */
export function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Midnight UTC of a YYYY-MM-DD string (what a Postgres DATE column round-trips as). */
export const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

export const addDays = (day: string, n: number) => new Date(dayDate(day).getTime() + n * DAY_MS).toISOString().slice(0, 10);

/** Inclusive IST day range ending today, plus the UTC instants that bound it. */
export function rangeFor(days: number, now: Date) {
  const to = istDay(now);
  const from = addDays(to, -(days - 1));
  return {
    from,
    to,
    start: new Date(dayDate(from).getTime() - IST_OFFSET_MS),
    end: new Date(dayDate(addDays(to, 1)).getTime() - IST_OFFSET_MS),
  };
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** sha256 of the strongest identity available: member, then device cookie, then ip + user agent. */
export function viewerKeyFor(v: { memberId?: string; deviceId?: string; ip?: string; userAgent?: string }): string {
  const raw = v.memberId ? `m:${v.memberId}` : v.deviceId ? `d:${v.deviceId}` : `i:${v.ip ?? ''}|${v.userAgent ?? ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

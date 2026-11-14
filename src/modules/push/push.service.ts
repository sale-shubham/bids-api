import { prisma } from '@/core/prisma/client';
import { env } from '@/core/config/env';
import { logger } from '@/core/logger/logger';

// ----------------------------------------------------------------------------
// WEB PUSH — the closed-app half of real-time DM delivery. The WebSocket
// (ws.service.ts) only reaches a tab that is open; a push wakes the browser's
// service worker even with the app shut, which is the only way to paint the
// installed app's icon badge. Mirrors ws.service.ts's pushToMember point for
// point: fan out to every row the member has, never throw, prune the dead.
// See readme/flows/push-notifications.md.
// ----------------------------------------------------------------------------

/** What the browser's `PushSubscription.toJSON()` produces (validated in push.validation.ts). */
export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// The VAPID public key the browser subscribes with. Served, never bundled into
// the app, so the key can only ever match the private key this API signs with.
// '' = push not configured here; the app says so instead of failing silently.
export function vapidPublicKey(): string {
  return env.push.vapidPrivateKey ? env.push.vapidPublicKey : '';
}

// Upsert on `endpoint` (unique per browser): the same browser re-subscribing —
// or a different member signing in on it — re-points the one row instead of
// failing on a duplicate. Bound to the caller's login session, so signing out
// (or being evicted by the device cap) deletes it with the Session row.
export async function subscribe(memberId: string, sessionId: string, input: SubscriptionInput, userAgent?: string) {
  const data = {
    memberId,
    sessionId,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    userAgent: userAgent?.slice(0, 500) ?? null,
  };
  const row = await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: { endpoint: input.endpoint, ...data },
    update: data,
    select: { id: true },
  });
  return { id: row.id };
}

// Only the caller's own row — the endpoint alone is not proof of ownership.
export async function unsubscribe(memberId: string, endpoint: string) {
  await prisma.pushSubscription.deleteMany({ where: { endpoint, memberId } });
  return { endpoint };
}

/** Body the service worker's `push` handler reads (web app public/sw.js). */
export interface DmPushPayload {
  type: 'dm:new-message';
  conversationId: string;
  senderName: string;
  body: string;
  /** The recipient's unread total after this message — the number on the app icon. */
  badgeCount: number;
}

type WebPush = typeof import('web-push');

// Loaded on first use, like the AWS SDK in ws.service.ts, to keep it off the
// cold-start path of every request. `web-push` is CommonJS: under the ESM
// Lambda bundle its API sits on `default`, under vitest/tsx on the module
// itself — take whichever is there.
let configured: Promise<WebPush | null> | undefined;
function client() {
  configured ??= (async () => {
    const { vapidPublicKey: pub, vapidPrivateKey: priv, vapidSubject } = env.push;
    if (!pub || !priv) return null; // local dev / not set up — push is a no-op
    try {
      const mod: WebPush & { default?: WebPush } = await import('web-push');
      const webpush = mod.default ?? mod;
      webpush.setVapidDetails(vapidSubject, pub, priv);
      return webpush;
    } catch (err) {
      logger.error({ err }, 'push: invalid VAPID configuration — push disabled');
      return null;
    }
  })();
  return configured;
}

// 404/410 = the push service has retired this subscription (permission
// revoked, browser data cleared, endpoint rotated). Read off statusCode rather
// than `instanceof WebPushError`, which a second copy of the package breaks.
const isGone = (err: unknown) => {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  return status === 404 || status === 410;
};

// Best effort to every browser the member subscribed. Never throws — a failed
// push must never fail the sendMessage call that triggered it; the message is
// already saved and the app catches up on next open. A dead row is deleted
// (the same self-healing GoneException does for WsConnection); any other
// failure (5xx, timeout) says nothing about the subscription, so it stays.
export async function sendPushToMember(memberId: string, payload: DmPushPayload): Promise<void> {
  try {
    const webpush = await client();
    if (!webpush) return;

    const subs = await prisma.pushSubscription.findMany({
      where: { memberId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (subs.length === 0) return;

    const body = JSON.stringify(payload);
    const dead: string[] = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          // A day: a phone that is off overnight still gets the badge in the
          // morning; older than that the inbox itself is the better signal.
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
            TTL: 60 * 60 * 24,
          });
        } catch (err) {
          if (isGone(err)) dead.push(s.id);
          else logger.warn({ err, memberId, subscriptionId: s.id }, 'push: delivery failed');
        }
      }),
    );
    if (dead.length) await prisma.pushSubscription.deleteMany({ where: { id: { in: dead } } });
  } catch (err) {
    logger.error({ err, memberId }, 'push: send failed');
  }
}

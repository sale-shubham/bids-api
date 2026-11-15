import { prisma } from '@/core/prisma/client';
import { logger } from '@/core/logger/logger';
import { emailProvider } from '@/providers/email';
import { pushToMember } from '@/modules/ws/ws.service';
import { sendPushToMember } from '@/modules/push/push.service';
import { whatsappProvider } from '@/providers/whatsapp';
import { env } from '@/core/config/env';
import { buildContent, formatInr, type Person } from './notify.content';
import { resolveChannels } from './notify.catalogue';
import type { NotifyMessage } from './notify.types';

export type ProcessResult = 'sent' | 'duplicate' | 'skipped';

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

const MOBILE = /^[6-9]\d{9}$/;
const clipTitle = (t: string) => (t.length > 60 ? `${t.slice(0, 59)}...` : t);
const paise = (v: unknown) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0);

type WaTemplate = { template: string; paise: number };

/** WhatsApp template + amount for the capable types (auction-won in checkout mode uses the payment-due template). */
function whatsappTemplate(msg: NotifyMessage, auction: { currentBidPaise?: unknown; startingBidPaise?: unknown } | null): WaTemplate | null {
  const t = env.whatsapp.templates;
  const d = msg.data ?? {};
  if (msg.type === 'outbid') return { template: t.outbid, paise: paise(d.newBidPaise) };
  if (msg.type === 'ending-soon') return { template: t.endingSoon, paise: paise(auction?.currentBidPaise) || paise(auction?.startingBidPaise) };
  if (msg.type === 'auction-won') {
    return { template: typeof d.saleId === 'string' ? t.salePaymentDue : t.auctionWon, paise: paise(d.finalBidPaise) };
  }
  return null;
}

/**
 * Deliver one notification (email + in-app row + Web Push), idempotently.
 *
 * Order (chosen so a queue retry can neither lose the email nor duplicate rows):
 *   1. dedupeKey already has a Notification row -> 'duplicate', do nothing.
 *   2. send the EMAIL. In the SQS worker (`rethrowEmailErrors`) a failure throws
 *      HERE, before anything is stored, so SQS redelivers and the whole message
 *      is retried (DLQ after maxReceiveCount). Inline it is only logged.
 *   3. insert the Notification row (unique dedupeKey; a concurrent duplicate
 *      hits P2002 and is treated as 'duplicate').
 *   4. send Web Push only if WE inserted the row (a duplicate never re-pushes).
 * Residual risk: email sent but the insert fails (DB blip) -> the retry re-sends
 * the email once. Accepted: a rare duplicate email beats a lost one. Trade-off:
 * if the email fails permanently the in-app row is not created either (the
 * message lands in the DLQ and is logged).
 * Missing or inactive members are skipped entirely.
 */
export async function processNotification(
  msg: NotifyMessage,
  opts: { rethrowEmailErrors?: boolean } = {},
): Promise<ProcessResult> {
  try {
    if (await prisma.notification.findUnique({ where: { dedupeKey: msg.dedupeKey }, select: { id: true } })) {
      return 'duplicate';
    }

    const member = await prisma.member.findUnique({
      where: { id: msg.memberId },
      select: { id: true, name: true, email: true, isActive: true, phone: true, phoneVerifiedAt: true, whatsappOptInAt: true },
    });
    // account-suspended is sent while / after the member is deactivated, so it is the one type that still goes out.
    if (!member || (!member.isActive && msg.type !== 'account-suspended')) {
      logger.info({ memberId: msg.memberId, type: msg.type }, 'notify: member missing or inactive, skipped');
      return 'skipped';
    }

    const pref = await prisma.notificationPreference.findUnique({
      where: { memberId_type: { memberId: member.id, type: msg.type } },
      select: { email: true, push: true, whatsapp: true },
    });
    const channels = resolveChannels({
      type: msg.type,
      pref,
      whatsappOptIn: !!member.whatsappOptInAt,
      phoneVerified: !!member.phoneVerifiedAt && !!member.phone && MOBILE.test(member.phone),
    });

    let auctionTitle = '';
    let auctionRow: { currentBidPaise?: unknown; startingBidPaise?: unknown } | null = null;
    let counterparty: Person | null = null;
    if (msg.auctionId) {
      const a = await prisma.auction.findUnique({
        where: { id: msg.auctionId },
        select: {
          title: true,
          currentBidPaise: true,
          startingBidPaise: true,
          seller: { select: { name: true, email: true, phone: true } },
          winner: { select: { name: true, email: true, phone: true } },
          highestBidder: { select: { name: true, email: true, phone: true } },
        },
      });
      auctionTitle = a?.title ?? '';
      auctionRow = a ?? null;
      // Checkout (sale) mode: contact details are only shared after payment, via the sale.
      const saleMode = typeof msg.data?.saleId === 'string';
      if (msg.type === 'auction-won' && !saleMode) counterparty = a?.seller ?? null;
      if (msg.type === 'auction-sold' && !saleMode) counterparty = a?.winner ?? a?.highestBidder ?? null;
    }

    const content = buildContent({
      type: msg.type,
      auctionId: msg.auctionId ?? '',
      auctionTitle,
      memberName: member.name,
      data: msg.data ?? {},
      counterparty,
    });

    if (channels.email) {
      try {
        await emailProvider.send({
          to: member.email,
          subject: content.subject,
          template: content.template,
          data: content.templateData,
        });
      } catch (err) {
        logger.error({ err, type: msg.type, dedupeKey: msg.dedupeKey }, 'notify: email failed');
        if (opts.rethrowEmailErrors) throw err;
      }
    }

    let notificationId: string;
    try {
      const row = await prisma.notification.create({
        data: {
          memberId: member.id,
          type: msg.type,
          title: content.title,
          body: content.body,
          url: content.url,
          data: { ...(msg.data ?? {}), ...(msg.auctionId ? { auctionId: msg.auctionId } : {}) },
          dedupeKey: msg.dedupeKey,
        },
        select: { id: true },
      });
      notificationId = row.id;
    } catch (err) {
      if (isUniqueViolation(err)) return 'duplicate';
      throw err;
    }

    await pushToMember(member.id, { type: 'notification.new', notificationId }); // never throws
    if (channels.push) {
      await sendPushToMember(member.id, { type: msg.type, title: content.title, body: content.body, url: content.url });
    }
    if (channels.whatsapp) {
      const wa = whatsappTemplate(msg, auctionRow);
      if (wa) {
        try {
          await whatsappProvider.sendTemplate({
            to: `+91${member.phone}`,
            template: wa.template,
            language: 'en',
            params: [clipTitle(auctionTitle), formatInr(wa.paise), content.url],
          });
        } catch (err) {
          logger.error({ err, type: msg.type, dedupeKey: msg.dedupeKey }, 'notify: whatsapp failed');
        }
      }
    }
    return 'sent';
  } catch (err) {
    if (opts.rethrowEmailErrors) throw err;
    logger.error({ err, type: msg.type, dedupeKey: msg.dedupeKey }, 'notify: processing failed');
    return 'skipped';
  }
}

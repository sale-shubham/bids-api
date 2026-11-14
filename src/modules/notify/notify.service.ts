import { prisma } from '@/core/prisma/client';
import { logger } from '@/core/logger/logger';
import { emailProvider } from '@/providers/email';
import { sendPushToMember } from '@/modules/push/push.service';
import { buildContent, type Person } from './notify.content';
import type { NotifyMessage } from './notify.types';

export type ProcessResult = 'sent' | 'duplicate' | 'skipped';

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

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
      select: { id: true, name: true, email: true, isActive: true },
    });
    if (!member || !member.isActive) {
      logger.info({ memberId: msg.memberId, type: msg.type }, 'notify: member missing or inactive, skipped');
      return 'skipped';
    }

    let auctionTitle = '';
    let counterparty: Person | null = null;
    if (msg.auctionId) {
      const a = await prisma.auction.findUnique({
        where: { id: msg.auctionId },
        select: {
          title: true,
          seller: { select: { name: true, email: true, phone: true } },
          winner: { select: { name: true, email: true, phone: true } },
          highestBidder: { select: { name: true, email: true, phone: true } },
        },
      });
      auctionTitle = a?.title ?? '';
      if (msg.type === 'auction-won') counterparty = a?.seller ?? null;
      if (msg.type === 'auction-sold') counterparty = a?.winner ?? a?.highestBidder ?? null;
    }

    const content = buildContent({
      type: msg.type,
      auctionId: msg.auctionId ?? '',
      auctionTitle,
      memberName: member.name,
      data: msg.data ?? {},
      counterparty,
    });

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

    try {
      await prisma.notification.create({
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
    } catch (err) {
      if (isUniqueViolation(err)) return 'duplicate';
      throw err;
    }

    await sendPushToMember(member.id, { type: msg.type, title: content.title, body: content.body, url: content.url });
    return 'sent';
  } catch (err) {
    if (opts.rethrowEmailErrors) throw err;
    logger.error({ err, type: msg.type, dedupeKey: msg.dedupeKey }, 'notify: processing failed');
    return 'skipped';
  }
}

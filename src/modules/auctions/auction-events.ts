import { prisma } from '@/core/prisma/client';
import { logger } from '@/core/logger/logger';
import { pushToAuctionRoom, pushToMember } from '@/modules/ws/ws.service';
import type { BidDTO } from './bidding.rules';

// Real-time auction events. Called from the bid and close flows; fanned out over
// WebSocket by publishAuctionEvent below (see readme/flows/websocket.md).

export type AuctionEvent =
  | {
      type: 'bid.placed';
      auctionId: string;
      currentBidPaise: number;
      bidCount: number;
      endTime: string; // ISO, already includes any anti-sniping extension
      highestBidderId: string;
      previousHighestBidderId: string | null;
      // Masked and viewer-agnostic (no isMe); clients compare ids themselves.
      bid: Omit<BidDTO, 'isMe'>;
    }
  | { type: 'auction.extended'; auctionId: string; endTime: string }
  | {
      type: 'auction.ended';
      auctionId: string;
      winnerId: string | null;
      finalBidPaise: number;
      bidCount: number;
      endedAt: string;
    };

async function auctionTitle(auctionId: string): Promise<string> {
  const a = await prisma.auction.findUnique({ where: { id: auctionId }, select: { title: true } }).catch(() => null);
  return a?.title ?? '';
}

/**
 * Fan an auction event out over WebSocket: the room (connections subscribed to
 * the auction) plus member-targeted frames (outbid / won). NEVER throws — every
 * leg is isolated and logged; callers also wrap it in try/catch.
 */
export async function publishAuctionEvent(event: AuctionEvent): Promise<void> {
  try {
    const legs: Promise<unknown>[] = [];
    switch (event.type) {
      case 'bid.placed': {
        const { previousHighestBidderId, ...room } = event;
        legs.push(pushToAuctionRoom(event.auctionId, room));
        if (previousHighestBidderId && previousHighestBidderId !== event.highestBidderId) {
          legs.push(
            auctionTitle(event.auctionId).then((title) =>
              pushToMember(previousHighestBidderId, {
                type: 'bid.outbid',
                auctionId: event.auctionId,
                title,
                currentBidPaise: event.currentBidPaise,
              }),
            ),
          );
        }
        break;
      }
      case 'auction.extended':
        legs.push(pushToAuctionRoom(event.auctionId, event));
        break;
      case 'auction.ended': {
        legs.push(pushToAuctionRoom(event.auctionId, event));
        const winnerId = event.winnerId;
        if (winnerId) {
          legs.push(
            auctionTitle(event.auctionId).then((title) =>
              pushToMember(winnerId, {
                type: 'auction.won',
                auctionId: event.auctionId,
                title,
                finalBidPaise: event.finalBidPaise,
              }),
            ),
          );
        }
        break;
      }
    }
    const results = await Promise.allSettled(legs);
    for (const r of results) if (r.status === 'rejected') logger.warn({ err: r.reason, type: event.type }, 'auction-events: leg failed');
  } catch (err) {
    logger.warn({ err, type: event.type }, 'auction-events: publish failed');
  }
}

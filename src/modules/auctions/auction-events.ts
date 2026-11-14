import type { BidDTO } from './bidding.rules';

// Real-time auction events. Phase 3 only DEFINES the shapes and calls the hook
// from the bid and close flows; Phase 4 implements publishAuctionEvent
// (WebSocket fan-out to the auction room via ws.service pushToMember/rooms).

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

/** No-op until Phase 4. Callers also guard with try/catch; keep it cheap and non-throwing. */
export async function publishAuctionEvent(_event: AuctionEvent): Promise<void> {
  // TODO(Phase 4): broadcast to WebSocket subscribers of `_event.auctionId`.
}

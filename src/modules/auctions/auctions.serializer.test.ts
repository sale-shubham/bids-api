import { describe, expect, it } from 'vitest';
import { toCard, toDetail, type AuctionRow } from './auctions.serializer';
import { toBidDTO } from './bidding.rules';

const now = new Date('2026-11-14T10:00:00Z');
const row = {
  id: 'a1',
  title: 'Telescope',
  description: '<p>x</p>',
  category: 'Electronics',
  condition: 'USED',
  images: [],
  startingBidPaise: 50_000n,
  minIncrementPaise: 10_000n,
  currentBidPaise: 5_000_000_000_000n / 5n, // beyond int4
  bidCount: 1,
  status: 'LIVE',
  deletedAt: null,
  startTime: new Date(now.getTime() - 3600_000),
  endTime: new Date(now.getTime() + 3600_000),
  endedAt: null,
  reservePricePaise: 6_000_000_000_000n,
  buyNowPricePaise: 9_000_000_000_000n,
  highestBidderId: null,
  winnerId: null,
  createdAt: now,
  updatedAt: now,
  seller: { id: 's1', name: 'S', avatarUrl: null, ratingCount: 0, ratingSum: 0 },
} as unknown as AuctionRow;

describe('serializers with bigint rows', () => {
  it('toCard / toDetail emit plain numbers and survive JSON.stringify', () => {
    const card = toCard(row, now);
    expect(card.startingBidPaise).toBe(50_000);
    expect(card.currentBidPaise).toBe(1_000_000_000_000);
    const detail = toDetail(row, now);
    expect(typeof detail.minIncrementPaise).toBe('number');
    const parsed = JSON.parse(JSON.stringify(detail));
    expect(parsed.currentBidPaise).toBe(1_000_000_000_000);
    expect(parsed.minIncrementPaise).toBe(10_000);
  });
  it('toBidDTO converts amountPaise', () => {
    const dto = toBidDTO({ id: 'b1', amountPaise: 123_456_789_012n, kind: 'MANUAL', createdAt: now, bidder: { id: 'u', name: 'Rahul' } }, 'u');
    expect(dto.amountPaise).toBe(123_456_789_012);
    expect(typeof dto.amountPaise).toBe('number');
    expect(dto.isMe).toBe(true);
  });
  it('never exposes the reserve amount in card or detail', () => {
    for (const dto of [toCard(row, now), toDetail(row, now)]) {
      expect(JSON.stringify(dto)).not.toContain('reservePricePaise');
      expect(JSON.stringify(dto)).not.toContain('6000000000000');
    }
  });
  it('card flags: hasReserve, reserveMet, buyNow hidden once bids exist', () => {
    const noBids = { ...row, bidCount: 0, currentBidPaise: 0n } as AuctionRow;
    expect(toCard(noBids, now)).toMatchObject({ hasReserve: true, reserveMet: false, buyNowPricePaise: 9_000_000_000_000 });
    expect(toCard(row, now)).toMatchObject({ hasReserve: true, reserveMet: false, buyNowPricePaise: null });
    const met = { ...row, currentBidPaise: 6_000_000_000_000n } as AuctionRow;
    expect(toCard(met, now).reserveMet).toBe(true);
    const none = { ...row, reservePricePaise: null, buyNowPricePaise: null } as AuctionRow;
    expect(toCard(none, now)).toMatchObject({ hasReserve: false, reserveMet: true, buyNowPricePaise: null });
  });
});

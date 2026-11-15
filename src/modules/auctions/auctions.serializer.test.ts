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
  highestBidderId: null,
  winnerId: null,
  createdAt: now,
  updatedAt: now,
  seller: { id: 's1', name: 'S', avatarUrl: null },
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
    const dto = toBidDTO({ id: 'b1', amountPaise: 123_456_789_012n, createdAt: now, bidder: { id: 'u', name: 'Rahul' } }, 'u');
    expect(dto.amountPaise).toBe(123_456_789_012);
    expect(typeof dto.amountPaise).toBe('number');
    expect(dto.isMe).toBe(true);
  });
});

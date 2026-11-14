// Demo data: one AUCTIONEER + ~12 auctions (mixed live / upcoming / ended).
// Idempotent, keyed by the demo seller's email: if it exists, nothing is created.
// Run manually: npm run seed:demo   (uses DIRECT_URL, falls back to DATABASE_URL)
import 'dotenv/config';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) throw new Error('DIRECT_URL or DATABASE_URL is required');

const needsSsl = /sslmode=/i.test(url) || /supabase\.(co|com)/i.test(url);
let connectionString = url;
if (needsSsl) {
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('ssl');
  connectionString = u.toString();
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}) }),
});

const DEMO_EMAIL = 'demo.seller@noblebid.local';
const H = 3_600_000;
const D = 24 * H;
const FALLBACK_CATEGORIES = ['Electronics', 'Fashion', 'Home & Garden', 'Collectibles', 'Art', 'Vehicles'];

type Phase = 'live' | 'upcoming' | 'ended';
const ITEMS: { title: string; condition: 'NEW' | 'USED'; startingBidPaise: number; phase: Phase }[] = [
  { title: 'Vintage Film Camera, fully working', condition: 'USED', startingBidPaise: 450000, phase: 'live' },
  { title: 'Noise-cancelling wireless headphones', condition: 'NEW', startingBidPaise: 650000, phase: 'live' },
  { title: 'Hand-woven silk saree, festive edition', condition: 'NEW', startingBidPaise: 1200000, phase: 'live' },
  { title: 'Teak wood garden bench', condition: 'USED', startingBidPaise: 800000, phase: 'live' },
  { title: 'Signed first-edition cricket memorabilia', condition: 'USED', startingBidPaise: 2500000, phase: 'live' },
  { title: 'Original oil painting, river at dusk', condition: 'NEW', startingBidPaise: 1800000, phase: 'live' },
  { title: 'Restored 1980s motor scooter', condition: 'USED', startingBidPaise: 6000000, phase: 'upcoming' },
  { title: 'Carbon fibre road bike frame', condition: 'NEW', startingBidPaise: 3500000, phase: 'upcoming' },
  { title: 'Antique silver necklace set', condition: 'USED', startingBidPaise: 900000, phase: 'upcoming' },
  { title: 'Collector box set of classic novels', condition: 'NEW', startingBidPaise: 150000, phase: 'ended' },
  { title: 'Gaming laptop, light use', condition: 'USED', startingBidPaise: 4500000, phase: 'ended' },
  { title: 'Brass table lamp, antique finish', condition: 'USED', startingBidPaise: 200000, phase: 'ended' },
];

function times(phase: Phase, i: number, now: number) {
  if (phase === 'live') return { startTime: new Date(now - (1 + (i % 3)) * D), endTime: new Date(now + (2 + i * 5) * H) };
  if (phase === 'upcoming') return { startTime: new Date(now + (6 + i * 4) * H), endTime: new Date(now + 3 * D + i * H) };
  return { startTime: new Date(now - 6 * D), endTime: new Date(now - (1 + (i % 3)) * D) };
}

async function main() {
  if (await prisma.member.findUnique({ where: { email: DEMO_EMAIL } })) {
    console.log(`[seed-demo] ${DEMO_EMAIL} already exists - nothing to do`);
    return;
  }
  const catRow = await prisma.appSetting.findUnique({ where: { key: 'auction.categories' } });
  let categories = FALLBACK_CATEGORIES;
  try {
    const parsed: unknown = catRow ? JSON.parse(catRow.value) : null;
    if (Array.isArray(parsed) && parsed.length) categories = parsed.filter((c): c is string => typeof c === 'string');
  } catch {
    /* keep fallback */
  }
  const incRow = await prisma.appSetting.findUnique({ where: { key: 'auction.minIncrementPaise' } });
  const minIncrementPaise = Number.parseInt(incRow?.value ?? '', 10) || 10000;

  const password = crypto.randomBytes(12).toString('base64url');
  const seller = await prisma.member.create({
    data: {
      email: DEMO_EMAIL,
      name: 'Demo Auctioneer',
      passwordHash: await bcrypt.hash(password, 12),
      role: 'AUCTIONEER',
      emailVerifiedAt: new Date(),
    },
  });

  const now = Date.now();
  let n = 0;
  for (const [i, item] of ITEMS.entries()) {
    n += 1;
    const t = times(item.phase, i, now);
    await prisma.auction.create({
      data: {
        title: item.title,
        description: `<p>${item.title}. Demo listing created for development and testing.</p><p>Condition: <strong>${item.condition === 'NEW' ? 'new' : 'pre-owned'}</strong>. Pickup or tracked shipping available.</p>`,
        category: categories[i % categories.length],
        condition: item.condition,
        images: [1, 2, 3].map((k) => `https://picsum.photos/seed/noblebid-${n}${k > 1 ? `-${k}` : ''}/800/600`),
        startingBidPaise: item.startingBidPaise,
        minIncrementPaise,
        status: item.phase === 'live' ? 'LIVE' : item.phase === 'ended' ? 'ENDED' : 'SCHEDULED',
        endedAt: item.phase === 'ended' ? t.endTime : null,
        sellerId: seller.id,
        ...t,
      },
    });
  }
  console.log(`[seed-demo] created ${DEMO_EMAIL} and ${n} auctions`);
  console.log(`[seed-demo] password (shown once): ${password}`);
}

main()
  .catch((err) => {
    console.error('[seed-demo] failed', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

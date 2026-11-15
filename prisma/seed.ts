// Idempotent seed: AppSettings + (optional) Super Admin. Run: npm run prisma:seed
// Uses DIRECT_URL (falls back to DATABASE_URL). Never logs secrets.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { LEGAL_SEED } from './legal-seed-content';

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

const SETTINGS: Record<string, string> = {
  'commission.rateBps': '500',
  'auction.minIncrementPaise': '10000',
  'auction.antiSnipingMinutes': '2',
  'auction.maxPricePaise': '10000000000',
  'checkout.mode': 'optional',
  'auction.categories': JSON.stringify([
    'Electronics',
    'Fashion',
    'Home & Garden',
    'Collectibles',
    'Art',
    'Vehicles',
    'Sports',
    'Jewellery',
    'Books',
    'Other',
  ]),
};

async function main() {
  for (const [key, value] of Object.entries(SETTINGS)) {
    // update: {} keeps admin-edited values on re-seed.
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: {} });
  }
  console.log(`[seed] app settings ensured (${Object.keys(SETTINGS).length})`);

  // Legal pages: only create when missing, so admin-edited content/titles survive a re-seed.
  for (const page of LEGAL_SEED) {
    await prisma.appSetting.upsert({
      where: { key: `page:${page.slug}` },
      create: { key: `page:${page.slug}`, value: page.content },
      update: {},
    });
    await prisma.appSetting.upsert({
      where: { key: `page-title:${page.slug}` },
      create: { key: `page-title:${page.slug}`, value: page.title },
      update: {},
    });
  }
  console.log(`[seed] legal pages ensured (${LEGAL_SEED.length})`);

  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('[seed] SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set - skipping Super Admin creation');
    return;
  }
  const existing = await prisma.member.findUnique({ where: { email } });
  if (existing) {
    console.log(`[seed] Super Admin ${email} already exists - left unchanged`);
    return;
  }
  await prisma.member.create({
    data: {
      email,
      name: 'Super Admin',
      passwordHash: await bcrypt.hash(password, 12),
      role: 'SUPER_ADMIN',
      emailVerifiedAt: new Date(),
    },
  });
  console.log(`[seed] Super Admin ${email} created`);
}

main()
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

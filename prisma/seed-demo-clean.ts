// Removes ONLY the demo data created by `npm run seed:demo` (members @demo.noblebid.test and everything hanging off
// them). Run manually: npm run seed:demo:clean   (uses DIRECT_URL, falls back to DATABASE_URL)
import { cleanDemo, createPrisma } from './demo-shared';

const prisma = createPrisma();

async function main() {
  const res = await prisma.$transaction((tx) => cleanDemo(tx), { timeout: 300_000, maxWait: 30_000 });
  console.log(`[seed-demo-clean] removed ${res.members} demo members and ${res.auctions} demo auctions (with all rows that reference them)`);
}

main()
  .catch((err) => {
    console.error('[seed-demo-clean] failed', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

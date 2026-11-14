// One-off manual run of the auction close job (same code the 1-minute Lambda runs).
// Usage: npm run job:close
import { runAuctionClose } from '../src/modules/auctions/auction-close.service';
import { prisma } from '../src/core/prisma/client';

try {
  const counts = await runAuctionClose();
  console.log('auction close:', counts);
} finally {
  await prisma.$disconnect();
}

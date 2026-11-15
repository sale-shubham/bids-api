// One-off manual run of the daily shill-bid scan (same code the daily Lambda runs).
// Usage: npm run job:risk
import { runRiskScan } from '../src/modules/risk/risk.jobs';
import { prisma } from '../src/core/prisma/client';

try {
  const counts = await runRiskScan();
  console.log('risk scan:', counts);
} finally {
  await prisma.$disconnect();
}

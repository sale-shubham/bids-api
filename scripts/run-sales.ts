// One-off manual run of the sales maintenance job (same code the hourly Lambda runs).
// Usage: npm run job:sales
import { runSalesMaintenance } from '../src/modules/sales/sales.jobs';
import { prisma } from '../src/core/prisma/client';

try {
  const counts = await runSalesMaintenance();
  console.log('sales maintenance:', counts);
} finally {
  await prisma.$disconnect();
}

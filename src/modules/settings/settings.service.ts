import { prisma } from '@/core/prisma/client';

// Admin-managed app settings live in the AppSetting key/value table
// (`value` is TEXT, parsed by each caller). Typed settings (commission rate,
// anti-sniping minutes, ...) are added here in later phases.

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

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

// ---------------------------------------------------------------- platform settings

export const SETTING_KEYS = {
  commissionRateBps: 'commission.rateBps',
  minIncrementPaise: 'auction.minIncrementPaise',
  antiSnipingMinutes: 'auction.antiSnipingMinutes',
  categories: 'auction.categories',
} as const;

export interface PlatformSettings {
  commissionRateBps: number;
  minIncrementPaise: number;
  antiSnipingMinutes: number;
  categories: string[];
}

export const SETTING_DEFAULTS = { commissionRateBps: 500, minIncrementPaise: 10_000, antiSnipingMinutes: 2 } as const;

const intOr = (raw: string | null | undefined, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

export function parseCategories(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: Object.values(SETTING_KEYS) } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    commissionRateBps: intOr(map.get(SETTING_KEYS.commissionRateBps), SETTING_DEFAULTS.commissionRateBps, 0, 10_000),
    minIncrementPaise: intOr(map.get(SETTING_KEYS.minIncrementPaise), SETTING_DEFAULTS.minIncrementPaise, 100, 2_000_000_000),
    antiSnipingMinutes: intOr(map.get(SETTING_KEYS.antiSnipingMinutes), SETTING_DEFAULTS.antiSnipingMinutes, 0, 30),
    categories: parseCategories(map.get(SETTING_KEYS.categories)),
  };
}

export async function setPlatformSettings(input: PlatformSettings): Promise<PlatformSettings> {
  const entries: [string, string][] = [
    [SETTING_KEYS.commissionRateBps, String(input.commissionRateBps)],
    [SETTING_KEYS.minIncrementPaise, String(input.minIncrementPaise)],
    [SETTING_KEYS.antiSnipingMinutes, String(input.antiSnipingMinutes)],
    [SETTING_KEYS.categories, JSON.stringify(input.categories)],
  ];
  await prisma.$transaction(
    entries.map(([key, value]) => prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })),
  );
  return getPlatformSettings();
}

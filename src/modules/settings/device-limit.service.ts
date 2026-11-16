import type { Role } from '@prisma/client';
import { prisma } from '@/core/prisma/client';
import { MAX_DEVICES_PER_MEMBER } from '@/core/config/constants';

// Admin-configurable per-role device/session cap, stored in the AppSetting
// key/value table . Replaces the
// flat MAX_DEVICES_PER_MEMBER constant as the *default* only — that constant
// is now just the bootstrap value until a SUPER_ADMIN saves a config row.
// `memberLimit` is universal — one value applied to every MEMBER
// account, not a per-member override. `superAdminLimit` is separate so
// SUPER_ADMIN accounts (which sign in from more places — ops laptop, phone,
// etc.) can be given a different cap without changing the member-facing one.
export const DEVICE_LIMIT_CONFIG_KEY = 'device_limit_config';

export interface DeviceLimitConfig {
  memberLimit: number;
  superAdminLimit: number;
}

const BOOTSTRAP_DEFAULT: DeviceLimitConfig = {
  memberLimit: MAX_DEVICES_PER_MEMBER,
  superAdminLimit: MAX_DEVICES_PER_MEMBER,
};

export async function getDeviceLimitConfig(): Promise<DeviceLimitConfig> {
  const row = await prisma.appSetting.findUnique({ where: { key: DEVICE_LIMIT_CONFIG_KEY } });
  if (!row?.value) return BOOTSTRAP_DEFAULT;
  try {
    const parsed = JSON.parse(row.value);
    if (parsed && typeof parsed.memberLimit === 'number' && typeof parsed.superAdminLimit === 'number') {
      return { memberLimit: parsed.memberLimit, superAdminLimit: parsed.superAdminLimit };
    }
  } catch {
    // fall through to bootstrap default
  }
  return BOOTSTRAP_DEFAULT;
}

export async function setDeviceLimitConfig(input: DeviceLimitConfig): Promise<DeviceLimitConfig> {
  const value = JSON.stringify(input);
  await prisma.appSetting.upsert({
    where: { key: DEVICE_LIMIT_CONFIG_KEY },
    create: { key: DEVICE_LIMIT_CONFIG_KEY, value },
    update: { value },
  });
  return input;
}

export async function getMaxDevicesForRole(role: Role): Promise<number> {
  const config = await getDeviceLimitConfig();
  return role === 'SUPER_ADMIN' ? config.superAdminLimit : config.memberLimit;
}

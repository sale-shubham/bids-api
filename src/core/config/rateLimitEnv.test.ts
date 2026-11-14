import { afterEach, describe, expect, it, vi } from 'vitest';

// env.ts is evaluated once at import, so each case re-imports it fresh.
async function loadRateLimitEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (await import('./env')).env.rateLimit;
}

describe('env.rateLimit', () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_AUTH_MAX;
    delete process.env.RATE_LIMIT_OTP_IP_MAX;
  });

  it('keeps the production caps when empty (empty also shields the case from .env dev overrides) (prod never sets them)', async () => {
    expect(await loadRateLimitEnv({ RATE_LIMIT_AUTH_MAX: '', RATE_LIMIT_OTP_IP_MAX: '' })).toEqual({ authMax: 20, otpIpMax: 20 });
  });

  it('takes the dev override', async () => {
    expect(await loadRateLimitEnv({ RATE_LIMIT_AUTH_MAX: '300', RATE_LIMIT_OTP_IP_MAX: '300' })).toEqual({ authMax: 300, otpIpMax: 300 });
  });

  it('rejects a non-number instead of silently disabling the cap', async () => {
    await expect(loadRateLimitEnv({ RATE_LIMIT_AUTH_MAX: 'lots' })).rejects.toThrow(/RATE_LIMIT_AUTH_MAX/);
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/core/config/env', () => ({ env: { rateLimit: { authMax: 20, otpIpMax: 20 } } }));
vi.mock('@/core/prisma/client', () => ({ prisma: {} }));

describe('rate limiters', () => {
  // express-rate-limit validates each limiter's options when it is created and
  // reports problems through console.error (e.g. ERR_ERL_KEY_GEN_IPV6 for a
  // keyGenerator that reads req.ip without ipKeyGenerator).
  it('are created without express-rate-limit validation errors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('./rateLimit');
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

import { describe, expect, it } from 'vitest';
import { buildCookieBase, parseCookieDomain, parseSameSite } from './cookie-options';

describe('cookie options', () => {
  it('defaults to lax and only accepts none explicitly', () => {
    expect(parseSameSite(undefined)).toBe('lax');
    expect(parseSameSite('')).toBe('lax');
    expect(parseSameSite('strict')).toBe('lax');
    expect(parseSameSite(' None ')).toBe('none');
  });

  it('empty COOKIE_DOMAIN in prod is host-only; unset in dev is localhost', () => {
    expect(parseCookieDomain('', true)).toBeUndefined();
    expect(parseCookieDomain(undefined, true)).toBeUndefined();
    expect(parseCookieDomain(undefined, false)).toBe('localhost');
    expect(parseCookieDomain('.example.com', true)).toBe('.example.com');
  });

  it('omits the domain attribute when empty', () => {
    const c = buildCookieBase({ isProd: true, domain: undefined, sameSite: 'lax' });
    expect('domain' in c).toBe(false);
    expect(c.secure).toBe(true);
  });

  it('sets domain when given and forces secure for SameSite=None', () => {
    const c = buildCookieBase({ isProd: false, domain: '.example.com', sameSite: 'none' });
    expect(c.domain).toBe('.example.com');
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe('none');
  });
});

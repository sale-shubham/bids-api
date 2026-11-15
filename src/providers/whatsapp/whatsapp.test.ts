import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  whatsapp: { driver: 'stub', token: 'tok', phoneNumberId: '123', apiVersion: 'v21.0' },
}));
const log = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('@/core/config/env', () => ({ env: envMock }));
vi.mock('@/core/logger/logger', () => ({ logger: log }));

import { StubWhatsapp } from './stub.whatsapp';
import { MetaWhatsapp } from './meta.whatsapp';

const input = { to: '+919876543210', template: 'nb_outbid', language: 'en' as const, params: ['Watch', '₹1,500', '/auctions/a1'] };

describe('StubWhatsapp', () => {
  it('logs the masked number and template only', async () => {
    await new StubWhatsapp().sendTemplate(input);
    expect(log.info).toHaveBeenCalledWith({ to: '+91******3210', template: 'nb_outbid' }, expect.any(String));
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain('9876543210');
    expect(logged).not.toContain('Watch');
  });
});

describe('MetaWhatsapp', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the template message to the Cloud API with a bearer token', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await new MetaWhatsapp().sendTemplate(input);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/123/messages');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '+919876543210',
      type: 'template',
      template: {
        name: 'nb_outbid',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Watch' },
              { type: 'text', text: '₹1,500' },
              { type: 'text', text: '/auctions/a1' },
            ],
          },
        ],
      },
    });
  });

  it('throws on an HTTP error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(new MetaWhatsapp().sendTemplate(input)).rejects.toThrow(/401/);
  });

  it('503 when not configured (no fetch)', async () => {
    const saved = envMock.whatsapp.token;
    envMock.whatsapp.token = '';
    await expect(new MetaWhatsapp().sendTemplate(input)).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
    envMock.whatsapp.token = saved;
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  isProd: false,
  sms: { driver: 'stub', msg91: { authKey: 'key', senderId: 'NOBLEB', otpTemplateId: 'tpl1' } },
}));
const log = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('@/core/config/env', () => ({ env: envMock }));
vi.mock('@/core/logger/logger', () => ({ logger: log }));

import { maskPhone } from './sms.provider';
import { StubSms } from './stub.sms';
import { Msg91Sms } from './msg91.sms';

describe('maskPhone', () => {
  it('keeps the country code and the last 4 digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91******3210');
    expect(maskPhone('9876543210')).toBe('******3210');
    expect(maskPhone('1234')).toBe('****');
  });
});

describe('StubSms', () => {
  beforeEach(() => log.info.mockClear());

  it('logs the masked number and, outside production, the code', async () => {
    envMock.isProd = false;
    await new StubSms().send({ to: '+919876543210', text: 't', templateVars: { otp: '123456' } });
    expect(log.info).toHaveBeenCalledWith({ to: '+91******3210', devOtp: '123456' }, expect.any(String));
  });

  it('never logs the code or the full number in production', async () => {
    envMock.isProd = true;
    await new StubSms().send({ to: '+919876543210', text: 'secret 123456', templateVars: { otp: '123456' } });
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain('123456');
    expect(logged).not.toContain('9876543210');
    envMock.isProd = false;
  });
});

describe('Msg91Sms', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the template flow with the otp variable and the auth key header', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ type: 'success' }) });
    await new Msg91Sms().send({ to: '+919876543210', text: 't', templateVars: { otp: '654321' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://control.msg91.com/api/v5/flow');
    expect(init.headers.authkey).toBe('key');
    expect(JSON.parse(init.body)).toEqual({
      template_id: 'tpl1',
      short_url: '0',
      recipients: [{ mobiles: '919876543210', otp: '654321' }],
    });
  });

  it('throws on an HTTP error or a non-success body', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(new Msg91Sms().send({ to: '+919876543210', text: 't' })).rejects.toThrow();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ type: 'error' }) });
    await expect(new Msg91Sms().send({ to: '+919876543210', text: 't' })).rejects.toThrow();
  });

  it('503 when MSG91 is not configured (no fetch)', async () => {
    const saved = envMock.sms.msg91.authKey;
    envMock.sms.msg91.authKey = '';
    await expect(new Msg91Sms().send({ to: '+919876543210', text: 't' })).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
    envMock.sms.msg91.authKey = saved;
  });
});

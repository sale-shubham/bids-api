import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
const envMock = vi.hoisted(() => ({
  admin: { email: 'admin@example.com' },
  app: { url: 'https://app.test' },
  email: { fromName: 'NobleBid', logoUrl: '' },
  rateLimit: { authMax: 20, otpIpMax: 20 },
}));
vi.mock('@/core/config/env', () => ({ env: envMock }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/core/prisma/client', () => ({ prisma: {} }));
vi.mock('@/providers/email', () => ({ emailProvider: { send } }));

import { contactSchema } from './contact.validation';
import { sendContactMessage } from './contact.service';
import router from './contact.routes';
import { contactLimiter } from '@/core/middleware/rateLimit';
import { renderEmail } from '@/providers/email/render';

const valid = { name: 'Asha', email: 'Asha@Example.com', subject: 'Question', message: 'Hello, I have a question.' };

describe('contact validation', () => {
  it('accepts valid input and lower-cases the email', () => {
    const { error, value } = contactSchema.validate(valid);
    expect(error).toBeUndefined();
    expect(value.email).toBe('asha@example.com');
  });
  it('enforces length limits and a valid email', () => {
    expect(contactSchema.validate({ ...valid, name: 'A' }).error).toBeDefined();
    expect(contactSchema.validate({ ...valid, name: 'x'.repeat(81) }).error).toBeDefined();
    expect(contactSchema.validate({ ...valid, email: 'nope' }).error).toBeDefined();
    expect(contactSchema.validate({ ...valid, subject: 'ab' }).error).toBeDefined();
    expect(contactSchema.validate({ ...valid, subject: 'x'.repeat(121) }).error).toBeDefined();
    expect(contactSchema.validate({ ...valid, message: 'too short' }).error).toBeDefined();
    expect(contactSchema.validate({ ...valid, message: 'x'.repeat(4001) }).error).toBeDefined();
  });
});

describe('contact route wiring', () => {
  it('POST / runs the contactLimiter first (5/hour/IP) and then validation', () => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/' && l.route.methods.post);
    expect(layer).toBeDefined();
    expect(layer.route.stack[0].handle).toBe(contactLimiter);
    expect(layer.route.stack).toHaveLength(3); // limiter, validate, handler
  });
});

describe('contact service', () => {
  beforeEach(() => send.mockClear());

  it('emails the admin with reply-to = sender', async () => {
    expect(await sendContactMessage({ ...valid, email: 'asha@example.com' })).toEqual({ received: true });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@example.com', replyTo: 'asha@example.com', template: 'contact-message' }),
    );
  });

  it('503 when ADMIN_EMAIL is not configured', async () => {
    envMock.admin.email = '';
    await expect(sendContactMessage(valid)).rejects.toMatchObject({ statusCode: 503 });
    envMock.admin.email = 'admin@example.com';
  });

  it('contact-message template renders html + text', async () => {
    const out = await renderEmail('contact-message', {
      senderName: 'Asha',
      senderEmail: 'asha@example.com',
      contactSubject: 'Question',
      message: 'Hello <b>there</b>',
    });
    expect(out.text).toContain('Hello <b>there</b>');
    expect(out.html).toContain('Hello &lt;b&gt;there&lt;/b&gt;');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { presignSchema } from './uploads.validation';
import { isOwnMediaUrl } from '@/modules/members/members.service';
import { renderEmail } from '@/providers/email/render';

vi.mock('@/core/prisma/client', () => ({ prisma: {} }));

describe('presignSchema', () => {
  const ok = { folder: 'auctions', contentType: 'image/png', size: 1000 };
  it('accepts valid input', () => expect(presignSchema.validate(ok).error).toBeUndefined());
  it('rejects other folders, types and > 5 MB', () => {
    expect(presignSchema.validate({ ...ok, folder: 'uploads' }).error).toBeDefined();
    expect(presignSchema.validate({ ...ok, contentType: 'image/gif' }).error).toBeDefined();
    expect(presignSchema.validate({ ...ok, size: 5 * 1024 * 1024 + 1 }).error).toBeDefined();
    expect(presignSchema.validate({ ...ok, size: 5 * 1024 * 1024 }).error).toBeUndefined();
  });
});

describe('presignSchema: videos', () => {
  const MB = 1024 * 1024;
  const video = { folder: 'auction-videos', contentType: 'video/mp4', size: 10 * MB };
  it('mp4 and webm up to 50 MB in auction-videos', () => {
    expect(presignSchema.validate(video).error).toBeUndefined();
    expect(presignSchema.validate({ ...video, contentType: 'video/webm', size: 50 * MB }).error).toBeUndefined();
    expect(presignSchema.validate({ ...video, size: 50 * MB + 1 }).error).toBeDefined();
    expect(presignSchema.validate({ ...video, contentType: 'video/quicktime' }).error).toBeDefined();
  });
  it('folder and type must match', () => {
    expect(presignSchema.validate({ ...video, folder: 'auctions' }).error).toBeDefined();
    expect(presignSchema.validate({ ...video, folder: 'avatars' }).error).toBeDefined();
    expect(presignSchema.validate({ ...video, contentType: 'image/png' }).error).toBeDefined();
  });
  it('images keep the 5 MB cap', () => {
    expect(presignSchema.validate({ folder: 'auctions', contentType: 'image/png', size: 5 * MB + 1 }).error).toBeDefined();
  });
  it('a video URL must be one of our uploads', () => {
    const bases = ['https://cdn.example.com/'];
    expect(isOwnMediaUrl('https://cdn.example.com/auction-videos/a.mp4', bases)).toBe(true);
    expect(isOwnMediaUrl('https://youtube.com/watch?v=1', bases)).toBe(false);
  });
});

describe('isOwnMediaUrl', () => {
  const bases = ['https://cdn.example.com/'];
  it('only allows URLs under our base', () => {
    expect(isOwnMediaUrl('https://cdn.example.com/avatars/a.png', bases)).toBe(true);
    expect(isOwnMediaUrl('https://evil.com/a.png', bases)).toBe(false);
    expect(isOwnMediaUrl('https://cdn.example.com.evil.com/a.png', bases)).toBe(false);
  });
});

describe('email templates', () => {
  it('otp-code renders HTML + text, purpose-aware', async () => {
    const reset = await renderEmail('otp-code', { code: '654321', purpose: 'PASSWORD_RESET', expiryMinutes: 10 });
    expect(reset.html).toContain('654321');
    expect(reset.text).toContain('reset your password');
    const signup = await renderEmail('otp-code', { code: '654321', purpose: 'SIGNUP', expiryMinutes: 10 });
    expect(signup.text).toContain('verify your email');
  });
  it('welcome renders', async () => {
    const w = await renderEmail('welcome', { name: 'Asha', role: 'BIDDER' });
    expect(w.html).toContain('Asha');
    expect(w.text).toContain('Asha');
  });
});

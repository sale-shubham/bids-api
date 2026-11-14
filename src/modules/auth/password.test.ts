import { describe, expect, it } from 'vitest';
import { passwordRuleError } from './password';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
  verifySignupSchema,
} from './auth.validation';

describe('passwordRuleError', () => {
  it('accepts a valid password', () => expect(passwordRuleError('abcdef12')).toBeNull());
  it('rejects < 8 chars', () => expect(passwordRuleError('abc12')).toMatch(/at least 8/));
  it('rejects no number', () => expect(passwordRuleError('abcdefgh')).toMatch(/number/));
  it('rejects no letter', () => expect(passwordRuleError('12345678')).toMatch(/letter/));
  it('allows exactly 72 bytes, rejects 73', () => {
    expect(passwordRuleError('a1' + 'x'.repeat(70))).toBeNull();
    expect(passwordRuleError('a1' + 'x'.repeat(71))).toMatch(/72 bytes/);
  });
  it('counts bytes, not characters', () => {
    // 30 three-byte chars + 'a1' = 92 bytes but only 32 characters
    expect(passwordRuleError('a1' + '€'.repeat(30))).toMatch(/72 bytes/);
  });
});

describe('auth validation schemas', () => {
  const good = { name: ' Asha ', email: ' Asha@Example.COM ', password: 'abcdef12', role: 'BIDDER' };

  it('signup normalises email + name', () => {
    const { error, value } = signupSchema.validate(good);
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ name: 'Asha', email: 'asha@example.com' });
  });
  it('signup rejects SUPER_ADMIN role and weak password', () => {
    expect(signupSchema.validate({ ...good, role: 'SUPER_ADMIN' }).error).toBeDefined();
    expect(signupSchema.validate({ ...good, password: 'short1' }).error).toBeDefined();
  });
  it('verify needs a 6-digit code', () => {
    expect(verifySignupSchema.validate({ email: 'a@b.co', code: '123456' }).error).toBeUndefined();
    expect(verifySignupSchema.validate({ email: 'a@b.co', code: '12345' }).error).toBeDefined();
    expect(verifySignupSchema.validate({ email: 'a@b.co', code: 'abcdef' }).error).toBeDefined();
  });
  it('login only requires a non-empty password', () => {
    expect(loginSchema.validate({ email: 'a@b.co', password: 'x' }).error).toBeUndefined();
    expect(loginSchema.validate({ email: 'a@b.co', password: '' }).error).toBeDefined();
  });
  it('forgot requires a valid email', () => {
    expect(forgotPasswordSchema.validate({ email: 'nope' }).error).toBeDefined();
  });
  it('reset / change apply the password rule', () => {
    expect(resetPasswordSchema.validate({ email: 'a@b.co', code: '123456', password: 'abcdefgh' }).error).toBeDefined();
    expect(changePasswordSchema.validate({ currentPassword: 'x', newPassword: 'abcdef12' }).error).toBeUndefined();
    expect(changePasswordSchema.validate({ currentPassword: 'x', newPassword: '12345678' }).error).toBeDefined();
  });
});

import Joi from 'joi';
import { passwordRuleError } from './password';

// Parsed client-side (ua-parser-js) and sent along — deviceId itself is not
// client-supplied, it's server-generated/reused via the `dvid` cookie
// (see device.service.ts).
export const deviceInfoSchema = Joi.object({
  browser: Joi.string().trim().max(100).allow('', null),
  os: Joi.string().trim().max(100).allow('', null),
  device: Joi.string().trim().max(100).allow('', null),
  type: Joi.string().trim().max(50).allow('', null),
}).optional();

const email = Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).required();

// New-password rule (see password.ts). Used for signup / reset / change.
const newPassword = Joi.string()
  .required()
  .custom((value: string, helpers) => {
    const msg = passwordRuleError(value);
    return msg ? helpers.message({ custom: msg }) : value;
  });

const code = Joi.string().trim().pattern(/^\d{6}$/).required().messages({
  'string.pattern.base': 'code must be a 6-digit number',
});

export const signupSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).required(),
  email,
  password: newPassword,
  role: Joi.string().valid('BIDDER', 'AUCTIONEER').required(),
  referralCode: Joi.string().trim().max(32).allow('', null),
});

export const verifySignupSchema = Joi.object({ email, code });
export const resendSchema = Joi.object({ email });
export const forgotPasswordSchema = Joi.object({ email });

// Login only checks presence — the stored hash decides; don't leak the policy.
export const loginSchema = Joi.object({
  email,
  password: Joi.string().min(1).max(1000).required(),
  deviceInfo: deviceInfoSchema,
});

export const resetPasswordSchema = Joi.object({ email, code, password: newPassword });

export const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().min(1).max(1000).required(),
  newPassword,
});

export type DeviceInfo = { browser?: string; os?: string; device?: string; type?: string };

const totpCode = Joi.string().trim().pattern(/^\d{6}$/).required().messages({
  'string.pattern.base': 'code must be a 6-digit number',
});
// A TOTP code or a recovery code (XXXX-XXXX).
const anyCode = Joi.string().trim().min(6).max(32).required();

export const twoFactorEnableSchema = Joi.object({ code: totpCode });
export const twoFactorDisableSchema = Joi.object({ password: Joi.string().min(1).max(1000).required(), code: anyCode });
export const twoFactorRecoverySchema = Joi.object({ code: anyCode });
export const twoFactorVerifySchema = Joi.object({
  challengeToken: Joi.string().trim().max(2000).required(),
  code: Joi.string().trim().pattern(/^\d{6}$/).messages({ 'string.pattern.base': 'code must be a 6-digit number' }),
  recoveryCode: Joi.string().trim().min(8).max(32),
  deviceInfo: deviceInfoSchema,
})
  .xor('code', 'recoveryCode')
  .messages({ 'object.missing': 'Provide code or recoveryCode', 'object.xor': 'Provide only one of code or recoveryCode' });

import Joi from 'joi';

// Parsed client-side (ua-parser-js) and sent along — deviceId itself is not
// client-supplied, it's server-generated/reused via the `dvid` cookie
// (see device.service.ts).
export const deviceInfoSchema = Joi.object({
  browser: Joi.string().trim().max(100).allow('', null),
  os: Joi.string().trim().max(100).allow('', null),
  device: Joi.string().trim().max(100).allow('', null),
  type: Joi.string().trim().max(50).allow('', null),
}).optional();

// TODO(Phase 1): signup / verify-email / login / forgot-password / reset-password schemas.

export type DeviceInfo = { browser?: string; os?: string; device?: string; type?: string };

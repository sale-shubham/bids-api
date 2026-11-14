// Flat, non-env-configurable constants used across modules. These never vary
// per-deployment (unlike src/core/config/env.ts), so they live in code, not
// .env — promote one to an AppSetting/env var only if a real need to vary it
// per-environment ever comes up.

// Email OTP shape (signup verification + forgot-password).
export const OTP_TTL_SECONDS = 600;
export const OTP_LENGTH = 6;
export const OTP_RESEND_COOLDOWN_SECONDS = 30;

// Per-Member device/session cap — logging in from a new device beyond this
// deletes the oldest (by createdAt) Session row first; also force-disconnects
// the evicted device's WebSocket connections (ws.service.ts's
// disconnectMemberConnections). Bootstrap default: the live, admin-configurable
// cap is settings/device-limit.service.ts's getMaxDevicesForRole().
export const MAX_DEVICES_PER_MEMBER = 3;

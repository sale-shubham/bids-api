// SMS delivery abstraction (phone-verification OTP only) — stub or MSG91. Swap by SMS_DRIVER env.
export interface SendSmsInput {
  // E.164, e.g. +919876543210
  to: string;
  text: string;
  // Variables for DLT template drivers (msg91 uses `otp`).
  templateVars?: Record<string, string>;
}

export interface SmsProvider {
  send(input: SendSmsInput): Promise<void>;
}

/** +919876543210 -> +91******3210 */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  const cc = e164.startsWith('+') && digits.length > 10 ? `+${digits.slice(0, digits.length - 10)}` : '';
  const rest = digits.slice(cc ? cc.length - 1 : 0);
  return `${cc}${'*'.repeat(Math.max(0, rest.length - 4))}${rest.slice(-4)}`;
}

import { logger } from '@/core/logger/logger';
import type { EmailProvider, SendEmailInput } from './email.provider';

// Dev stub — never sends. Logs subject + recipient (+ the OTP code when the
// template carries one) so dev accounts are verifiable from the server log.
// The code itself is decided by otp-challenge.service (env.otp.stubCode in stub mode).
export class StubEmail implements EmailProvider {
  async send({ to, subject, template, data }: SendEmailInput): Promise<void> {
    const code = typeof data?.code === 'string' ? data.code : undefined;
    logger.info({ to, subject, template, ...(code ? { code } : {}) }, '[email:stub] email not sent');
  }
}

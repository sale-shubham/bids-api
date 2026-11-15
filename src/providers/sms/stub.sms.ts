import { env } from '@/core/config/env';
import { logger } from '@/core/logger/logger';
import { maskPhone, type SendSmsInput, type SmsProvider } from './sms.provider';

// Dev stub — never sends. Logs a masked number; outside production also the OTP so local dev works.
export class StubSms implements SmsProvider {
  async send({ to, templateVars }: SendSmsInput): Promise<void> {
    const devOtp = !env.isProd && templateVars?.otp ? { devOtp: templateVars.otp } : {};
    logger.info({ to: maskPhone(to), ...devOtp }, '[sms:stub] sms not sent');
  }
}

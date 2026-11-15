import { env } from '@/core/config/env';
import { AppError } from '@/core/errors/AppError';
import type { SendSmsInput, SmsProvider } from './sms.provider';

// MSG91 Flow API. Needs a DLT-registered sender id + template (India); the template carries a ##otp## variable.
const FLOW_URL = 'https://control.msg91.com/api/v5/flow';

export class Msg91Sms implements SmsProvider {
  async send({ to, templateVars }: SendSmsInput): Promise<void> {
    const { authKey, otpTemplateId } = env.sms.msg91;
    if (!authKey || !otpTemplateId) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'SMS is not configured');
    const res = await fetch(FLOW_URL, {
      method: 'POST',
      headers: { authkey: authKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        template_id: otpTemplateId,
        short_url: '0',
        recipients: [{ mobiles: to.replace(/^\+/, ''), ...(templateVars ?? {}) }],
      }),
    });
    if (!res.ok) throw new Error(`MSG91 responded ${res.status}`);
    const body = (await res.json().catch(() => null)) as { type?: string } | null;
    if (body?.type && body.type !== 'success') throw new Error('MSG91 rejected the request');
  }
}

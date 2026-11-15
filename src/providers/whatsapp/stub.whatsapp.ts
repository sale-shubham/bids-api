import { logger } from '@/core/logger/logger';
import { maskPhone } from '@/providers/sms/sms.provider';
import type { SendTemplateInput, WhatsappProvider } from './whatsapp.provider';

// Dev stub — never sends. Logs the masked number and the template name only.
export class StubWhatsapp implements WhatsappProvider {
  async sendTemplate({ to, template }: SendTemplateInput): Promise<void> {
    logger.info({ to: maskPhone(to), template }, '[whatsapp:stub] message not sent');
  }
}

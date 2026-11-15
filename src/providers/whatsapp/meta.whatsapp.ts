import { env } from '@/core/config/env';
import { AppError } from '@/core/errors/AppError';
import type { SendTemplateInput, WhatsappProvider } from './whatsapp.provider';

// WhatsApp Cloud API (Meta). Utility templates must be pre-approved in the Meta Business account.
export class MetaWhatsapp implements WhatsappProvider {
  async sendTemplate({ to, template, language, params }: SendTemplateInput): Promise<void> {
    const { token, phoneNumberId, apiVersion } = env.whatsapp;
    if (!token || !phoneNumberId) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'WhatsApp is not configured');
    const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: template,
          language: { code: language },
          components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
        },
      }),
    });
    if (!res.ok) throw new Error(`WhatsApp Cloud API responded ${res.status}`);
  }
}

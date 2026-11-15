// WhatsApp delivery abstraction (opt-in utility alerts) — stub or Meta Cloud API. Swap by WHATSAPP_DRIVER env.
export interface SendTemplateInput {
  // E.164, e.g. +919876543210
  to: string;
  // Approved template name.
  template: string;
  language: 'en';
  // Body variables in template order ({{1}}, {{2}}, ...).
  params: string[];
}

export interface WhatsappProvider {
  sendTemplate(input: SendTemplateInput): Promise<void>;
}

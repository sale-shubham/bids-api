import { env } from '@/core/config/env';
import { StubWhatsapp } from './stub.whatsapp';
import { MetaWhatsapp } from './meta.whatsapp';
import type { WhatsappProvider } from './whatsapp.provider';

export const whatsappProvider: WhatsappProvider = env.whatsapp.driver === 'meta' ? new MetaWhatsapp() : new StubWhatsapp();

export type { WhatsappProvider, SendTemplateInput } from './whatsapp.provider';

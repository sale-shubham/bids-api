import { env } from '@/core/config/env';
import { StubEmail } from './stub.email';
import { SesEmail } from './ses.email';
import type { EmailProvider } from './email.provider';

export const emailProvider: EmailProvider = env.email.driver === 'ses' ? new SesEmail() : new StubEmail();

export type { EmailProvider } from './email.provider';

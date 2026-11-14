import { env } from '@/core/config/env';
import { logger } from '@/core/logger/logger';
import { AppError } from '@/core/errors/AppError';
import { emailProvider } from '@/providers/email';
import type { ContactInput } from './contact.validation';

/** Forward a contact-form message to the admin inbox; Reply-To is the sender. */
export async function sendContactMessage(input: ContactInput): Promise<{ received: true }> {
  const to = env.admin.email;
  if (!to) {
    logger.error('contact: ADMIN_EMAIL is not configured, message dropped');
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Contact is temporarily unavailable');
  }
  await emailProvider.send({
    to,
    subject: `[Contact] ${input.subject}`,
    template: 'contact-message',
    replyTo: input.email,
    data: {
      senderName: input.name,
      senderEmail: input.email,
      contactSubject: input.subject,
      message: input.message,
    },
  });
  return { received: true };
}

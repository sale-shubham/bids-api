import { env } from '@/core/config/env';
import { logger } from '@/core/logger/logger';
import type { EmailProvider, SendEmailInput } from './email.provider';
import { renderEmail } from './render';

// No explicit credentials — on Lambda, the function's execution role grants
// ses:SendEmail/ses:SendRawEmail (see serverless.yml) and the SDK's default
// provider chain picks that up automatically. Locally, whatever AWS
// credentials are otherwise configured apply, same as the S3 storage driver.
// The SDK is loaded on first use, not at module load: static imports of the
// runtime-provided @aws-sdk/* packages are hoisted to the top of the Lambda
// bundle, and the AWS clients together were ~30% of cold-start import time.
let ses:
  | Promise<{
      client: import('@aws-sdk/client-ses').SESClient;
      SendEmailCommand: typeof import('@aws-sdk/client-ses').SendEmailCommand;
    }>
  | undefined;
const getSes = () =>
  (ses ??= import('@aws-sdk/client-ses').then(({ SESClient, SendEmailCommand }) => ({
    client: new SESClient({ region: env.storage.s3.region }),
    SendEmailCommand,
  })));

// Real driver — wired when EMAIL_DRIVER=ses. Renders the local EJS template pair
// (HTML + plain text) and sends it via SES SendEmailCommand (no SES-native
// templates, no attachments).
export class SesEmail implements EmailProvider {
  async send({ to, subject, template, data }: SendEmailInput): Promise<void> {
    const { html, text } = await renderEmail(template, data);

    try {
      const { client: sesClient, SendEmailCommand } = await getSes();
      const result = await sesClient.send(
        new SendEmailCommand({
          Source: `${env.email.fromName} <${env.email.fromAddress}>`,
          Destination: { ToAddresses: [to] },
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' } },
          },
        })
      );
      logger.info({ to, template, messageId: result.MessageId }, 'SES email sent');
    } catch (err) {
      // Log with address/template context so a failed send is traceable
      // (unverified sender, sandbox-mode recipient, throttling, etc).
      logger.error({ err, to, template }, 'SES email send failed');
      throw err;
    }
  }
}

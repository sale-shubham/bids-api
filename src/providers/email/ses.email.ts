import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { env } from '@/core/config/env';
import { OTP_TTL_SECONDS } from '@/core/config/constants';
import { logger } from '@/core/logger/logger';
import type { EmailProvider } from './email.provider';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Source run (tsx): src/providers/email → src/templates. Lambda bundle:
// dist/index.mjs → dist/templates (copied by scripts/build-lambda.mjs).
const templatesDir = existsSync(join(__dirname, 'templates'))
  ? join(__dirname, 'templates')
  : join(__dirname, '../../templates');

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

// Real driver — wired when EMAIL_DRIVER=ses. Renders the local otp-code.ejs
// template to an HTML string and sends it via SES SendEmailCommand (no SES-native
// templates, no attachments — OTP emails never need either).
export class SesEmail implements EmailProvider {
  async send(to: string, code: string): Promise<void> {
    const html = await ejs.renderFile(join(templatesDir, 'otp-code.ejs'), {
      code,
      expiryMinutes: Math.round(OTP_TTL_SECONDS / 60),
      fromName: env.email.fromName,
      logoUrl: env.email.logoUrl,
      frontendUrl: env.app.url,
    });

    try {
      const { client: sesClient, SendEmailCommand } = await getSes();
      const result = await sesClient.send(
        new SendEmailCommand({
          Source: `${env.email.fromName} <${env.email.fromAddress}>`,
          Destination: { ToAddresses: [to] },
          Message: {
            Subject: { Data: 'Your NobleBid verification code' },
            Body: { Html: { Data: html as string } },
          },
        })
      );
      logger.info({ to, messageId: result.MessageId }, 'SES OTP email sent');
    } catch (err) {
      // The global error handler already logs unhandled errors, but without
      // "to"/driver context — log it here so a failed send is traceable to
      // which address/SES error (unverified sender, sandbox-mode recipient,
      // throttling, etc) without having to correlate stack traces.
      logger.error({ err, to }, 'SES OTP email send failed');
      throw err;
    }
  }
}

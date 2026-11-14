import { env } from '@/core/config/env';
import { logger } from '@/core/logger/logger';
import type { NotifyMessage } from './notify.types';

// SQS client loaded on first use (keeps the AWS SDK off the cold-start path).
let sqs:
  | Promise<{
      client: import('@aws-sdk/client-sqs').SQSClient;
      SendMessageCommand: typeof import('@aws-sdk/client-sqs').SendMessageCommand;
    }>
  | undefined;
const getSqs = () =>
  (sqs ??= import('@aws-sdk/client-sqs').then(({ SQSClient, SendMessageCommand }) => ({
    client: new SQSClient({ region: env.storage.s3.region }),
    SendMessageCommand,
  })));

/**
 * Queue a notification. With NOTIFY_QUEUE_URL set it goes to SQS (the
 * notifyWorker Lambda processes it); otherwise it is processed inline so local
 * dev works. Never throws: a notification must not fail the bid / close that
 * triggered it.
 */
export async function enqueueNotification(msg: NotifyMessage): Promise<void> {
  try {
    if (env.notify.queueUrl) {
      const { client, SendMessageCommand } = await getSqs();
      await client.send(new SendMessageCommand({ QueueUrl: env.notify.queueUrl, MessageBody: JSON.stringify(msg) }));
      return;
    }
    const { processNotification } = await import('./notify.service');
    await processNotification(msg); // inline: errors are logged inside, not thrown
  } catch (err) {
    logger.error({ err, type: msg.type, dedupeKey: msg.dedupeKey }, 'notify: enqueue failed');
  }
}

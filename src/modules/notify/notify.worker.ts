import { logger } from '@/core/logger/logger';
import { processNotification } from './notify.service';
import type { NotifyMessage } from './notify.types';

export type SqsBatchEvent = { Records?: { messageId: string; body: string }[] };

/**
 * SQS handler body (ReportBatchItemFailures): process every record, return only
 * the failed ones so SQS retries just those. An unparseable body is a poison
 * message and is reported failed too, so it ends up in the DLQ.
 */
export async function processSqsBatch(event: SqsBatchEvent) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    try {
      const msg = JSON.parse(record.body) as NotifyMessage;
      await processNotification(msg, { rethrowEmailErrors: true });
    } catch (err) {
      logger.error({ err, messageId: record.messageId }, 'notify worker: record failed');
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

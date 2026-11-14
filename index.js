// Single entry point — both the AWS Lambda handler and the local dev server
// live here. Plain JS so the Lambda runtime resolves `index.handler`; tsx
// (registered via NODE_OPTIONS=--import tsx in serverless.yml, and `tsx index.js`
// locally) type-strips the imported .ts source and resolves the `@/*` tsconfig
// path aliases. The deployed bundle is produced by scripts/build-lambda.mjs (CI only).
import serverlessExpress from '@codegenie/serverless-express';
import { createApp } from './src/app.ts';
import { env } from './src/core/config/env.ts';
import { logger } from './src/core/logger/logger.ts';
import { prisma } from './src/core/prisma/client.ts';

// Express app built ONCE per container (warm reuse). No `.listen()` on Lambda —
// the runtime invokes `handler`.
const app = createApp();

const expressHandler = serverlessExpress({ app });

// Keep-warm ping from the EventBridge schedule on this function (serverless.yml)
// — short-circuit before serverless-express tries to parse a non-HTTP event.
//
// A WebSocket event (event.requestContext.eventType is 'CONNECT'/'DISCONNECT'/
// 'MESSAGE') is routed to src/modules/ws/ws.service.ts instead — same Lambda,
// same warm container/Prisma singleton as the REST API, just a second,
// separate API Gateway (WebSocket, not HTTP) triggering it. The check has to
// come before serverless-express, which would choke on this event shape.
export const handler = async (event, context) => {
  if (event?.warmer) return 'warmed';

  const wsEventType = event?.requestContext?.eventType;
  if (wsEventType) {
    const ws = await import('./src/modules/ws/ws.service.ts');
    if (wsEventType === 'CONNECT') return ws.handleConnect(event);
    if (wsEventType === 'DISCONNECT') return ws.handleDisconnect(event);
    return ws.handleDefault(event);
  }

  return expressHandler(event, context);
};

// Scheduled (EventBridge) handler — daily retention purge (expired OtpChallenge
// rows, stale Session rows, stale WS rows, expired rate-limit buckets).
// Separate Lambda function (index.retentionPurgeHandler); see serverless.yml
// functions.retentionPurge.
export const retentionPurgeHandler = async () => {
  const { runRetentionPurge } = await import('./src/modules/admin/retention/admin-retention.service.ts');
  return runRetentionPurge();
};

// Scheduled every minute (serverless.yml functions.closeAuctions): start due
// auctions, close ended ones. Idempotent — overlapping runs are no-ops.
export const closeAuctionsHandler = async () => {
  const { runAuctionClose } = await import('./src/modules/auctions/auction-close.service.ts');
  const counts = await runAuctionClose();
  if (counts.started || counts.ended) logger.info(counts, 'auction close run');
  return counts;
};

// Scheduled daily (serverless.yml functions.commissionReminder): remind sellers of
// DUE commissions that are overdue or older than 3 days. One reminder per commission per day.
export const commissionReminderHandler = async () => {
  const { runCommissionReminders } = await import('./src/modules/commissions/commissions.service.ts');
  const res = await runCommissionReminders();
  if (res.reminded) logger.info(res, 'commission reminders run');
  return res;
};

// Scheduled every 15 min (serverless.yml functions.endingSoon): notify watchers of
// auctions ending within the hour. One notification per watcher per auction.
export const endingSoonHandler = async () => {
  const { runEndingSoon } = await import('./src/modules/watchlist/watchlist.service.ts');
  const res = await runEndingSoon();
  if (res.notified) logger.info(res, 'ending soon run');
  return res;
};

// SQS NotifyQueue worker (ReportBatchItemFailures): returns the failed
// messageIds so only those are retried / sent to the DLQ.
export const notifyWorkerHandler = async (event) => {
  const { processSqsBatch } = await import('./src/modules/notify/notify.worker.ts');
  return processSqsBatch(event);
};

// Local development server (not production / not Lambda): listen + graceful shutdown.
if (env.nodeEnv !== 'production') {
  const server = app.listen(env.port, () => {
    logger.info(`NobleBid API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  // Local live updates without AWS: WebSocket server on the same HTTP server at
  // /ws, routed to the same handlers as Lambda (src/modules/ws/ws.local.ts).
  // Skipped when a real API Gateway endpoint is configured.
  if (!env.ws.apiEndpoint) {
    const { attachLocalWsServer } = await import('./src/modules/ws/ws.local.ts');
    attachLocalWsServer(server);
  }

  // No EventBridge locally: run the auction close job every 60 s.
  let closing = false;
  const closeTimer = setInterval(async () => {
    if (closing) return;
    closing = true;
    try {
      const { runAuctionClose } = await import('./src/modules/auctions/auction-close.service.ts');
      const counts = await runAuctionClose();
      if (counts.started || counts.ended) logger.info(counts, 'auction close run');
    } catch (err) {
      logger.error({ err }, 'auction close run failed');
    } finally {
      closing = false;
    }
  }, 60_000);

  // No EventBridge locally: commission reminders once at startup, then every 6 h
  // (per-day dedupeKey keeps it to one reminder per commission per day).
  const runReminders = async () => {
    try {
      await commissionReminderHandler();
    } catch (err) {
      logger.error({ err }, 'commission reminder run failed');
    }
  };
  void runReminders();
  const reminderTimer = setInterval(runReminders, 6 * 60 * 60 * 1000);

  // No EventBridge locally: ending-soon watchlist reminders every 5 min.
  let endingSoon = false;
  const endingSoonTimer = setInterval(async () => {
    if (endingSoon) return;
    endingSoon = true;
    try {
      await endingSoonHandler();
    } catch (err) {
      logger.error({ err }, 'ending soon run failed');
    } finally {
      endingSoon = false;
    }
  }, 5 * 60 * 1000);

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    clearInterval(closeTimer);
    clearInterval(reminderTimer);
    clearInterval(endingSoonTimer);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

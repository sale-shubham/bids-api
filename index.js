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
// TODO(Phase 5+): closeAuctionsHandler, endingSoonHandler, commissionReminderHandler,
// notifyWorkerHandler.
export const retentionPurgeHandler = async () => {
  const { runRetentionPurge } = await import('./src/modules/admin/retention/admin-retention.service.ts');
  return runRetentionPurge();
};

// Local development server (not production / not Lambda): listen + graceful shutdown.
if (env.nodeEnv !== 'production') {
  const server = app.listen(env.port, () => {
    logger.info(`NobleBid API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

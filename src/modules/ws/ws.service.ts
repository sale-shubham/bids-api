import { prisma } from '@/core/prisma/client';
import { env } from '@/core/config/env';
import { logger } from '@/core/logger/logger';

// ----------------------------------------------------------------------------
// WEBSOCKET — real-time push layered on top of the REST API, NOT a second
// write path. Members only ever send a message via the existing
// `POST /messages/conversations/:id/messages` (keeps validation, the
// FEATURE_KEYS.MEMBER_CHAT gate, and rate limiting in one place); this module
// only pushes a "here's what just happened" frame to whichever of the
// recipient's tabs/devices currently have a socket open. See
// readme/flows/websocket.md.
//
// Same Lambda/handler as the REST API — index.js's `handler` branches on
// event.requestContext.eventType and routes CONNECT/DISCONNECT/MESSAGE here
// instead of into serverless-express.
// ----------------------------------------------------------------------------

// Minimal shape of an API Gateway WebSocket Lambda proxy event — just the
// fields this module actually reads. No @types/aws-lambda dependency added
// for this alone; index.js (the real entry point) is already untyped JS.
interface WsEvent {
  requestContext: {
    connectionId: string;
    eventType?: 'CONNECT' | 'DISCONNECT' | 'MESSAGE';
  };
  queryStringParameters?: Record<string, string | undefined> | null;
}

// A ticket is good for this long after issue — just enough time for the
// client to receive the response and immediately open the socket. Not a
// "session" length: a fresh ticket is minted for every single connection
// attempt (see issueTicket), it's not reused across reconnects.
const WS_TICKET_TTL_MS = 60_000;

// wss:// URL the client should actually open — derived from the same
// CloudFormation-injected env.ws.apiEndpoint pushToMember already uses
// (https://...), not a second, separately-configured value. This is why the
// client never needs its own NEXT_PUBLIC_WS_URL: the server already knows
// its own WebSocket endpoint with zero manual config (serverless.yml's
// `!Sub` against the auto-created WebsocketsApi resource), so it just hands
// that same knowledge to whoever asks for a ticket. `null` when unset
// (local dev, no AWS-provisioned WebSocket API) — the frontend treats a
// `null` wsUrl as "don't attempt to connect", the same outcome an unset env
// var used to produce, just derived server-side instead of duplicated
// client-side.
function getWsUrl(): string | null {
  if (!env.ws.apiEndpoint) return null;
  return env.ws.apiEndpoint.replace(/^https:\/\//, 'wss://');
}

// POST /ws/ticket — called over the ordinary, cookie-authenticated REST API
// right before opening a socket. A raw JWT can't be handed to the browser's
// native WebSocket API the way a fetch() call gets one (no custom headers on
// the handshake, and the httpOnly access-token cookie doesn't carry over to
// a different hostname — the auto-generated WebSocket API isn't on the same
// domain the cookie is scoped to). This single-use, short-TTL ticket stands
// in for it instead: opaque, meaningless outside the next few seconds, and
// consumed the instant handleConnect accepts it.
export async function issueTicket(memberId: string) {
  const ticket = await prisma.wsTicket.create({
    data: { memberId, expiresAt: new Date(Date.now() + WS_TICKET_TTL_MS) },
  });
  return { ticket: ticket.id, expiresAt: ticket.expiresAt, wsUrl: getWsUrl() };
}

// $connect — API Gateway aborts the handshake on anything but a 2xx
// statusCode, so a rejected/expired/already-used ticket just fails the
// WebSocket connection outright (the frontend's reconnect logic treats that
// like any other dropped connection — it doesn't get a structured error
// frame to read, there's no connection to send one over).
export async function handleConnect(event: WsEvent) {
  const ticketId = event.queryStringParameters?.ticket;
  if (!ticketId) return { statusCode: 401, body: 'Missing ticket' };

  const ticket = await prisma.wsTicket.findUnique({ where: { id: ticketId } });
  if (!ticket || ticket.usedAt || ticket.expiresAt.getTime() < Date.now()) {
    return { statusCode: 401, body: 'Invalid or expired ticket' };
  }

  await prisma.$transaction([
    prisma.wsTicket.update({ where: { id: ticketId }, data: { usedAt: new Date() } }),
    prisma.wsConnection.create({
      data: { id: event.requestContext.connectionId, memberId: ticket.memberId },
    }),
  ]);

  return { statusCode: 200 };
}

// $disconnect — best-effort cleanup; a connectionId that's already gone
// (e.g. handleConnect never actually created a row because the ticket was
// bad) is not an error, there's just nothing to delete.
export async function handleDisconnect(event: WsEvent) {
  await prisma.wsConnection.deleteMany({ where: { id: event.requestContext.connectionId } });
  return { statusCode: 200 };
}

// $default — catches any inbound frame not matched by another route (this
// module only ever defines $connect/$disconnect/$default, no named action
// routes). The client never needs to send anything meaningful over the
// socket — sending a message always goes through the REST endpoint — so this
// just acknowledges receipt. Doubles as a keepalive target if the frontend
// ever pings on an interval to detect a half-open connection sooner than API
// Gateway's own idle timeout would.
export async function handleDefault(_event: WsEvent) {
  return { statusCode: 200 };
}

// The SDK is loaded on first use, not at module load: static imports of the
// runtime-provided @aws-sdk/* packages are hoisted to the top of the Lambda
// bundle, and the AWS clients together were ~30% of cold-start import time.
async function managementClient() {
  if (!env.ws.apiEndpoint) return null; // local dev / no AWS access — see env.ts
  const sdk = await import('@aws-sdk/client-apigatewaymanagementapi');
  return { sdk, client: new sdk.ApiGatewayManagementApiClient({ endpoint: env.ws.apiEndpoint }) };
}

// Best-effort push to every open socket a member currently has (multiple
// tabs/devices = multiple WsConnection rows). Never throws — a failed push
// must not fail the REST call that triggered it (e.g. sendMessage); the
// state is already durably saved either way. A failed/undelivered push just
// means the recipient finds out on their next reload or reconnect.
export async function pushToMember(memberId: string, payload: unknown) {
  const mgmt = await managementClient();
  if (!mgmt) return;
  const { sdk, client } = mgmt;

  const connections = await prisma.wsConnection.findMany({
    where: { memberId },
    select: { id: true },
  });
  if (connections.length === 0) return;

  const data = Buffer.from(JSON.stringify(payload));
  await Promise.all(
    connections.map(async (conn) => {
      try {
        await client.send(new sdk.PostToConnectionCommand({ ConnectionId: conn.id, Data: data }));
      } catch (err) {
        if (err instanceof sdk.GoneException) {
          // The client disconnected without API Gateway ever firing
          // $disconnect for it (network drop, tab killed) — the connection
          // itself is already gone (that's what GoneException means), so
          // just clean up our own now-stale row.
          await prisma.wsConnection.deleteMany({ where: { id: conn.id } }).catch(() => {});
          return;
        }
        logger.error({ err, memberId, connectionId: conn.id }, 'ws: push failed');
      }
    })
  );
}

// Force-closes every open socket a member currently has. Called when a
// device is evicted by the session cap (session.service.ts's
// upsertDeviceSession, fixed 2026-09-12) — WsConnection is keyed to memberId,
// not Session.id, so without this an evicted device's REST calls start
// 401ing immediately while its still-open WebSocket keeps receiving live
// dm:new-message/dm:read pushes until it separately disconnects. Best-effort,
// same GoneException self-healing as pushToMember — never throws, since
// login must never fail because of a WS cleanup problem. DB rows are deleted
// regardless of whether the AWS call itself succeeds (or whether there's no
// management client at all, i.e. local dev) — a member forced down to 1
// device should never have a stale WsConnection row lying around either way.
export async function disconnectMemberConnections(memberId: string) {
  const connections = await prisma.wsConnection.findMany({
    where: { memberId },
    select: { id: true },
  });
  if (connections.length === 0) return;

  const mgmt = await managementClient();
  if (mgmt) {
    const { sdk, client } = mgmt;
    await Promise.all(
      connections.map(async (conn) => {
        try {
          await client.send(new sdk.DeleteConnectionCommand({ ConnectionId: conn.id }));
        } catch (err) {
          if (!(err instanceof sdk.GoneException)) {
            logger.error({ err, memberId, connectionId: conn.id }, 'ws: force-disconnect failed');
          }
        }
      })
    );
  }

  await prisma.wsConnection.deleteMany({ where: { memberId } }).catch(() => {});
}

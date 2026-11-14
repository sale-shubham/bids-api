import { prisma } from '@/core/prisma/client';
import { env } from '@/core/config/env';
import { logger } from '@/core/logger/logger';
import { closeConnection, isGone, isLocalServerActive, postToConnection } from './ws.transport';

// ----------------------------------------------------------------------------
// WEBSOCKET — real-time push layered on the REST API, NOT a second write path.
// Bids etc. always go through REST; this module only pushes "what just
// happened" frames to open sockets (a member's own, or an auction room).
// index.js routes CONNECT/DISCONNECT/MESSAGE here (Lambda) or via the local
// dev server adapter (ws.local.ts). See readme/flows/websocket.md.
// ----------------------------------------------------------------------------

/** Minimal API Gateway WebSocket Lambda proxy event (only the fields read here). */
export interface WsEvent {
  requestContext: {
    connectionId: string;
    eventType?: 'CONNECT' | 'DISCONNECT' | 'MESSAGE';
  };
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
}

/** Frame sent to clients: a `type` plus event-specific fields. */
export interface WsPayload {
  type: string;
  [k: string]: unknown;
}

// A ticket is good this long after issue; minted fresh for every connection.
export const WS_TICKET_TTL_MS = 60_000;
const MAX_MESSAGE_BYTES = 2048;
const BAD_MESSAGE = { type: 'error', code: 'BAD_MESSAGE' } as const;

/** URL the client should open, or null ("no live endpoint" -> client polls). */
export function getWsUrl(): string | null {
  if (env.ws.apiEndpoint) return env.ws.apiEndpoint.replace(/^https:\/\//, 'wss://');
  if (isLocalServerActive()) return env.ws.publicUrl || `ws://localhost:${env.port}/ws`;
  return null;
}

/** Single-use ticket. `memberId` null = guest (public auction rooms only). */
export async function issueTicket(memberId: string | null) {
  const ticket = await prisma.wsTicket.create({
    data: { memberId, expiresAt: new Date(Date.now() + WS_TICKET_TTL_MS) },
  });
  return { ticket: ticket.id, expiresAt: ticket.expiresAt, wsUrl: getWsUrl() };
}

// $connect — API Gateway aborts the handshake on any non-2xx statusCode.
// The ticket is consumed atomically (updateMany guarded on usedAt/expiresAt)
// so two racing connects can never both win.
export async function handleConnect(event: WsEvent) {
  const ticketId = event.queryStringParameters?.ticket;
  if (!ticketId) return { statusCode: 401, body: 'Missing ticket' };

  const ticket = await prisma.wsTicket.findUnique({ where: { id: ticketId } });
  if (!ticket || ticket.usedAt || ticket.expiresAt.getTime() < Date.now()) {
    return { statusCode: 401, body: 'Invalid or expired ticket' };
  }

  const consumed = await prisma.wsTicket.updateMany({
    where: { id: ticketId, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (consumed.count !== 1) return { statusCode: 401, body: 'Invalid or expired ticket' };

  await prisma.wsConnection.create({
    data: { id: event.requestContext.connectionId, memberId: ticket.memberId },
  });
  return { statusCode: 200 };
}

export async function handleDisconnect(event: WsEvent) {
  await prisma.wsConnection.deleteMany({ where: { id: event.requestContext.connectionId } });
  return { statusCode: 200 };
}

export type ParsedMessage =
  | { action: 'subscribe'; auctionId: string }
  | { action: 'unsubscribe' }
  | { action: 'ping' };

/** Pure parser for client frames; null = BAD_MESSAGE. */
export function parseClientMessage(body: string | null | undefined): ParsedMessage | null {
  if (typeof body !== 'string' || body.length === 0 || Buffer.byteLength(body) > MAX_MESSAGE_BYTES) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const m = msg as { action?: unknown; auctionId?: unknown };
  if (m.action === 'ping') return { action: 'ping' };
  if (m.action === 'unsubscribe') return { action: 'unsubscribe' };
  if (m.action === 'subscribe' && typeof m.auctionId === 'string' && m.auctionId.length > 0 && m.auctionId.length <= 64) {
    return { action: 'subscribe', auctionId: m.auctionId };
  }
  return null;
}

async function reply(connectionId: string, payload: WsPayload) {
  try {
    await postToConnection(connectionId, payload);
  } catch (err) {
    if (isGone(err)) await prisma.wsConnection.deleteMany({ where: { id: connectionId } }).catch(() => {});
    else logger.warn({ err, connectionId }, 'ws: reply failed');
  }
}

// $default — client actions: subscribe / unsubscribe / ping. Always 200 (an
// error is a frame, not an HTTP failure).
export async function handleDefault(event: WsEvent) {
  const connectionId = event.requestContext.connectionId;
  try {
    const msg = parseClientMessage(event.body);
    if (!msg) {
      await reply(connectionId, BAD_MESSAGE);
    } else if (msg.action === 'ping') {
      await reply(connectionId, { type: 'pong' });
    } else if (msg.action === 'unsubscribe') {
      await prisma.wsConnection.updateMany({ where: { id: connectionId }, data: { auctionId: null } });
    } else {
      const auction = await prisma.auction.findFirst({ where: { id: msg.auctionId, deletedAt: null }, select: { id: true } });
      if (!auction) {
        await reply(connectionId, BAD_MESSAGE);
      } else {
        await prisma.wsConnection.updateMany({ where: { id: connectionId }, data: { auctionId: auction.id } });
      }
    }
  } catch (err) {
    logger.error({ err, connectionId }, 'ws: default handler failed');
  }
  return { statusCode: 200 };
}

// Fan a frame out to connections; dead ones (410 / closed socket) lose their row.
async function fanOut(connections: { id: string }[], payload: WsPayload) {
  if (connections.length === 0) return;
  const results = await Promise.allSettled(connections.map((c) => postToConnection(c.id, payload)));
  const goneIds: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') return;
    if (isGone(r.reason)) goneIds.push(connections[i].id);
    else logger.error({ err: r.reason, connectionId: connections[i].id }, 'ws: push failed');
  });
  if (goneIds.length) await prisma.wsConnection.deleteMany({ where: { id: { in: goneIds } } }).catch(() => {});
}

/** Best-effort push to every open socket of a member. Never throws. */
export async function pushToMember(memberId: string, payload: WsPayload) {
  try {
    const connections = await prisma.wsConnection.findMany({ where: { memberId }, select: { id: true } });
    await fanOut(connections, payload);
  } catch (err) {
    logger.error({ err, memberId }, 'ws: pushToMember failed');
  }
}

/** Best-effort push to every connection subscribed to an auction. Never throws. */
export async function pushToAuctionRoom(auctionId: string, payload: WsPayload) {
  try {
    const connections = await prisma.wsConnection.findMany({ where: { auctionId }, select: { id: true } });
    await fanOut(connections, payload);
  } catch (err) {
    logger.error({ err, auctionId }, 'ws: pushToAuctionRoom failed');
  }
}

// Force-closes every socket a member has (session-cap eviction). Rows are
// deleted regardless; never throws.
export async function disconnectMemberConnections(memberId: string) {
  const connections = await prisma.wsConnection.findMany({ where: { memberId }, select: { id: true } });
  if (connections.length === 0) return;
  await Promise.allSettled(
    connections.map((c) =>
      closeConnection(c.id).catch((err) => logger.error({ err, memberId, connectionId: c.id }, 'ws: force-disconnect failed')),
    ),
  );
  await prisma.wsConnection.deleteMany({ where: { memberId } }).catch(() => {});
}

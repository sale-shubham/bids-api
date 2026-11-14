import { env } from '@/core/config/env';

// ----------------------------------------------------------------------------
// WebSocket transport — the ONLY place that knows how a frame reaches a
// connection. Two drivers:
//   - lambda: API Gateway Management API (`env.ws.apiEndpoint` set).
//   - local:  in-memory socket map filled by the dev WebSocket server in
//             index.js (ws.local.ts). Used whenever no apiEndpoint is set.
// Everything else (pushToMember, room broadcast, pong replies) goes through
// postToConnection, and treats `isGone(err)` as "delete the WsConnection row".
// ----------------------------------------------------------------------------

/** Minimal socket surface the local driver needs (satisfied by `ws`'s WebSocket). */
export interface LocalSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
}

const OPEN = 1;
const localSockets = new Map<string, LocalSocket>();
let localServerActive = false;

export class GoneError extends Error {
  readonly gone = true;
  constructor(connectionId: string) {
    super(`connection ${connectionId} is gone`);
    this.name = 'GoneError';
  }
}

export function registerLocalSocket(connectionId: string, socket: LocalSocket) {
  localSockets.set(connectionId, socket);
}
export function unregisterLocalSocket(connectionId: string) {
  localSockets.delete(connectionId);
}
export function setLocalServerActive(active: boolean) {
  localServerActive = active;
}
export function isLocalServerActive() {
  return localServerActive;
}

/** True when the error means the connection no longer exists (410 / GoneException / closed local socket). */
export function isGone(err: unknown): boolean {
  const e = err as { gone?: boolean; name?: string; $metadata?: { httpStatusCode?: number }; statusCode?: number } | null;
  return !!e && (e.gone === true || e.name === 'GoneException' || e.$metadata?.httpStatusCode === 410 || e.statusCode === 410);
}

async function lambdaClient() {
  const sdk = await import('@aws-sdk/client-apigatewaymanagementapi');
  return { sdk, client: new sdk.ApiGatewayManagementApiClient({ endpoint: env.ws.apiEndpoint }) };
}

/** Send one JSON frame. Rejects with an error for which `isGone` is true when the connection is dead. */
export async function postToConnection(connectionId: string, payload: unknown): Promise<void> {
  const json = JSON.stringify(payload);
  if (env.ws.apiEndpoint) {
    const { sdk, client } = await lambdaClient();
    await client.send(new sdk.PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(json) }));
    return;
  }
  const socket = localSockets.get(connectionId);
  if (!socket || socket.readyState !== OPEN) {
    localSockets.delete(connectionId);
    throw new GoneError(connectionId);
  }
  socket.send(json);
}

/** Force-close a connection. Never throws for an already-gone connection. */
export async function closeConnection(connectionId: string): Promise<void> {
  if (env.ws.apiEndpoint) {
    const { sdk, client } = await lambdaClient();
    try {
      await client.send(new sdk.DeleteConnectionCommand({ ConnectionId: connectionId }));
    } catch (err) {
      if (!isGone(err)) throw err;
    }
    return;
  }
  const socket = localSockets.get(connectionId);
  localSockets.delete(connectionId);
  try {
    socket?.close();
  } catch {
    /* already closed */
  }
}

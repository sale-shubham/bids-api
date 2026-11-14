import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from '@/core/logger/logger';
import { registerLocalSocket, setLocalServerActive, unregisterLocalSocket } from './ws.transport';
import { handleConnect, handleDefault, handleDisconnect, type WsEvent } from './ws.service';

// ----------------------------------------------------------------------------
// LOCAL DEV WebSocket server (non-production only; attached from index.js).
// Each socket gets a generated connectionId and is routed through the SAME
// handleConnect / handleDefault / handleDisconnect as Lambda, via an adapter
// that builds the API-Gateway-shaped event. The local transport driver writes
// to the socket map populated here.
// ----------------------------------------------------------------------------

export const LOCAL_WS_PATH = '/ws';

/** Build the API-Gateway-shaped event the shared handlers expect. */
export function buildLocalEvent(
  eventType: 'CONNECT' | 'DISCONNECT' | 'MESSAGE',
  connectionId: string,
  extra: { query?: URLSearchParams; body?: string } = {},
): WsEvent {
  const queryStringParameters = extra.query ? Object.fromEntries(extra.query.entries()) : null;
  return {
    requestContext: { connectionId, eventType },
    queryStringParameters,
    body: extra.body ?? null,
  };
}

function reject(socket: Duplex, code: number, text: string) {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachLocalWsServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });
  setLocalServerActive(true);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== LOCAL_WS_PATH) {
      socket.destroy();
      return;
    }
    const connectionId = randomUUID();
    handleConnect(buildLocalEvent('CONNECT', connectionId, { query: url.searchParams }))
      .then((res) => {
        if (res.statusCode !== 200) return reject(socket, res.statusCode, 'Unauthorized');
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          registerLocalSocket(connectionId, ws);
          ws.on('message', (data) => {
            handleDefault(buildLocalEvent('MESSAGE', connectionId, { body: data.toString() })).catch((err) =>
              logger.error({ err }, 'ws.local: message failed'),
            );
          });
          ws.on('close', () => {
            unregisterLocalSocket(connectionId);
            handleDisconnect(buildLocalEvent('DISCONNECT', connectionId)).catch((err) =>
              logger.error({ err }, 'ws.local: disconnect failed'),
            );
          });
          ws.on('error', (err) => logger.warn({ err }, 'ws.local: socket error'));
        });
      })
      .catch((err) => {
        logger.error({ err }, 'ws.local: connect failed');
        reject(socket, 500, 'Internal Server Error');
      });
  });

  logger.info(`Local WebSocket server on path ${LOCAL_WS_PATH}`);
  return wss;
}

# WebSocket live updates

Real-time push layered on the REST API. It is **not** a write path: bids, etc. always go through REST; the socket only tells clients what just happened. If no live endpoint exists (`wsUrl: null`) or the socket drops, clients fall back to polling.

Code: `src/modules/ws/` (`ws.service.ts`, `ws.transport.ts`, `ws.local.ts`), `src/modules/auctions/auction-events.ts`, `index.js`.

## Tickets

- `POST /ws/ticket` (auth) and `POST /ws/guest-ticket` (public, 30/min per IP) return `data: { ticket, wsUrl, expiresAt }`. Guest tickets have `memberId = null`.
- Single use, 60 s TTL. Consumed atomically on connect (`updateMany` guarded on `usedAt: null`, `expiresAt > now`).
- Connect to `<wsUrl>?ticket=<ticket>`. A missing/invalid/expired/used ticket is rejected with 401 (API Gateway aborts the handshake; the local server answers HTTP 401).
- `wsUrl`: `wss://` form of `WS_API_ENDPOINT` on Lambda; locally `WS_PUBLIC_URL` or `ws://localhost:<PORT>/ws`; otherwise `null`.

## Client -> server (`$default`)

| Frame | Effect |
|---|---|
| `{"action":"subscribe","auctionId"}` | sets this connection's `auctionId` (one room per connection); auction must exist, else `BAD_MESSAGE` |
| `{"action":"unsubscribe"}` | clears `auctionId` |
| `{"action":"ping"}` | replies `{"type":"pong"}` |
| anything else / invalid JSON / >2 KB | `{"type":"error","code":"BAD_MESSAGE"}` |

## Server -> client

Room (connections whose `auctionId` matches):
- `{ type:'bid.placed', auctionId, currentBidPaise, bidCount, endTime, highestBidderId, reserveMet, bid:{ id, amountPaise, kind, createdAt, bidderLabel } }`. **One event per inserted `Bid` row, in order**: a single bid request can yield two events (proxy bidding), each carrying the auction state after that row (`currentBidPaise` = that row's amount, `highestBidderId` = that row's bidder, running `bidCount`; `endTime` is the final end including anti-sniping). `bid.kind` is `MANUAL` / `AUTO` / `BUY_NOW`; `reserveMet` is the boolean for that state (true when there is no reserve; the reserve amount is never sent). Buy It Now sends `bid.placed` (`kind: 'BUY_NOW'`) then `auction.ended`.
- `{ type:'auction.extended', auctionId, endTime }`
- `{ type:'auction.ended', auctionId, winnerId, finalBidPaise, bidCount, endedAt }`

Member-targeted (every connection of the member, any room):
- `{ type:'bid.outbid', auctionId, title, currentBidPaise }` to the member who lost the lead in the request (sent from the last row's event only, so intermediate proxy rows never trigger it; never to the requester)
- `{ type:'auction.won', auctionId, title, finalBidPaise }` to the winner
- `{ type:'notification.new', notificationId }` after `processNotification` inserts an in-app row

`publishAuctionEvent` (called by the bid and close flows) never throws; every leg is isolated and logged.

## Transport

`ws.transport.ts` is the only code that talks to a connection: `postToConnection(id, payload)`, `closeConnection(id)`, `isGone(err)`. Driver = Lambda (API Gateway Management API, when `WS_API_ENDPOINT` is set) or local (in-memory socket map). Fan-out uses `Promise.allSettled`; a gone connection (410 / `GoneException` / closed or unknown local socket) has its `WsConnection` row deleted.

## Local dev server

In the non-production branch of `index.js` (and only if `WS_API_ENDPOINT` is empty) `attachLocalWsServer` mounts a `ws` server on the same HTTP server at `/ws`. Each socket gets a random connectionId and is routed through the same `handleConnect` / `handleDefault` / `handleDisconnect` via `buildLocalEvent` (API-Gateway-shaped event). After a server restart, rows for dead sockets are cleaned lazily on the next push.

## Limits

API Gateway: 10 min idle timeout (clients ping every 4.5 min), 2 h max connection (clients reconnect with a fresh ticket). The daily retention purge deletes `WsConnection` rows older than 2 h and expired/old `WsTicket` rows.

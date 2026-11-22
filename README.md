# SyncScript

A real-time collaborative text editor: Yjs CRDT documents in the browser, synced through a custom Node.js WebSocket relay.

**Live demo:** https://syncscript-delta.vercel.app

## Features

- Multi-user editing of a shared document (CodeMirror 6 bound to a Yjs `Y.Text`)
- Live remote cursors and selections, plus a presence bar listing who is in the room
- Shareable rooms: a random 21-character room ID is generated and placed in the URL; the server rejects any other ID format
- Display names must be unique within a room (checked over HTTP before joining and again on the WebSocket)
- Offline editing after joining: the document is cached in IndexedDB, and a "Go Offline / Go Online" toggle lets you test it. Changes merge when the connection returns
- Optional PostgreSQL persistence of document updates, compacted into a snapshot once more than 50 updates pile up
- Optional Redis pub/sub that relays document and presence updates between server instances
- Line, word and character counts in the editor footer

## How it works

The React client creates a `Y.Doc` per room and attaches two providers: `y-indexeddb` for a local copy and `y-websocket`'s `WebsocketProvider` for the network. The server (`server/index.js`) is a custom relay built on `ws` and `y-protocols` rather than the stock y-websocket server. It keeps one in-memory `Y.Doc` and `Awareness` per room and runs the Yjs sync handshake with each new client. It also sends the new client the current presence state, then forwards document and awareness updates to the other clients in the room. When `DATABASE_URL` is set, it loads room state from Postgres and appends each edit. When `REDIS_URL` is set, it publishes updates on `syncscript:room:<id>` and `syncscript:awareness:<id>` channels and applies updates received from other instances. A ping/pong heartbeat drops dead connections, a disconnecting client's cursor is removed right away, and an empty room is evicted from memory after a grace period (10 minutes by default).

## Tech stack

| Part | Libraries |
|---|---|
| Client | React 19, Vite 8, CodeMirror 6, Yjs, y-codemirror.next, y-websocket, y-indexeddb, lucide-react, oxlint |
| Server | Node.js (ES modules), ws, yjs, y-protocols, lib0, pg, ioredis, dotenv |
| Storage | PostgreSQL (optional), Redis (optional), IndexedDB (browser) |

## Getting started

Requires Node.js 20.19+ or 22.12+ (Vite 8 needs one of these; ioredis needs 20+).

### 1. Server

```bash
cd server
npm install
npm start          # listens on http://localhost:1234 by default
```

The server runs without a database or Redis. It logs a warning and keeps documents in memory only. `GET /` returns a JSON health and status report.

Server environment variables (read from the environment or `server/.env`):

| Name | Required | Purpose |
|---|---|---|
| `PORT` | no | HTTP/WebSocket port (default `1234`) |
| `DATABASE_URL` | no | PostgreSQL connection string. The tables are created on startup, and the connection always uses SSL |
| `REDIS_URL` | no | Turns on cross-instance pub/sub |
| `CORS_ORIGIN` | no | `Access-Control-Allow-Origin` value (default `*`) |
| `ROOM_EVICTION_TIMEOUT_MS` | no | How long an empty room stays in memory (default `600000`) |
| `HEARTBEAT_INTERVAL_MS` | no | Ping interval (default `30000`) |

### 2. Client

```bash
cd client
npm install
npm run dev        # Vite dev server
```

Client environment variable:

| Name | Required | Purpose |
|---|---|---|
| `VITE_WS_URL` | no | Relay URL (default `ws://localhost:1234`). `http(s)://` is converted to `ws(s)://` |

You can also point a single tab at another server with a `?ws=` query parameter, e.g. `?ws=ws://localhost:1235`.

Other client scripts:

```bash
npm run lint       # oxlint
npm run build      # production build to client/dist
npm run preview    # serve the built files
```

## Project structure

```
client/   React + Vite front end (editor, join screen, presence, Vercel config)
server/   WebSocket relay, Postgres persistence and Redis pub/sub (single file: index.js)
```

## Deployment

- **Client:** deployed on Vercel. `client/vercel.json` rewrites every path to `index.html` so room URLs load the app. Set `VITE_WS_URL` to the public `wss://` address of the relay at build time.
- **Server:** a plain Node process started with `npm start`. This repository contains no deployment configuration for it.

## Screenshots

Add screenshots here

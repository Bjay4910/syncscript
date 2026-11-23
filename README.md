# SyncScript

A real-time collaborative text editor. Documents are Yjs CRDTs in the browser, synced through a custom Node.js WebSocket relay. Edits from several people merge without conflicts, including edits made while offline.

**Live demo:** https://syncscript-delta.vercel.app

> The relay for the live demo runs on Render's free tier, which sleeps when idle. If the first load is slow, the header shows "Waking up the server" for up to about a minute instead of an error.

## Try it

1. Open the live demo, enter a display name and click **Join Document**. A new room ID is generated and placed in the URL.
2. Use **Copy Room Link** in the header, open that URL in a second tab or on another device, and join with a different name.
3. Type in both. Cursors, selections and the presence bar update live.
4. Click **Go Offline**, edit in both tabs, then click **Go Online**. The two documents merge with no conflicts.

## Features

- Multi-user editing of a shared document (CodeMirror 6 bound to a Yjs `Y.Text`)
- Live remote cursors and selections, plus a presence bar listing who is in the room
- Shareable rooms: a random 21-character room ID is generated and placed in the URL, and the server rejects any other ID format
- Display names must be unique within a room (checked over HTTP before joining and again on the WebSocket)
- Offline editing after joining: the document is cached in IndexedDB, and changes merge when the connection returns
- Cold-start handling: if the first connection takes longer than 3.5 seconds (configurable), the header switches from "Connecting" to "Waking up the server" so a sleeping free-tier server doesn't look like a failure
- Optional PostgreSQL persistence of document updates, compacted into a snapshot once more than 50 updates pile up
- Optional Redis pub/sub that relays document and presence updates between server instances
- Heartbeat that drops dead connections, and room eviction from memory after a grace period
- Line, word and character counts in the editor footer

## Architecture

```
 Browser A                      Browser B
 CodeMirror 6                   CodeMirror 6
 Yjs Y.Doc + IndexedDB          Yjs Y.Doc + IndexedDB
        \                         /
         \  WebSocket (sync + presence)
          v                      v
        Node.js relay (ws + y-protocols)
        one in-memory Y.Doc + Awareness per room
              |                     |
              | optional            | optional
              v                     v
         PostgreSQL         Redis pub/sub --> other relay instances
```

### How it works

- **The relay never interprets edits.** It forwards opaque Yjs updates between clients in the same room. Merge correctness comes from the CRDT on each client, so the server stays small. (An operational-transform server has to transform concurrent operations itself.)
- **Join handshake.** When a client connects, the relay sends its Yjs state vector. The client replies with only the updates the relay is missing, and the relay does the same in the other direction. Reconnecting after being offline therefore sends the missing changes, not the whole document.
- **Presence.** Cursor and name state uses the Yjs awareness protocol. It is never persisted. When a client disconnects, its cursor is removed right away.
- **Persistence (optional).** With `DATABASE_URL` set, the relay loads a room's state from PostgreSQL and appends each update, compacting into a snapshot after 50 updates.
- **Scaling out (optional).** With `REDIS_URL` set, each instance publishes updates on `syncscript:room:<id>` and `syncscript:awareness:<id>` and applies updates published by other instances, so clients connected to different instances see the same room.

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

The server runs without a database or Redis. It logs a warning and keeps documents in memory only.

| Name | Required | Purpose |
|---|---|---|
| `PORT` | no | HTTP/WebSocket port (default `1234`) |
| `DATABASE_URL` | no | PostgreSQL connection string. Tables are created on startup, and the connection always uses SSL |
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

| Name | Required | Purpose |
|---|---|---|
| `VITE_WS_URL` | no | Relay URL (default `ws://localhost:1234`). `http(s)://` is converted to `ws(s)://` |
| `VITE_COLD_START_DELAY_MS` | no | Milliseconds before the first connection attempt is shown as "waking up" (default `3500`) |

You can also point a single tab at another server with a `?ws=` query parameter, for example `?ws=ws://localhost:1235`.

```bash
npm run lint       # oxlint
npm run build      # production build to client/dist
npm run preview    # serve the built files
```

## Deployment

- **Client:** Vercel. `client/vercel.json` rewrites every path to `index.html` so room URLs load the app. Set `VITE_WS_URL` to the public `wss://` address of the relay at build time.
- **Server:** a plain Node process started with `npm start` (the live demo uses a Render web service on the free tier). Set `CORS_ORIGIN` to the client's origin. This repository contains no deployment configuration for it.
- **Free-tier cold starts:** Render's free instances sleep after about 15 minutes without traffic, and waking one takes roughly 30-50 seconds. An external uptime monitor that requests the server's URL every few minutes keeps it awake.

## Testing status

Tested manually with 7+ concurrent clients editing one room. There is no automated test suite yet, and no formal load or latency benchmarking.

## Known limitations

- No authentication. The room ID is the only access control.
- Plain-text editing only: there is no syntax highlighting or language mode.
- The relay is a single file (`server/index.js`) and has no rate limiting or message-size limits.
- Offline editing works after a room has been joined. A first visit still needs the server for the join check.

## Project structure

```
client/   React + Vite front end (editor, join screen, presence, Vercel config)
server/   WebSocket relay, Postgres persistence and Redis pub/sub (single file: index.js)
```

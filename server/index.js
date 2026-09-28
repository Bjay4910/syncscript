import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const PORT = parseInt(process.env.PORT || '1234', 10);

// Protocol message types matching y-protocols / y-websocket specifications
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;

/**
 * Safely send a binary message to a WebSocket client.
 * @param {WebSocket} conn
 * @param {Uint8Array} message
 */
function send(conn, message) {
  if (conn.readyState !== WebSocket.OPEN) return;
  try {
    conn.send(message, (err) => {
      if (err) {
        console.error('[Send Error]:', err.message);
      }
    });
  } catch (err) {
    console.error('[Send Exception]:', err.message);
  }
}

/**
 * Represents an in-memory collaborative document room.
 */
class Room {
  /**
   * @param {string} name
   */
  constructor(name) {
    this.name = name;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    // The server is a pure relay; it holds no local cursor/user state
    this.awareness.setLocalState(null);
    /** @type {Set<WebSocket>} */
    this.clients = new Set();

    // Relay document updates to all other clients in this room
    this.doc.on('update', (update, origin) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      for (const client of this.clients) {
        if (client !== origin && client.readyState === WebSocket.OPEN) {
          send(client, message);
        }
      }
    });

    // Relay awareness updates (presence, cursors, user info) to peers
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changedClients = added.concat(updated).concat(removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      );
      const message = encoding.toUint8Array(encoder);

      for (const client of this.clients) {
        if (client !== origin && client.readyState === WebSocket.OPEN) {
          send(client, message);
        }
      }
    });
  }
}

// In-memory room store (one Y.Doc and one Awareness instance per room)
const rooms = new Map();

/**
 * Retrieve or create a room by name.
 * @param {string} roomName
 * @returns {Room}
 */
function getOrCreateRoom(roomName) {
  let room = rooms.get(roomName);
  if (!room) {
    room = new Room(roomName);
    rooms.set(roomName, room);
  }
  return room;
}

// Create HTTP server for health checks and WebSocket upgrading
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      service: 'syncscript-server',
      status: 'healthy',
      activeRooms: rooms.size,
      rooms: Array.from(rooms.keys()),
    })
  );
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // Extract room name from the URL path: e.g. ws://localhost:1234/<roomId>
  const parsedUrl = new URL(req.url || '/', 'http://localhost');
  const pathSegment = parsedUrl.pathname.replace(/^\/+|\/+$/g, '');
  const roomName = decodeURIComponent(pathSegment) || 'default-room';

  const room = getOrCreateRoom(roomName);
  room.clients.add(ws);

  // Track client IDs published through this WebSocket connection for awareness cleanup
  const controlledUserIds = new Set();

  console.log(`[Connect] Room: "${roomName}" | Active clients: ${room.clients.size}`);

  // 1. Send initial SyncStep1 from server to initiate sync handshake
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(ws, encoding.toUint8Array(encoder));
  }

  // 2. Send current awareness states so the new client immediately sees existing users & cursors
  const currentAwarenessStates = room.awareness.getStates();
  if (currentAwarenessStates.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        room.awareness,
        Array.from(currentAwarenessStates.keys())
      )
    );
    send(ws, encoding.toUint8Array(encoder));
  }

  // Handle incoming binary messages from the client
  ws.on('message', (data) => {
    try {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const decoder = decoding.createDecoder(uint8Array);
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case MESSAGE_SYNC: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
          if (encoding.length(encoder) > 1) {
            send(ws, encoding.toUint8Array(encoder));
          }
          break;
        }

        case MESSAGE_AWARENESS: {
          const update = decoding.readVarUint8Array(decoder);

          // Track client IDs in this update so we can immediately clean them up upon disconnect
          try {
            const updateDecoder = decoding.createDecoder(update);
            const len = decoding.readVarUint(updateDecoder);
            for (let i = 0; i < len; i++) {
              const clientID = decoding.readVarUint(updateDecoder);
              decoding.readVarUint(updateDecoder); // clock
              decoding.readVarString(updateDecoder); // JSON state string
              controlledUserIds.add(clientID);
            }
          } catch (decodeErr) {
            console.warn('[Awareness Decode Warning]:', decodeErr.message);
          }

          awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
          break;
        }

        case MESSAGE_QUERY_AWARENESS: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(
              room.awareness,
              Array.from(room.awareness.getStates().keys())
            )
          );
          send(ws, encoding.toUint8Array(encoder));
          break;
        }

        case MESSAGE_AUTH: {
          // Authentication is deliberately omitted per specification for this stage
          break;
        }

        default:
          console.warn(`[Warning] Unknown message type received: ${messageType}`);
          break;
      }
    } catch (err) {
      console.error(`[Error] Handling message in room "${roomName}":`, err);
    }
  });

  // Handle client disconnection
  ws.on('close', () => {
    room.clients.delete(ws);

    // Immediately remove this client's awareness state so remote cursors disappear for remaining users
    if (controlledUserIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(
        room.awareness,
        Array.from(controlledUserIds),
        null
      );
    }

    console.log(`[Disconnect] Room: "${roomName}" | Active clients: ${room.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error(`[Socket Error] Room: "${roomName}":`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 SyncScript WebSocket Server listening on http://localhost:${PORT} (ws://localhost:${PORT}/<roomId>)`);
});

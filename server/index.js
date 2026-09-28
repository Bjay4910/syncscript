import 'dotenv/config';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import pg from 'pg';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const { Pool } = pg;
const PORT = parseInt(process.env.PORT || '1234', 10);

// Protocol message types matching y-protocols / y-websocket specifications
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;

/**
 * PostgreSQL connection pool and state.
 */
let pool = null;
let dbConnected = false;

/**
 * Initialize PostgreSQL connection, handle errors gracefully,
 * and ensure schema tables and indexes exist.
 */
async function setupDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn('⚠️  [Persistence Warning] DATABASE_URL is not set in environment. Running in in-memory mode with degraded persistence.');
    return;
  }

  try {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
    });

    pool.on('error', (err) => {
      console.error('[Postgres Pool Error]:', err.message);
    });

    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS document_updates (
          id BIGSERIAL PRIMARY KEY,
          doc_id TEXT NOT NULL,
          update BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_document_updates_doc_id
          ON document_updates(doc_id, id);

        CREATE TABLE IF NOT EXISTS document_snapshots (
          doc_id TEXT PRIMARY KEY,
          state BYTEA NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      dbConnected = true;
      console.log('📦 [Postgres Persistence] Connected to Supabase Postgres and verified schema.');
    } finally {
      client.release();
    }
  } catch (err) {
    dbConnected = false;
    console.error('❌ [Postgres Connection Error] Could not connect to Postgres on startup:', err.message);
    console.warn('⚠️  [Persistence Degraded] Document editing will work in-memory, but changes will not be saved.');
  }
}

/**
 * Compact document updates into a snapshot when uncompacted count exceeds 50.
 * @param {Room} room
 * @param {string|number} highestId
 */
async function compactRoom(room, highestId) {
  if (!pool || !dbConnected) return;

  const snapshotState = Y.encodeStateAsUpdate(room.doc);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO document_snapshots (doc_id, state, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (doc_id)
       DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [room.name, Buffer.from(snapshotState)]
    );

    const deleteRes = await client.query(
      `DELETE FROM document_updates WHERE doc_id = $1 AND id <= $2`,
      [room.name, highestId]
    );

    await client.query('COMMIT');
    console.log(`[Compaction] doc_id: "${room.name}", compacted ${deleteRes.rowCount} rows`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Enqueue update persistence and compaction check for a room.
 * @param {Room} room
 * @param {Uint8Array} update
 */
function persistUpdate(room, update) {
  if (!pool || !dbConnected) return;

  room.persistQueue = room.persistQueue
    .then(async () => {
      // 1. Insert update into document_updates
      await pool.query(
        'INSERT INTO document_updates (doc_id, update) VALUES ($1, $2)',
        [room.name, Buffer.from(update)]
      );

      // 2. Check count of uncompacted rows for this doc_id
      const countRes = await pool.query(
        'SELECT count(*)::int AS count, max(id)::bigint AS max_id FROM document_updates WHERE doc_id = $1',
        [room.name]
      );

      const count = countRes.rows[0]?.count || 0;
      const maxId = countRes.rows[0]?.max_id;

      // 3. Compact if count exceeds 50
      if (count > 50 && maxId != null) {
        await compactRoom(room, maxId);
      }
    })
    .catch((err) => {
      console.error(`[Persistence Error] Failed to persist update for room "${room.name}":`, err.message);
    });
}

/**
 * Load snapshot and uncompacted updates from Postgres into a room's Y.Doc.
 * @param {Room} room
 */
async function loadRoomFromDb(room) {
  if (!pool || !dbConnected) return;

  try {
    // 1. Load snapshot if one exists
    const snapshotRes = await pool.query(
      'SELECT state FROM document_snapshots WHERE doc_id = $1',
      [room.name]
    );

    if (snapshotRes.rows.length > 0 && snapshotRes.rows[0].state) {
      const stateBuf = snapshotRes.rows[0].state;
      Y.applyUpdate(room.doc, new Uint8Array(stateBuf), 'persistence');
    }

    // 2. Load uncompacted updates in order
    const updatesRes = await pool.query(
      'SELECT update FROM document_updates WHERE doc_id = $1 ORDER BY id ASC',
      [room.name]
    );

    for (const row of updatesRes.rows) {
      if (row.update) {
        Y.applyUpdate(room.doc, new Uint8Array(row.update), 'persistence');
      }
    }
  } catch (err) {
    console.error(`[Persistence Error] Failed to load document for room "${room.name}":`, err.message);
    console.warn(`[Persistence Warning] Starting room "${room.name}" with in-memory state.`);
  }
}

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
    this.persistQueue = Promise.resolve();
    this.initPromise = null;

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

      // Persist update to Postgres if not loaded from persistence
      if (origin !== 'persistence') {
        persistUpdate(this, update);
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
 * Retrieve or create a room by name, ensuring DB state is loaded on initial creation.
 * @param {string} roomName
 * @returns {Promise<Room>}
 */
async function getOrCreateRoom(roomName) {
  let room = rooms.get(roomName);
  if (!room) {
    room = new Room(roomName);
    rooms.set(roomName, room);
    room.initPromise = loadRoomFromDb(room);
  }
  if (room.initPromise) {
    await room.initPromise;
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
      persistence: dbConnected ? 'connected' : 'degraded',
      activeRooms: rooms.size,
      rooms: Array.from(rooms.keys()),
    })
  );
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  // Extract room name from the URL path: e.g. ws://localhost:1234/<roomId>
  const parsedUrl = new URL(req.url || '/', 'http://localhost');
  const pathSegment = parsedUrl.pathname.replace(/^\/+|\/+$/g, '');
  const roomName = decodeURIComponent(pathSegment) || 'default-room';

  // Buffer messages arriving before room is initialized
  const earlyMessages = [];
  let isReady = false;
  const onEarlyMessage = (data) => {
    if (!isReady) {
      earlyMessages.push(data);
    }
  };
  ws.on('message', onEarlyMessage);

  let room;
  try {
    room = await getOrCreateRoom(roomName);
  } catch (err) {
    console.error(`[Error] Failed to initialize room "${roomName}":`, err);
    ws.close(1011, 'Internal server error');
    return;
  }

  // If client closed while waiting for DB load
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

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

  // Stop buffering early messages
  ws.off('message', onEarlyMessage);
  isReady = true;

  // Handle incoming binary messages from the client
  const handleMessage = (data) => {
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
  };

  ws.on('message', handleMessage);

  // Replay any buffered messages that arrived while room was initializing
  for (const earlyData of earlyMessages) {
    handleMessage(earlyData);
  }

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

// Initialize database tables, then start listening
await setupDatabase();

server.listen(PORT, () => {
  console.log(`🚀 SyncScript WebSocket Server listening on http://localhost:${PORT} (ws://localhost:${PORT}/<roomId>)`);
});

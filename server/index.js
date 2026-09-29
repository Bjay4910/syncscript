import 'dotenv/config';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import pg from 'pg';
import Redis from 'ioredis';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const { Pool } = pg;
const PORT = parseInt(process.env.PORT || '1234', 10);
const EVICTION_TIMEOUT_MS = parseInt(
  process.env.ROOM_EVICTION_TIMEOUT_MS || `${10 * 60 * 1000}`,
  10
);
const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.HEARTBEAT_INTERVAL_MS || '30000',
  10
);

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
 * Dedicated Redis pub/sub connections and state.
 * Hard Redis requirement: a single connection cannot both publish and subscribe.
 */
let redisPub = null;
let redisSub = null;
let redisConnected = false;

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
 * Initialize separate Redis publisher and subscriber connections.
 */
function setupRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('⚠️  [Redis Warning] REDIS_URL is not set in environment. Cross-instance pub/sub is disabled.');
    return;
  }

  try {
    redisPub = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      },
    });

    redisSub = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      },
    });

    redisPub.on('error', (err) => {
      console.error('[Redis Pub Error]:', err.message);
    });

    redisSub.on('error', (err) => {
      console.error('[Redis Sub Error]:', err.message);
    });

    redisPub.on('connect', () => {
      console.log('📡 [Redis Pub] Connected to Redis publisher.');
    });

    redisSub.on('connect', () => {
      console.log('📡 [Redis Sub] Connected to Redis subscriber.');
      redisConnected = true;

      // Resubscribe all active rooms when subscriber connects or reconnects
      for (const roomName of rooms.keys()) {
        subscribeRoomToRedis(roomName);
      }
    });

    // Handle incoming binary messages from Redis pub/sub
    redisSub.on('messageBuffer', (channelBuf, messageBuf) => {
      const channel = channelBuf.toString();
      const roomPrefix = 'syncscript:room:';
      const awarenessPrefix = 'syncscript:awareness:';

      if (channel.startsWith(roomPrefix)) {
        const roomName = channel.slice(roomPrefix.length);
        const room = rooms.get(roomName);
        if (!room) return;

        console.log(`[Redis Sub] Room: "${roomName}" | Type: sync`);
        const update = new Uint8Array(messageBuf.buffer, messageBuf.byteOffset, messageBuf.byteLength);
        // Apply with origin 'redis' so it triggers local client broadcast but skips republishing to Redis
        Y.applyUpdate(room.doc, update, 'redis');
      } else if (channel.startsWith(awarenessPrefix)) {
        const roomName = channel.slice(awarenessPrefix.length);
        const room = rooms.get(roomName);
        if (!room) return;

        console.log(`[Redis Sub] Room: "${roomName}" | Type: awareness`);
        const update = new Uint8Array(messageBuf.buffer, messageBuf.byteOffset, messageBuf.byteLength);
        // Apply with origin 'redis' so it triggers local client broadcast but skips republishing to Redis
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, 'redis');
      }
    });
  } catch (err) {
    console.error('❌ [Redis Error] Failed to initialize Redis:', err.message);
  }
}

/**
 * Subscribe Redis subscriber to a room's document and awareness channels.
 * @param {string} roomName
 */
function subscribeRoomToRedis(roomName) {
  if (!redisSub) return;
  const docChannel = `syncscript:room:${roomName}`;
  const awarenessChannel = `syncscript:awareness:${roomName}`;
  redisSub.subscribe(docChannel, awarenessChannel, (err) => {
    if (err) {
      console.error(`[Redis Subscribe Error] Room "${roomName}":`, err.message);
    }
  });
}

/**
 * Unsubscribe Redis subscriber from a room's document and awareness channels.
 * @param {string} roomName
 */
function unsubscribeRoomFromRedis(roomName) {
  if (!redisSub) return;
  const docChannel = `syncscript:room:${roomName}`;
  const awarenessChannel = `syncscript:awareness:${roomName}`;
  redisSub.unsubscribe(docChannel, awarenessChannel, (err) => {
    if (err) {
      console.error(`[Redis Unsubscribe Error] Room "${roomName}":`, err.message);
    } else {
      console.log(`📡 [Redis Sub] Unsubscribed from channels for room: "${roomName}"`);
    }
  });
}

/**
 * Publish raw Yjs update to room's Redis channel.
 * @param {string} roomName
 * @param {Uint8Array} update
 */
function publishSyncToRedis(roomName, update) {
  if (!redisPub) return;
  console.log(`[Redis Pub] Room: "${roomName}" | Type: sync`);
  redisPub.publish(`syncscript:room:${roomName}`, Buffer.from(update)).catch((err) => {
    console.error(`[Redis Publish Error] Room "${roomName}":`, err.message);
  });
}

/**
 * Publish raw awareness update to room's Redis channel.
 * @param {string} roomName
 * @param {Uint8Array} awarenessUpdate
 */
function publishAwarenessToRedis(roomName, awarenessUpdate) {
  if (!redisPub) return;
  console.log(`[Redis Pub] Room: "${roomName}" | Type: awareness`);
  redisPub.publish(`syncscript:awareness:${roomName}`, Buffer.from(awarenessUpdate)).catch((err) => {
    console.error(`[Redis Awareness Publish Error] Room "${roomName}":`, err.message);
  });
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
    this.evictionTimer = null;

    // Relay document updates to all other clients in this room and to Redis
    this.doc.on('update', (update, origin) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      // 1. Broadcast to local WebSocket clients (reusing existing local broadcast logic)
      for (const client of this.clients) {
        if (client !== origin && client.readyState === WebSocket.OPEN) {
          send(client, message);
        }
      }

      // 2. Persist update to Postgres if not loaded from persistence and not from Redis
      // (The origin instance where the client submitted the edit handles DB persistence)
      if (origin !== 'persistence' && origin !== 'redis') {
        persistUpdate(this, update);
      }

      // 3. Publish to Redis channel if update did not originate from Redis or DB persistence
      if (origin !== 'redis' && origin !== 'persistence') {
        publishSyncToRedis(this.name, update);
      }
    });

    // Relay awareness updates (presence, cursors, user info) to local peers and to Redis
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changedClients = added.concat(updated).concat(removed);
      if (changedClients.length === 0) return;

      const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessUpdate);
      const message = encoding.toUint8Array(encoder);

      // 1. Broadcast to local WebSocket clients
      for (const client of this.clients) {
        if (client !== origin && client.readyState === WebSocket.OPEN) {
          send(client, message);
        }
      }

      // 2. Publish awareness update to Redis if not originating from Redis
      if (origin !== 'redis') {
        publishAwarenessToRedis(this.name, awarenessUpdate);
      }
    });
  }
}

// In-memory room store (one Y.Doc and one Awareness instance per room)
const rooms = new Map();

/**
 * Schedules eviction for an empty room after the grace period.
 * If clients reconnect before the timer fires, eviction is cancelled.
 * @param {Room} room
 */
function scheduleRoomEviction(room) {
  cancelRoomEviction(room);

  console.log(`⏱️  [Eviction Scheduled] Room "${room.name}" empty. Eviction scheduled in ${EVICTION_TIMEOUT_MS}ms.`);

  room.evictionTimer = setTimeout(async () => {
    // Re-verify room still has zero active clients
    if (room.clients.size > 0) {
      console.log(`[Eviction Aborted] Room "${room.name}" re-acquired active clients before timer expired.`);
      room.evictionTimer = null;
      return;
    }

    try {
      // 1. Wait for any queued database operations to settle
      await room.persistQueue;

      // 2. Remove room from in-memory Map
      rooms.delete(room.name);

      // 3. Unsubscribe shared Redis subscriber from channels
      unsubscribeRoomFromRedis(room.name);

      // 4. Destroy in-memory Awareness and Y.Doc to free memory
      room.awareness.destroy();
      room.doc.destroy();

      room.evictionTimer = null;
      console.log(`🧹 [Eviction] Room "${room.name}" evicted from memory. (Active rooms: ${rooms.size})`);
    } catch (err) {
      console.error(`[Eviction Error] Failed during eviction of room "${room.name}":`, err.message);
    }
  }, EVICTION_TIMEOUT_MS);

  // Unref timer so it doesn't keep Node process alive if otherwise idle
  if (room.evictionTimer && typeof room.evictionTimer.unref === 'function') {
    room.evictionTimer.unref();
  }
}

/**
 * Cancels any pending eviction timer for a room (e.g. when a client connects).
 * @param {Room} room
 */
function cancelRoomEviction(room) {
  if (room.evictionTimer) {
    clearTimeout(room.evictionTimer);
    room.evictionTimer = null;
    console.log(`[Eviction Cancelled] Room "${room.name}" has active client. Eviction timer cancelled.`);
  }
}

/**
 * Clears all pending eviction timers across all rooms on process shutdown.
 */
function clearAllEvictionTimers() {
  for (const room of rooms.values()) {
    if (room.evictionTimer) {
      clearTimeout(room.evictionTimer);
      room.evictionTimer = null;
    }
  }
}

/**
 * Strict regex matching 21-character URL-safe room IDs (nanoid specification):
 * Exactly 21 characters from the alphabet: 0-9, A-Z, a-z, _, -
 */
const ROOM_ID_REGEX = /^[0-9A-Za-z_-]{21}$/;

/**
 * Validates whether a room ID matches the exact shape generateRandomRoomId() produces.
 * @param {string} roomId
 * @returns {boolean}
 */
function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_REGEX.test(roomId);
}

/**
 * Retrieve or create a room by name, ensuring DB state is loaded and Redis subscribed.
 * If room already existed in memory with a pending eviction timer, cancels the timer.
 * @param {string} roomName
 * @returns {Promise<Room>}
 */
async function getOrCreateRoom(roomName) {
  if (!isValidRoomId(roomName)) {
    throw new Error(`Invalid room ID: "${roomName}"`);
  }

  let room = rooms.get(roomName);
  if (!room) {
    room = new Room(roomName);
    rooms.set(roomName, room);
    room.initPromise = loadRoomFromDb(room);
    subscribeRoomToRedis(roomName);
  } else {
    // Room exists: cancel pending eviction timer since a client is accessing it
    cancelRoomEviction(room);
  }
  if (room.initPromise) {
    await room.initPromise;
  }
  return room;
}

/**
 * Checks whether a display name is already in use by another connected client in that same room.
 * Reuses the in-memory room.awareness tracking (no database table needed).
 * @param {string} roomName
 * @param {string} targetName
 * @returns {boolean}
 */
function isNameTakenInRoom(roomName, targetName) {
  if (!isValidRoomId(roomName)) return false;
  const room = rooms.get(roomName);
  if (!room) return false;

  const normalized = targetName.trim().toLowerCase();
  const states = room.awareness.getStates();

  for (const [, state] of states.entries()) {
    if (state && state.user && typeof state.user.name === 'string') {
      if (state.user.name.trim().toLowerCase() === normalized) {
        return true;
      }
    }
  }
  return false;
}

// Create HTTP server for health checks, name-uniqueness checks, and WebSocket upgrading
const server = http.createServer((req, res) => {
  // CORS headers so web client can query name availability (supports optional CORS_ORIGIN env var)
  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Pragma');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Live name-uniqueness check per room
  if (parsedUrl.pathname === '/check-name') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const roomName = parsedUrl.searchParams.get('room') || '';
    const name = parsedUrl.searchParams.get('name') || '';

    if (!roomName.trim() || !name.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Missing room or name parameter' }));
      return;
    }

    if (!isValidRoomId(roomName.trim())) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: 'Invalid room ID: must be a 21-character secure identifier',
        })
      );
      return;
    }

    const taken = isNameTakenInRoom(roomName.trim(), name.trim());
    if (taken) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          taken: true,
          error: 'That name is already in use in this room — please choose another',
        })
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, taken: false, available: true }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      service: 'syncscript-server',
      status: 'healthy',
      port: PORT,
      persistence: dbConnected ? 'connected' : 'degraded',
      redis: redisConnected ? 'connected' : 'disabled',
      activeRooms: rooms.size,
      rooms: Array.from(rooms.keys()),
      roomDetails: Array.from(rooms.entries()).map(([name, r]) => ({
        name,
        clients: r.clients.size,
        evictionPending: r.evictionTimer !== null,
      })),
    })
  );
});

const wss = new WebSocketServer({ server });

/**
 * Server-wide heartbeat interval:
 * Runs periodically to detect dead/unresponsive WebSocket connections.
 * For each connected client:
 * - If ws.isAlive === false (client did not respond to the last ping), terminates connection.
 * - Otherwise sets ws.isAlive = false and sends a ping (ws.ping()).
 * ws.terminate() forcibly closes the underlying socket and emits the 'close' event,
 * correctly triggering the existing cleanup logic (room.clients, awareness, room eviction timer).
 */
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[Heartbeat] Terminating unresponsive/dead WebSocket client');
      return ws.terminate();
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  });
}, HEARTBEAT_INTERVAL_MS);

// Allow Node process to exit cleanly if only heartbeat timer remains
if (typeof heartbeatInterval.unref === 'function') {
  heartbeatInterval.unref();
}

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

wss.on('connection', async (ws, req) => {
  // Standard WebSocket heartbeat: mark client alive on connection and upon each pong response
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  // Extract room name and optional display name from the URL path/query:
  // e.g. ws://localhost:1234/<roomId>?name=Alice
  const parsedUrl = new URL(req.url || '/', 'http://localhost');
  const pathSegment = parsedUrl.pathname.replace(/^\/+|\/+$/g, '');
  const roomName = decodeURIComponent(pathSegment);
  const requestedName = parsedUrl.searchParams.get('name');

  // Enforce strict format check on room name (must be a valid 21-character URL-safe ID)
  if (!isValidRoomId(roomName)) {
    console.warn(`[Reject] WebSocket connection rejected for invalid room ID: "${roomName}"`);
    ws.close(4400, 'Invalid room ID');
    return;
  }

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

  // Live name-uniqueness verification at WebSocket connection handshake
  if (requestedName && isNameTakenInRoom(roomName, requestedName)) {
    console.warn(`[Reject] Name "${requestedName}" is already taken in room "${roomName}"`);
    ws.close(4409, 'That name is already in use in this room — please choose another');
    return;
  }

  // Cancel any pending eviction timer when a new client connects
  cancelRoomEviction(room);

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

          // Track client IDs in this update and reject awareness updates claiming a taken name
          let nameConflict = false;
          try {
            const updateDecoder = decoding.createDecoder(update);
            const len = decoding.readVarUint(updateDecoder);
            for (let i = 0; i < len; i++) {
              const clientID = decoding.readVarUint(updateDecoder);
              decoding.readVarUint(updateDecoder); // clock
              const stateStr = decoding.readVarString(updateDecoder); // JSON state string
              controlledUserIds.add(clientID);

              if (stateStr) {
                try {
                  const parsedState = JSON.parse(stateStr);
                  if (parsedState?.user?.name && typeof parsedState.user.name === 'string') {
                    const claimedName = parsedState.user.name.trim().toLowerCase();
                    const existingStates = room.awareness.getStates();
                    for (const [existingId, existingState] of existingStates.entries()) {
                      if (
                        existingId !== clientID &&
                        existingState?.user?.name &&
                        existingState.user.name.trim().toLowerCase() === claimedName
                      ) {
                        nameConflict = true;
                        break;
                      }
                    }
                  }
                } catch {
                  // Ignore JSON parse error on non-user awareness states
                }
              }
            }
          } catch (decodeErr) {
            console.warn('[Awareness Decode Warning]:', decodeErr.message);
          }

          if (nameConflict) {
            console.warn(`[Reject] Awareness name conflict detected in room "${roomName}"`);
            ws.close(4409, 'That name is already in use in this room — please choose another');
            break;
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

    // If no clients remain in the room, schedule eviction after grace period
    if (room.clients.size === 0) {
      scheduleRoomEviction(room);
    }
  });

  ws.on('error', (err) => {
    console.error(`[Socket Error] Room: "${roomName}":`, err.message);
  });
});

// Clean process shutdown handlers: clear any pending eviction timers and heartbeat interval
function gracefulShutdown(signal) {
  console.log(`Received ${signal}, clearing pending eviction timers and heartbeat interval.`);
  clearInterval(heartbeatInterval);
  clearAllEvictionTimers();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Initialize database tables & Redis pub/sub, then start listening
await setupDatabase();
setupRedis();

server.listen(PORT, () => {
  console.log(`🚀 SyncScript WebSocket Server listening on http://localhost:${PORT} (ws://localhost:${PORT}/<roomId>)`);
});

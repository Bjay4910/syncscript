/**
 * Fixed curated palette of vibrant, high-contrast colors for collaborative presence.
 */
export const USER_PALETTE = [
  { name: 'Rose', color: '#f43f5e', light: 'rgba(244, 63, 94, 0.25)' },
  { name: 'Cyan', color: '#06b6d4', light: 'rgba(6, 182, 212, 0.25)' },
  { name: 'Violet', color: '#8b5cf6', light: 'rgba(139, 92, 246, 0.25)' },
  { name: 'Emerald', color: '#10b981', light: 'rgba(16, 185, 129, 0.25)' },
  { name: 'Amber', color: '#f59e0b', light: 'rgba(245, 158, 11, 0.25)' },
  { name: 'Pink', color: '#ec4899', light: 'rgba(236, 72, 153, 0.25)' },
  { name: 'Blue', color: '#3b82f6', light: 'rgba(59, 130, 246, 0.25)' },
  { name: 'Teal', color: '#14b8a6', light: 'rgba(20, 184, 166, 0.25)' },
  { name: 'Orange', color: '#f97316', light: 'rgba(249, 115, 22, 0.25)' },
  { name: 'Lime', color: '#84cc16', light: 'rgba(132, 204, 22, 0.25)' },
];

/**
 * Returns a randomly picked user color from the fixed palette.
 */
export function getRandomUserColor() {
  const index = Math.floor(Math.random() * USER_PALETTE.length);
  return USER_PALETTE[index];
}

/**
 * Generates a cryptographically secure, high-entropy room ID (21 characters, 126 bits of entropy).
 * Uses crypto.getRandomValues with a 64-character URL-safe alphabet (nanoid specification),
 * rendering room IDs infeasible to guess or brute-force.
 */
export function generateRandomRoomId() {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  const size = 21;
  const bytes = new Uint8Array(size);

  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < size; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  let id = '';
  for (let i = 0; i < size; i++) {
    // 64-character alphabet: bitwise AND with 63 provides uniform distribution without modulo bias
    id += alphabet[bytes[i] & 63];
  }
  return id;
}

/**
 * Resolves the WebSocket Server URL.
 * Checks for a `ws` query parameter first (e.g. ?ws=ws://localhost:1235),
 * falling back to the existing VITE_WS_URL environment variable or ws://localhost:1234.
 * Automatically normalizes scheme (http/https -> ws/wss) and strips trailing slashes.
 */
export function getWsServerUrl() {
  let url = '';
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const queryWs = params.get('ws');
    if (queryWs && queryWs.trim()) {
      url = queryWs.trim();
    }
  }

  if (!url) {
    url = (import.meta.env?.VITE_WS_URL || '').trim();
  }

  if (!url) {
    url = 'ws://localhost:1234';
  }

  // Normalize: strip trailing slashes and convert any http(s) scheme to ws(s)
  url = url.replace(/\/+$/, '');
  url = url.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  return url;
}

/**
 * Resolves the HTTP Server URL corresponding to the WebSocket Server URL.
 * Converts ws:// -> http:// and wss:// -> https://, and ensures no trailing slash.
 */
export function getHttpServerUrl() {
  const wsUrl = getWsServerUrl();
  return wsUrl
    .replace(/^ws:\/\//i, 'http://')
    .replace(/^wss:\/\//i, 'https://')
    .replace(/\/+$/, '');
}

export const DEFAULT_WS_SERVER_URL = getWsServerUrl();


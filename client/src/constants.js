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
 * Generates a clean, friendly document room ID if none was specified.
 */
export function generateRandomRoomId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let result = 'doc-';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Resolves the WebSocket Server URL.
 * Checks for a `ws` query parameter first (e.g. ?ws=ws://localhost:1235),
 * falling back to the existing VITE_WS_URL environment variable or ws://localhost:1234.
 */
export function getWsServerUrl() {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const queryWs = params.get('ws');
    if (queryWs && queryWs.trim()) {
      return queryWs.trim();
    }
  }
  return import.meta.env.VITE_WS_URL || 'ws://localhost:1234';
}

export const DEFAULT_WS_SERVER_URL = getWsServerUrl();


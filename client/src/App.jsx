import React, { useState, useEffect, useMemo } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import Header from './components/Header';
import Editor from './components/Editor';
import JoinModal from './components/JoinModal';
import {
  getRandomUserColor,
  generateRandomRoomId,
  getWsServerUrl,
  getHttpServerUrl,
} from './constants';

function CollaborativeSession({ roomId, currentUser, onNameConflict }) {
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [users, setUsers] = useState([]);

  // Create Yjs document, IndexedDB persistence for offline support, and WebSocket provider
  const { doc, provider, persistence } = useMemo(() => {
    const ydoc = new Y.Doc();
    // 1. Initialize IndexedDB persistence immediately on mount (before WebSocket connects)
    const idbPersistence = new IndexeddbPersistence(roomId, ydoc);
    // 2. WebSocket provider for real-time sync with server (supports ?ws=ws://localhost:1235 query override)
    const wsServerUrl = getWsServerUrl();
    const wsProvider = new WebsocketProvider(wsServerUrl, roomId, ydoc, {
      params: { name: currentUser.name },
    });

    // Register user awareness state
    wsProvider.awareness.setLocalStateField('user', {
      name: currentUser.name,
      color: currentUser.color,
      colorLight: currentUser.colorLight,
    });

    return { doc: ydoc, provider: wsProvider, persistence: idbPersistence };
  }, [roomId, currentUser]);

  // Clean up provider and document when unmounting or switching rooms
  useEffect(() => {
    // Helper to update active users list from awareness
    const updateUsersFromAwareness = () => {
      const states = provider.awareness.getStates();
      const activeUsers = [];

      states.forEach((state, clientId) => {
        if (state.user && state.user.name) {
          activeUsers.push({
            clientId,
            name: state.user.name,
            color: state.user.color,
          });
        }
      });

      setUsers(activeUsers);
    };

    provider.awareness.on('change', updateUsersFromAwareness);
    updateUsersFromAwareness();

    let syncTimer = null;
    let syncStartTime = 0;

    // Handle WebSocket status transitions: connecting, connected (syncing handshake), offline
    const handleStatus = ({ status }) => {
      if (status === 'connected') {
        if (provider.synced) {
          setConnectionStatus('connected');
        } else {
          syncStartTime = Date.now();
          setConnectionStatus('syncing');
        }
      } else if (status === 'connecting') {
        setConnectionStatus('connecting');
      } else if (status === 'disconnected') {
        setConnectionStatus('offline');
      }
    };

    // Handle Yjs sync handshake completion
    const handleSync = (isSynced) => {
      if (isSynced) {
        // Guarantee brief visual visibility for "Syncing..." on fast connections
        const elapsed = syncStartTime > 0 ? Date.now() - syncStartTime : 400;
        const remainingDelay = Math.max(0, 350 - elapsed);
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
          if (provider.wsconnected && provider.synced) {
            setConnectionStatus('connected');
          }
        }, remainingDelay);
      } else if (provider.wsconnected) {
        syncStartTime = Date.now();
        setConnectionStatus('syncing');
      }
    };

    // Listen for permanent close event (e.g. code 4409 if server rejected due to race condition)
    const handleClosed = (closeEvent) => {
      if (closeEvent && (closeEvent.code === 4409 || closeEvent.code === 4001)) {
        if (onNameConflict) {
          onNameConflict(closeEvent.reason || 'That name is already in use in this room — please choose another');
        }
      }
    };

    provider.on('status', handleStatus);
    provider.on('sync', handleSync);
    provider.on('closed', handleClosed);

    // Real network drop listeners (browser offline / online)
    const handleWindowOffline = () => {
      setConnectionStatus('offline');
    };
    const handleWindowOnline = () => {
      if (provider.shouldReconnect) {
        provider.connect();
      }
    };

    window.addEventListener('offline', handleWindowOffline);
    window.addEventListener('online', handleWindowOnline);

    return () => {
      if (syncTimer) clearTimeout(syncTimer);
      window.removeEventListener('offline', handleWindowOffline);
      window.removeEventListener('online', handleWindowOnline);
      provider.awareness.off('change', updateUsersFromAwareness);
      provider.off('status', handleStatus);
      provider.off('sync', handleSync);
      provider.off('closed', handleClosed);
      provider.destroy();
      persistence.destroy();
      doc.destroy();
    };
  }, [doc, provider, persistence, onNameConflict]);

  // Deterministic manual offline / online toggle
  const handleToggleOffline = () => {
    if (connectionStatus === 'offline') {
      provider.connect();
      setConnectionStatus('connecting');
    } else {
      provider.disconnect();
      setConnectionStatus('offline');
    }
  };

  return (
    <div className="app-wrapper">
      <Header
        roomId={roomId}
        connectionStatus={connectionStatus}
        users={users}
        currentClientId={doc.clientID}
        onToggleOffline={handleToggleOffline}
      />

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Editor ydoc={doc} provider={provider} roomId={roomId} persistence={persistence} />
      </main>
    </div>
  );
}

export default function App() {
  // Resolve room name from URL query parameter or path segment
  const roomId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const queryRoom = params.get('room');
    if (queryRoom && queryRoom.trim()) {
      return queryRoom.trim();
    }

    const pathSegment = window.location.pathname.replace(/^\/+|\/+$/g, '');
    if (pathSegment && pathSegment !== 'index.html') {
      const match = pathSegment.match(/^(?:room|rooms)\/(.+)$/);
      if (match && match[1]) {
        return decodeURIComponent(match[1]);
      }
      return decodeURIComponent(pathSegment);
    }

    const newRoom = generateRandomRoomId();
    // Update URL query param so the room link is immediately copyable & shareable
    const url = new URL(window.location.href);
    url.searchParams.set('room', newRoom);
    window.history.replaceState(null, '', url.toString());
    return newRoom;
  }, []);

  const [joined, setJoined] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [joinError, setJoinError] = useState('');

  const handleJoin = async (name) => {
    setJoinError('');

    // 1. Live name-uniqueness check against server awareness before joining
    try {
      const httpUrl = getHttpServerUrl();
      const checkUrl = `${httpUrl}/check-name?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name)}&_t=${Date.now()}`;
      const res = await fetch(checkUrl, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.taken || !data.ok) {
        const errorMsg = data.error || 'That name is already in use in this room — please choose another';
        return { ok: false, error: errorMsg };
      }
    } catch (err) {
      console.warn('[Name Check Warning] Could not reach server for pre-check:', err.message);
      // Hard gate: Never fall through to join session on pre-check failure or abort
      return {
        ok: false,
        error: 'Unable to verify display name availability. Please try again.',
      };
    }

    // 2. Name is available: assign color and enter session
    const colorObj = getRandomUserColor();
    const user = {
      name,
      color: colorObj.color,
      colorLight: colorObj.light,
    };
    setCurrentUser(user);
    setJoined(true);
    return { ok: true };
  };

  const handleNameConflict = (errorMsg) => {
    setJoinError(errorMsg);
    setJoined(false);
    setCurrentUser(null);
  };

  if (!joined || !currentUser) {
    return <JoinModal roomId={roomId} onJoin={handleJoin} initialError={joinError} />;
  }

  return (
    <CollaborativeSession
      roomId={roomId}
      currentUser={currentUser}
      onNameConflict={handleNameConflict}
    />
  );
}

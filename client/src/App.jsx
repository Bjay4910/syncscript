import React, { useState, useEffect, useMemo } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import Header from './components/Header';
import Editor from './components/Editor';
import JoinModal from './components/JoinModal';
import {
  getRandomUserColor,
  generateRandomRoomId,
  DEFAULT_WS_SERVER_URL,
} from './constants';

function CollaborativeSession({ roomId, currentUser }) {
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [users, setUsers] = useState([]);

  // Create Yjs document and WebSocket provider tied to this room and user
  const { doc, provider } = useMemo(() => {
    const ydoc = new Y.Doc();
    const wsProvider = new WebsocketProvider(DEFAULT_WS_SERVER_URL, roomId, ydoc);

    // Register user awareness state
    wsProvider.awareness.setLocalStateField('user', {
      name: currentUser.name,
      color: currentUser.color,
      colorLight: currentUser.colorLight,
    });

    return { doc: ydoc, provider: wsProvider };
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

    const handleStatus = ({ status }) => {
      setConnectionStatus(status);
    };
    provider.on('status', handleStatus);

    return () => {
      provider.awareness.off('change', updateUsersFromAwareness);
      provider.off('status', handleStatus);
      provider.destroy();
      doc.destroy();
    };
  }, [doc, provider]);

  return (
    <div className="app-wrapper">
      <Header
        roomId={roomId}
        connectionStatus={connectionStatus}
        users={users}
        currentClientId={doc.clientID}
      />

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Editor ydoc={doc} provider={provider} />
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

  const handleJoin = (name) => {
    const colorObj = getRandomUserColor();
    const user = {
      name,
      color: colorObj.color,
      colorLight: colorObj.light,
    };
    setCurrentUser(user);
    setJoined(true);
  };

  if (!joined || !currentUser) {
    return <JoinModal roomId={roomId} onJoin={handleJoin} />;
  }

  return <CollaborativeSession roomId={roomId} currentUser={currentUser} />;
}

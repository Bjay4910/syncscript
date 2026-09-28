import React, { useState } from 'react';
import { FileText, Copy, Check, Share2, Wifi, WifiOff } from 'lucide-react';
import PresenceBar from './PresenceBar';

export default function Header({
  roomId,
  connectionStatus,
  users,
  currentClientId,
  onToggleOffline,
}) {
  const [copied, setCopied] = useState(false);

  const handleCopyLink = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Format connection status details across 4 distinct states
  const getStatusDetails = () => {
    switch (connectionStatus) {
      case 'connected':
      case 'synced':
        return {
          label: 'Connected',
          className: 'status-connected',
          icon: <span className="status-dot" />,
        };
      case 'syncing':
        return {
          label: 'Syncing...',
          className: 'status-syncing',
          icon: <span className="status-dot" />,
        };
      case 'connecting':
        return {
          label: 'Connecting...',
          className: 'status-connecting',
          icon: <span className="status-dot" />,
        };
      case 'offline':
      case 'disconnected':
      default:
        return {
          label: 'Offline — editing locally',
          className: 'status-offline',
          icon: <span className="status-dot" />,
        };
    }
  };

  const status = getStatusDetails();
  const isOffline = connectionStatus === 'offline' || connectionStatus === 'disconnected';

  return (
    <header className="app-header">
      <div className="brand-section">
        <a href="/" className="brand-logo" title="SyncScript Home">
          <div className="brand-icon-box">
            <FileText size={18} color="#ffffff" />
          </div>
          <span>SyncScript</span>
        </a>

        <div className="room-badge">
          <span>Room:</span>
          <strong>{roomId}</strong>
          <button
            onClick={handleCopyLink}
            className="btn-icon-subtle"
            title="Copy Room Link"
            aria-label="Copy Room Link"
          >
            {copied ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      <div className="header-actions">
        {/* Presence Bar showing active peers */}
        <PresenceBar users={users} currentClientId={currentClientId} />

        {/* Deterministic Go Offline / Go Online Toggle Button */}
        <button
          onClick={onToggleOffline}
          className={`btn-offline-toggle ${isOffline ? 'is-offline' : ''}`}
          id="toggle-offline-button"
          title={isOffline ? 'Connect to server (Go Online)' : 'Disconnect from server (Go Offline)'}
          aria-label={isOffline ? 'Go Online' : 'Go Offline'}
        >
          {isOffline ? (
            <>
              <Wifi size={14} />
              <span>Go Online</span>
            </>
          ) : (
            <>
              <WifiOff size={14} />
              <span>Go Offline</span>
            </>
          )}
        </button>

        {/* Connection status indicator */}
        <div className={`connection-status ${status.className}`} id="connection-status-badge">
          {status.icon}
          <span>{status.label}</span>
        </div>

        {/* Share Button */}
        <button
          onClick={handleCopyLink}
          className={`btn-share ${copied ? 'copied' : ''}`}
          id="share-room-button"
        >
          {copied ? (
            <>
              <Check size={14} />
              <span>Link Copied!</span>
            </>
          ) : (
            <>
              <Share2 size={14} />
              <span>Share</span>
            </>
          )}
        </button>
      </div>
    </header>
  );
}


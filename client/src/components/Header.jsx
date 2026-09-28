import React, { useState } from 'react';
import { FileText, Copy, Check, Share2 } from 'lucide-react';
import PresenceBar from './PresenceBar';

export default function Header({
  roomId,
  connectionStatus,
  users,
  currentClientId,
}) {
  const [copied, setCopied] = useState(false);

  const handleCopyLink = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Format connection status label
  const getStatusDetails = () => {
    switch (connectionStatus) {
      case 'connected':
        return {
          label: 'Connected',
          className: 'status-connected',
          icon: <span className="status-dot" />,
        };
      case 'connecting':
        return {
          label: 'Connecting...',
          className: 'status-connecting',
          icon: <span className="status-dot" />,
        };
      case 'disconnected':
      default:
        return {
          label: 'Disconnected',
          className: 'status-disconnected',
          icon: <span className="status-dot" />,
        };
    }
  };

  const status = getStatusDetails();

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

        {/* Connection status indicator */}
        <div className={`connection-status ${status.className}`}>
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

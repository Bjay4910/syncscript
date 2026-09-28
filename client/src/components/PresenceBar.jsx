import React from 'react';
import { Users } from 'lucide-react';

export default function PresenceBar({ users, currentClientId }) {
  if (!users || users.length === 0) {
    return null;
  }

  return (
    <div className="presence-bar" title="Collaborators currently active in this room">
      <div className="presence-label">
        <Users size={14} />
        <span>{users.length} {users.length === 1 ? 'user' : 'users'}</span>
      </div>

      <div className="presence-chips-container">
        {users.map((u) => {
          const isSelf = u.clientId === currentClientId;
          return (
            <div
              key={u.clientId}
              className={`presence-chip ${isSelf ? 'is-self' : ''}`}
              title={`${u.name}${isSelf ? ' (You)' : ''}`}
            >
              <span
                className="presence-dot"
                style={{
                  backgroundColor: u.color || '#6366f1',
                  color: u.color || '#6366f1',
                }}
              />
              <span className="presence-name">{u.name}</span>
              {isSelf && <span className="self-tag">(You)</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

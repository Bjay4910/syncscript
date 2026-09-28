import React, { useState } from 'react';
import { User, ArrowRight, FileText, Info } from 'lucide-react';

export default function JoinModal({ roomId, onJoin }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = name.trim();

    if (!trimmed) {
      setError('Please enter your name to join');
      return;
    }

    if (trimmed.length > 30) {
      setError('Name cannot exceed 30 characters');
      return;
    }

    onJoin(trimmed);
  };

  const handleChange = (e) => {
    const val = e.target.value;
    if (val.length <= 30) {
      setName(val);
      if (error) setError('');
    }
  };

  return (
    <div className="join-screen-container">
      <div className="join-card">
        <div className="join-card-glow" />

        <div className="join-header">
          <div className="join-brand-badge">
            <div className="brand-icon-box">
              <FileText size={18} color="#ffffff" />
            </div>
            <span style={{ fontWeight: 700, fontSize: '1.1rem', letterSpacing: '-0.02em', color: '#fff' }}>
              SyncScript
            </span>
          </div>

          <h1 className="join-title">Collaborative Document</h1>
          <p className="join-subtitle">
            Instant peer-to-peer real-time editing with live remote cursors
          </p>

          <div className="join-room-pill">
            <span>Room:</span>
            <strong>{roomId}</strong>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="join-form">
          <div className="form-group">
            <div className="form-label-row">
              <label htmlFor="user-name-input" className="form-label">
                Your Display Name
              </label>
              <span className={`char-counter ${name.length === 30 ? 'limit-reached' : ''}`}>
                {name.length}/30
              </span>
            </div>

            <div className="join-input-wrapper">
              <User size={16} className="join-input-icon" />
              <input
                id="user-name-input"
                type="text"
                className="join-input"
                placeholder="Enter your name to join"
                value={name}
                onChange={handleChange}
                maxLength={30}
                autoFocus
                autoComplete="off"
              />
            </div>

            {error && <p className="join-error-msg">{error}</p>}
          </div>

          <button type="submit" className="btn-primary" id="join-room-btn">
            <span>Join Document</span>
            <ArrowRight size={16} />
          </button>

          <div className="join-info-callout">
            <Info size={15} />
            <span>
              Anyone with this room link can join and collaborate in real time. No password or account required.
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}

import React, { useState } from 'react';
import { User, ArrowRight, FileText, Info } from 'lucide-react';

export default function JoinModal({ roomId, onJoin, initialError = '' }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(initialError);
  const [prevInitialError, setPrevInitialError] = useState(initialError);
  const [lastTakenName, setLastTakenName] = useState('');
  const [isChecking, setIsChecking] = useState(false);

  if (initialError !== prevInitialError) {
    setPrevInitialError(initialError);
    setError(initialError);
  }

  const handleSubmit = async (e) => {
    if (e && e.preventDefault) {
      e.preventDefault();
    }
    if (isChecking) return;

    const trimmed = name.trim();

    if (!trimmed) {
      setError('Please enter your name to join');
      return;
    }

    if (trimmed.length > 30) {
      setError('Name cannot exceed 30 characters');
      return;
    }

    // If this exact name was already verified taken, keep error and block immediately
    if (lastTakenName && trimmed.toLowerCase() === lastTakenName.toLowerCase()) {
      setError('That name is already in use in this room — please choose another');
      return;
    }

    setError('');
    setIsChecking(true);

    try {
      const res = await onJoin(trimmed);
      if (!res || !res.ok) {
        setLastTakenName(trimmed);
        setError(res?.error || 'That name is already in use in this room — please choose another');
        return;
      }
      setLastTakenName('');
    } catch (err) {
      setError(err?.message || 'Unable to verify name. Please try again.');
    } finally {
      setIsChecking(false);
    }
  };

  const handleChange = (e) => {
    const val = e.target.value;
    if (val.length <= 30) {
      setName(val);
      if (error) setError('');
      if (lastTakenName && val.trim().toLowerCase() !== lastTakenName.toLowerCase()) {
        setLastTakenName('');
      }
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

          <button
            type="submit"
            className="btn-primary"
            id="join-room-btn"
            disabled={isChecking}
            onClick={handleSubmit}
          >
            <span>{isChecking ? 'Checking availability...' : 'Join Document'}</span>
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

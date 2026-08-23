import { useState } from 'react';
import { getApiKey, getModel, MODELS, setApiKey, setModel } from '../lib/settings';

interface Props {
  onClose: () => void;
  onChangeFeed: () => void;
  onSettingsChanged: () => void;
  feedLoaded: boolean;
}

export function SettingsModal({ onClose, onChangeFeed, onSettingsChanged, feedLoaded }: Props) {
  const [key, setKey] = useState(() => getApiKey());
  const [model, setModelState] = useState(() => getModel());
  const [saved, setSaved] = useState(false);

  const save = () => {
    setApiKey(key.trim());
    setModel(model);
    setSaved(true);
    onSettingsChanged();
    setTimeout(() => setSaved(false), 1500);
  };

  const clear = () => {
    setKey('');
    setApiKey('');
    onSettingsChanged();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <label className="field">
          <span>Anthropic API key</span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
          />
        </label>
        <p className="field-note">
          Your key is stored only in this browser (localStorage) and sent only to
          api.anthropic.com. Use a dedicated key with a spend limit (Anthropic Console).
        </p>

        <label className="field">
          <span>Model</span>
          <select value={model} onChange={(e) => setModelState(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <div className="modal-actions">
          <button className="primary" onClick={save}>
            {saved ? 'Saved ✓' : 'Save'}
          </button>
          <button onClick={clear}>Clear key</button>
          {feedLoaded && (
            <button className="danger" onClick={onChangeFeed}>
              Change feed
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

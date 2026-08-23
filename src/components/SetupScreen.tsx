import { useCallback, useState } from 'react';
import {
  fileTab,
  GtfsSelector,
  mobilityDataCsv,
  transportDataGouvFr,
  urlTab,
  type GtfsSelectionResult,
} from 'react-gtfs-selector';
import 'react-gtfs-selector/style.css';
import type { LastFeedInfo, ProgressInfo } from '../worker/api';

const SELECTOR_TABS = [fileTab, urlTab, transportDataGouvFr, mobilityDataCsv];

export interface FeedRequest {
  selection: GtfsSelectionResult;
  skipShapes?: boolean;
}

interface Props {
  loading: boolean;
  progress: ProgressInfo | null;
  error: string | null;
  lastFeedInfo: LastFeedInfo | null;
  onReloadLast: () => void;
  onLoadFeed: (request: FeedRequest) => void;
}

export function SetupScreen({
  loading,
  progress,
  error,
  lastFeedInfo,
  onReloadLast,
  onLoadFeed,
}: Props) {
  const [lastSelection, setLastSelection] = useState<GtfsSelectionResult | null>(null);

  const handleSelect = useCallback(
    (selection: GtfsSelectionResult) => {
      setLastSelection(selection);
      onLoadFeed({ selection });
    },
    [onLoadFeed]
  );

  const retryWithoutShapes = useCallback(() => {
    if (!lastSelection) return;
    onLoadFeed({ selection: lastSelection, skipShapes: true });
  }, [lastSelection, onLoadFeed]);

  return (
    <div className="setup-screen">
      <header className="setup-header">
        <h1>GTFS Chat</h1>
        <p>
          Pick a transit feed (GTFS), it loads into a SQLite database in your browser, then chat
          with Claude about stops, routes, departures and delays. Nothing leaves your browser
          except calls to the Anthropic API with your own key.
        </p>
      </header>

      {lastFeedInfo && !loading && (
        <button className="reload-last" onClick={onReloadLast}>
          ↻ Reload last feed: {lastFeedInfo.title}{' '}
          <span className="reload-last-note">(instant, from cache)</span>
        </button>
      )}

      {loading ? (
        <div className="progress-panel">
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill"
              style={{ width: `${Math.min(progress?.percentComplete ?? 0, 100)}%` }}
            />
          </div>
          <p className="progress-message">
            {progress?.message ?? 'Loading feed…'}{' '}
            {progress ? `(${Math.floor(progress.percentComplete)}%)` : ''}
          </p>
        </div>
      ) : (
        <GtfsSelector onSelect={handleSelect} tabs={SELECTOR_TABS} />
      )}

      {error && !loading && (
        <div className="banner banner-error">
          <p>{error}</p>
          {lastSelection && /too large|memory|shapes/i.test(error) && (
            <button onClick={retryWithoutShapes}>Retry without shapes.txt</button>
          )}
        </div>
      )}
    </div>
  );
}

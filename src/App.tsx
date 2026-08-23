import { useCallback, useEffect, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import type { FeedSummary, GtfsWorkerApi, LastFeedInfo, ProgressInfo } from './worker/api';
import { StopIndex } from './search/stopIndex';
import { proxied } from './lib/proxy';
import { getLastFeed, setLastFeed } from './lib/settings';
import { SetupScreen, type FeedRequest } from './components/SetupScreen';
import { ChatScreen } from './components/ChatScreen';
import { SettingsModal } from './components/SettingsModal';

function createWorker(): { worker: Worker; api: Comlink.Remote<GtfsWorkerApi> } {
  const worker = new Worker(new URL('./worker/gtfs.worker.ts', import.meta.url), {
    type: 'module',
  });
  return { worker, api: Comlink.wrap<GtfsWorkerApi>(worker) };
}

export function App() {
  const workerRef = useRef<ReturnType<typeof createWorker> | null>(null);
  if (!workerRef.current) workerRef.current = createWorker();
  const api = workerRef.current.api;

  const [summary, setSummary] = useState<FeedSummary | null>(null);
  const [stopIndex, setStopIndex] = useState<StopIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsVersion, setSettingsVersion] = useState(0);
  // Key forcing a fresh ChatScreen (new history) when a new feed is loaded.
  const [feedGeneration, setFeedGeneration] = useState(0);
  const [lastFeedInfo, setLastFeedInfo] = useState<LastFeedInfo | null>(null);

  useEffect(() => {
    void api.getLastFeedInfo().then(setLastFeedInfo, () => {});
    return () => workerRef.current?.worker.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadFeed = useCallback(
    async (request: FeedRequest) => {
      setLoading(true);
      setLoadError(null);
      setProgress(null);
      setSummary(null);
      setStopIndex(null);
      const onProgress = Comlink.proxy((p: ProgressInfo) => setProgress(p));
      const options = request.skipShapes ? { skipShapes: true } : undefined;
      try {
        let feedSummary: FeedSummary;
        const selection = request.selection;
        if (selection.type === 'file') {
          const buffer = await new Response(selection.blob).arrayBuffer();
          const bytes = new Uint8Array(buffer);
          feedSummary = await api.loadFromZipData(
            Comlink.transfer(bytes, [bytes.buffer]),
            [],
            onProgress,
            { ...options, title: selection.fileName }
          );
        } else {
          const rtUrls = (selection.gtfsRtUrls ?? []).map(proxied);
          feedSummary = await api.loadFromZipUrl(
            proxied(selection.url),
            rtUrls,
            onProgress,
            { ...options, title: selection.title }
          );
          setLastFeed({
            url: selection.url,
            title: selection.title,
            gtfsRtUrls: selection.gtfsRtUrls,
          });
        }
        const stops = await api.listAllStopsLight();
        setStopIndex(new StopIndex(stops));
        setSummary(feedSummary);
        setFeedGeneration((g) => g + 1);
        void api.getLastFeedInfo().then(setLastFeedInfo, () => {});
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
        setProgress(null);
      }
    },
    [api]
  );

  const restoreLastFeed = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setProgress(null);
    setSummary(null);
    setStopIndex(null);
    const onProgress = Comlink.proxy((p: ProgressInfo) => setProgress(p));
    try {
      let feedSummary: FeedSummary;
      try {
        feedSummary = await api.restoreLastFeed(onProgress);
      } catch (restoreError) {
        // Snapshot missing or corrupted — fall back to re-downloading the
        // last URL feed if we know one.
        const lastUrlFeed = getLastFeed();
        if (!lastUrlFeed) throw restoreError;
        const rtUrls = (lastUrlFeed.gtfsRtUrls ?? []).map(proxied);
        feedSummary = await api.loadFromZipUrl(proxied(lastUrlFeed.url), rtUrls, onProgress, {
          title: lastUrlFeed.title,
        });
      }
      const stops = await api.listAllStopsLight();
      setStopIndex(new StopIndex(stops));
      setSummary(feedSummary);
      setFeedGeneration((g) => g + 1);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, [api]);

  const changeFeed = useCallback(async () => {
    setSettingsOpen(false);
    setSummary(null);
    setStopIndex(null);
    setLoadError(null);
    try {
      await api.close();
    } catch {
      // worker may already have no feed open
    }
  }, [api]);

  const ready = summary !== null && stopIndex !== null;

  return (
    <div className="app">
      {ready ? (
        <ChatScreen
          key={feedGeneration}
          worker={api}
          stopIndex={stopIndex}
          summary={summary}
          onOpenSettings={() => setSettingsOpen(true)}
          settingsVersion={settingsVersion}
        />
      ) : (
        <>
          <SetupScreen
            loading={loading}
            progress={progress}
            error={loadError}
            lastFeedInfo={lastFeedInfo}
            onReloadLast={() => void restoreLastFeed()}
            onLoadFeed={(request) => void loadFeed(request)}
          />
          <button className="settings-fab" onClick={() => setSettingsOpen(true)}>
            ⚙ Settings
          </button>
        </>
      )}

      {settingsOpen && (
        <SettingsModal
          feedLoaded={ready}
          onClose={() => setSettingsOpen(false)}
          onChangeFeed={() => void changeFeed()}
          onSettingsChanged={() => setSettingsVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}

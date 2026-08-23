/**
 * Snapshot of the last successfully loaded feed, stored in IndexedDB.
 *
 * gtfs-sqljs's own cache is keyed by the ZIP checksum, so a URL reload still
 * downloads the whole ZIP before the cache can hit. This store keeps the
 * exported SQLite database instead, so "reload last feed" restores with zero
 * network — including feeds that were dragged & dropped as local files.
 */

const DB_NAME = 'gtfs-chat-last-feed';
const STORE = 'snapshot';
const KEY = 'last';

export interface LastFeedSnapshot {
  data: ArrayBuffer;
  title: string;
  rtUrls: string[];
  savedAt: number;
}

export interface LastFeedInfo {
  title: string;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
  }
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const request = fn(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function saveLastFeedSnapshot(snapshot: LastFeedSnapshot): Promise<void> {
  await withStore('readwrite', (store) => store.put(snapshot, KEY));
}

export async function getLastFeedSnapshot(): Promise<LastFeedSnapshot | null> {
  const record = await withStore<LastFeedSnapshot | undefined>('readonly', (store) =>
    store.get(KEY)
  );
  return record ?? null;
}

export async function getLastFeedInfo(): Promise<LastFeedInfo | null> {
  const snapshot = await getLastFeedSnapshot();
  return snapshot ? { title: snapshot.title, savedAt: snapshot.savedAt } : null;
}

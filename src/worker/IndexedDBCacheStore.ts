import type { CacheEntry, CacheEntryWithData, CacheMetadata, CacheStore } from 'gtfs-sqljs';

/**
 * Browser cache store persisting processed GTFS databases in IndexedDB,
 * implementing the gtfs-sqljs CacheStore interface (adapted from the
 * reference implementation in the gtfs-sqljs repository's examples/cache/).
 * Second load of the same feed hits this cache and completes in ~1 s.
 */
export class IndexedDBCacheStore implements CacheStore {
  private dbName: string;
  private storeName = 'gtfs-cache';
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName = 'gtfs-sqljs-cache') {
    this.dbName = dbName;
  }

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      });
    }
    return this.dbPromise;
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const db = await this.openDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(this.storeName, mode);
      const request = fn(tx.objectStore(this.storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  }

  async get(key: string): Promise<CacheEntryWithData | null> {
    const record = await this.withStore<
      { key: string; data: ArrayBuffer; metadata: CacheMetadata } | undefined
    >('readonly', (store) => store.get(key));
    if (!record) return null;
    return { data: record.data, metadata: record.metadata };
  }

  async set(key: string, data: ArrayBuffer, metadata: CacheMetadata): Promise<void> {
    await this.withStore('readwrite', (store) => store.put({ key, data, metadata }));
  }

  async has(key: string): Promise<boolean> {
    const count = await this.withStore<number>('readonly', (store) => store.count(key));
    return count > 0;
  }

  async delete(key: string): Promise<void> {
    await this.withStore('readwrite', (store) => store.delete(key));
  }

  async clear(): Promise<void> {
    await this.withStore('readwrite', (store) => store.clear());
  }

  async list(): Promise<CacheEntry[]> {
    const records = await this.withStore<
      Array<{ key: string; metadata: CacheMetadata }>
    >('readonly', (store) => store.getAll());
    return records.map((r) => ({ key: r.key, metadata: r.metadata }));
  }
}

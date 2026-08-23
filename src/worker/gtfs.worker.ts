import * as Comlink from 'comlink';
import { GtfsSqlJs } from 'gtfs-sqljs';
import type { GtfsSqlJsOptions, Row, SqlValue } from 'gtfs-sqljs';
import { createSqlJsAdapter } from 'gtfs-sqljs/adapters/sql-js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { IndexedDBCacheStore } from './IndexedDBCacheStore';
import {
  getLastFeedInfo,
  getLastFeedSnapshot,
  saveLastFeedSnapshot,
} from './lastFeedStore';
import type { FeedSummary, GtfsWorkerApi, LoadOptions, ProgressInfo, StopLight } from './api';

type FactoryOptions = Omit<GtfsSqlJsOptions, 'zipPath' | 'database'>;

let gtfs: GtfsSqlJs | null = null;

function instance(): GtfsSqlJs {
  if (!gtfs) throw new Error('No GTFS feed is loaded');
  return gtfs;
}

function throttledProgress(onProgress: (p: ProgressInfo) => void): (p: ProgressInfo) => void {
  // onProgress is a Comlink proxy: every call is a postMessage. Only forward
  // meaningful changes so huge feeds don't flood the main thread.
  let lastPercent = -1;
  let lastPhase = '';
  return (p) => {
    const percent = Math.floor(p.percentComplete);
    if (p.phase !== lastPhase || percent !== lastPercent || p.phase === 'complete') {
      lastPhase = p.phase;
      lastPercent = percent;
      void onProgress(p);
    }
  };
}

async function buildOptions(
  rtUrls: string[],
  onProgress: (p: ProgressInfo) => void,
  options?: LoadOptions
): Promise<FactoryOptions> {
  return {
    adapter: await createSqlJsAdapter({ locateFile: () => sqlWasmUrl }),
    cache: new IndexedDBCacheStore(),
    realtimeFeedUrls: rtUrls,
    onProgress: throttledProgress(onProgress),
    ...(options?.skipShapes ? { skipFiles: ['shapes.txt'] } : {}),
  };
}

async function rawQuery(sql: string, params: SqlValue[] = []): Promise<Row[]> {
  const db = instance().getDatabase();
  const stmt = await db.prepare(sql);
  try {
    if (params.length > 0) await stmt.bind(params);
    const rows: Row[] = [];
    while (await stmt.step()) {
      rows.push(await stmt.getAsObject());
    }
    return rows;
  } finally {
    await stmt.free();
  }
}

async function count(table: string): Promise<number> {
  try {
    const rows = await rawQuery(`SELECT COUNT(*) AS c FROM ${table}`);
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

async function summarize(hasRealtime: boolean): Promise<FeedSummary> {
  const g = instance();
  const agencies = await g.getAgencies();
  const timezone = agencies[0]?.agency_timezone || 'UTC';
  const summary: FeedSummary = {
    agencies: agencies.map((a) => ({ name: a.agency_name, timezone: a.agency_timezone })),
    timezone,
    stopCount: await count('stops'),
    routeCount: await count('routes'),
    hasRealtime,
  };
  try {
    const rows = await rawQuery(
      `SELECT MIN(d) AS start, MAX(d) AS end FROM (
         SELECT start_date AS d FROM calendar
         UNION SELECT end_date FROM calendar
         UNION SELECT date FROM calendar_dates
       ) WHERE d IS NOT NULL`
    );
    if (rows[0]?.start && rows[0]?.end) {
      summary.serviceDateRange = { start: String(rows[0].start), end: String(rows[0].end) };
    }
  } catch {
    // calendar tables may be absent or empty — the range is optional
  }
  return summary;
}

async function closeCurrent(): Promise<void> {
  if (gtfs) {
    const g = gtfs;
    gtfs = null;
    await g.close();
  }
}

async function saveSnapshot(title: string, rtUrls: string[]): Promise<void> {
  // Best-effort: a failed snapshot (quota, private mode) must not fail the load.
  try {
    const data = await instance().export();
    await saveLastFeedSnapshot({ data, title, rtUrls, savedAt: Date.now() });
  } catch {
    // no snapshot — "reload last feed" just won't be instant
  }
}

function rethrowWithMemoryHint(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/memory|allocat|out of bounds|OOM/i.test(message)) {
    throw new Error(
      `${message} — the feed may be too large for the browser; retry with shapes.txt skipped`
    );
  }
  throw error instanceof Error ? error : new Error(message);
}

const api: GtfsWorkerApi = {
  async loadFromZipUrl(zipUrl, rtUrls, onProgress, options) {
    await closeCurrent();
    try {
      gtfs = await GtfsSqlJs.fromZip(zipUrl, await buildOptions(rtUrls, onProgress, options));
    } catch (error) {
      rethrowWithMemoryHint(error);
    }
    const summary = await summarize(rtUrls.length > 0);
    await saveSnapshot(options?.title ?? zipUrl, rtUrls);
    return summary;
  },

  async loadFromZipData(bytes, rtUrls, onProgress, options) {
    await closeCurrent();
    try {
      gtfs = await GtfsSqlJs.fromZipData(bytes, await buildOptions(rtUrls, onProgress, options));
    } catch (error) {
      rethrowWithMemoryHint(error);
    }
    const summary = await summarize(rtUrls.length > 0);
    await saveSnapshot(options?.title ?? 'local file', rtUrls);
    return summary;
  },

  async getLastFeedInfo() {
    try {
      return await getLastFeedInfo();
    } catch {
      return null;
    }
  },

  async restoreLastFeed(onProgress) {
    const snapshot = await getLastFeedSnapshot();
    if (!snapshot) throw new Error('No saved feed to restore');
    await closeCurrent();
    onProgress({
      phase: 'loading_from_cache',
      currentFile: null,
      filesCompleted: 0,
      totalFiles: 0,
      rowsProcessed: 0,
      totalRows: 0,
      percentComplete: 50,
      message: `Restoring ${snapshot.title} from cache…`,
    });
    gtfs = await GtfsSqlJs.fromDatabase(snapshot.data, {
      adapter: await createSqlJsAdapter({ locateFile: () => sqlWasmUrl }),
      realtimeFeedUrls: snapshot.rtUrls,
    });
    return summarize(snapshot.rtUrls.length > 0);
  },

  getAgencies: () => instance().getAgencies(),
  getStops: (filters) => instance().getStops(filters),
  getRoutes: (filters) => instance().getRoutes(filters),
  getTrips: (filters) => instance().getTrips(filters),
  getStopTimes: (filters) => instance().getStopTimes(filters),
  getTripSchedules: (filters) => instance().getTripSchedules(filters),
  getAlerts: (filters) => instance().getAlerts(filters),
  getVehiclePositions: (filters) => instance().getVehiclePositions(filters),
  getActiveServiceIds: (date) => instance().getActiveServiceIds(date),

  async fetchRealtimeData() {
    const g = instance();
    await g.fetchRealtimeData();
    return g.getLastRealtimeFetchTimestamp();
  },

  rawQuery: (sql, params) => rawQuery(sql, params),

  async listAllStopsLight() {
    const rows = await rawQuery(
      `SELECT stop_id, stop_name, stop_code, stop_lat, stop_lon, parent_station
       FROM stops
       WHERE stop_name IS NOT NULL AND stop_name != ''`
    );
    return rows.map(
      (r): StopLight => ({
        stop_id: String(r.stop_id),
        stop_name: String(r.stop_name),
        stop_code: r.stop_code == null ? null : String(r.stop_code),
        stop_lat: r.stop_lat == null ? null : Number(r.stop_lat),
        stop_lon: r.stop_lon == null ? null : Number(r.stop_lon),
        parent_station:
          r.parent_station == null || r.parent_station === '' ? null : String(r.parent_station),
      })
    );
  },

  close: () => closeCurrent(),
};

Comlink.expose(api);

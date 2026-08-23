import type {
  Agency,
  Alert,
  AlertFilters,
  GtfsSqlJsOptions,
  Route,
  RouteFilters,
  Row,
  SqlValue,
  Stop,
  StopFilters,
  StopTime,
  StopTimeFilters,
  Trip,
  TripFilters,
  TripSchedule,
  TripScheduleFilters,
  VehiclePosition,
  VehiclePositionFilters,
} from 'gtfs-sqljs';

/** ProgressInfo is not re-exported by gtfs-sqljs v0.8 — derive it from the options type. */
export type ProgressInfo = Parameters<NonNullable<GtfsSqlJsOptions['onProgress']>>[0];

export interface FeedSummary {
  agencies: { name: string; timezone: string }[];
  /** Timezone of the first agency — used for all user-facing times. */
  timezone: string;
  stopCount: number;
  routeCount: number;
  hasRealtime: boolean;
  serviceDateRange?: { start: string; end: string };
}

export interface StopLight {
  stop_id: string;
  stop_name: string;
  stop_code: string | null;
  stop_lat: number | null;
  stop_lon: number | null;
}

export interface LoadOptions {
  /** Retry knob for very large feeds: skip shapes.txt to reduce memory. */
  skipShapes?: boolean;
}

/** API exposed by the GTFS worker via Comlink. Every method is async. */
export interface GtfsWorkerApi {
  loadFromZipUrl(
    zipUrl: string,
    rtUrls: string[],
    onProgress: (progress: ProgressInfo) => void,
    options?: LoadOptions
  ): Promise<FeedSummary>;
  loadFromZipData(
    bytes: Uint8Array,
    rtUrls: string[],
    onProgress: (progress: ProgressInfo) => void,
    options?: LoadOptions
  ): Promise<FeedSummary>;

  getAgencies(): Promise<Agency[]>;
  getStops(filters?: StopFilters): Promise<Stop[]>;
  getRoutes(filters?: RouteFilters): Promise<Route[]>;
  getTrips(filters?: TripFilters): Promise<Trip[]>;
  getStopTimes(filters?: StopTimeFilters & { date?: string }): Promise<StopTime[]>;
  getTripSchedules(filters: TripScheduleFilters): Promise<TripSchedule[]>;
  getAlerts(filters?: AlertFilters): Promise<Alert[]>;
  getVehiclePositions(filters?: VehiclePositionFilters): Promise<VehiclePosition[]>;
  getActiveServiceIds(date: string): Promise<string[]>;
  /** Fetch GTFS-RT feeds; returns the last successful fetch unix timestamp. */
  fetchRealtimeData(): Promise<number | null>;
  /** Read-only raw SQL against the GTFS database. */
  rawQuery(sql: string, params?: SqlValue[]): Promise<Row[]>;
  /** Light stop list for building the MiniSearch index. */
  listAllStopsLight(): Promise<StopLight[]>;
  close(): Promise<void>;
}

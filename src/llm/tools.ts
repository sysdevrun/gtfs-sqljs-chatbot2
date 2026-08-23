import type Anthropic from '@anthropic-ai/sdk';
import type { Remote } from 'comlink';
import { AlertEffect } from 'gtfs-sqljs';
import type { Route, TripSchedule, TripScheduleStop } from 'gtfs-sqljs';
import type { FeedSummary, GtfsWorkerApi } from '../worker/api';
import type { StopIndex } from '../search/stopIndex';
import { epochToHM, nowUnix, serviceDateInTz } from '../lib/time';

const RT_STALENESS_SECONDS = 120;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export interface ToolContext {
  worker: Remote<GtfsWorkerApi>;
  stopIndex: StopIndex;
  summary: FeedSummary;
  lastRtFetch: number | null;
}

/** Human-readable labels shown in the UI while a tool runs. */
export const TOOL_LABELS: Record<string, string> = {
  search_stops: 'Searching stops…',
  find_nearby_stops: 'Finding nearby stops…',
  list_routes: 'Listing routes…',
  get_stop_departures: 'Fetching departures…',
  get_trip_schedule: 'Fetching trip schedule…',
  get_route_schedule: 'Fetching route schedule…',
  get_alerts: 'Checking alerts…',
  get_vehicle_positions: 'Locating vehicles…',
  refresh_realtime: 'Refreshing realtime data…',
};

function clampLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing required string parameter "${name}"`);
  }
  return value;
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function maybeRefreshRealtime(ctx: ToolContext): Promise<void> {
  if (!ctx.summary.hasRealtime) return;
  const now = nowUnix();
  if (ctx.lastRtFetch !== null && now - ctx.lastRtFetch < RT_STALENESS_SECONDS) return;
  try {
    ctx.lastRtFetch = (await ctx.worker.fetchRealtimeData()) ?? now;
  } catch {
    // realtime is best-effort; scheduled data still works without it
  }
}

interface DepartureRow {
  epoch: number;
  time: string;
  realtime: boolean;
  delay_min?: number;
  route?: string;
  headsign?: string;
  trip_id: string;
  canceled?: boolean;
  skipped?: boolean;
}

function scheduleStopToDeparture(
  schedule: TripSchedule,
  stop: TripScheduleStop,
  routesById: Map<string, Route>
): DepartureRow | null {
  if (stop.display_epoch == null) return null;
  const route = routesById.get(schedule.trip.route_id);
  const row: DepartureRow = {
    epoch: stop.display_epoch,
    time: epochToHM(stop.display_epoch, schedule.timezone),
    realtime: stop.display_is_realtime,
    trip_id: schedule.trip.trip_id,
  };
  if (stop.display_is_realtime && stop.display_delay != null) {
    row.delay_min = Math.round(stop.display_delay / 60);
  }
  const routeName = route?.route_short_name || route?.route_long_name;
  if (routeName) row.route = routeName;
  const headsign = schedule.trip.trip_headsign || stop.stop_headsign;
  if (headsign) row.headsign = headsign;
  if (schedule.canceled) row.canceled = true;
  if (stop.skipped) row.skipped = true;
  return row;
}

function translated(text?: { translation: Array<{ text: string }> }): string | undefined {
  return text?.translation?.[0]?.text;
}

function effectName(effect?: AlertEffect): string | undefined {
  if (effect == null) return undefined;
  const name = AlertEffect[effect];
  return typeof name === 'string' ? name : String(effect);
}

type ToolImpl = (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;

const implementations: Record<string, ToolImpl> = {
  async search_stops(ctx, input) {
    const query = asString(input.query, 'query');
    const limit = clampLimit(input.limit, 8);
    const results = ctx.stopIndex.search(query, limit).map((r) => ({
      stop_id: r.stop_id,
      stop_name: r.stop_name,
      ...(r.stop_code ? { stop_code: r.stop_code } : {}),
    }));
    if (results.length === 0) {
      return { results: [], hint: 'no stop matches this query; try fewer or different words' };
    }
    return { results };
  },

  async find_nearby_stops(ctx, input) {
    const lat = optNumber(input.lat);
    const lon = optNumber(input.lon);
    if (lat === undefined || lon === undefined) {
      throw new Error('lat and lon are required numbers');
    }
    const radius = Math.min(optNumber(input.radius_m) ?? 500, 5000);
    const dLat = radius / 111320;
    const dLon = radius / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    const rows = await ctx.worker.rawQuery(
      `SELECT stop_id, stop_name, stop_code, stop_lat, stop_lon FROM stops
       WHERE stop_lat BETWEEN ? AND ? AND stop_lon BETWEEN ? AND ?`,
      [lat - dLat, lat + dLat, lon - dLon, lon + dLon]
    );
    const toRad = (d: number) => (d * Math.PI) / 180;
    const withDistance = rows
      .filter((r) => r.stop_lat != null && r.stop_lon != null)
      .map((r) => {
        const sLat = Number(r.stop_lat);
        const sLon = Number(r.stop_lon);
        const a =
          Math.sin(toRad(sLat - lat) / 2) ** 2 +
          Math.cos(toRad(lat)) * Math.cos(toRad(sLat)) * Math.sin(toRad(sLon - lon) / 2) ** 2;
        const distance = Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
        return {
          stop_id: String(r.stop_id),
          stop_name: String(r.stop_name),
          ...(r.stop_code ? { stop_code: String(r.stop_code) } : {}),
          distance_m: distance,
        };
      })
      .filter((r) => r.distance_m <= radius)
      .sort((a, b) => a.distance_m - b.distance_m)
      .slice(0, clampLimit(input.limit, 10));
    if (withDistance.length === 0) {
      return { results: [], hint: 'no stops within this radius' };
    }
    return { results: withDistance };
  },

  async list_routes(ctx, input) {
    const query = optString(input.query)?.toLowerCase();
    const routes = await ctx.worker.getRoutes();
    const filtered = query
      ? routes.filter(
          (r) =>
            r.route_short_name?.toLowerCase().includes(query) ||
            r.route_long_name?.toLowerCase().includes(query)
        )
      : routes;
    const results = filtered.slice(0, MAX_LIMIT).map((r) => ({
      route_id: r.route_id,
      ...(r.route_short_name ? { short_name: r.route_short_name } : {}),
      ...(r.route_long_name ? { long_name: r.route_long_name } : {}),
      type: r.route_type,
    }));
    if (results.length === 0) {
      return { results: [], hint: 'no route matches this query' };
    }
    return { results, total_matching: filtered.length };
  },

  async get_stop_departures(ctx, input) {
    const stopId = asString(input.stop_id, 'stop_id');
    const tz = ctx.summary.timezone;
    const date = optString(input.date) ?? serviceDateInTz(tz);
    const limit = clampLimit(input.limit);
    const now = nowUnix();
    await maybeRefreshRealtime(ctx);

    // A parent station's departures live on its child platforms/quays.
    const childRows = await ctx.worker.rawQuery(
      `SELECT stop_id FROM stops WHERE parent_station = ?`,
      [stopId]
    );
    const stopIds = [stopId, ...childRows.map((r) => String(r.stop_id))];
    const stopIdSet = new Set(stopIds);

    const stopTimes = await ctx.worker.getStopTimes({ stopId: stopIds, date });
    if (stopTimes.length === 0) {
      return { date, stop_id: stopId, departures: [], hint: 'no service at this stop on this date' };
    }
    const tripIds = [...new Set(stopTimes.map((st) => st.trip_id))].slice(0, 500);
    const schedules = await ctx.worker.getTripSchedules({ tripId: tripIds, date, now });

    const routeIds = [...new Set(schedules.map((s) => s.trip.route_id))];
    const routes = routeIds.length > 0 ? await ctx.worker.getRoutes({ routeId: routeIds }) : [];
    const routesById = new Map(routes.map((r) => [r.route_id, r]));

    const departures: DepartureRow[] = [];
    for (const schedule of schedules) {
      for (const stop of schedule.stops) {
        if (!stopIdSet.has(stop.stop_id)) continue;
        if (stop.is_last) continue; // terminus arrivals are not departures
        const row = scheduleStopToDeparture(schedule, stop, routesById);
        if (row && row.epoch >= now - 30) departures.push(row);
      }
    }
    departures.sort((a, b) => a.epoch - b.epoch);
    const shaped = departures.slice(0, limit).map(({ epoch: _epoch, ...rest }) => rest);
    if (shaped.length === 0) {
      return {
        date,
        stop_id: stopId,
        departures: [],
        hint: 'no departures after the current time on this service date; try the next service date',
      };
    }
    return {
      date,
      stop_id: stopId,
      now_local: epochToHM(now, tz),
      timezone: tz,
      realtime_active: ctx.summary.hasRealtime && ctx.lastRtFetch !== null,
      departures: shaped,
    };
  },

  async get_trip_schedule(ctx, input) {
    const tripId = asString(input.trip_id, 'trip_id');
    const date = asString(input.date, 'date');
    await maybeRefreshRealtime(ctx);
    const schedules = await ctx.worker.getTripSchedules({ tripId, date, now: nowUnix() });
    const schedule = schedules[0];
    if (!schedule) {
      return { trip_id: tripId, date, stops: [], hint: 'trip not found or not running on this date' };
    }
    const routes = await ctx.worker.getRoutes({ routeId: schedule.trip.route_id });
    const route = routes[0];
    return {
      trip_id: tripId,
      date,
      timezone: schedule.timezone,
      route: route?.route_short_name || route?.route_long_name,
      headsign: schedule.trip.trip_headsign,
      canceled: schedule.canceled,
      has_realtime: schedule.has_realtime,
      stops: schedule.stops.map((s) => ({
        stop_id: s.stop_id,
        stop_name: s.stop_name,
        time: s.display_epoch != null ? epochToHM(s.display_epoch, schedule.timezone) : null,
        realtime: s.display_is_realtime,
        ...(s.display_is_realtime && s.display_delay != null
          ? { delay_min: Math.round(s.display_delay / 60) }
          : {}),
        ...(s.skipped ? { skipped: true } : {}),
        ...(s.no_data ? { no_data: true } : {}),
      })),
    };
  },

  async get_route_schedule(ctx, input) {
    const routeId = asString(input.route_id, 'route_id');
    const date = asString(input.date, 'date');
    const directionId = optNumber(input.direction_id);
    await maybeRefreshRealtime(ctx);
    const schedules = await ctx.worker.getTripSchedules({
      routeId,
      date,
      ...(directionId !== undefined ? { directionId } : {}),
      now: nowUnix(),
    });
    if (schedules.length === 0) {
      return { route_id: routeId, date, trips: [], hint: 'no service on this route on this date' };
    }
    const timezone = schedules[0].timezone;
    const trips = schedules
      .map((s) => {
        const first = s.stops[0];
        const last = s.stops[s.stops.length - 1];
        return {
          trip_id: s.trip.trip_id,
          ...(s.trip.trip_headsign ? { headsign: s.trip.trip_headsign } : {}),
          ...(s.trip.direction_id != null ? { direction_id: s.trip.direction_id } : {}),
          start: first?.display_epoch != null ? epochToHM(first.display_epoch, timezone) : null,
          end: last?.display_epoch != null ? epochToHM(last.display_epoch, timezone) : null,
          startEpoch: first?.display_epoch ?? Number.MAX_SAFE_INTEGER,
          ...(s.canceled ? { canceled: true } : {}),
        };
      })
      .sort((a, b) => a.startEpoch - b.startEpoch)
      .map(({ startEpoch: _startEpoch, ...rest }) => rest);
    return {
      route_id: routeId,
      date,
      timezone,
      trip_count: trips.length,
      first_departure: trips[0]?.start ?? null,
      last_departure: trips[trips.length - 1]?.start ?? null,
      trips: trips.slice(0, MAX_LIMIT),
      ...(trips.length > MAX_LIMIT ? { hint: `showing ${MAX_LIMIT} of ${trips.length} trips` } : {}),
    };
  },

  async get_alerts(ctx, input) {
    if (!ctx.summary.hasRealtime) {
      return { alerts: [], hint: 'this feed has no realtime data configured' };
    }
    await maybeRefreshRealtime(ctx);
    const alerts = await ctx.worker.getAlerts({
      ...(optString(input.route_id) ? { routeId: optString(input.route_id) } : {}),
      ...(optString(input.stop_id) ? { stopId: optString(input.stop_id) } : {}),
      activeOnly: true,
    });
    if (alerts.length === 0) {
      return { alerts: [], hint: 'no active alerts' };
    }
    const tz = ctx.summary.timezone;
    return {
      alerts: alerts.slice(0, 15).map((a) => ({
        id: a.id,
        header: translated(a.header_text),
        description: translated(a.description_text)?.slice(0, 400),
        effect: effectName(a.effect),
        active_period: a.active_period?.map((p) => ({
          ...(p.start ? { from: epochToHM(p.start, tz) } : {}),
          ...(p.end ? { until: epochToHM(p.end, tz) } : {}),
        })),
      })),
    };
  },

  async get_vehicle_positions(ctx, input) {
    if (!ctx.summary.hasRealtime) {
      return { vehicles: [], hint: 'this feed has no realtime data configured' };
    }
    await maybeRefreshRealtime(ctx);
    const routeId = optString(input.route_id);
    const vehicles = await ctx.worker.getVehiclePositions(routeId ? { routeId } : undefined);
    if (vehicles.length === 0) {
      return { vehicles: [], hint: 'no vehicle positions available right now' };
    }
    return {
      vehicles: vehicles.slice(0, MAX_LIMIT).map((v) => ({
        trip_id: v.trip_id,
        ...(v.route_id ? { route_id: v.route_id } : {}),
        ...(v.vehicle?.label || v.vehicle?.id ? { vehicle: v.vehicle.label || v.vehicle.id } : {}),
        ...(v.position ? { lat: v.position.latitude, lon: v.position.longitude } : {}),
        ...(v.stop_id ? { stop_id: v.stop_id } : {}),
        ...(v.current_status != null ? { status: v.current_status } : {}),
      })),
    };
  },

  async refresh_realtime(ctx) {
    if (!ctx.summary.hasRealtime) {
      return { hint: 'this feed has no realtime data configured' };
    }
    const timestamp = await ctx.worker.fetchRealtimeData();
    ctx.lastRtFetch = timestamp ?? nowUnix();
    return {
      fetched: timestamp != null,
      ...(timestamp != null
        ? { fetched_at: epochToHM(timestamp, ctx.summary.timezone) }
        : { hint: 'realtime fetch did not succeed' }),
    };
  },
};

export async function executeTool(
  ctx: ToolContext,
  name: string,
  input: unknown
): Promise<string> {
  const impl = implementations[name];
  if (!impl) return JSON.stringify({ error: `unknown tool: ${name}` });
  try {
    const args = (input ?? {}) as Record<string, unknown>;
    const result = await impl(ctx, args);
    return JSON.stringify(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: message });
  }
}

const limitSchema = {
  type: 'number',
  description: `Maximum results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
} as const;

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'search_stops',
    description:
      'Fuzzy-search stops by name or code. ALWAYS use this to resolve a stop name to a stop_id before calling any schedule tool — never guess stop IDs. Handles typos and missing accents.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Stop name or code as given by the user' },
        limit: limitSchema,
      },
      required: ['query'],
    },
  },
  {
    name: 'find_nearby_stops',
    description: 'Find stops near a latitude/longitude, sorted by distance.',
    input_schema: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lon: { type: 'number' },
        radius_m: { type: 'number', description: 'Search radius in meters (default 500, max 5000)' },
        limit: limitSchema,
      },
      required: ['lat', 'lon'],
    },
  },
  {
    name: 'list_routes',
    description: 'List routes of the feed, optionally filtered by a name fragment.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional filter on route short/long name' },
      },
      required: [],
    },
  },
  {
    name: 'get_stop_departures',
    description:
      'Next departures from a stop (includes child platforms of a station). Times are HH:MM in the feed timezone, realtime-resolved when available. Requires a stop_id from search_stops or find_nearby_stops.',
    input_schema: {
      type: 'object',
      properties: {
        stop_id: { type: 'string' },
        date: {
          type: 'string',
          description:
            'Service date YYYYMMDD (default: today in the feed timezone). Late-night trips may belong to the previous service date.',
        },
        limit: limitSchema,
      },
      required: ['stop_id'],
    },
  },
  {
    name: 'get_trip_schedule',
    description: 'Full ordered stop list of one trip with realtime-resolved times.',
    input_schema: {
      type: 'object',
      properties: {
        trip_id: { type: 'string' },
        date: { type: 'string', description: 'Service date YYYYMMDD' },
      },
      required: ['trip_id', 'date'],
    },
  },
  {
    name: 'get_route_schedule',
    description:
      "Summary of a route's trips for one service date: trip count, first/last departures, per-trip start and end times.",
    input_schema: {
      type: 'object',
      properties: {
        route_id: { type: 'string' },
        date: { type: 'string', description: 'Service date YYYYMMDD' },
        direction_id: { type: 'number', description: 'Optional GTFS direction_id (0 or 1)' },
      },
      required: ['route_id', 'date'],
    },
  },
  {
    name: 'get_alerts',
    description: 'Active service alerts, optionally filtered by route or stop.',
    input_schema: {
      type: 'object',
      properties: {
        route_id: { type: 'string' },
        stop_id: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'get_vehicle_positions',
    description: 'Current realtime vehicle positions, optionally filtered by route.',
    input_schema: {
      type: 'object',
      properties: {
        route_id: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'refresh_realtime',
    description:
      'Force a refresh of the GTFS-RT feeds. Departure tools already auto-refresh when data is older than 2 minutes; use this only if the user explicitly asks for the latest data.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    // Last tool definition carries the cache breakpoint: the whole static
    // prefix (all tool definitions) is cached across the agent loop's calls.
    cache_control: { type: 'ephemeral' },
  },
];

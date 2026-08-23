/**
 * Time helpers. All user-facing times come from getTripSchedules epochs and are
 * formatted in the feed's timezone here so the model never does time math.
 */

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** Format a unix epoch as HH:MM in the given IANA timezone. */
export function epochToHM(epoch: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    }).format(new Date(epoch * 1000));
  } catch {
    return new Date(epoch * 1000).toISOString().slice(11, 16) + 'Z';
  }
}

/** Full local date-time string in the given timezone, for the system prompt. */
export function epochToLocalString(epoch: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: timezone,
    }).format(new Date(epoch * 1000));
  } catch {
    return new Date(epoch * 1000).toISOString();
  }
}

/** Current calendar date in the given timezone, as YYYYMMDD (a GTFS service date). */
export function serviceDateInTz(timezone: string, epoch = nowUnix()): string {
  try {
    // en-CA formats as YYYY-MM-DD
    const iso = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone,
    }).format(new Date(epoch * 1000));
    return iso.replaceAll('-', '');
  } catch {
    return new Date(epoch * 1000).toISOString().slice(0, 10).replaceAll('-', '');
  }
}

/** The service date one day before the given YYYYMMDD date. */
export function previousServiceDate(yyyymmdd: string): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

/** Local hour of day (0-23) in the given timezone. */
export function hourInTz(timezone: string, epoch = nowUnix()): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hour12: false,
      timeZone: timezone,
    }).format(new Date(epoch * 1000));
    return Number(h) % 24;
  } catch {
    return new Date(epoch * 1000).getUTCHours();
  }
}

const API_KEY = 'gtfschat:apiKey';
const MODEL = 'gtfschat:model';
const LAST_FEED = 'gtfschat:lastFeed';

export const DEFAULT_MODEL = 'claude-haiku-4-5';
export const MODELS = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fast, cheap)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (smarter)' },
];

export interface LastFeed {
  url: string;
  title: string;
  gtfsRtUrls?: string[];
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode) — settings just won't persist
  }
}

export function getApiKey(): string {
  return safeGet(API_KEY) ?? '';
}

export function setApiKey(key: string): void {
  safeSet(API_KEY, key || null);
}

export function getModel(): string {
  return safeGet(MODEL) ?? DEFAULT_MODEL;
}

export function setModel(model: string): void {
  safeSet(MODEL, model);
}

export function getLastFeed(): LastFeed | null {
  const raw = safeGet(LAST_FEED);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LastFeed;
    if (typeof parsed.url === 'string' && typeof parsed.title === 'string') return parsed;
  } catch {
    // corrupted entry — ignore
  }
  return null;
}

export function setLastFeed(feed: LastFeed | null): void {
  safeSet(LAST_FEED, feed ? JSON.stringify(feed) : null);
}

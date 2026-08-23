import MiniSearch from 'minisearch';
import type { StopLight } from '../worker/api';

/** Lowercase + strip diacritics, applied to both indexing and querying. */
function normalize(term: string): string {
  return term.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

export interface StopSearchResult {
  stop_id: string;
  stop_name: string;
  stop_code: string | null;
  stop_lat: number | null;
  stop_lon: number | null;
  parent_station: string | null;
  score: number;
}

export class StopIndex {
  private index: MiniSearch<StopLight>;

  constructor(stops: StopLight[]) {
    this.index = new MiniSearch<StopLight>({
      idField: 'stop_id',
      fields: ['stop_name', 'stop_code'],
      storeFields: ['stop_id', 'stop_name', 'stop_code', 'stop_lat', 'stop_lon', 'parent_station'],
      processTerm: normalize,
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
        processTerm: normalize,
      },
    });
    const seen = new Set<string>();
    const unique = stops.filter((s) => {
      if (seen.has(s.stop_id)) return false;
      seen.add(s.stop_id);
      return true;
    });
    this.index.addAll(unique);
  }

  search(query: string, limit = 8): StopSearchResult[] {
    return this.index.search(query).slice(0, limit).map((r) => ({
      stop_id: r.stop_id as string,
      stop_name: r.stop_name as string,
      stop_code: (r.stop_code ?? null) as string | null,
      stop_lat: (r.stop_lat ?? null) as number | null,
      stop_lon: (r.stop_lon ?? null) as number | null,
      parent_station: (r.parent_station ?? null) as string | null,
      score: r.score,
    }));
  }
}

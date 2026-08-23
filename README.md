# GTFS Chat

**Live app: <https://sysdevrun.github.io/gtfs-sqljs-chatbot2/>**

A fully static, browser-only chatbot for **any GTFS transit feed**. Pick a feed (search, URL, or drag & drop a ZIP), it loads into an in-browser SQLite database ([gtfs-sqljs](https://github.com/sysdevrun/gtfs-sqljs) in a Web Worker), and you chat with a Claude model that answers transit questions — stops, routes, next departures, realtime delays, alerts — by calling client-side tools that query that database.

**No backend.** Deployed on GitHub Pages. **BYOK**: you paste your own Anthropic API key; it is stored in `localStorage` and sent only to `api.anthropic.com`, directly from your browser.

## How it works

- **Feed selection** — [react-gtfs-selector](https://www.npmjs.com/package/react-gtfs-selector) with transport.data.gouv.fr and Mobility Database sources, plus direct URL and local ZIP drag & drop. Third-party URLs are wrapped with the SysDevRun CORS proxy.
- **GTFS engine** — `gtfs-sqljs` (v0.8, async adapter API) + `sql.js` running in a Web Worker via `comlink`, with an IndexedDB cache so reloading the same feed takes ~1 second.
- **Stop search** — a MiniSearch fuzzy/prefix index (diacritics-insensitive) built after feed load; the model resolves stop names through it and never guesses stop IDs.
- **Agent loop** — `@anthropic-ai/sdk` with `dangerouslyAllowBrowser: true`, streaming responses and client-side tool use (`search_stops`, `get_stop_departures`, `get_trip_schedule`, `get_route_schedule`, `get_alerts`, `get_vehicle_positions`, …). Departures/arrivals come from `getTripSchedules()`, which handles past-midnight times, timezones/DST, and GTFS-RT delay resolution.

## Development

```bash
npm install
npm run dev        # local dev server
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
```

## Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`, which builds and deploys `dist/` to GitHub Pages (repo Settings → Pages → Source: **GitHub Actions**). `vite.config.ts` uses `base: './'` so the site works under `https://<owner>.github.io/<repo>/`.

## Security notes

- Your API key lives only in this browser's `localStorage` and is only ever sent to `api.anthropic.com`. Use a dedicated key with a spend limit.
- No raw HTML is rendered from model output (`react-markdown` without HTML plugins) and a CSP meta tag restricts scripts to the app bundle (plus `wasm-unsafe-eval` required by sql.js).

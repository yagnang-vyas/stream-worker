# StreamWorker Console

A React + TypeScript frontend for StreamWorker: an **operations dashboard** over the existing optional admin API and a
browser-only **playground** that teaches the reliability mechanics. It is entirely separate from the Python package:
nothing in `src/streamworker`, the Lua scripts, the CLI, `compose.yaml` or the library's CI depends on it, and the
library works without Node.js.

Stack: Vite, React 18, TypeScript (strict), Tailwind CSS, Lucide icons, Recharts, Vitest + Testing Library.
Components are small shadcn-style primitives (class-variance-authority + tailwind-merge) in `src/components/ui.tsx`.

## Quick start

```bash
cd frontend
npm ci
npm run dev        # http://localhost:5173
```

To see live data in development, run an admin API (see the main README, "Admin API") and point the dev proxy at it:

```bash
STREAMWORKER_ADMIN_URL=http://127.0.0.1:8000 npm run dev   # proxies /api -> the admin API
```

Open **System Connection**, keep the base URL `/api`, and enter the admin API key. The Playground needs none of this.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | dev server (optionally proxying `/api`) |
| `npm run typecheck` | `tsc` in strict mode |
| `npm test` | Vitest unit and component tests (mocked `fetch`, deterministic fixtures) |
| `npm run build` | type-check and production build into `dist/` |
| `node scripts/check-bundle.mjs` | builds with sentinel secrets in the environment and fails if any reach the bundle |
| `npm run check` | all of the above |

## Features

**Dashboard** (needs a connection): Overview, Queues, Queue detail, Job Explorer, Dead Letter Queue, using only these
admin endpoints: `GET /queues`, `GET /queues/{name}`, `GET /queues/{name}/dead?limit&cursor&include_payload`,
`POST /queues/{name}/dead/{id}/requeue`, `DELETE /queues/{name}/dead/{id}`.

* Statistics are exactly `length`, `pending`, `consumers`, `delayed`, `dead`, `oldest_pending_age_ms`. They describe the
  **current state** of each queue, not history: acknowledged jobs are deleted, so there are no completed totals,
  throughput, latency or success rates, and none are shown.
* The admin API cannot list ready, pending or delayed jobs. The Job Explorer therefore searches dead-letter entries only.
* Dead-letter payloads are hidden by default; "Reveal payload" re-fetches the page with `include_payload=true` and shows
  that one payload until you hide it or change page.
* **Requeue** returns the job to the ready stream with its attempt reset to 1 and may run the handler again; it needs an
  explicit confirmation. **Purge** permanently deletes one entry and requires typing its entry id. There is no bulk purge.
  The UI shows the server's actual response and never claims a requeued job succeeded.

**Playground** (Simulation Mode, no server): enqueue simulator, lifecycle scenarios, retry/backoff lab, worker crash and
recovery, idempotency, dead-letter requeue/purge, concurrency/ordering illustration. Everything is labelled
**SIMULATED**; demo ids look like `demo-0001`; handlers are scripted and no user code is ever executed. The engine
(`src/sim/`) is pure TypeScript, never imports the API client and makes no network calls (a test enforces this).
It follows `SPEC.md` §5–6 in simplified form: `XAUTOCLAIM` after the visibility timeout, poison dead-lettering when
deliveries exceed `max_attempts`, retry creating a new entry, requeue resetting the attempt to 1. It is an illustration,
not a Redis test. The backoff formulas are checked against `streamworker.ExponentialBackoff`; regenerate the fixture with
`python frontend/scripts/gen_backoff_fixture.py` after changing the Python implementation.

A "Connected Instance" playground mode is intentionally **not** implemented: the existing endpoints cannot enqueue jobs,
and the console must not add server capabilities.

## Configuration and API-key security

* **API base URL**: entered on the Connection page; default `/api` (same origin). Absolute `http(s)` URLs are accepted;
  URLs containing credentials, query strings or fragments are rejected; plain `http` to a non-local host shows a warning.
* **API key**: typed by the operator, held **in memory only**, sent only in the `X-API-Key` header, cleared on sign-out
  or reload. It is never read from environment variables, written to local/session storage, put in URLs, or logged.
  No secret is compiled in: only `VITE_*` variables can reach a Vite bundle and this app reads none (checked by
  `scripts/check-bundle.mjs`).
* The admin API has one shared key and **no per-user roles**; the console adds none. Put SSO or basic auth in front of it
  if you need to restrict who can open the console.
* Dead-letter entries can contain sensitive payloads and error messages. Treat the console like the Redis dead stream.

## Deployment

The admin API sends **no CORS headers** and this project does not change that. Serve the static build (`dist/`) from the
same origin as the API and reverse-proxy one fixed path to it; see `deploy/nginx.example.conf` (HTTPS, fixed upstream,
CSP, optional extra auth). Do not build an open proxy that accepts arbitrary upstream URLs. The build uses relative asset
paths and hash routing, so it works from any sub-path or static host.

```bash
npm run build   # -> frontend/dist
```

### Netlify

The root `netlify.toml` builds from `frontend/` (`npm run build`, publish `dist`, Node 22) with an SPA fallback and
security headers. Out of the box this is a **playground-only** deploy: the Playground works, and the dashboard shows its
disconnected state because there is no admin API to reach. No environment variables or secrets are needed.

To use the dashboard from Netlify, host the admin API yourself over HTTPS and uncomment the `/api/*` redirect in
`netlify.toml`, pointing it at that one literal host. Netlify then proxies same-origin (the admin API has no CORS), and
the operator types the API key into System Connection with base URL `/api`. Rules: no API key in `netlify.toml` or build
settings (it would be public or baked into assets); one fixed upstream only, never an open proxy; the admin API's shared
key is its only authentication, so also restrict access (Netlify password protection or SSO, or an IP allow-list on the
API). The CSP in `netlify.toml` allows `connect-src 'self'`, which fits the same-origin proxy.

## Limits

* Redis persistence is whatever your Redis provides (use AOF if losing recent jobs matters); the console cannot change it.
* Delivery is at-least-once; handlers must be idempotent. `idempotency_key` only dedupes enqueues within its TTL.
* Polling is off by default; options are 15/30/60 s.

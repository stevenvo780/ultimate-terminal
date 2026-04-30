# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Ultimate Terminal** — distributed remote-terminal system. Three pieces, one repo (npm workspaces):

- `nexus/` — relay server (Node/Express + Socket.IO + SQLite/Postgres). Default port `3002`.
- `worker/` — agent that runs on each target host. Spawns PTY shells via `node-pty`, connects out to Nexus.
- `client/` — React 19 + Vite 7 + Xterm.js web UI, connects to Nexus over Socket.IO. Deployed as a static SPA on Vercel (`vercel.json`).

There is no monolithic deploy: Nexus runs as a long-lived backend, the client is a static SPA, and workers are installed per-host via the universal installer in `packaging/universal_install.sh`.

## Common commands

Run from the repo root unless noted.

```bash
# Dev
npm install                       # install all workspaces
npm run start:nexus               # ts-node nexus/src/index.ts (port 3002)
npm run start:worker              # connects to NEXUS_URL with API_KEY/WORKER_TOKEN
npm run start:client              # vite dev server on :5173
./start-services.sh               # kills stale processes + boots nexus + worker (+ client if START_CLIENT=true)

# Lint / typecheck (no root-level command — run per-workspace)
npm run lint --workspace=client
npx tsc --noEmit --project nexus/tsconfig.json
npx tsc --noEmit --project worker/tsconfig.json
cd client && npm run build        # tsc -b && vite build (also typechecks client)

# Tests
npm run test:e2e                  # vitest: tests/e2e.test.ts + tests/multi-client.test.ts (boots its own nexus on :3003)
npx vitest run tests/e2e.test.ts  # single vitest file
npx playwright test tests/terminal-e2e.spec.ts   # requires Docker stack on :13002/:13003

# Docker dev (8 simulated workers)
docker compose -f docker-compose.dev.yml up -d --build
docker compose -f docker-compose.dev.yml logs -f nexus worker-01   # tail
rm -rf .docker-data/nexus && docker compose -f docker-compose.dev.yml up -d --build   # reseed DB

# Packaging
npm run package:deb               # build nexus + worker .deb -> dist/packages/
npm run package:deb:worker        # worker only
npm run package:deb:ubuntu        # matrix-build worker .deb for ubuntu 20.04/22.04/24.04
```

Note: `npm run docker:deploy` / `docker:test` reference `scripts/docker-deploy.sh` / `scripts/docker-test.sh` which are **not in the repo**; ignore those targets unless the scripts get added.

## Releasing the worker

Releases are tag-driven via GitHub Actions (`.github/workflows/release-worker.yml`). Push a tag matching `worker-v*` and the workflow builds three Ubuntu `.deb`s + a prebuilt source tarball and publishes a GitHub Release. Full process and troubleshooting in `docs/RELEASING.md`.

```bash
git tag -a worker-v1.0.1 -m "Worker v1.0.1" && git push origin worker-v1.0.1
```

The `build-tarball` job copies `worker/` to `$RUNNER_TEMP` before `npm install` — this is **load-bearing**: a plain install at `worker/` would hoist deps to the workspaces root and produce a non-self-contained tarball. Don't "simplify" that step.

## Architecture

### Three roles, one socket protocol

`nexus/src/socket.ts` is the heart of the system. Both clients and workers connect to the same Socket.IO server but authenticate differently in the `io.use()` middleware:

- **Client** sends `auth: { type: 'client', token: <JWT> }`. JWT is issued by `POST /api/auth/login`.
- **Worker** sends `auth: { type: 'worker', apiKey, workerName }`. The API key is provisioned via the client UI / `POST /api/workers` and stored in the `workers` table.

After auth, `socket.data.role` decides which event handlers apply. Clients send `execute` / `resize` / `subscribe` / `join-session` / `close-session` / `rename-session`; workers send `output` / `heartbeat` / `session-shell-exited`. Nexus is a relay — it does not run shells itself.

### Sessions are in-memory on Nexus

`activeSessions: Map<workerId:sessionId, ActiveSession>` and `sessionSubscribers: Map<sessionId, Set<socketId>>` live in `socket.ts`. Session metadata is broadcast via `session-list` (debounced by `SESSION_LIST_DEBOUNCE_MS`, default 500ms), but the in-memory state is **not persisted across Nexus restarts** — there's a `sessions` table in the schema but it is only used for `display_name` updates today. If you ever add restart-survivability, that's the place. (See README "Persistencia de sesiones" caveat.)

### Worker session model

Each worker keeps `sessionShells: Map<sessionId, IPty>`, `sessionDimensions`, and `sessionClientViewports` (per-client cols/rows). When multiple clients view the same session, the PTY is resized to the **min** of all client viewports (`calculateSessionDimensions`). On unexpected shell exit the worker auto-respawns (`AUTO_RESTART_SHELL=true` default) unless the session was explicitly killed via `kill-session`.

Output is buffered (`UT_OUTPUT_FLUSH_MS`, `UT_OUTPUT_MAX_BUFFER`) before emitting to Nexus, to avoid packet storms on noisy commands.

If running as root, the worker drops to a real user via `su -l <user>`. Target user comes from `RUN_AS_USER` env, else first uid≥1000 in `/etc/passwd`.

### Native modules in packaged builds

`worker/src/index.ts` and `nexus/src/config/database.ts` both look for prebuilt native bindings under `/usr/lib/ultimate-terminal/prebuilds/linux-x64/` (installed by the `.deb`) and patch `Module._resolveFilename` to load `pty.node` / `better_sqlite3.node` from there when present. This is what lets the .deb ship a precompiled tree even though `node-pty` and `better-sqlite3` would normally be rebuilt against the local Node. Keep this in mind when changing native deps.

### Database adapter

`nexus/src/config/db-adapter.ts` provides one interface over `better-sqlite3` (default, `.qodo/nexus.db`) and `pg` (when `DATABASE_URL` is set). Schema is created idempotently in `initDatabase()` with inline `ALTER TABLE … ADD COLUMN` migrations guarded by try/catch — that's the migration pattern in this repo. The `${AUTO_INC}` template handles the SQLite vs Postgres syntax difference for primary keys.

### Auth / access control

- Users live in `users` (with bcrypt-style `password_hash` + `salt` and a `plan` column: `free` / `pro` / `enterprise`).
- Workers belong to an owner and can be shared via `worker_shares` with `view` or `control` permission. `WorkerModel.hasAccess(userId, workerId, level)` is the single check used by every privileged socket handler.
- Plan limits (`getUserPlan` + `canOpenSession` in `nexus/src/services/plan-limits.ts`) gate concurrent session count when a client first opens a new session.
- Optional `NEXUS_SETUP_TOKEN` gates the first-time setup / register endpoint.
- `ALLOW_UNAUTHENTICATED_WORKERS=true` accepts workers without a token — explicitly unsafe, only for dev.

### Billing

Nexus runs an internal scheduler (24h interval, also fires 10s after boot) that calls `PaymentService.processExpiredSubscriptions()` to expire subscriptions. Mercado Pago integration lives in `services/payment.service.ts` and `controllers/payment.controller.ts`. Don't add an external cron — the in-process scheduler is the design.

### Client (React)

- State: Redux Toolkit + redux-persist (`client/src/store/slices/*` — auth, sessions, workers, connection, commands, ui).
- Hooks: `useSocket`, `useAuth`, `useTerminalSession` in `client/src/hooks/`.
- Terminal grid: `react-grid-layout` + `react-resizable` allow tiling multiple Xterm panels (`components/Terminal/TerminalGrid.tsx`).
- The CORS rule in `nexus/src/app.ts` whitelists `*.vercel.app` deploys matching `stevenvo780` or `ultimate-terminal` in addition to `CLIENT_ORIGIN`.

## Environment variables

Copy `.env.example` to `.env`. The minimum set:

| Var | Where | Notes |
|---|---|---|
| `PORT` | Nexus | default 3002 |
| `NEXUS_JWT_SECRET` | Nexus | required in prod |
| `ADMIN_PASSWORD` | Nexus | seeds the `admin` user on first boot |
| `WORKER_TOKEN` | Nexus + Worker | shared secret used as worker API key in dev |
| `NEXUS_SETUP_TOKEN` | Nexus | optional, gates first-time register |
| `DATABASE_URL` | Nexus | switches from SQLite to Postgres |
| `DEV_WORKER_SPECS` | Nexus | comma-list of `name:apiKey` to auto-seed workers in dev |
| `CLIENT_ORIGIN` | Nexus | comma-separated allowed origins |
| `NEXUS_URL` | Worker | nexus address |
| `WORKER_NAME` | Worker | display name (defaults to hostname) |
| `RUN_AS_USER` | Worker | which user to `su -l` to when worker runs as root |
| `AUTO_RESTART_SHELL` | Worker | `false` to disable auto-respawn |
| `UT_OUTPUT_FLUSH_MS`, `UT_OUTPUT_MAX_BUFFER` | Worker | tune the output coalescer |
| `VITE_NEXUS_URL` | Client (build-time) | Nexus URL baked into bundle |

## Things to know

- Node is pinned to **22** in worker tooling (`@yao-pkg/pkg --targets node22-linux-x64`). The release tarball uses Node 22 in CI as well.
- Nexus is **not** a Next.js / Vercel function — it's a long-lived Node process with a live Socket.IO server. Only the `client/` SPA is deployed to Vercel.
- The data dir is `.qodo/` by default (override with `NEXUS_DATA_DIR`). The folder name is historical; don't rename it without also updating Docker volumes (`./.docker-data/nexus:/app/.qodo`).
- `tests/*.spec.ts` are Playwright (need a running Docker stack on ports 13002/13003); `tests/*.test.ts` are vitest (self-bootstrapping). Don't mix the two runners on the same file.
- The previous project name was **TermiCoop** — references survive in container names (`termicoop-worker-*`) and the `GEMINI.md` overview file.

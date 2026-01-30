# Ultimate Terminal

A distributed terminal system allowing you to control and view your devices from anywhere.

## Architecture
- **Nexus (Server)**: Relay server (Port 3002).
- **Worker (Agent)**: Runs on the target machine (your PC/VPS). Connects to Nexus.
- **Client (UI)**: Web interface to view and control workers.

## 📦 Generated Installers

| Component | Platform | Location | Description |
|-----------|----------|----------|-------------|
| **Worker** | Linux | `worker/bin/worker-linux` | Standalone binary. Copy to any VPS/PC and run. |

## Development Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Start Nexus (The Hub)**
   ```bash
   npm run start:nexus
   ```

3. **Start Worker (Dev Mode)**
   ```bash
   npm run start:worker
   ```

4. **Start Client (Web Dev Mode)**
   ```bash
   npm run start:client
   ```

## Debian (.deb) Packages

Build .deb packages for Nexus and Worker (systemd + config included):
```bash
npm run package:deb
```
Artifacts are written to `dist/packages/`.

The web client builds to `client/dist` and is bundled into the Nexus package.

## Docker Deploy (3 servicios)

Build .deb packages and deploy Nexus + Worker + Client using Docker:
```bash
npm run docker:deploy
```

Validate stack:
```bash
npm run docker:test
```

Defaults:
- Nexus: `http://localhost:13002` (`NEXUS_PORT`)
- Client: `http://localhost:13003` (`CLIENT_PORT`)
If you change `NEXUS_PORT`, also set `VITE_NEXUS_URL` for the client build.

## Configuration (env)
- Copy `.env.example` to `.env` and adjust as needed.
- Important:
  - Set a strong `NEXUS_JWT_SECRET` (required in production) and `ADMIN_PASSWORD` for first boot.
  - Set the same `WORKER_TOKEN` in Nexus and each worker.
  - Optional: set `NEXUS_SETUP_TOKEN` to allow remote first-time setup (UI has a Setup Token field).
  - Optional: set `ALLOW_UNAUTHENTICATED_WORKERS=true` to accept workers without a token (not recommended).
  - Point `VITE_NEXUS_URL` and `CLIENT_ORIGIN` to your deployment URLs.

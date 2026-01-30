# Ultimate Terminal - Project Overview

**Ultimate Terminal** is a distributed terminal system that allows users to control and view shell sessions on remote devices (Workers) via a central relay server (Nexus) using a web Client interface.

## 🏗 Architecture

The project acts as a monorepo with three main workspaces:

1.  **Nexus (`/nexus`)**
    *   **Role:** The relay server (Hub).
    *   **Tech:** Node.js, Express, Socket.io.
    *   **Function:** Manages connections from Workers and Clients. Routes commands from Clients to Workers and streams terminal output back to Clients.
    *   **Port:** Defaults to `3002`.

2.  **Worker (`/worker`)**
    *   **Role:** The agent running on the target machine (remote PC/VPS).
    *   **Tech:** Node.js, `node-pty`, Socket.io-client, `pkg` (for binary packaging).
    *   **Function:** Connects to Nexus, spawns a local PTY (Pseudo-Terminal) shell (e.g., bash), executes commands received from Nexus, and streams stdout/stderr back.

3.  **Client (`/client`)**
    *   **Role:** The web user interface.
    *   **Tech:** React, Vite, TypeScript, Xterm.js.
    *   **Function:** Connects to Nexus, lists available Workers, and renders an interactive terminal session using Xterm.js.

## 🚀 Getting Started

### Prerequisites
*   Node.js (v18+ recommended)
*   npm

### Installation
From the project root:
```bash
npm install
```

### Running the Development Environment

You typically need three terminal instances running simultaneously:

1.  **Start Nexus (Server)**
    ```bash
    npm run start:nexus
    ```

2.  **Start a Worker (Agent)**
    ```bash
    npm run start:worker
    ```
    *   *Note:* Reads `NEXUS_URL` (default: http://localhost:3002) and `WORKER_NAME`.

3.  **Start Client (Web Interface)**
    ```bash
    npm run start:client
    ```
    *   Access at: `http://localhost:5173`

## 📦 Building & Packaging

### Worker (Standalone Binary)
Creates a single executable binary for Linux (configurable for others in `package.json`).
```bash
npm run package --workspace=worker
# Output: worker/bin/worker-linux
```

### Client (Web)
Builds the web UI to `client/dist` and is served by Nexus in production packaging.
```bash
npm run build --workspace=client
```

## 🛠 Development Conventions

### Communication Protocol (Socket.io)
*   **Events:**
    *   `register`: Sent by Client/Worker to identify themselves.
    *   `worker-list`: Broadcast by Nexus to Clients when workers connect/disconnect.
    *   `execute`: Client -> Nexus -> Worker (Payload: `{ workerId, command }`).
    *   `output`: Worker -> Nexus -> Client (Payload: `{ output }`).
    *   `resize`: Client -> Nexus -> Worker (Payload: `{ cols, rows }`).

### Environment Variables
*   **Nexus:** `PORT`
*   **Worker:** `NEXUS_URL` (Server address), `WORKER_NAME` (Display name), `SHELL` (Shell executable path).

### Code Style
*   **Language:** TypeScript is used across all workspaces.
*   **Linting:** ESLint configuration is present in the `client` workspace.
*   **Formatting:** Follows standard Prettier/EditorConfig patterns (implied).

## 📂 Key File Locations
*   `nexus/src/index.ts`: Main server entry point (socket logic).
*   `worker/src/index.ts`: Main worker logic (pty spawning).
*   `client/src/App.tsx`: Main React component containing the Terminal UI and socket logic.

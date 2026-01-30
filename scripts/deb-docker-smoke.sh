#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.deb.yml"
HOST_PORT="${HOST_PORT:-13002}"

compose() {
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$COMPOSE_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

echo "[1/4] Building .deb packages..."
(cd "$ROOT_DIR" && npm run package:deb)

echo "[2/4] Building docker images..."
compose build

echo "[3/4] Starting stack..."
compose down --remove-orphans >/dev/null 2>&1 || true
compose up -d

echo "[4/4] Waiting for Nexus..."
for _ in {1..30}; do
  if curl -fsS "http://localhost:${HOST_PORT}/api/auth/status" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://localhost:${HOST_PORT}/api/auth/status" >/dev/null 2>&1; then
  echo "Nexus did not become ready in time."
  compose logs --no-color
  exit 1
fi

echo "Nexus is up. Waiting for worker registration..."
NEXUS_ID="$(compose ps -q nexus)"
for _ in {1..30}; do
  if docker logs "$NEXUS_ID" 2>&1 | grep -q "Worker registered"; then
    echo "Worker registered successfully."
    exit 0
  fi
  sleep 1
done

echo "Worker did not register in time."
compose logs --no-color
exit 1

#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"

compose() {
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$COMPOSE_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

echo "[1/3] Construyendo paquetes .deb..."
(cd "$ROOT_DIR" && npm run package:deb)

echo "[2/3] Construyendo imagenes Docker..."
compose build

echo "[3/3] Desplegando stack..."
compose down --remove-orphans >/dev/null 2>&1 || true
compose up -d

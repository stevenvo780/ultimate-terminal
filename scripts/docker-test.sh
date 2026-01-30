#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"
NEXUS_PORT="${NEXUS_PORT:-13002}"
CLIENT_PORT="${CLIENT_PORT:-13003}"

compose() {
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$COMPOSE_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

echo "[1/3] Esperando a Nexus..."
for _ in {1..30}; do
  if curl -fsS "http://localhost:${NEXUS_PORT}/api/auth/status" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://localhost:${NEXUS_PORT}/api/auth/status" >/dev/null 2>&1; then
  echo "Nexus no estuvo listo a tiempo."
  compose logs --no-color
  exit 1
fi

echo "[2/3] Verificando registro del worker..."
NEXUS_ID="$(compose ps -q nexus)"
for _ in {1..30}; do
  if docker logs "$NEXUS_ID" 2>&1 | grep -q "Worker registered"; then
    break
  fi
  sleep 1
done

if ! docker logs "$NEXUS_ID" 2>&1 | grep -q "Worker registered"; then
  echo "El worker no se registro a tiempo."
  compose logs --no-color
  exit 1
fi

echo "[3/3] Verificando cliente web..."
if ! curl -fsS "http://localhost:${CLIENT_PORT}" >/dev/null 2>&1; then
  echo "El cliente web no responde."
  compose logs --no-color
  exit 1
fi

echo "OK: Nexus, Worker y Client responden."

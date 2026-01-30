#!/bin/bash

# 1. Limpieza de procesos anteriores para evitar conflictos de puertos
echo "Deteniendo procesos anteriores..."
pkill -f "vite"
pkill -f "ts-node src/index.ts"
pkill -f "ultimate-terminal"

# Esperar un momento para asegurar que los puertos se liberen
sleep 2

# 2. Iniciar Nexus (Backend)
# setsid: crea una nueva sesión.
# < /dev/null: desconecta la entrada estándar.
# > ... 2>&1: redirige logs para no bloquear la salida.
# &: ejecuta en segundo plano.
echo "Iniciando Nexus..."
setsid npm run start:nexus > nexus.log 2>&1 < /dev/null &

# Esperar a que Nexus inicie
echo "Esperando a Nexus..."
timeout 15 bash -c 'until curl -s http://localhost:3002 > /dev/null; do sleep 0.5; done'

# 3. Iniciar Worker (Agente)
echo "Iniciando Worker..."
setsid npm run start:worker > worker.log 2>&1 < /dev/null &

# 4. Iniciar Client (Frontend) opcional
START_CLIENT="${START_CLIENT:-false}"
CLIENT_URL="http://localhost:5173"
NEXUS_URL="http://localhost:3002"

if [ "$START_CLIENT" = "true" ]; then
  echo "Iniciando Client..."
  setsid npm run start:client > client.log 2>&1 < /dev/null &

  echo "Esperando a Client..."
  timeout 15 bash -c "until curl -s $CLIENT_URL > /dev/null; do sleep 0.5; done"
fi

echo "--- Verificación Final ---"
if [ "$START_CLIENT" = "true" ]; then
  if curl -s -I "$CLIENT_URL" | grep "200 OK"; then
      echo "✅ Cliente ONLINE: $CLIENT_URL"
  else
      echo "❌ Error: El cliente no responde."
      cat client.log | tail -n 10
  fi
fi

if curl -s -I "$NEXUS_URL/api/auth/status" | grep "200 OK"; then
    echo "✅ Nexus ONLINE: $NEXUS_URL"
else
    echo "❌ Error: Nexus no responde."
    cat nexus.log | tail -n 10
fi

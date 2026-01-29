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

# 4. Iniciar Client (Frontend) -> DESACTIVADO: Nexus ya sirve los estáticos en ../client/dist
# echo "Iniciando Client..."
# setsid npm run start:client > client.log 2>&1 < /dev/null &

# Esperar a que el Cliente inicie
echo "Esperando a Client..."
timeout 15 bash -c 'until curl -s http://localhost:5173 > /dev/null; do sleep 0.5; done'

echo "--- Verificación Final ---"
if curl -s -I http://localhost:5173 | grep "200 OK"; then
    echo "✅ Cliente ONLINE: http://localhost:5173"
else
    echo "❌ Error: El cliente no responde."
    cat client.log | tail -n 10
fi

if curl -s -I http://localhost:3002 | grep "404"; then
    echo "✅ Nexus ONLINE: http://localhost:3002"
else
    echo "❌ Error: Nexus no responde."
    cat nexus.log | tail -n 10
fi
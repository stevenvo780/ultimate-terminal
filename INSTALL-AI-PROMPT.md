# Prompt — Instalación de Workers ultimate-terminal (para IA con acceso SSH)

> Pásale **todo este archivo** como input a la IA que tiene acceso SSH a los 10 hosts.
> Última actualización: 2026-04-29 — instalador dual-path (.deb preferido, source fallback), commit `07d891e` en `main`.

---

## Resumen del trabajo

Instalar / reinstalar el worker `ultimate-terminal-worker` en 10 hosts, conectándolos al hub central que ya está en producción (`https://terminal.humanizar-dev.cloud`). El frontend ya está desplegado en Vercel (`https://terminal.humanizar.cloud`). Tu trabajo es **solo los workers**.

**Cómo funciona el instalador (dual-path):**

1. **Path binario (preferido)** — intenta bajar el `.deb` desde la última GitHub Release pública (`https://github.com/stevenvo780/ultimate-terminal/releases/latest/download/ultimate-terminal-worker_<version>_<distro-version>_amd64_x86_64.deb`). Si la distro encaja con uno de los .deb publicados (Ubuntu 20.04 / 22.04 / 24.04, Debian 11/12/13, Kali, Mint, Pop), `dpkg -i` y listo.
2. **Smoke test** del binario `/usr/bin/ultimate-terminal-worker --help`. Si pasa → service ya está registrado por el .deb, solo se escribe `/etc/ultimate-terminal/worker.env` y se arranca.
3. **Fallback automático a source build** si:
   - No existe Release todavía (404 → ver "Pre-requisito" abajo);
   - GLIBC no coincide (smoke test falla);
   - Distro no soportada por los .deb (Fedora/RHEL/Arch); aquí salta directo a source.
   - Source build hace: `git clone` (o tar.gz desde `/api/downloads/source` del nexus si está disponible), `npm install` (manejando workspaces de monorepo), `npx tsc`, `npm rebuild node-pty`, copia a `/opt/ultimate-terminal-worker`, escribe `worker.env`, registra service.

Todo eso es **automático**: el delegate AI solo ejecuta el one-liner.

El instalador es:
```
https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh
```
Funciona sin más en Ubuntu, Debian, Mint, Pop!_OS, Kali, Fedora, RHEL, CentOS, Rocky, Alma, Arch y Manjaro. Para `pc-stev` usa modo `USER_INSTALL=1` (servicio de usuario, sin sudo) — en ese modo siempre va por source build (los .deb instalan a `/usr/bin`, que requiere root).

---

## Pre-requisito: publicar la primera Release de .deb (el dueño del repo, una vez)

Mientras no exista la Release, **el instalador igual funciona** (cae a source build). Si quieres habilitar el path rápido `.deb`:

```bash
# Desde el repo, en main:
git tag worker-v1.0.0
git push origin worker-v1.0.0
```

Eso dispara `.github/workflows/release-worker.yml`, que en ~10 min publica:
- `ultimate-terminal-worker_1.0.0_ubuntu20.04_amd64_x86_64.deb`
- `ultimate-terminal-worker_1.0.0_ubuntu22.04_amd64_x86_64.deb`
- `ultimate-terminal-worker_1.0.0_ubuntu24.04_amd64_x86_64.deb`
- `worker-source-prebuilt.tar.gz`

A partir de ahí los hosts derivados de Debian/Ubuntu (8 de 10) usan el path binario; `nass-stev` (depende de la distro real) y `pc-stev` (USER_INSTALL) usan source.

---

## One-liner por host

**Plantilla genérica** (root/sudo, todos los hosts excepto `pc-stev`):
```bash
NEXUS_URL=https://terminal.humanizar-dev.cloud
curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh \
  | sudo NEXUS_URL="$NEXUS_URL" WORKER_NAME=<NAME> bash -s -- <API_KEY>
```

**Plantilla para `pc-stev`** (no usa sudo; servicio systemd --user):
```bash
NEXUS_URL=https://terminal.humanizar-dev.cloud
curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh \
  | USER_INSTALL=1 NEXUS_URL="$NEXUS_URL" WORKER_NAME=pc-stev bash -s -- <API_KEY>
# Y, una sola vez para que arranque sin login:
sudo loginctl enable-linger stev
```

> El `<API_KEY>` (también llamado `WORKER_TOKEN`) es la columna `api_key` de la tabla `workers` en Postgres — **64 caracteres hex**, NO el UUID del worker.

---

## Inventario de hosts (10) con tokens

| # | Worker | Acceso SSH | Tipo install | API_KEY (token) |
|---|--------|------------|--------------|-----------------|
| 1 | `vpn-principal` | `humanizar@148.230.88.162 -p 49222` | sudo | `<REDACTED_WORKER_API_KEY>` |
| 2 | `stev-server` | `stev@100.98.8.227` | sudo | `<REDACTED_WORKER_API_KEY>` |
| 3 | `humanizar1` | `humanizar1` (ProxyJump vía `servidor-i3`) | sudo | `<REDACTED_WORKER_API_KEY>` |
| 4 | `humanizar2` | `humanizar@100.98.5.11` | sudo | `<REDACTED_WORKER_API_KEY>` |
| 5 | `servidor-i3` | `humanizar@100.98.143.113` | sudo | `<REDACTED_WORKER_API_KEY>` |
| 6 | `nass-stev` | `nass@100.98.67.189` | sudo | `<REDACTED_WORKER_API_KEY>` |
| 7 | `pc-stev` | `stev@100.98.81.177` | **USER_INSTALL=1** | `<REDACTED_WORKER_API_KEY>` |
| 8 | `ws-humanizar` | `operador@10.88.88.11` (VM en pc-stev) | sudo | `<REDACTED_WORKER_API_KEY>` |
| 9 | `ws-personal` | `operador@…` (VM en pc-stev) | sudo | `<REDACTED_WORKER_API_KEY>` |
| 10 | `ws-indotel` | `operador@10.88.88.12` (VM en pc-stev) | sudo | `<REDACTED_WORKER_API_KEY>` |

---

## Comandos exactos (copy-paste)

### Bonus — actualiza el nexus primero (para que los instaladores ganen el atajo `/api/downloads/source`)

```bash
ssh vpn-principal '
  set -e
  cd /opt/ultimate-terminal-nexus
  sudo -u utnexus git pull
  sudo -u utnexus npm ci
  sudo -u utnexus npm run build
  sudo systemctl restart ultimate-terminal-nexus
  sudo journalctl -u ultimate-terminal-nexus -n 20 --no-pager
'
```

> No es estrictamente necesario: si saltas este paso, el instalador igual funciona porque cae a `git clone` desde GitHub. Hacerlo solo acelera el resto y deja `/install.sh` actualizado en el nexus.

### 1 — vpn-principal
```bash
ssh vpn-principal 'curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh | sudo NEXUS_URL=https://terminal.humanizar-dev.cloud WORKER_NAME=vpn-principal bash -s -- <REDACTED_WORKER_API_KEY>'
```

### 2 — stev-server
```bash
ssh stev-server 'curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh | sudo NEXUS_URL=https://terminal.humanizar-dev.cloud WORKER_NAME=stev-server bash -s -- <REDACTED_WORKER_API_KEY>'
```

### 3 — humanizar1
```bash
ssh humanizar1 'curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh | sudo NEXUS_URL=https://terminal.humanizar-dev.cloud WORKER_NAME=humanizar1 bash -s -- <REDACTED_WORKER_API_KEY>'
```

### 4 — humanizar2
```bash
ssh humanizar2 'curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh | sudo NEXUS_URL=https://terminal.humanizar-dev.cloud WORKER_NAME=humanizar2 bash -s -- <REDACTED_WORKER_API_KEY>'
```

### 5 — servidor-i3
```bash
ssh servidor-i3 'curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh | sudo NEXUS_URL=https://terminal.humanizar-dev.cloud WORKER_NAME=servidor-i3 bash -s -- <REDACTED_WORKER_API_KEY>'
```

### 6 — nass-stev
```bash
ssh nass-stev 'curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh | sudo NEXUS_URL=https://terminal.humanizar-dev.cloud WORKER_NAME=nass-stev bash -s -- <REDACTED_WORKER_API_KEY>'
```

### 7 — pc-stev (USER_INSTALL=1, sin sudo)
```bash
ssh pc-stev 'curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh | USER_INSTALL=1 NEXUS_URL=https://terminal.humanizar-dev.cloud WORKER_NAME=pc-stev bash -s -- <REDACTED_WORKER_API_KEY>'
ssh pc-stev 'sudo loginctl enable-linger stev'   # solo una vez
```

### 8 — ws-humanizar
```bash
ssh ws-humanizar 'curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh | sudo NEXUS_URL=https://terminal.humanizar-dev.cloud WORKER_NAME=ws-humanizar bash -s -- <REDACTED_WORKER_API_KEY>'
```

### 9 — ws-personal
```bash
ssh ws-personal 'curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh | sudo NEXUS_URL=https://terminal.humanizar-dev.cloud WORKER_NAME=ws-personal bash -s -- <REDACTED_WORKER_API_KEY>'
```

### 10 — ws-indotel
```bash
ssh ws-indotel 'curl -fsSL https://raw.githubusercontent.com/stevenvo780/ultimate-terminal/main/packaging/universal_install.sh | sudo NEXUS_URL=https://terminal.humanizar-dev.cloud WORKER_NAME=ws-indotel bash -s -- <REDACTED_WORKER_API_KEY>'
```

---

## Verificación

### Por host (al terminar cada install)
**Workers system (todos menos pc-stev):**
```bash
ssh <host> 'sudo systemctl status ultimate-terminal-worker --no-pager -l | head -20 && sudo journalctl -u ultimate-terminal-worker -n 15 --no-pager'
```

**pc-stev (user service):**
```bash
ssh pc-stev 'systemctl --user status ultimate-terminal-worker --no-pager -l | head -20 && journalctl --user -u ultimate-terminal-worker -n 15 --no-pager'
```

Debe aparecer `[Worker] Connected to Nexus.` en los logs y status `active (running)`.

### Global (desde un host autorizado)
La URL de PostgreSQL debe inyectarse desde el gestor de secretos; nunca se documenta ni se guarda en Git.
```bash
psql "$DATABASE_URL" \
  -c "SELECT name, status, to_timestamp(last_seen/1000) AS last_seen FROM workers ORDER BY name;"
```
El registro `/api/agents` debe contener **12 agentes canónicos**. Cada worker desplegado para ellos debe figurar `online` y con `last_seen` reciente (segundos); los hosts auxiliares se validan por separado.

### Web
Login en `https://client-iota-three-42.vercel.app` con una cuenta administrada por el gestor de secretos. El dominio histórico `terminal.humanizar.cloud` pertenece a otro proyecto de Vercel y no debe usarse hasta transferirlo.

---

## Troubleshooting (resumido)

| Síntoma | Causa probable | Acción |
|---|---|---|
| `Error: API_KEY (worker token) requerido.` | Olvidaste el token al final del comando | Reejecuta con `bash -s -- <API_KEY>` |
| `npx tsc` falla por TypeScript | Node muy viejo | El script instala Node 22; si ya había uno, exporta `NODE_MAJOR=22` y vuelve a correr |
| `node-pty` no compila | Faltan headers/python3 | El script instala `build-essential python3 make gcc g++`; en distros raras instálalos a mano |
| Worker arranca pero `websocket error` | El token no es la `api_key` (hex 64), pusiste el UUID | Reemplaza por la `api_key` de la tabla y `restart` |
| 404 en `https://terminal.humanizar-dev.cloud/api/downloads/source` | El nexus en vpn-principal aún no se actualizó | El instalador cae a `git clone` automáticamente — funciona igual. Para arreglar el nexus, sigue el paso "Bonus" arriba |
| 410 / "No hay paquetes prebuilt .deb" | Estás llamando al endpoint viejo del nexus | Eso es esperado y correcto: usa `/install.sh` o el script de raw GitHub |
| 404 al bajar el `.deb` desde GitHub Releases | Aún no se ha publicado la Release | El script cae a source build automáticamente. Para habilitar el path rápido, ver "Pre-requisito" arriba |
| `dpkg: dependency problems` | El .deb publicado tiene una versión de Node embebida que no encaja | Ejecuta de nuevo con `PREFER_BINARY=0 …` para forzar source: `… \| sudo PREFER_BINARY=0 NEXUS_URL=… bash -s -- <token>` |
| Worker arrancó pero el binario `/usr/bin/ultimate-terminal-worker` da `error while loading shared libraries` | GLIBC del .deb no encaja con el host | El script ya hace `dpkg -r` y reintenta con source automáticamente; si quedó a medias: `sudo apt remove -y ultimate-terminal-worker && reejecuta con PREFER_BINARY=0` |
| `Empty reply from server` al usar curl al nexus | Nginx anti-scan rechaza User-Agent vacío | Usa `curl -A "..."`; los instaladores ya envían UA por defecto |
| Worker `last_seen` antiguo en DB | Worker caído / red caída | `systemctl status` y `journalctl -n 50` en ese host |

---

## Limpieza opcional (si hay duplicados antiguos)

```sql
-- Inspecciona primero
SELECT id, name, status, api_key FROM workers
 WHERE name IN ('humanizar1','humanizar2')
 ORDER BY name, status;

-- Borra solo los offline viejos (cambia los UUIDs)
DELETE FROM workers WHERE id IN ('<uuid_offline_1>', '<uuid_offline_2>');
```

---

## Anatomía de un worker instalado (referencia)

**Modo binario (default cuando hay Release y la distro encaja):**
```
/usr/bin/ultimate-terminal-worker          # binario empaquetado con pkg
/usr/lib/systemd/system/ultimate-terminal-worker.service
/etc/ultimate-terminal/worker.env          (chmod 600, lo escribe el script)
```

**Modo system source (fallback automático):**
```
/opt/ultimate-terminal-worker/
├── dist/index.js        # entrypoint compilado
├── node_modules/
└── package.json
/etc/ultimate-terminal/worker.env   (chmod 600)
/etc/systemd/system/ultimate-terminal-worker.service
```

**Modo user (`USER_INSTALL=1`):**
```
~/.local/share/ultimate-terminal-worker/
├── dist/index.js
├── node_modules/
└── package.json
~/.config/ultimate-terminal/worker.env
~/.config/systemd/user/ultimate-terminal-worker.service
```

Contenido de `worker.env` que escribe el script:
```env
NEXUS_URL=https://terminal.humanizar-dev.cloud
API_KEY=<token>
WORKER_TOKEN=<token>     # alias por compatibilidad
WORKER_NAME=<nombre>
WORKER_HEARTBEAT_MS=5000
AUTO_RESTART_SHELL=true
```

---

## Reglas para ti, IA destinataria

1. **Procesa los hosts en serie**, no en paralelo: si una distro requiere instalar Node, evita pelearte con apt locks concurrentes.
2. **Tras cada host**, verifica `systemctl status` y un par de líneas de `journalctl` antes de pasar al siguiente.
3. **Si un host falla**, NO intentes "arreglar" cambiando el script; reporta el error textual de logs y sigue con los demás.
4. **Si un host falla específicamente con error de .deb / GLIBC**, reintenta con `PREFER_BINARY=0` para forzar source build en ese host.
5. **Nunca uses los endpoints `/api/downloads/latest/worker-linux.deb` o `.rpm` del nexus** — devuelven 410. El instalador correcto baja el .deb desde GitHub Releases o compila source.
6. **`pc-stev` es la única excepción** del patrón: USER_INSTALL=1, sin sudo, y `loginctl enable-linger` la primera vez.
7. **Reporte final**: pega el output del SQL de verificación (10 filas, status online), e indica para cada host si fue *binario* o *source* (mira el `journalctl` la primera línea del worker, o `which ultimate-terminal-worker`).

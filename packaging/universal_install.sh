#!/bin/bash
set -euo pipefail

# Ultimate Terminal — Worker universal installer (source build).
#
# Uso (curl pipe):
#   curl -fsSL "$NEXUS_URL/install.sh" \
#     | sudo NEXUS_URL="$NEXUS_URL" WORKER_NAME=mi-pc bash -s -- <API_KEY>
#
# o equivalentes con variables:
#   sudo NEXUS_URL=... API_KEY=... WORKER_NAME=... bash universal_install.sh
#
# Este script no descarga paquetes .deb/.rpm pre-compilados (esos requieren
# Docker para construirse y suelen romperse por GLIBC). Siempre compila el
# worker desde el código fuente con Node.js + tsc, lo que funciona en
# cualquier distribución Linux moderna.

NEXUS_URL="${NEXUS_URL:-http://localhost:3002}"
API_KEY="${1:-${API_KEY:-${WORKER_TOKEN:-}}}"
WORKER_NAME="${WORKER_NAME:-$(hostname)}"
REPO_OWNER="${WORKER_REPO_OWNER:-stevenvo780}"
REPO_NAME="${WORKER_REPO_NAME:-ultimate-terminal}"
REPO_URL="${WORKER_REPO_URL:-https://github.com/${REPO_OWNER}/${REPO_NAME}.git}"
REPO_REF="${WORKER_REPO_REF:-main}"
RELEASE_BASE_URL="${RELEASE_BASE_URL:-https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download}"
NODE_MAJOR="${NODE_MAJOR:-22}"
USER_INSTALL="${USER_INSTALL:-0}"   # 1 = instala como systemd --user (sin sudo)
PREFER_BINARY="${PREFER_BINARY:-1}"  # 1 = intenta .deb/.rpm de GitHub Releases primero

if [ "$USER_INSTALL" = "1" ]; then
  INSTALL_DIR="${HOME}/.local/share/ultimate-terminal-worker"
  CONFIG_DIR="${HOME}/.config/ultimate-terminal"
  CONFIG_FILE="$CONFIG_DIR/worker.env"
  SERVICE_DIR="${HOME}/.config/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/ultimate-terminal-worker.service"
else
  INSTALL_DIR="/opt/ultimate-terminal-worker"
  CONFIG_DIR="/etc/ultimate-terminal"
  CONFIG_FILE="$CONFIG_DIR/worker.env"
  SERVICE_FILE="/etc/systemd/system/ultimate-terminal-worker.service"
fi
WORK_DIR="$(mktemp -d /tmp/termicoop-worker.XXXXXX)"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

if [ -z "${API_KEY:-}" ]; then
  echo "Error: API_KEY (worker token) requerido."
  echo "Uso: curl -fsSL \$NEXUS_URL/install.sh | sudo bash -s -- <API_KEY>"
  exit 1
fi

SUDO=""
if [ "$USER_INSTALL" = "1" ]; then
  echo "Modo USER_INSTALL=1: instalación a nivel de usuario (~/.local + systemd --user)."
elif [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "Error: se requiere root, sudo o USER_INSTALL=1."
    exit 1
  fi
fi

OS_ID="unknown"; VERSION_ID="unknown"
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  VERSION_ID="${VERSION_ID:-unknown}"
fi
ARCH_RAW="$(uname -m || echo unknown)"

echo "=== Ultimate Terminal Worker installer ==="
echo "Sistema:   $OS_ID $VERSION_ID ($ARCH_RAW)"
echo "Nexus URL: $NEXUS_URL"
echo "Worker:    $WORKER_NAME"
echo "Repo:      $REPO_URL@$REPO_REF"

install_pkgs_apt() {
  local APT_OPTS="-o Acquire::Retries=3 -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=20"
  $SUDO apt-get $APT_OPTS update -y || true
  $SUDO apt-get $APT_OPTS install -y --no-install-recommends \
    ca-certificates curl git build-essential python3 make gcc g++ pkg-config
}

install_pkgs_dnf() {
  $SUDO dnf install -y --setopt=install_weak_deps=False \
    ca-certificates curl git gcc gcc-c++ make python3 tar
}

install_pkgs_yum() {
  $SUDO yum install -y ca-certificates curl git gcc gcc-c++ make python3 tar
}

install_pkgs_pacman() {
  $SUDO pacman -Sy --noconfirm --needed ca-certificates curl git base-devel python
}

run_root() {
  if [ -n "$SUDO" ]; then sudo -E "$@"; else "$@"; fi
}

install_node() {
  local current_major=""
  if command -v node >/dev/null 2>&1; then
    current_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if [ -n "$current_major" ] && [ "$current_major" -ge 20 ]; then
    echo "Node.js $current_major detectado, OK."
    return 0
  fi
  echo "Instalando Node.js ${NODE_MAJOR}..."
  case "$OS_ID" in
    ubuntu|debian|linuxmint|pop|kali)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$WORK_DIR/nodesource.sh"
      run_root bash "$WORK_DIR/nodesource.sh"
      $SUDO apt-get install -y nodejs
      ;;
    fedora|rhel|centos|rocky|alma)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" -o "$WORK_DIR/nodesource.sh"
      run_root bash "$WORK_DIR/nodesource.sh"
      $SUDO dnf install -y nodejs || $SUDO yum install -y nodejs
      ;;
    arch|manjaro|endeavouros)
      $SUDO pacman -Sy --noconfirm --needed nodejs npm
      ;;
    *)
      echo "Distro no reconocida; usando tarball oficial de Node.js..."
      local node_ver="${NODE_MAJOR}.11.1"
      local arch_tag="x64"
      case "$ARCH_RAW" in
        x86_64|amd64) arch_tag="x64" ;;
        aarch64|arm64) arch_tag="arm64" ;;
        armv7l) arch_tag="armv7l" ;;
        *) echo "Arquitectura no soportada: $ARCH_RAW"; exit 1 ;;
      esac
      curl -fsSL "https://nodejs.org/dist/v${node_ver}/node-v${node_ver}-linux-${arch_tag}.tar.xz" -o "$WORK_DIR/node.tar.xz"
      $SUDO tar -xJf "$WORK_DIR/node.tar.xz" -C /usr/local --strip-components=1
      ;;
  esac
}

if [ "$USER_INSTALL" = "1" ]; then
  echo "==> Saltando instalación de paquetes (modo user)."
  echo "    Asegúrate de tener instalado: node>=20, npm, git, python3, build-essential."
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: 'node' no está disponible y no podemos instalarlo sin sudo."
    exit 1
  fi
else
  echo "==> Instalando dependencias del sistema..."
  case "$OS_ID" in
    ubuntu|debian|linuxmint|pop|kali) install_pkgs_apt ;;
    fedora|rhel|centos|rocky|alma)
      if command -v dnf >/dev/null 2>&1; then install_pkgs_dnf; else install_pkgs_yum; fi
      ;;
    arch|manjaro|endeavouros) install_pkgs_pacman ;;
    *)
      if [ -f /etc/debian_version ]; then install_pkgs_apt
      elif [ -f /etc/redhat-release ]; then
        if command -v dnf >/dev/null 2>&1; then install_pkgs_dnf; else install_pkgs_yum; fi
      else
        echo "Distro no reconocida; instala manualmente: curl git build-essential python3"
      fi
      ;;
  esac
  install_node
fi

USE_BINARY=0
BIN_DEB=""

if [ "$USER_INSTALL" != "1" ] && [ "$PREFER_BINARY" = "1" ]; then
  case "$OS_ID" in
    ubuntu|debian|linuxmint|pop|kali)
      release_url=""
      case "$OS_ID-$VERSION_ID" in
        ubuntu-20.04|debian-11) release_url="${RELEASE_BASE_URL}/ultimate-terminal-worker_1.0.0_ubuntu20.04_amd64_x86_64.deb" ;;
        ubuntu-22.04|debian-12|kali-*|pop-22.04|linuxmint-21*) release_url="${RELEASE_BASE_URL}/ultimate-terminal-worker_1.0.0_ubuntu22.04_amd64_x86_64.deb" ;;
        ubuntu-24.04|debian-13|pop-24.04|linuxmint-22*) release_url="${RELEASE_BASE_URL}/ultimate-terminal-worker_1.0.0_ubuntu24.04_amd64_x86_64.deb" ;;
        *) release_url="${RELEASE_BASE_URL}/ultimate-terminal-worker_1.0.0_ubuntu22.04_amd64_x86_64.deb" ;;
      esac
      echo "==> Intentando .deb pre-compilado: $release_url"
      if curl -fL --retry 3 -o "$WORK_DIR/worker.deb" "$release_url" 2>/dev/null && [ -s "$WORK_DIR/worker.deb" ]; then
        USE_BINARY=1
        BIN_DEB="$WORK_DIR/worker.deb"
      else
        echo "    .deb no disponible aún (release no creada). Cambiando a source build."
      fi
      ;;
  esac
fi

if [ "$USE_BINARY" = "1" ]; then
  echo "==> Instalando .deb pre-compilado..."
  if ! $SUDO dpkg -i "$BIN_DEB"; then
    echo "    dpkg falló (probable dep faltante). Intentando apt-get install -f..."
    $SUDO apt-get update -y || true
    $SUDO apt-get install -f -y
    $SUDO dpkg -i "$BIN_DEB"
  fi
  # smoke-test del binario
  if command -v timeout >/dev/null 2>&1; then
    rc=0; timeout 2 /usr/bin/ultimate-terminal-worker --help >/dev/null 2>&1 || rc=$?
    [ "$rc" = "124" ] && rc=0
  else
    rc=0; /usr/bin/ultimate-terminal-worker --help >/dev/null 2>&1 || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    echo "ERROR: el binario no ejecuta (probable GLIBC). Quitando .deb y cayendo a source build..."
    $SUDO dpkg -r ultimate-terminal-worker || true
    USE_BINARY=0
  fi
fi

if [ "$USE_BINARY" != "1" ]; then
  echo "==> Descargando código fuente del worker..."
  SRC_DIR="$WORK_DIR/src"
  mkdir -p "$SRC_DIR"
  if curl -fL "$NEXUS_URL/api/downloads/source" -o "$WORK_DIR/source.tar.gz" 2>/dev/null \
     && tar -tzf "$WORK_DIR/source.tar.gz" >/dev/null 2>&1; then
    echo "Fuente obtenida desde Nexus."
    tar -xzf "$WORK_DIR/source.tar.gz" -C "$SRC_DIR" --strip-components=1
  else
    echo "Fuente no disponible en Nexus, clonando $REPO_URL ..."
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SRC_DIR"
  fi

  # Detecta si es monorepo (raíz tiene package.json + worker/) o tarball plano
  BUILD_ROOT=""
  WORKER_SRC=""
  if [ -d "$SRC_DIR/worker" ] && [ -f "$SRC_DIR/package.json" ]; then
    # Monorepo con workspaces — npm install en raíz hoist node_modules
    BUILD_ROOT="$SRC_DIR"
    WORKER_SRC="$SRC_DIR/worker"
  elif [ -d "$SRC_DIR/worker" ]; then
    BUILD_ROOT="$SRC_DIR/worker"
    WORKER_SRC="$SRC_DIR/worker"
  elif [ -d "$SRC_DIR/src" ] && [ -f "$SRC_DIR/package.json" ]; then
    BUILD_ROOT="$SRC_DIR"
    WORKER_SRC="$SRC_DIR"
  else
    echo "Error: no encontré el código del worker en la fuente."
    exit 1
  fi

  echo "==> Compilando worker (build root: $BUILD_ROOT, worker: $WORKER_SRC)..."
  pushd "$BUILD_ROOT" >/dev/null
  npm install --no-audit --no-fund
  popd >/dev/null
  pushd "$WORKER_SRC" >/dev/null
  npx tsc
  popd >/dev/null
  # node-pty rebuild (best effort) — nodemodules hoisted o local
  if [ -d "$BUILD_ROOT/node_modules/node-pty" ]; then
    (cd "$BUILD_ROOT" && npm rebuild node-pty --build-from-source) >/dev/null 2>&1 || true
  elif [ -d "$WORKER_SRC/node_modules/node-pty" ]; then
    (cd "$WORKER_SRC" && npm rebuild node-pty --build-from-source) >/dev/null 2>&1 || true
  fi

  # Localiza node_modules: o en worker/ (no-monorepo) o en raíz (monorepo hoist)
  NM_DIR=""
  if [ -d "$WORKER_SRC/node_modules" ]; then
    NM_DIR="$WORKER_SRC/node_modules"
  elif [ -d "$BUILD_ROOT/node_modules" ]; then
    NM_DIR="$BUILD_ROOT/node_modules"
  else
    echo "Error: npm install no creó node_modules en ningún lugar conocido."
    exit 1
  fi

  echo "==> Instalando en $INSTALL_DIR (node_modules desde $NM_DIR)..."
  $SUDO mkdir -p "$INSTALL_DIR"
  $SUDO rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules" "$INSTALL_DIR/package.json"
  $SUDO cp -r "$WORKER_SRC/dist" "$INSTALL_DIR/"
  $SUDO cp -r "$NM_DIR" "$INSTALL_DIR/node_modules"
  $SUDO cp "$WORKER_SRC/package.json" "$INSTALL_DIR/"
fi

echo "==> Escribiendo configuración en $CONFIG_FILE..."
$SUDO mkdir -p "$CONFIG_DIR"
$SUDO tee "$CONFIG_FILE" >/dev/null <<EOF
NEXUS_URL=$NEXUS_URL
API_KEY=$API_KEY
WORKER_TOKEN=$API_KEY
WORKER_NAME=$WORKER_NAME
WORKER_HEARTBEAT_MS=5000
AUTO_RESTART_SHELL=true
EOF
$SUDO chmod 600 "$CONFIG_FILE"

NODE_BIN="$(command -v node || echo /usr/bin/node)"

if [ "$USER_INSTALL" = "1" ]; then
  echo "==> Instalando servicio systemd --user..."
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Ultimate Terminal Worker (user)
Documentation=https://github.com/stevenvo780/ultimate-terminal
After=default.target

[Service]
Type=simple
EnvironmentFile=$CONFIG_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/dist/index.js
WorkingDirectory=$INSTALL_DIR
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ut-worker

[Install]
WantedBy=default.target
EOF
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable ultimate-terminal-worker >/dev/null 2>&1 || true
    systemctl --user restart ultimate-terminal-worker
    sleep 2
    systemctl --user --no-pager --full status ultimate-terminal-worker | head -n 20 || true
    echo "Tip: 'sudo loginctl enable-linger $USER' para que arranque al boot sin login."
    echo "=== Worker '$WORKER_NAME' instalado (user mode) ==="
  else
    echo "systemd --user no disponible. Arranca manualmente:"
    echo "  $NODE_BIN $INSTALL_DIR/dist/index.js"
  fi
else
  if [ "$USE_BINARY" = "1" ]; then
    echo "==> Usando service file del .deb (/usr/lib/systemd/system/ultimate-terminal-worker.service)..."
    # El .deb ya instaló el unit; solo refrescamos.
    $SUDO systemctl daemon-reload
  else
    echo "==> Instalando servicio systemd (source build)..."
    $SUDO tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Ultimate Terminal Worker
Documentation=https://github.com/stevenvo780/ultimate-terminal
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
EnvironmentFile=$CONFIG_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/dist/index.js
WorkingDirectory=$INSTALL_DIR
Restart=always
RestartSec=5
User=root
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ut-worker

[Install]
WantedBy=multi-user.target
EOF
  fi

  if command -v systemctl >/dev/null 2>&1 && [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ]; then
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable ultimate-terminal-worker >/dev/null 2>&1 || true
    $SUDO systemctl restart ultimate-terminal-worker
    sleep 2
    $SUDO systemctl --no-pager --full status ultimate-terminal-worker | head -n 20 || true
    echo "=== Worker '$WORKER_NAME' instalado y arrancado ==="
  else
    echo "systemd no detectado. Arranca manualmente:"
    if [ "$USE_BINARY" = "1" ]; then echo "  /usr/bin/ultimate-terminal-worker"
    else echo "  $NODE_BIN $INSTALL_DIR/dist/index.js"; fi
  fi
fi

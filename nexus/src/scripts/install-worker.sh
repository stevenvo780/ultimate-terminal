#!/bin/bash
set -euo pipefail

# Ultimate Terminal / TermiCoop — Worker universal installer (source build).
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
REPO_URL="${TERMICOOP_REPO_URL:-https://github.com/stevenvo780/TermiCoop.git}"
REPO_REF="${TERMICOOP_REPO_REF:-main}"
NODE_MAJOR="${NODE_MAJOR:-22}"
USER_INSTALL="${USER_INSTALL:-0}"   # 1 = instala como systemd --user (sin sudo)

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

echo "=== TermiCoop Worker installer ==="
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
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
      $SUDO apt-get install -y nodejs
      ;;
    fedora|rhel|centos|rocky|alma)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
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

if [ -d "$SRC_DIR/worker" ]; then
  WORKER_SRC="$SRC_DIR/worker"
elif [ -d "$SRC_DIR/src" ] && [ -f "$SRC_DIR/package.json" ]; then
  WORKER_SRC="$SRC_DIR"
else
  echo "Error: no encontré el código del worker en la fuente."
  exit 1
fi

echo "==> Compilando worker en $WORKER_SRC..."
pushd "$WORKER_SRC" >/dev/null
npm install --no-audit --no-fund
npx tsc
npm rebuild node-pty --build-from-source >/dev/null 2>&1 || true
popd >/dev/null

echo "==> Instalando en $INSTALL_DIR..."
$SUDO mkdir -p "$INSTALL_DIR"
$SUDO rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules" "$INSTALL_DIR/package.json"
$SUDO cp -r "$WORKER_SRC/dist" "$WORKER_SRC/node_modules" "$WORKER_SRC/package.json" "$INSTALL_DIR/"

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
Description=TermiCoop / Ultimate Terminal Worker (user)
Documentation=https://github.com/stevenvo780/TermiCoop
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
  echo "==> Instalando servicio systemd..."
  $SUDO tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=TermiCoop / Ultimate Terminal Worker
Documentation=https://github.com/stevenvo780/TermiCoop
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

  if command -v systemctl >/dev/null 2>&1 && [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ]; then
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable ultimate-terminal-worker >/dev/null 2>&1 || true
    $SUDO systemctl restart ultimate-terminal-worker
    sleep 2
    $SUDO systemctl --no-pager --full status ultimate-terminal-worker | head -n 20 || true
    echo "=== Worker '$WORKER_NAME' instalado y arrancado ==="
  else
    echo "systemd no detectado. Arranca manualmente:"
    echo "  $NODE_BIN $INSTALL_DIR/dist/index.js"
  fi
fi

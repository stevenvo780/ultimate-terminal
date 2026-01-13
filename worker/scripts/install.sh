#!/bin/bash
# Ultimate Terminal Worker - Universal Installer
# Works on Ubuntu, Debian, Fedora, RHEL, CentOS, Arch

set -e

NEXUS_URL="${NEXUS_URL:-https://terminal.humanizar-dev.cloud}"
WORKER_NAME="${WORKER_NAME:-$(hostname)}"
WORKER_TOKEN="${WORKER_TOKEN:-}"
INSTALL_DIR="/opt/ultimate-terminal"
BIN_LINK="/usr/local/bin/ut-worker"
SERVICE_NAME="ut-worker"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "Please run as root (sudo)"
        exit 1
    fi
}

detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO=$ID
        VERSION=$VERSION_ID
    else
        DISTRO=$(uname -s)
    fi
    log_info "Detected: $DISTRO $VERSION"
}

install_nodejs() {
    log_info "Checking Node.js..."
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -ge 18 ]; then
            log_info "Node.js $(node -v) already installed"
            return
        fi
    fi

    log_info "Installing Node.js 20..."
    case $DISTRO in
        ubuntu|debian)
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
            apt-get install -y nodejs
            ;;
        fedora)
            dnf install -y nodejs npm
            ;;
        centos|rhel|rocky|almalinux)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
            yum install -y nodejs
            ;;
        arch|manjaro)
            pacman -Sy --noconfirm nodejs npm
            ;;
        *)
            log_error "Unsupported distro: $DISTRO"
            exit 1
            ;;
    esac
}

install_dependencies() {
    log_info "Installing build dependencies..."
    case $DISTRO in
        ubuntu|debian)
            apt-get update
            apt-get install -y build-essential python3 git
            ;;
        fedora)
            dnf install -y gcc gcc-c++ make python3 git
            ;;
        centos|rhel|rocky|almalinux)
            yum groupinstall -y "Development Tools"
            yum install -y python3 git
            ;;
        arch|manjaro)
            pacman -Sy --noconfirm base-devel python git
            ;;
    esac
}

install_worker() {
    log_info "Installing Ultimate Terminal Worker..."
    
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"

    # Download latest from GitHub
    if [ -d ".git" ]; then
        git pull
    else
        git clone https://github.com/stevenvo780/ultimate-terminal.git .
    fi

    cd worker
    npm install --production=false
    npm run build

    # Create wrapper script
    cat > "$BIN_LINK" << 'WRAPPER'
#!/bin/bash
# Ultimate Terminal Worker CLI

CONFIG_FILE="$HOME/.ut-worker.env"

show_help() {
    echo "Ultimate Terminal Worker"
    echo ""
    echo "Usage: ut-worker [command] [options]"
    echo ""
    echo "Commands:"
    echo "  start         Start worker (foreground)"
    echo "  daemon        Start as background service"
    echo "  stop          Stop background service"
    echo "  status        Show service status"
    echo "  config        Configure connection settings"
    echo "  logs          Show service logs"
    echo ""
    echo "Options:"
    echo "  -u, --url     Nexus server URL"
    echo "  -n, --name    Worker name"
    echo "  -t, --token   Worker token"
    echo ""
    echo "Examples:"
    echo "  ut-worker config -u https://terminal.example.com -t mytoken"
    echo "  ut-worker start"
    echo "  ut-worker daemon"
}

load_config() {
    if [ -f "$CONFIG_FILE" ]; then
        source "$CONFIG_FILE"
    fi
}

save_config() {
    echo "NEXUS_URL=\"$NEXUS_URL\"" > "$CONFIG_FILE"
    echo "WORKER_NAME=\"$WORKER_NAME\"" >> "$CONFIG_FILE"
    echo "WORKER_TOKEN=\"$WORKER_TOKEN\"" >> "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    echo "Configuration saved to $CONFIG_FILE"
}

do_config() {
    load_config
    while [[ $# -gt 0 ]]; do
        case $1 in
            -u|--url) NEXUS_URL="$2"; shift 2;;
            -n|--name) WORKER_NAME="$2"; shift 2;;
            -t|--token) WORKER_TOKEN="$2"; shift 2;;
            *) shift;;
        esac
    done
    
    if [ -z "$NEXUS_URL" ]; then
        read -p "Nexus URL [https://terminal.humanizar-dev.cloud]: " NEXUS_URL
        NEXUS_URL="${NEXUS_URL:-https://terminal.humanizar-dev.cloud}"
    fi
    if [ -z "$WORKER_NAME" ]; then
        read -p "Worker name [$(hostname)]: " WORKER_NAME
        WORKER_NAME="${WORKER_NAME:-$(hostname)}"
    fi
    if [ -z "$WORKER_TOKEN" ]; then
        read -sp "Worker token: " WORKER_TOKEN
        echo ""
    fi
    save_config
}

do_start() {
    load_config
    if [ -z "$NEXUS_URL" ] || [ -z "$WORKER_TOKEN" ]; then
        echo "Not configured. Run: ut-worker config"
        exit 1
    fi
    export NEXUS_URL WORKER_NAME WORKER_TOKEN
    cd /opt/ultimate-terminal/worker
    exec node dist/index.js
}

do_daemon() {
    load_config
    if [ -z "$NEXUS_URL" ] || [ -z "$WORKER_TOKEN" ]; then
        echo "Not configured. Run: ut-worker config"
        exit 1
    fi
    
    # Create systemd user service
    mkdir -p ~/.config/systemd/user
    cat > ~/.config/systemd/user/ut-worker.service << EOF
[Unit]
Description=Ultimate Terminal Worker
After=network.target

[Service]
Type=simple
Environment="NEXUS_URL=$NEXUS_URL"
Environment="WORKER_NAME=$WORKER_NAME"
Environment="WORKER_TOKEN=$WORKER_TOKEN"
WorkingDirectory=/opt/ultimate-terminal/worker
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable ut-worker
    systemctl --user start ut-worker
    echo "Worker started as daemon. Check: ut-worker status"
}

do_stop() {
    systemctl --user stop ut-worker 2>/dev/null || true
    echo "Worker stopped"
}

do_status() {
    systemctl --user status ut-worker 2>/dev/null || echo "Service not running"
}

do_logs() {
    journalctl --user -u ut-worker -f
}

case "${1:-help}" in
    start) shift; do_start "$@";;
    daemon) shift; do_daemon "$@";;
    stop) do_stop;;
    status) do_status;;
    config) shift; do_config "$@";;
    logs) do_logs;;
    help|-h|--help) show_help;;
    *) show_help;;
esac
WRAPPER

    chmod +x "$BIN_LINK"
    log_info "Installed: $BIN_LINK"
}

configure_worker() {
    if [ -n "$WORKER_TOKEN" ]; then
        log_info "Configuring worker..."
        sudo -u "${SUDO_USER:-$USER}" bash -c "
            echo 'NEXUS_URL=\"$NEXUS_URL\"' > \$HOME/.ut-worker.env
            echo 'WORKER_NAME=\"$WORKER_NAME\"' >> \$HOME/.ut-worker.env
            echo 'WORKER_TOKEN=\"$WORKER_TOKEN\"' >> \$HOME/.ut-worker.env
            chmod 600 \$HOME/.ut-worker.env
        "
    fi
}

main() {
    echo "========================================"
    echo "  Ultimate Terminal Worker Installer"
    echo "========================================"
    
    check_root
    detect_distro
    install_dependencies
    install_nodejs
    install_worker
    configure_worker

    echo ""
    log_info "Installation complete!"
    echo ""
    echo "Next steps:"
    echo "  1. Configure: ut-worker config -u https://terminal.humanizar-dev.cloud -t YOUR_TOKEN"
    echo "  2. Start:     ut-worker start"
    echo "  3. Or daemon: ut-worker daemon"
    echo ""
}

main "$@"

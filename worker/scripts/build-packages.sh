#!/bin/bash
# Build .deb and .rpm packages for Ultimate Terminal Worker

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$WORKER_DIR")"
OUTPUT_DIR="$WORKER_DIR/packages"
VERSION="1.0.0"
NAME="ut-worker"

mkdir -p "$OUTPUT_DIR"

echo "Building packages using Docker..."

# Build Docker image for packaging
docker build -t ut-packager -f "$SCRIPT_DIR/Dockerfile.packager" "$SCRIPT_DIR"

# Create package structure
STAGING="/tmp/ut-worker-staging"
rm -rf "$STAGING"
mkdir -p "$STAGING/opt/ultimate-terminal/worker"
mkdir -p "$STAGING/usr/local/bin"
mkdir -p "$STAGING/etc/ut-worker"

# Copy worker files
cp -r "$WORKER_DIR/dist" "$STAGING/opt/ultimate-terminal/worker/"
cp -r "$WORKER_DIR/node_modules" "$STAGING/opt/ultimate-terminal/worker/"
cp "$WORKER_DIR/package.json" "$STAGING/opt/ultimate-terminal/worker/"

# Create CLI wrapper
cat > "$STAGING/usr/local/bin/ut-worker" << 'WRAPPER'
#!/bin/bash
# Ultimate Terminal Worker CLI

CONFIG_FILE="${UT_CONFIG:-/etc/ut-worker/config.env}"
USER_CONFIG="$HOME/.ut-worker.env"

show_help() {
    cat << EOF
Ultimate Terminal Worker v1.0.0

Usage: ut-worker [command] [options]

Commands:
  start         Start worker in foreground
  daemon        Start as systemd service
  stop          Stop the service
  status        Show service status
  config        Configure connection
  logs          Show logs

Options:
  -u, --url     Nexus server URL
  -n, --name    Worker name (default: hostname)
  -t, --token   Worker authentication token

Examples:
  ut-worker config -u https://terminal.example.com -t mytoken
  ut-worker start
  sudo ut-worker daemon

EOF
}

load_config() {
    [ -f "$USER_CONFIG" ] && source "$USER_CONFIG"
    [ -f "$CONFIG_FILE" ] && source "$CONFIG_FILE"
    WORKER_NAME="${WORKER_NAME:-$(hostname)}"
}

save_config() {
    local target="$USER_CONFIG"
    [ "$EUID" -eq 0 ] && target="$CONFIG_FILE"
    
    cat > "$target" << EOF
NEXUS_URL="$NEXUS_URL"
WORKER_NAME="$WORKER_NAME"
WORKER_TOKEN="$WORKER_TOKEN"
EOF
    chmod 600 "$target"
    echo "Configuration saved to $target"
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
    
    [ -z "$NEXUS_URL" ] && read -p "Nexus URL: " NEXUS_URL
    [ -z "$WORKER_NAME" ] && read -p "Worker name [$(hostname)]: " WORKER_NAME
    WORKER_NAME="${WORKER_NAME:-$(hostname)}"
    [ -z "$WORKER_TOKEN" ] && { read -sp "Token: " WORKER_TOKEN; echo; }
    
    save_config
}

do_start() {
    load_config
    [ -z "$NEXUS_URL" ] || [ -z "$WORKER_TOKEN" ] && { echo "Run: ut-worker config"; exit 1; }
    export NEXUS_URL WORKER_NAME WORKER_TOKEN
    cd /opt/ultimate-terminal/worker
    exec node dist/index.js
}

do_daemon() {
    load_config
    [ -z "$NEXUS_URL" ] || [ -z "$WORKER_TOKEN" ] && { echo "Run: ut-worker config"; exit 1; }
    
    if [ "$EUID" -eq 0 ]; then
        # System service
        cat > /etc/systemd/system/ut-worker.service << EOF
[Unit]
Description=Ultimate Terminal Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$CONFIG_FILE
WorkingDirectory=/opt/ultimate-terminal/worker
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable ut-worker
        systemctl start ut-worker
        echo "System service started. Check: systemctl status ut-worker"
    else
        # User service
        mkdir -p ~/.config/systemd/user
        cat > ~/.config/systemd/user/ut-worker.service << EOF
[Unit]
Description=Ultimate Terminal Worker
After=network-online.target

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
        echo "User service started. Check: ut-worker status"
    fi
}

do_stop() {
    if [ "$EUID" -eq 0 ]; then
        systemctl stop ut-worker 2>/dev/null || true
    else
        systemctl --user stop ut-worker 2>/dev/null || true
    fi
    echo "Stopped"
}

do_status() {
    if [ "$EUID" -eq 0 ]; then
        systemctl status ut-worker 2>/dev/null || echo "Not running"
    else
        systemctl --user status ut-worker 2>/dev/null || echo "Not running"
    fi
}

do_logs() {
    if [ "$EUID" -eq 0 ]; then
        journalctl -u ut-worker -f
    else
        journalctl --user -u ut-worker -f
    fi
}

case "${1:-help}" in
    start) shift; do_start "$@";;
    daemon) shift; do_daemon "$@";;
    stop) do_stop;;
    status) do_status;;
    config) shift; do_config "$@";;
    logs) do_logs;;
    -h|--help|help) show_help;;
    *) show_help; exit 1;;
esac
WRAPPER
chmod +x "$STAGING/usr/local/bin/ut-worker"

# Create default config
cat > "$STAGING/etc/ut-worker/config.env.example" << 'EOF'
# Ultimate Terminal Worker Configuration
NEXUS_URL="https://terminal.humanizar-dev.cloud"
WORKER_NAME="my-worker"
WORKER_TOKEN="your-token-here"
EOF

# Build packages in Docker - use tar to transfer files
echo "Transferring files to Docker..."
tar czf /tmp/ut-staging.tar.gz -C "$STAGING" .

docker run --rm -v "/tmp/ut-staging.tar.gz:/staging.tar.gz:ro" -v "$OUTPUT_DIR:/output" ut-packager bash -c "
    # Extract staging files
    mkdir -p /build/pkg
    tar xzf /staging.tar.gz -C /build/pkg
    cd /build/pkg
    
    # Build .deb
    fpm -s dir -t deb \
        -n $NAME \
        -v $VERSION \
        --description 'Ultimate Terminal Worker - Remote terminal access' \
        --url 'https://github.com/stevenvo780/ultimate-terminal' \
        --maintainer 'Stev <stev@humanizar-dev.cloud>' \
        --license 'MIT' \
        -d 'nodejs' \
        -p /output/${NAME}_${VERSION}_amd64.deb \
        .
    
    # Build .rpm  
    fpm -s dir -t rpm \
        -n $NAME \
        -v $VERSION \
        --description 'Ultimate Terminal Worker - Remote terminal access' \
        --url 'https://github.com/stevenvo780/ultimate-terminal' \
        --maintainer 'Stev <stev@humanizar-dev.cloud>' \
        --license 'MIT' \
        -d 'nodejs' \
        -p /output/${NAME}-${VERSION}.x86_64.rpm \
        .
    
    echo 'Packages built!'
"

rm -f /tmp/ut-staging.tar.gz

echo ""
echo "Packages created in $OUTPUT_DIR:"
ls -la "$OUTPUT_DIR"

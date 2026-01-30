#!/bin/bash
set -e

# Quick installation script for development/testing
# Downloads and installs the latest packages

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VERSION="${UT_VERSION:-}"
if [ -z "$VERSION" ]; then
    VERSION=$(node -p "require('${PROJECT_ROOT}/package.json').version" 2>/dev/null || echo "1.0.0")
fi

REPO_URL="https://github.com/stevenvo780/ultimate-terminal"
RELEASES_URL="$REPO_URL/releases/latest/download"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        echo "$ID"
    elif [ -f /etc/debian_version ]; then
        echo "debian"
    elif [ -f /etc/redhat-release ]; then
        echo "rhel"
    else
        echo "unknown"
    fi
}

install_worker() {
    local distro=$(detect_distro)
    
    log_info "Installing Ultimate Terminal Worker..."
    
    case "$distro" in
        ubuntu|debian|linuxmint|pop)
            if [ -f "$1" ]; then
                sudo dpkg -i "$1"
            else
                curl -LO "$RELEASES_URL/ultimate-terminal-worker_${VERSION}_amd64.deb"
                sudo dpkg -i "ultimate-terminal-worker_${VERSION}_amd64.deb"
            fi
            ;;
        fedora|rhel|centos|rocky|alma)
            if [ -f "$1" ]; then
                sudo rpm -i "$1"
            else
                curl -LO "$RELEASES_URL/ultimate-terminal-worker-${VERSION}-1.x86_64.rpm"
                sudo rpm -i "ultimate-terminal-worker-${VERSION}-1.x86_64.rpm"
            fi
            ;;
        arch|manjaro)
            log_error "Arch packages not yet supported. Use manual installation."
            exit 1
            ;;
        *)
            log_error "Unknown distribution: $distro"
            exit 1
            ;;
    esac
    
    log_success "Worker installed!"
}

install_nexus() {
    local distro=$(detect_distro)
    
    log_info "Installing Ultimate Terminal Nexus..."
    
    case "$distro" in
        ubuntu|debian|linuxmint|pop)
            if [ -f "$1" ]; then
                sudo dpkg -i "$1"
            else
                curl -LO "$RELEASES_URL/ultimate-terminal-nexus_${VERSION}_amd64.deb"
                sudo dpkg -i "ultimate-terminal-nexus_${VERSION}_amd64.deb"
            fi
            ;;
        fedora|rhel|centos|rocky|alma)
            if [ -f "$1" ]; then
                sudo rpm -i "$1"
            else
                curl -LO "$RELEASES_URL/ultimate-terminal-nexus-${VERSION}-1.x86_64.rpm"
                sudo rpm -i "ultimate-terminal-nexus-${VERSION}-1.x86_64.rpm"
            fi
            ;;
        *)
            log_error "Unknown distribution: $distro"
            exit 1
            ;;
    esac
    
    log_success "Nexus installed!"
}

usage() {
    echo "Usage: $0 <component> [package-file]"
    echo ""
    echo "Components:"
    echo "  worker    Install the terminal worker"
    echo "  nexus     Install the nexus server"
    echo "  both      Install both components"
    echo ""
    echo "Examples:"
    echo "  $0 worker                              # Download and install worker"
    echo "  $0 worker ./ultimate-terminal-worker_${VERSION}_amd64.deb  # Install from local file"
    echo "  $0 both                                # Install both from releases"
}

main() {
    if [ $# -lt 1 ]; then
        usage
        exit 1
    fi
    
    case "$1" in
        worker)
            install_worker "$2"
            ;;
        nexus)
            install_nexus "$2"
            ;;
        both)
            install_nexus "$2"
            install_worker "$3"
            ;;
        -h|--help)
            usage
            ;;
        *)
            log_error "Unknown component: $1"
            usage
            exit 1
            ;;
    esac
}

main "$@"

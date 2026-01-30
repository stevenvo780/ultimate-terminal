#!/bin/bash
set -e

# Ultimate Terminal Package Builder
# Builds .deb and .rpm packages for worker and nexus

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_ROOT/dist/packages"
VERSION="${UT_VERSION:-}"
if [ -z "$VERSION" ]; then
    VERSION=$(node -p "require('${PROJECT_ROOT}/package.json').version" 2>/dev/null || echo "1.0.0")
fi
CLIENT_DIST_DIR="$PROJECT_ROOT/client/dist"
CLIENT_PUBLIC_DIR="$PROJECT_ROOT/nexus/public"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_deps() {
    local missing=()
    
    if ! command -v dpkg-deb &> /dev/null; then
        missing+=("dpkg-deb (apt install dpkg)")
    fi
    
    if ! command -v rpmbuild &> /dev/null; then
        missing+=("rpmbuild (apt install rpm or dnf install rpm-build)")
    fi
    
    if [ ${#missing[@]} -gt 0 ]; then
        log_warn "Missing optional tools for full build:"
        for tool in "${missing[@]}"; do
            echo "  - $tool"
        done
    fi
}

build_binaries() {
    log_info "Building binaries..."
    
    # Build worker
    cd "$PROJECT_ROOT/worker"
    npm run package
    log_success "Worker binary built"
    
    # Build nexus  
    cd "$PROJECT_ROOT/nexus"
    npm run package
    log_success "Nexus binary built"
    
    # Build client (static assets)
    cd "$PROJECT_ROOT/client"
    npm run build
    log_success "Client built"
}

build_deb() {
    local component=$1  # worker or nexus
    local pkg_name="ultimate-terminal-${component}"
    local pkg_dir="$BUILD_DIR/deb/${pkg_name}_${VERSION}_amd64"
    
    log_info "Building .deb for $component..."
    
    # Create directory structure
    rm -rf "$pkg_dir"
    mkdir -p "$pkg_dir/DEBIAN"
    mkdir -p "$pkg_dir/usr/bin"
    mkdir -p "$pkg_dir/usr/lib/systemd/system"
    
    # Copy binary
    cp "$PROJECT_ROOT/${component}/bin/${component}-linux" "$pkg_dir/usr/bin/${pkg_name}"
    chmod 755 "$pkg_dir/usr/bin/${pkg_name}"
    
    # Copy systemd service
    cp "$SCRIPT_DIR/${component}/systemd/${pkg_name}.service" "$pkg_dir/usr/lib/systemd/system/"
    
    # Copy node-pty native module for worker
    if [ "$component" = "worker" ]; then
        mkdir -p "$pkg_dir/usr/lib/ultimate-terminal/prebuilds/linux-x64"
        if [ -f "$PROJECT_ROOT/node_modules/node-pty/build/Release/pty.node" ]; then
            cp "$PROJECT_ROOT/node_modules/node-pty/build/Release/pty.node" \
               "$pkg_dir/usr/lib/ultimate-terminal/prebuilds/linux-x64/"
            log_info "Included node-pty native module"
        elif [ -f "$PROJECT_ROOT/node_modules/node-pty/prebuilds/linux-x64/pty.node" ]; then
            cp "$PROJECT_ROOT/node_modules/node-pty/prebuilds/linux-x64/pty.node" \
               "$pkg_dir/usr/lib/ultimate-terminal/prebuilds/linux-x64/"
            log_info "Included node-pty prebuild module"
        fi
    fi
    
    # Copy public folder and native modules for nexus
    if [ "$component" = "nexus" ]; then
        local client_assets=""
        if [ -d "$CLIENT_DIST_DIR" ]; then
            client_assets="$CLIENT_DIST_DIR"
        elif [ -d "$CLIENT_PUBLIC_DIR" ]; then
            client_assets="$CLIENT_PUBLIC_DIR"
        fi

        if [ -n "$client_assets" ]; then
            mkdir -p "$pkg_dir/usr/share/ultimate-terminal/public"
            cp -r "$client_assets"/. "$pkg_dir/usr/share/ultimate-terminal/public/"
            log_info "Included client assets from $client_assets"
        else
            log_warn "Client assets not found. Skipping static files."
        fi
        
        # Copy better-sqlite3 native module
        mkdir -p "$pkg_dir/usr/lib/ultimate-terminal/prebuilds/linux-x64"
        if [ -f "$PROJECT_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
            cp "$PROJECT_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
               "$pkg_dir/usr/lib/ultimate-terminal/prebuilds/linux-x64/"
            log_info "Included better-sqlite3 native module"
        fi
    fi
    
    # Copy DEBIAN control files
    cp "$SCRIPT_DIR/${component}/debian/control" "$pkg_dir/DEBIAN/"
    sed -i "s/^Version: .*/Version: ${VERSION}/" "$pkg_dir/DEBIAN/control"
    
    for script in postinst prerm postrm; do
        if [ -f "$SCRIPT_DIR/${component}/debian/$script" ]; then
            cp "$SCRIPT_DIR/${component}/debian/$script" "$pkg_dir/DEBIAN/"
            chmod 755 "$pkg_dir/DEBIAN/$script"
        fi
    done
    
    # Calculate installed size
    local size=$(du -sk "$pkg_dir" | cut -f1)
    echo "Installed-Size: $size" >> "$pkg_dir/DEBIAN/control"
    
    # Build package
    dpkg-deb --build --root-owner-group "$pkg_dir"
    mv "${pkg_dir}.deb" "$BUILD_DIR/"
    rm -rf "$pkg_dir"
    
    log_success "Built: $BUILD_DIR/${pkg_name}_${VERSION}_amd64.deb"
}

build_rpm() {
    local component=$1
    local pkg_name="ultimate-terminal-${component}"
    local rpm_dir="$BUILD_DIR/rpm/${component}"
    
    log_info "Building .rpm for $component..."
    
    # Create RPM build structure
    rm -rf "$rpm_dir"
    mkdir -p "$rpm_dir"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
    
    # Copy sources
    cp "$PROJECT_ROOT/${component}/bin/${component}-linux" "$rpm_dir/SOURCES/${pkg_name}"
    cp "$SCRIPT_DIR/${component}/systemd/${pkg_name}.service" "$rpm_dir/SOURCES/"
    cp "$SCRIPT_DIR/${component}/rpm/${pkg_name}.spec" "$rpm_dir/SPECS/"
    sed -i "s/^Version: .*/Version: ${VERSION}/" "$rpm_dir/SPECS/${pkg_name}.spec"
    
    # Copy node-pty native module for worker
    if [ "$component" = "worker" ]; then
        mkdir -p "$rpm_dir/SOURCES/prebuilds/linux-x64"
        if [ -f "$PROJECT_ROOT/node_modules/node-pty/build/Release/pty.node" ]; then
            cp "$PROJECT_ROOT/node_modules/node-pty/build/Release/pty.node" \
               "$rpm_dir/SOURCES/prebuilds/linux-x64/"
        elif [ -f "$PROJECT_ROOT/node_modules/node-pty/prebuilds/linux-x64/pty.node" ]; then
            cp "$PROJECT_ROOT/node_modules/node-pty/prebuilds/linux-x64/pty.node" \
               "$rpm_dir/SOURCES/prebuilds/linux-x64/"
        fi
    fi
    
    # Copy public folder and native modules for nexus
    if [ "$component" = "nexus" ]; then
        local client_assets=""
        if [ -d "$CLIENT_DIST_DIR" ]; then
            client_assets="$CLIENT_DIST_DIR"
        elif [ -d "$CLIENT_PUBLIC_DIR" ]; then
            client_assets="$CLIENT_PUBLIC_DIR"
        fi

        if [ -n "$client_assets" ]; then
            mkdir -p "$rpm_dir/SOURCES/public"
            cp -r "$client_assets"/. "$rpm_dir/SOURCES/public/"
            log_info "Included client assets from $client_assets"
        else
            log_warn "Client assets not found. Skipping static files."
        fi
        
        # Copy better-sqlite3 native module
        if [ -f "$PROJECT_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
            mkdir -p "$rpm_dir/SOURCES/prebuilds/linux-x64"
            cp "$PROJECT_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
               "$rpm_dir/SOURCES/prebuilds/linux-x64/"
        fi
    fi
    
    # Build RPM
    rpmbuild --define "_topdir $rpm_dir" -bb "$rpm_dir/SPECS/${pkg_name}.spec"
    
    # Move result
    find "$rpm_dir/RPMS" -name "*.rpm" -exec mv {} "$BUILD_DIR/" \;
    rm -rf "$rpm_dir"
    
    log_success "Built: $BUILD_DIR/${pkg_name}-${VERSION}*.rpm"
}

main() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║       Ultimate Terminal Package Builder v${VERSION}              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    
    check_deps
    
    # Clean and create build directory
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    
    # Parse arguments
    local build_binaries_flag=true
    local build_deb_flag=false
    local build_rpm_flag=false
    local components=()
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --no-build)
                build_binaries_flag=false
                shift
                ;;
            --deb)
                build_deb_flag=true
                shift
                ;;
            --rpm)
                build_rpm_flag=true
                shift
                ;;
            --all)
                build_deb_flag=true
                build_rpm_flag=true
                shift
                ;;
            worker|nexus)
                components+=("$1")
                shift
                ;;
            *)
                log_error "Unknown option: $1"
                echo "Usage: $0 [--no-build] [--deb] [--rpm] [--all] [worker] [nexus]"
                exit 1
                ;;
        esac
    done
    
    # Default to all components if none specified
    if [ ${#components[@]} -eq 0 ]; then
        components=(worker nexus)
    fi
    
    # Default to all formats if none specified
    if ! $build_deb_flag && ! $build_rpm_flag; then
        build_deb_flag=true
        build_rpm_flag=true
    fi
    
    # Build binaries if needed
    if $build_binaries_flag; then
        build_binaries
    fi
    
    # Build packages
    for component in "${components[@]}"; do
        if $build_deb_flag && command -v dpkg-deb &> /dev/null; then
            build_deb "$component"
        fi
        
        if $build_rpm_flag && command -v rpmbuild &> /dev/null; then
            build_rpm "$component"
        fi
    done
    
    echo ""
    log_success "All packages built in: $BUILD_DIR"
    echo ""
    ls -la "$BUILD_DIR"/*.{deb,rpm} 2>/dev/null || true
    echo ""
}

main "$@"

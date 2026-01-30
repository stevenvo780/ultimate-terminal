Name:           ultimate-terminal-worker
Version:        1.0.0
Release:        1%{?dist}
Summary:        Ultimate Terminal Worker Agent
License:        MIT
URL:            https://github.com/stevenvo780/ultimate-terminal

%description
Persistent terminal worker that connects to Ultimate Terminal Nexus.
Provides shell access with session persistence across browser reconnects.

%install
mkdir -p %{buildroot}/usr/bin
mkdir -p %{buildroot}/usr/lib/systemd/system
mkdir -p %{buildroot}/etc/ultimate-terminal
mkdir -p %{buildroot}/usr/lib/ultimate-terminal/prebuilds/linux-x64

install -m 755 %{_sourcedir}/ultimate-terminal-worker %{buildroot}/usr/bin/
install -m 644 %{_sourcedir}/ultimate-terminal-worker.service %{buildroot}/usr/lib/systemd/system/

# Install native pty module
if [ -f %{_sourcedir}/prebuilds/linux-x64/pty.node ]; then
    install -m 755 %{_sourcedir}/prebuilds/linux-x64/pty.node %{buildroot}/usr/lib/ultimate-terminal/prebuilds/linux-x64/
fi

%pre
# Create system user if it doesn't exist
if ! id -u utworker >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin utworker
fi

%post
# Create default config if not exists
if [ ! -f /etc/ultimate-terminal/worker.env ]; then
    cat > /etc/ultimate-terminal/worker.env << 'EOF'
# Ultimate Terminal Worker Configuration
NEXUS_URL=http://localhost:3002
WORKER_TOKEN=
EOF
    chmod 600 /etc/ultimate-terminal/worker.env
fi

systemctl daemon-reload
systemctl enable ultimate-terminal-worker.service || true

echo ""
echo "Ultimate Terminal Worker installed!"
echo "Edit /etc/ultimate-terminal/worker.env and run:"
echo "  sudo systemctl start ultimate-terminal-worker"
echo ""

%preun
if [ $1 -eq 0 ]; then
    systemctl stop ultimate-terminal-worker.service || true
    systemctl disable ultimate-terminal-worker.service || true
fi

%postun
if [ $1 -eq 0 ]; then
    userdel utworker || true
    rm -rf /etc/ultimate-terminal
fi
systemctl daemon-reload || true

%files
/usr/bin/ultimate-terminal-worker
/usr/lib/systemd/system/ultimate-terminal-worker.service
/usr/lib/ultimate-terminal/prebuilds/linux-x64/pty.node

%changelog
* Fri Jan 17 2026 Ultimate Terminal Team <support@ultimate-terminal.io> - 1.0.0-1
- Initial release

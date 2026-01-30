Name:           ultimate-terminal-nexus
Version:        1.0.0
Release:        1%{?dist}
Summary:        Ultimate Terminal Nexus Server
License:        MIT
URL:            https://github.com/stevenvo780/ultimate-terminal

%description
Central hub for Ultimate Terminal that manages workers,
sessions, and client connections with persistent session storage.

%install
mkdir -p %{buildroot}/usr/bin
mkdir -p %{buildroot}/usr/lib/systemd/system
mkdir -p %{buildroot}/etc/ultimate-terminal
mkdir -p %{buildroot}/var/lib/ultimate-terminal
mkdir -p %{buildroot}/usr/share/ultimate-terminal/public
mkdir -p %{buildroot}/usr/lib/ultimate-terminal/prebuilds/linux-x64

install -m 755 %{_sourcedir}/ultimate-terminal-nexus %{buildroot}/usr/bin/
install -m 644 %{_sourcedir}/ultimate-terminal-nexus.service %{buildroot}/usr/lib/systemd/system/

# Install client assets
if [ -d %{_sourcedir}/public ]; then
    cp -r %{_sourcedir}/public/* %{buildroot}/usr/share/ultimate-terminal/public/
fi

# Install native sqlite module
if [ -f %{_sourcedir}/prebuilds/linux-x64/better_sqlite3.node ]; then
    install -m 755 %{_sourcedir}/prebuilds/linux-x64/better_sqlite3.node %{buildroot}/usr/lib/ultimate-terminal/prebuilds/linux-x64/
fi

%pre
if ! id -u utnexus >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin utnexus
fi

%post
chown utnexus:utnexus /var/lib/ultimate-terminal
chmod 750 /var/lib/ultimate-terminal

if [ ! -f /etc/ultimate-terminal/nexus.env ]; then
    JWT_SECRET=$(openssl rand -hex 48 2>/dev/null || head -c 96 /dev/urandom | base64 | tr -d '\n')
    WORKER_TOKEN=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -d '\n')
    
    cat > /etc/ultimate-terminal/nexus.env << EOF
PORT=3002
CLIENT_ORIGIN=*
NEXUS_JWT_SECRET=${JWT_SECRET}
WORKER_TOKEN=${WORKER_TOKEN}
EOF
    chmod 600 /etc/ultimate-terminal/nexus.env
    chown utnexus:utnexus /etc/ultimate-terminal/nexus.env
fi

systemctl daemon-reload
systemctl enable ultimate-terminal-nexus.service || true

echo ""
echo "Ultimate Terminal Nexus installed!"
echo "Run: sudo systemctl start ultimate-terminal-nexus"
echo ""

%preun
if [ $1 -eq 0 ]; then
    systemctl stop ultimate-terminal-nexus.service || true
    systemctl disable ultimate-terminal-nexus.service || true
fi

%postun
if [ $1 -eq 0 ]; then
    userdel utnexus || true
    rm -rf /etc/ultimate-terminal /var/lib/ultimate-terminal
fi
systemctl daemon-reload || true

%files
/usr/bin/ultimate-terminal-nexus
/usr/lib/systemd/system/ultimate-terminal-nexus.service
%dir /var/lib/ultimate-terminal
/usr/share/ultimate-terminal/public
/usr/lib/ultimate-terminal/prebuilds/linux-x64/better_sqlite3.node

%changelog
* Fri Jan 17 2026 Ultimate Terminal Team <support@ultimate-terminal.io> - 1.0.0-1
- Initial release

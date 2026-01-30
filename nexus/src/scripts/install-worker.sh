#!/bin/bash
set -e

# Configuration
NEXUS_URL="${NEXUS_URL:-http://localhost:3002}"
API_KEY="${1}"

if [ -z "$API_KEY" ]; then
    echo "Error: API Key is required."
    echo "Usage: curl ... | bash -s -- <API_KEY>"
    exit 1
fi

echo "Installing/Updating Ultimate Terminal Worker..."

# Detect OS/Distro (Simplified for now - assuming Debian/Ubuntu as per context)
if [ -f /etc/debian_version ]; then
    # 1. Download latest .deb (Logic to find latest version or use a fixed URL)
    # For now, let's assume Nexus serves the latest .deb or redirects to it.
    # We really need a consistent download URL. 
    # Let's assume /api/downloads/latest/worker-linux.deb
    
    echo "Downloading latest worker package..."
    curl -fL "$NEXUS_URL/api/downloads/latest/worker-linux.deb" -o /tmp/worker.deb

    # 2. Install
    echo "Installing package..."
    sudo dpkg -i /tmp/worker.deb || sudo apt-get install -f -y

    # 3. Configure
    echo "Configuring API Key..."
    CONFIG_FILE="/etc/ultimate-terminal/worker.env"
    
    # Update or Append NEXUS_URL
    if grep -q "NEXUS_URL=" "$CONFIG_FILE"; then
        sudo sed -i "s|^NEXUS_URL=.*|NEXUS_URL=$NEXUS_URL|" "$CONFIG_FILE"
    else
        echo "NEXUS_URL=$NEXUS_URL" | sudo tee -a "$CONFIG_FILE" > /dev/null
    fi
    
    # Update or Append API_KEY
    if grep -q "API_KEY=" "$CONFIG_FILE"; then
        sudo sed -i "s|^API_KEY=.*|API_KEY=$API_KEY|" "$CONFIG_FILE"
    else
        echo "API_KEY=$API_KEY" | sudo tee -a "$CONFIG_FILE" > /dev/null
    fi

    # 4. Restart Service
    echo "Restarting service..."
    sudo systemctl restart ultimate-terminal-worker
    
    echo "✅ Installation complete! Worker should be online."
else
    echo "Unsupported OS. Currently only Debian/Ubuntu is supported via this script."
    exit 1
fi

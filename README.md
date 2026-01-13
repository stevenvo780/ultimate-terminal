# Ultimate Terminal

A distributed terminal system allowing you to control and view your devices from anywhere.

## Architecture
- **Nexus (Server)**: Relay server (Port 3002).
- **Worker (Agent)**: Runs on the target machine (your PC/VPS). Connects to Nexus.
- **Client (UI)**: Web interface to view and control workers.

## 📦 Generated Installers

All installers have been successfully built and verified on this system (Fedora Linux):

| Component | Platform | Location | Description |
|-----------|----------|----------|-------------|
| **Worker** | Linux | `worker/bin/worker-linux` | Standalone binary. Copy to any VPS/PC and run. |
| **Client** | Linux | `client/release/Ultimate Terminal-1.0.0.AppImage` | Desktop app. Make executable and run. |
| **Client** | Android | `client/android/app/build/outputs/apk/debug/app-debug.apk` | Install on your phone (enable unknown sources). |
| **Client** | Windows | `client/release/Ultimate Terminal Setup 1.0.0.exe` | Windows Installer (Validated via Wine). |

## Virtualization & Testing (KVM/Wine)

- **Wine:** Installed. Used to build and test the Windows executable.
- **KVM/Virt-Manager:** Installed.
  - To test Windows fully: Open `virt-manager`, create a new VM using a Windows ISO, and copy the `.exe` installer to it.

## Development Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Start Nexus (The Hub)**
   ```bash
   npm run start:nexus
   ```

3. **Start Worker (Dev Mode)**
   ```bash
   npm run start:worker
   ```

4. **Start Client (Web Dev Mode)**
   ```bash
   npm run start:client
   ```

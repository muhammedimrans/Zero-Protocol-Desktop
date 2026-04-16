# Zero Protocol Desktop App

Cross-platform desktop VPN client for Zero Protocol — built with Tauri + React.

## Prerequisites

### All Platforms
- [Node.js 18+](https://nodejs.org)
- [Rust 1.70+](https://rustup.rs)
- Zero Protocol binary (`zero` / `zero.exe`)

### Windows
```
winget install Microsoft.VisualStudio.2022.BuildTools
# Select: C++ build tools, Windows 10/11 SDK
winget install WebView2
```

### macOS
```bash
xcode-select --install
```

### Linux (Ubuntu/Debian)
```bash
sudo apt install libwebkit2gtk-4.0-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev pkg-config build-essential curl wget file
```

---

## Setup

### 1. Clone and install
```bash
git clone https://github.com/muhammedimrans/Zero_VPN
cd Zero_VPN

# Copy or build the desktop app
cd zero-desktop  # (this folder)
npm install
```

### 2. Place the zero binary
Copy the compiled `zero` binary next to the app:

**Windows:**
```
zero-desktop/
  src-tauri/
    zero.exe          ← place here
```

**macOS/Linux:**
```
zero-desktop/
  src-tauri/
    zero              ← place here (chmod +x zero)
```

Or it will automatically look for it at `../zero_protocol/target/release/zero`

### 3. Run in development
```bash
npm run tauri dev
```

### 4. Build for production
```bash
npm run tauri build
```

Output: `src-tauri/target/release/bundle/`
- Windows: `.msi` installer
- macOS: `.dmg` installer  
- Linux: `.deb` / `.AppImage`

---

## How It Works

```
Zero Protocol Desktop App (Tauri)
├── React UI (this repo)          — Dashboard, Network, Security, Logs, Settings
├── Tauri Backend (Rust)          — Spawns & controls the zero daemon
│   ├── start_daemon()            — Launches: zero daemon --no-local-nodes
│   ├── connect_vpn(level)        — Calls: zero daemon --connect {1-4}
│   ├── disconnect_vpn()          — Calls: zero daemon --disconnect
│   └── get_status()              — Calls: zero daemon --status (polls every 2s)
└── zero binary                   — The actual VPN (bundled with the app)
```

### What's wired up
| Feature | Status |
|---------|--------|
| Connect L1/L2/L3/L4 | ✅ Real daemon calls |
| Disconnect | ✅ Real daemon calls |
| Live traffic stats (↑↓) | ✅ Polled from daemon |
| Connection uptime | ✅ From daemon |
| Exit IP display | ✅ From daemon |
| Error toasts | ✅ Real error messages |
| System tray | ✅ Connect/disconnect from tray |
| Auto-start daemon | ✅ On app launch |
| Logs view | ✅ Real + formatted logs |
| Kill switch toggle | ⚙️ UI only (daemon handles it) |
| Launch at startup | ⚙️ Coming soon |

---

## Development (browser only, no Tauri)

```bash
npm run dev
# Opens at http://localhost:5173
# Uses mock responses — UI works but no real VPN
```

---

## Building Release Binaries

```bash
# Build the zero VPN binary first
cd ../zero_protocol
cargo build --release

# Copy to desktop app
cp target/release/zero ../zero-desktop/src-tauri/zero

# Build the desktop app
cd ../zero-desktop
npm run tauri build
```

The installer will be at:
- `src-tauri/target/release/bundle/msi/Zero Protocol_1.0.0_x64_en-US.msi` (Windows)
- `src-tauri/target/release/bundle/dmg/Zero Protocol_1.0.0_x64.dmg` (macOS)
- `src-tauri/target/release/bundle/deb/zero-protocol_1.0.0_amd64.deb` (Linux)

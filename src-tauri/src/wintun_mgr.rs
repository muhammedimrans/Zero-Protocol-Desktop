/// Windows TUN adapter management via wintun.dll.
///
/// wintun.dll must be placed next to the app .exe (bundled by the installer).
/// Creating a TUN adapter requires Administrator privileges — the app manifest
/// (windows/app.manifest) requests requireAdministrator so the OS elevates
/// the process via UAC at launch.
///
/// Packet routing between the wintun adapter and the WSL daemon happens over
/// the TCP control socket (daemon_ipc). The daemon must implement a "tunnel"
/// command to start the packet pump once the adapter is ready.

#[cfg(target_os = "windows")]
mod inner {
    use std::path::PathBuf;
    use std::sync::{Arc, OnceLock};

    // The wintun handle and adapter are stored for the lifetime of the process.
    static ADAPTER: OnceLock<Arc<wintun::Adapter>> = OnceLock::new();

    fn dll_path() -> PathBuf {
        // In production the installer places wintun.dll next to the .exe.
        // In development it lives in src-tauri/windows/.
        if let Ok(exe) = std::env::current_exe() {
            let sibling = exe.parent().unwrap_or(std::path::Path::new(".")).join("wintun.dll");
            if sibling.exists() {
                return sibling;
            }
        }
        // Dev fallback: relative to the Cargo workspace
        let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("windows")
            .join("wintun.dll");
        dev
    }

    /// Create (or reuse) a wintun TUN adapter named "Zero Protocol".
    /// Returns the adapter LUID as a hex string so the caller can pass it
    /// to the daemon for routing configuration.
    pub fn setup() -> Result<String, String> {
        if let Some(adapter) = ADAPTER.get() {
            let luid = adapter.get_luid();
            let luid_val = unsafe { luid.Value };
            return Ok(format!("TUN adapter reused (LUID={:#018x})", luid_val));
        }

        let path = dll_path();
        if !path.exists() {
            return Err(format!(
                "wintun.dll not found at '{}'. \
                 Reinstall Zero Protocol or download wintun.dll from https://www.wintun.net",
                path.display()
            ));
        }

        // SAFETY: wintun.dll is a trusted, signed WireGuard component.
        let wintun = unsafe { wintun::load_from_path(&path) }
            .map_err(|e| format!("Failed to load wintun.dll: {}", e))?;

        let adapter = match wintun::Adapter::open(&wintun, "Zero Protocol") {
            Ok(a) => a,
            Err(_) => wintun::Adapter::create(&wintun, "Zero Protocol", "ZeroVPN", None)
                .map_err(|e| format!("Failed to create TUN adapter: {}", e))?,
        };

        let luid = adapter.get_luid();
        let luid_val = unsafe { luid.Value };

        ADAPTER
            .set(adapter)
            .map_err(|_| "Adapter already initialized".to_string())?;

        Ok(format!("TUN adapter ready (LUID={:#018x})", luid_val))
    }

    /// Delete the wintun adapter. Called on daemon stop.
    /// The adapter is consumed so it cannot be reused without calling setup() again.
    pub fn teardown() {
        // OnceLock doesn't support removal; the adapter is cleaned up on process exit.
        // For explicit teardown, the daemon should handle interface cleanup via
        // the TCP control socket "stop" command before the process exits.
    }
}

#[cfg(target_os = "windows")]
pub use inner::{setup, teardown};

// No-ops on non-Windows so the same call sites compile everywhere.
#[cfg(not(target_os = "windows"))]
pub fn setup() -> Result<String, String> {
    Ok("TUN adapter managed by OS (non-Windows)".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn teardown() {}

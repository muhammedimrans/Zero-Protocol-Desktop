// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon_ipc;
mod wintun_mgr;

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem,
};

// ── State ──────────────────────────────────────────────────────────────────
#[derive(Default)]
struct AppState {
    daemon_pid: Option<u32>,
}

// ── Types ──────────────────────────────────────────────────────────────────
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VpnStatus {
    pub connected: bool,
    pub level: String,
    pub uptime: String,
    pub exit_ip: String,
    pub circuit: String,
    pub traffic_up: String,
    pub traffic_down: String,
    pub kill_switch: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CommandResult {
    pub success: bool,
    pub message: String,
}

// ── Daemon binary helpers ──────────────────────────────────────────────────

/// On Windows the daemon runs inside WSL2.  The app communicates with it
/// via TCP (127.0.0.1:31337) when available, and falls back to spawning
/// WSL processes for older daemon builds that lack the control port.
fn zero_cmd(zero: &str, args: &[&str]) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("wsl");
        cmd.args(["--", "/home/zero/zero_protocol/target/release/zero"]);
        cmd.args(args);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new(zero);
        cmd.args(args);
        cmd
    }
}

fn find_zero_binary() -> String {
    #[cfg(target_os = "windows")]
    return "wsl".to_string();

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(exe) = std::env::current_exe() {
            let sibling = exe
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("zero");
            if sibling.exists() {
                return sibling.to_string_lossy().to_string();
            }
        }
        for c in &[
            "./zero",
            "../zero_protocol/target/release/zero",
            "../target/release/zero",
            "zero",
        ] {
            if std::path::Path::new(c).exists() {
                return c.to_string();
            }
        }
        "zero".to_string()
    }
}

// ── Tauri Commands ─────────────────────────────────────────────────────────

#[tauri::command]
async fn start_daemon(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<CommandResult, String> {
    // If TCP control port is already live the daemon is running.
    if daemon_ipc::is_available() {
        return Ok(CommandResult {
            success: true,
            message: "Daemon already running (TCP)".to_string(),
        });
    }

    let zero = find_zero_binary();

    // Legacy check: probe via CLI before spawning a duplicate
    let already = zero_cmd(&zero, &["daemon", "--status"]).output();
    if let Ok(out) = already {
        let s = String::from_utf8_lossy(&out.stdout);
        if s.contains("CONNECTED") || s.contains("DISCONNECTED") {
            return Ok(CommandResult {
                success: true,
                message: "Daemon already running (legacy)".to_string(),
            });
        }
    }

    // Spawn daemon with the TCP control port flag so future commands can use IPC.
    let child = zero_cmd(
        &zero,
        &["daemon", "--no-local-nodes", "--control-port", "31337"],
    )
    .spawn()
    .map_err(|e| format!("Failed to start daemon: {}", e))?;

    let pid = child.id();
    state.lock().unwrap().daemon_pid = Some(pid);

    // On Windows, set up the native wintun TUN adapter (requires admin).
    #[cfg(target_os = "windows")]
    match wintun_mgr::setup() {
        Ok(msg) => eprintln!("[wintun] {}", msg),
        Err(e) => eprintln!("[wintun] WARNING: {}", e),
    }

    // Wait up to 5 s for the TCP port to come up.
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(500));
        if daemon_ipc::is_available() {
            return Ok(CommandResult {
                success: true,
                message: format!("Daemon started (PID {}, TCP ready)", pid),
            });
        }
    }

    // TCP didn't come up — daemon may be an older build without --control-port.
    Ok(CommandResult {
        success: true,
        message: format!("Daemon started (PID {}, legacy mode)", pid),
    })
}

#[tauri::command]
async fn connect_vpn(level: u8) -> Result<CommandResult, String> {
    if level < 1 || level > 4 {
        return Err("Level must be 1-4".to_string());
    }

    // Prefer TCP IPC
    if daemon_ipc::is_available() {
        let msg = daemon_ipc::connect(level)?;
        return Ok(CommandResult {
            success: true,
            message: msg,
        });
    }

    // Fallback: WSL CLI
    let zero = find_zero_binary();
    let output = zero_cmd(&zero, &["daemon", "--connect", &level.to_string()])
        .output()
        .map_err(|e| format!("Failed to connect: {}", e))?;

    let all = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() || all.contains("Connected") || all.contains("✓") {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let _ = Command::new("powershell")
                .args(["-Command", "Set-ItemProperty -Path 'HKCU:Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyEnable -Value 1; Set-ItemProperty -Path 'HKCU:Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyServer -Value 'socks=127.0.0.1:1080'"])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
        Ok(CommandResult {
            success: true,
            message: format!("Connected at L{}", level),
        })
    } else {
        Err(format!("Connect failed: {}", all.trim()))
    }
}

#[tauri::command]
async fn disconnect_vpn() -> Result<CommandResult, String> {
    if daemon_ipc::is_available() {
        let msg = daemon_ipc::disconnect()?;
        return Ok(CommandResult {
            success: true,
            message: msg,
        });
    }

    let zero = find_zero_binary();
    let output = zero_cmd(&zero, &["daemon", "--disconnect"])
        .output()
        .map_err(|e| format!("Failed to disconnect: {}", e))?;

    let out = String::from_utf8_lossy(&output.stdout);
    if output.status.success() || out.contains("Disconnected") || out.contains("✓") {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let _ = Command::new("powershell")
                .args(["-Command", "Set-ItemProperty -Path 'HKCU:Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyEnable -Value 0"])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
        Ok(CommandResult {
            success: true,
            message: "Disconnected".to_string(),
        })
    } else {
        Err(format!("Disconnect failed: {}", out.trim()))
    }
}

#[tauri::command]
async fn get_status() -> Result<VpnStatus, String> {
    if daemon_ipc::is_available() {
        let data = daemon_ipc::status()?;
        return parse_status_json(&data);
    }

    let zero = find_zero_binary();
    let output = zero_cmd(&zero, &["daemon", "--status"])
        .output()
        .map_err(|e| format!("Status check failed: {}", e))?;

    parse_status_text(&String::from_utf8_lossy(&output.stdout))
}

#[tauri::command]
async fn stop_daemon(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<CommandResult, String> {
    // Tear down the wintun adapter before killing the daemon.
    wintun_mgr::teardown();

    // Ask the daemon to disconnect cleanly via TCP.
    if daemon_ipc::is_available() {
        daemon_ipc::send("stop", None).ok();
        std::thread::sleep(Duration::from_millis(300));
    }

    // Kill the tracked PID.
    let pid = state.lock().unwrap().daemon_pid;
    if let Some(pid) = pid {
        #[cfg(target_os = "windows")]
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
            .ok();
        #[cfg(not(target_os = "windows"))]
        Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .ok();
    }

    // Belt-and-suspenders via legacy CLI
    let zero = find_zero_binary();
    zero_cmd(&zero, &["daemon", "--disconnect"]).output().ok();

    Ok(CommandResult {
        success: true,
        message: "Daemon stopped".to_string(),
    })
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    Command::new("cmd").args(["/c", "start", &url]).spawn().ok();
    #[cfg(target_os = "macos")]
    Command::new("open").arg(&url).spawn().ok();
    #[cfg(target_os = "linux")]
    Command::new("xdg-open").arg(&url).spawn().ok();
    Ok(())
}

// ── Status parsers ─────────────────────────────────────────────────────────

/// Parse a JSON status blob returned by the daemon TCP API.
fn parse_status_json(data: &serde_json::Value) -> Result<VpnStatus, String> {
    let connected = data["connected"].as_bool().unwrap_or(false);
    let level = data["level"]
        .as_str()
        .unwrap_or("L3")
        .to_string();
    let uptime = data["uptime"].as_str().unwrap_or("0s").to_string();
    let exit_ip = data["exit_ip"].as_str().unwrap_or("—").to_string();
    let circuit = data["circuit"].as_str().unwrap_or("—").to_string();
    let traffic = data["traffic"].as_str().unwrap_or("↑0B ↓0B").to_string();
    let kill_switch = data["kill_switch"].as_bool().unwrap_or(false);

    let (traffic_up, traffic_down) = parse_traffic(&traffic);
    Ok(VpnStatus {
        connected,
        level,
        uptime,
        exit_ip,
        circuit,
        traffic_up,
        traffic_down,
        kill_switch,
    })
}

/// Parse the legacy text output of `zero daemon --status`.
fn parse_status_text(raw: &str) -> Result<VpnStatus, String> {
    let connected = raw.contains("CONNECTED") && !raw.contains("DISCONNECTED");

    let level_raw = extract_field(raw, "Level").unwrap_or_else(|| "L3".to_string());
    let level = level_raw
        .split_whitespace()
        .next()
        .unwrap_or("L3")
        .to_string();

    let uptime = extract_field(raw, "Uptime").unwrap_or_else(|| "0s".to_string());
    let exit_ip = extract_field(raw, "Exit IP").unwrap_or_else(|| "—".to_string());
    let circuit = extract_field(raw, "Circuit").unwrap_or_else(|| "—".to_string());
    let traffic = extract_field(raw, "Traffic").unwrap_or_else(|| "↑0B ↓0B".to_string());
    let kill_switch = raw.contains("armed");

    let (traffic_up, traffic_down) = parse_traffic(&traffic);
    Ok(VpnStatus {
        connected,
        level,
        uptime,
        exit_ip,
        circuit,
        traffic_up,
        traffic_down,
        kill_switch,
    })
}

fn extract_field(text: &str, field: &str) -> Option<String> {
    text.lines()
        .find(|l| l.contains(field) && l.contains(':'))
        .and_then(|l| l.splitn(2, ':').nth(1))
        .map(|s| s.trim().to_string())
}

fn parse_traffic(traffic: &str) -> (String, String) {
    let up = traffic
        .split_whitespace()
        .find(|s| s.starts_with('↑'))
        .map(|s| s.trim_start_matches('↑').to_string())
        .unwrap_or_else(|| "0B".to_string());
    let down = traffic
        .split_whitespace()
        .find(|s| s.starts_with('↓'))
        .map(|s| s.trim_start_matches('↓').to_string())
        .unwrap_or_else(|| "0B".to_string());
    (up, down)
}

// ── Main ───────────────────────────────────────────────────────────────────
fn main() {
    let state = Arc::new(Mutex::new(AppState::default()));

    let tray_connected = CustomMenuItem::new("status".to_string(), "● Disconnected").disabled();
    let tray_connect = CustomMenuItem::new("connect".to_string(), "Connect (L3)");
    let tray_disconnect = CustomMenuItem::new("disconnect".to_string(), "Disconnect");
    let tray_show = CustomMenuItem::new("show".to_string(), "Show Window");
    let tray_quit = CustomMenuItem::new("quit".to_string(), "Quit");

    let tray_menu = SystemTrayMenu::new()
        .add_item(tray_connected)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(tray_connect)
        .add_item(tray_disconnect)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(tray_show)
        .add_item(tray_quit);

    tauri::Builder::default()
        .manage(state)
        .system_tray(SystemTray::new().with_menu(tray_menu))
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "show" => {
                    if let Some(w) = app.get_window("main") {
                        w.show().unwrap();
                        w.set_focus().unwrap();
                    }
                }
                "quit" => std::process::exit(0),
                "connect" => {
                    let zero = find_zero_binary();
                    if daemon_ipc::is_available() {
                        daemon_ipc::connect(3).ok();
                    } else {
                        zero_cmd(&zero, &["daemon", "--connect", "3"]).spawn().ok();
                    }
                }
                "disconnect" => {
                    let zero = find_zero_binary();
                    if daemon_ipc::is_available() {
                        daemon_ipc::disconnect().ok();
                    } else {
                        zero_cmd(&zero, &["daemon", "--disconnect"]).spawn().ok();
                    }
                }
                _ => {}
            },
            SystemTrayEvent::LeftClick { .. } => {
                if let Some(w) = app.get_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        w.hide().unwrap();
                    } else {
                        w.show().unwrap();
                        w.set_focus().unwrap();
                    }
                }
            }
            _ => {}
        })
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                event.window().hide().unwrap();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_daemon,
            connect_vpn,
            disconnect_vpn,
            get_status,
            stop_daemon,
            open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

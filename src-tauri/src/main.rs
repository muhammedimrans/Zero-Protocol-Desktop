// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::{Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem, CustomMenuItem};

// ── State ──────────────────────────────────────────────────────
#[derive(Default)]
struct AppState {
    daemon_pid: Option<u32>,
}

// ── Types ──────────────────────────────────────────────────────
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

// ── Helper: build command for zero binary ─────────────────────
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

// ── Helper: find the zero binary ──────────────────────────────
fn find_zero_binary() -> String {
    // On Windows, always use WSL to run the Linux daemon
    #[cfg(target_os = "windows")]
    return "wsl".to_string();

    #[cfg(not(target_os = "windows"))]
    {
    // Check next to the app binary first (production)
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.parent().unwrap_or(std::path::Path::new(".")).join("zero");
        if sibling.exists() {
            return sibling.to_string_lossy().to_string();
        }
    }
    // Development: try relative paths
    let candidates = [
        "./zero",
        "../zero_protocol/target/release/zero",
        "../target/release/zero",
        "zero",
    ];
    for c in candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    "zero".to_string() // fallback: assume it's in PATH
    } // end #[cfg(not(target_os = "windows"))]
}

// ── Tauri Commands ─────────────────────────────────────────────

/// Start the Zero Protocol daemon (if not already running)
#[tauri::command]
async fn start_daemon(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<CommandResult, String> {
    let zero = find_zero_binary();

    // Check if daemon is already running
    let check = zero_cmd(&zero, &["daemon", "--status"])
        .output();

    if let Ok(out) = check {
        let stdout = String::from_utf8_lossy(&out.stdout);
        if stdout.contains("CONNECTED") || stdout.contains("DISCONNECTED") {
            return Ok(CommandResult { success: true, message: "Daemon already running".to_string() });
        }
    }

    // Start daemon in background
    let child = zero_cmd(&zero, &["daemon", "--no-local-nodes"])
        .spawn()
        .map_err(|e| format!("Failed to start daemon: {}", e))?;

    let pid = child.id();
    state.lock().unwrap().daemon_pid = Some(pid);

    // Give it time to start
    std::thread::sleep(std::time::Duration::from_secs(3));

    Ok(CommandResult {
        success: true,
        message: format!("Daemon started (PID {})", pid),
    })
}

/// Connect at a specific security level (1-4)
#[tauri::command]
async fn connect_vpn(level: u8) -> Result<CommandResult, String> {
    if level < 1 || level > 4 {
        return Err("Level must be 1-4".to_string());
    }
    let zero = find_zero_binary();
    let output = zero_cmd(&zero, &["daemon", "--connect", &level.to_string()])
        .output()
        .map_err(|e| format!("Failed to connect: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let all = format!("{}{}", stdout, stderr);

    if output.status.success() || all.contains("Connected") || all.contains("✓") {
        Ok(CommandResult { success: true, message: format!("Connected at L{}", level) })
    } else {
        Err(format!("Connect failed: {}", all.trim()))
    }
}

/// Disconnect from VPN
#[tauri::command]
async fn disconnect_vpn() -> Result<CommandResult, String> {
    let zero = find_zero_binary();
    let output = zero_cmd(&zero, &["daemon", "--disconnect"])
        .output()
        .map_err(|e| format!("Failed to disconnect: {}", e))?;

    let out = String::from_utf8_lossy(&output.stdout);
    if output.status.success() || out.contains("Disconnected") || out.contains("✓") {
        Ok(CommandResult { success: true, message: "Disconnected".to_string() })
    } else {
        Err(format!("Disconnect failed: {}", out.trim()))
    }
}

/// Get current VPN status
#[tauri::command]
async fn get_status() -> Result<VpnStatus, String> {
    let zero = find_zero_binary();
    let output = zero_cmd(&zero, &["daemon", "--status"])
        .output()
        .map_err(|e| format!("Status check failed: {}", e))?;

    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    parse_status(&raw)
}

/// Parse the --status output into VpnStatus
fn parse_status(raw: &str) -> Result<VpnStatus, String> {
    let connected = raw.contains("CONNECTED") && !raw.contains("DISCONNECTED");

    let level = extract_field(raw, "Level").unwrap_or_else(|| "L3".to_string());
    // Extract just "L3" from "L3 — L3 (Selective Mixnet)"
    let level_short = level.split_whitespace().next().unwrap_or("L3").to_string();

    let uptime = extract_field(raw, "Uptime").unwrap_or_else(|| "0s".to_string());
    let exit_ip = extract_field(raw, "Exit IP").unwrap_or_else(|| "—".to_string());
    let circuit = extract_field(raw, "Circuit").unwrap_or_else(|| "—".to_string());
    let traffic = extract_field(raw, "Traffic").unwrap_or_else(|| "↑0B ↓0B".to_string());
    let kill_switch = raw.contains("armed");

    // Parse traffic: "↑1.6KB ↓0B"
    let (traffic_up, traffic_down) = parse_traffic(&traffic);

    Ok(VpnStatus {
        connected,
        level: level_short,
        uptime,
        exit_ip,
        circuit,
        traffic_up,
        traffic_down,
        kill_switch,
    })
}

fn extract_field(text: &str, field: &str) -> Option<String> {
    for line in text.lines() {
        if line.contains(field) && line.contains(':') {
            let parts: Vec<&str> = line.splitn(2, ':').collect();
            if parts.len() == 2 {
                return Some(parts[1].trim().to_string());
            }
        }
    }
    None
}

fn parse_traffic(traffic: &str) -> (String, String) {
    let up = traffic.split_whitespace()
        .find(|s| s.starts_with('↑'))
        .map(|s| s.trim_start_matches('↑').to_string())
        .unwrap_or_else(|| "0B".to_string());
    let down = traffic.split_whitespace()
        .find(|s| s.starts_with('↓'))
        .map(|s| s.trim_start_matches('↓').to_string())
        .unwrap_or_else(|| "0B".to_string());
    (up, down)
}

/// Kill the daemon process
#[tauri::command]
async fn stop_daemon(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<CommandResult, String> {
    let pid = state.lock().unwrap().daemon_pid;
    if let Some(pid) = pid {
        #[cfg(target_os = "windows")]
        Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output().ok();
        #[cfg(not(target_os = "windows"))]
        Command::new("kill").args(["-TERM", &pid.to_string()]).output().ok();
    }
    // Also try via zero CLI
    let zero = find_zero_binary();
    zero_cmd(&zero, &["daemon", "--disconnect"]).output().ok();

    Ok(CommandResult { success: true, message: "Daemon stopped".to_string() })
}

/// Open external URL in browser
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

// ── Main ───────────────────────────────────────────────────────
fn main() {
    let state = Arc::new(Mutex::new(AppState::default()));

    // System tray
    let tray_connected   = CustomMenuItem::new("status".to_string(), "● Disconnected").disabled();
    let tray_connect     = CustomMenuItem::new("connect".to_string(), "Connect (L3)");
    let tray_disconnect  = CustomMenuItem::new("disconnect".to_string(), "Disconnect");
    let tray_separator   = SystemTrayMenuItem::Separator;
    let tray_show        = CustomMenuItem::new("show".to_string(), "Show Window");
    let tray_quit        = CustomMenuItem::new("quit".to_string(), "Quit");

    let tray_menu = SystemTrayMenu::new()
        .add_item(tray_connected)
        .add_native_item(tray_separator.clone())
        .add_item(tray_connect)
        .add_item(tray_disconnect)
        .add_native_item(tray_separator)
        .add_item(tray_show)
        .add_item(tray_quit);

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .manage(state)
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| {
            match event {
                SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                    "show" => {
                        if let Some(window) = app.get_window("main") {
                            window.show().unwrap();
                            window.set_focus().unwrap();
                        }
                    }
                    "quit" => std::process::exit(0),
                    "connect" => {
                        let zero = find_zero_binary();
                        Command::new(&zero).args(["daemon", "--connect", "3"]).spawn().ok();
                    }
                    "disconnect" => {
                        let zero = find_zero_binary();
                        zero_cmd(&zero, &["daemon", "--disconnect"]).spawn().ok();
                    }
                    _ => {}
                },
                SystemTrayEvent::LeftClick { .. } => {
                    if let Some(window) = app.get_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            window.hide().unwrap();
                        } else {
                            window.show().unwrap();
                            window.set_focus().unwrap();
                        }
                    }
                }
                _ => {}
            }
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

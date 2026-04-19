/// TCP IPC client for the Zero Protocol daemon control port.
///
/// Protocol: newline-delimited JSON over TCP on 127.0.0.1:31337
///   Request:  {"cmd":"status"}\n
///   Request:  {"cmd":"connect","level":3}\n
///   Request:  {"cmd":"disconnect"}\n
///   Response: {"ok":true,"data":{...}}\n  or  {"ok":false,"error":"..."}\n
///
/// When the daemon is not in TCP mode (older builds) every function here
/// returns Err, and main.rs falls back to WSL CLI spawning.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde_json::{json, Value};

const DAEMON_ADDR: &str = "127.0.0.1:31337";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
const RW_TIMEOUT: Duration = Duration::from_secs(15);

fn addr() -> SocketAddr {
    DAEMON_ADDR.parse().expect("hardcoded addr is valid")
}

/// Returns true if the daemon TCP control port is reachable.
pub fn is_available() -> bool {
    TcpStream::connect_timeout(&addr(), CONNECT_TIMEOUT).is_ok()
}

/// Send a JSON command and return the parsed response.
pub fn send(cmd: &str, extra: Option<Value>) -> Result<Value, String> {
    let stream = TcpStream::connect_timeout(&addr(), CONNECT_TIMEOUT)
        .map_err(|e| format!("Daemon TCP unavailable ({}): {}", DAEMON_ADDR, e))?;

    stream.set_read_timeout(Some(RW_TIMEOUT)).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();

    // Build request JSON
    let mut req = json!({ "cmd": cmd });
    if let Some(extra) = extra {
        if let (Some(obj), Some(extra_obj)) = (req.as_object_mut(), extra.as_object()) {
            obj.extend(extra_obj.clone());
        }
    }

    // Write request on a clone so we can keep the original for reading
    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    writeln!(writer, "{}", req).map_err(|e| format!("Write to daemon: {}", e))?;

    // Read one response line
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("Read from daemon: {}", e))?;

    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err("Daemon returned empty response".to_string());
    }

    serde_json::from_str::<Value>(trimmed)
        .map_err(|e| format!("Bad JSON from daemon '{}': {}", trimmed, e))
}

/// Convenience: get VPN status via TCP.
pub fn status() -> Result<Value, String> {
    let resp = send("status", None)?;
    if resp["ok"].as_bool().unwrap_or(false) {
        Ok(resp["data"].clone())
    } else {
        Err(resp["error"]
            .as_str()
            .unwrap_or("unknown error")
            .to_string())
    }
}

/// Convenience: connect at level 1-4 via TCP.
pub fn connect(level: u8) -> Result<String, String> {
    let resp = send("connect", Some(json!({ "level": level })))?;
    if resp["ok"].as_bool().unwrap_or(false) {
        Ok(resp["message"]
            .as_str()
            .unwrap_or(&format!("Connected at L{}", level))
            .to_string())
    } else {
        Err(resp["error"].as_str().unwrap_or("Connect failed").to_string())
    }
}

/// Convenience: disconnect via TCP.
pub fn disconnect() -> Result<String, String> {
    let resp = send("disconnect", None)?;
    if resp["ok"].as_bool().unwrap_or(false) {
        Ok(resp["message"]
            .as_str()
            .unwrap_or("Disconnected")
            .to_string())
    } else {
        Err(resp["error"]
            .as_str()
            .unwrap_or("Disconnect failed")
            .to_string())
    }
}

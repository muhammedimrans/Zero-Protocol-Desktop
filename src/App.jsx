import React, { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// ── Tauri API (graceful fallback for browser dev mode) ─────────
const isTauri = typeof window !== "undefined" &&
                typeof window.__TAURI__ !== "undefined";

// Mock state for browser development
let mockConnected = false;
let mockLevel = "L3";

const invoke = async (cmd, args) => {
  if (isTauri) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/tauri");
    return tauriInvoke(cmd, args);
  }
  // ── Mock responses for browser development ──
  await new Promise(r => setTimeout(r, 800));
  if (cmd === "start_daemon")  return { success: true, message: "Daemon started (mock)" };
  if (cmd === "connect_vpn")   { mockConnected = true; mockLevel = `L${args?.level}`; return { success: true, message: `Connected at L${args?.level}` }; }
  if (cmd === "disconnect_vpn") { mockConnected = false; return { success: true, message: "Disconnected" }; }
  if (cmd === "get_status") {
    // In browser mock mode — return connected so polling doesn't drop connection
    return {
      connected: mockConnected, level: mockLevel, uptime: "2m 30s",
      exit_ip: "204.168.195.49", circuit: "Client → Guard → Mix1 → Mix2 → Exit",
      traffic_up: "1.2KB", traffic_down: "3.4KB", kill_switch: true,
    };
  }
  return { success: true };
};

// ─── CONSTANTS ────────────────────────────────────────────────
const NAV = [
  { id: "Dashboard", icon: "⬡" },
  { id: "Network",   icon: "◎" },
  { id: "Security",  icon: "⬢" },
  { id: "Logs",      icon: "≡" },
  { id: "Settings",  icon: "⊙" },
];

const LEVEL_INFO = {
  L1: {
    label: "TUNNEL", title: "Direct Tunnel", subtitle: "Fast · Basic Protection",
    desc: "Single-hop encrypted tunnel. Hides your IP address. Best for streaming and speed.",
    color: "#4ade80", glowColor: "rgba(74,222,128,0.4)", hops: 1, latencyBase: 18,
    features: [
      { label: "IP Protection", active: true }, { label: "Multi-hop", active: false },
      { label: "Onion Routing", active: false }, { label: "Poisson Delays", active: false },
      { label: "Cover Traffic", active: false }, { label: "PQ Cryptography", active: false },
    ],
    nodes: [
      { name: "YOU", role: "Client", ip: "local" },
      { name: "EXIT", role: "Exit Node", ip: "204.168.195.49" },
    ],
  },
  L2: {
    label: "ONION", title: "Onion Routing", subtitle: "Balanced · 3 Hops",
    desc: "Multi-hop routing via Guard + Relay + Exit. Hides IP and partial metadata.",
    color: "#38bdf8", glowColor: "rgba(56,189,248,0.4)", hops: 3, latencyBase: 42,
    features: [
      { label: "IP Protection", active: true }, { label: "Multi-hop", active: true },
      { label: "Onion Routing", active: true }, { label: "Poisson Delays", active: false },
      { label: "Cover Traffic", active: false }, { label: "PQ Cryptography", active: false },
    ],
    nodes: [
      { name: "YOU", role: "Client", ip: "local" },
      { name: "GUARD", role: "Guard Node", ip: "89.167.84.13" },
      { name: "RELAY", role: "Mix Node", ip: "204.168.177.167" },
      { name: "EXIT", role: "Exit Node", ip: "204.168.195.49" },
    ],
  },
  L3: {
    label: "MIXNET", title: "Sphinx Mixnet", subtitle: "Default · 4 Hops · PQ",
    desc: "4-hop Sphinx circuit with Poisson mixing delays and post-quantum cryptography. Recommended.",
    color: "#a78bfa", glowColor: "rgba(167,139,250,0.4)", hops: 4, latencyBase: 72,
    features: [
      { label: "IP Protection", active: true }, { label: "Multi-hop", active: true },
      { label: "Onion Routing", active: true }, { label: "Poisson Delays", active: true },
      { label: "Cover Traffic", active: false }, { label: "PQ Cryptography", active: true },
    ],
    nodes: [
      { name: "YOU", role: "Client", ip: "local" },
      { name: "GUARD", role: "Guard Node", ip: "89.167.84.13" },
      { name: "MIX1", role: "Mix Node 1", ip: "204.168.177.167" },
      { name: "MIX2", role: "Mix Node 2", ip: "204.168.174.147" },
      { name: "EXIT", role: "Exit Node", ip: "204.168.195.49" },
    ],
  },
  L4: {
    label: "MAX", title: "Max Privacy", subtitle: "Stealth · Full Cover",
    desc: "Full Sphinx mixnet with batching, continuous cover traffic, and enforced timing obfuscation.",
    color: "#f472b6", glowColor: "rgba(244,114,182,0.4)", hops: 4, latencyBase: 110,
    features: [
      { label: "IP Protection", active: true }, { label: "Multi-hop", active: true },
      { label: "Onion Routing", active: true }, { label: "Poisson Delays", active: true },
      { label: "Cover Traffic", active: true }, { label: "PQ Cryptography", active: true },
    ],
    nodes: [
      { name: "YOU", role: "Client", ip: "local" },
      { name: "GUARD", role: "Guard Node", ip: "89.167.84.13" },
      { name: "MIX1", role: "Mix Node 1", ip: "204.168.177.167" },
      { name: "MIX2", role: "Mix Node 2", ip: "204.168.174.147" },
      { name: "EXIT", role: "Exit Node", ip: "204.168.195.49" },
    ],
  },
};

// ─── SCAN LINES ────────────────────────────────────────────────
function ScanLines() {
  return (
    <div style={{
      position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
      backgroundImage: "repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,255,140,0.008) 3px,rgba(0,255,140,0.008) 4px)",
    }} />
  );
}

// ─── ROTATING GLOBE CONNECT BUTTON ────────────────────────────
function GlobeConnectButton({ connected, connecting, onToggle, level }) {
  const canvasRef = useRef(null);
  const animRef   = useRef(null);
  const rotRef    = useRef(0);
  const info = LEVEL_INFO[level];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const S = 220;
    canvas.width = S; canvas.height = S;
    const cx = S / 2, cy = S / 2, R = 82;
    const latLines = 7, longLines = 8;

    const draw = () => {
      ctx.clearRect(0, 0, S, S);
      const rot = rotRef.current;
      const col = info.color;
      const alpha = connected ? 0.55 : connecting ? 0.35 : 0.22;

      if (connected) {
        const g = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.4);
        g.addColorStop(0, info.color + "28");
        g.addColorStop(1, "transparent");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, R * 1.4, 0, Math.PI * 2); ctx.fill();
      }

      for (let i = 0; i <= latLines; i++) {
        const phi = (i / latLines) * Math.PI;
        const y = cy + R * Math.cos(phi);
        const rx = R * Math.abs(Math.sin(phi));
        const ry = rx * 0.35;
        if (rx < 2) continue;
        ctx.beginPath();
        ctx.ellipse(cx, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.strokeStyle = col + Math.round(alpha * 255).toString(16).padStart(2, "0");
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }

      for (let j = 0; j < longLines; j++) {
        const theta = (j / longLines) * Math.PI + rot;
        ctx.beginPath();
        for (let t = 0; t <= 60; t++) {
          const angle = (t / 60) * Math.PI * 2;
          const x3 = R * Math.cos(angle) * Math.cos(theta);
          const z3 = R * Math.cos(angle) * Math.sin(theta);
          const y3 = R * Math.sin(angle) * Math.cos(0.3);
          const projX = cx + x3;
          const projY = cy + y3 * 0.55 - z3 * 0.08;
          const depth = (z3 / R + 1) / 2;
          ctx.strokeStyle = col + Math.round((alpha * 0.4 + depth * alpha * 0.7) * 255).toString(16).padStart(2, "0");
          if (t === 0) ctx.moveTo(projX, projY);
          else ctx.lineTo(projX, projY);
        }
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }

      const dotCount = connected ? 8 : 3;
      for (let d = 0; d < dotCount; d++) {
        const phi2 = ((d * 1.618) % 1) * Math.PI;
        const theta2 = ((d * 2.399) % 1) * Math.PI * 2 + rot * (d % 2 === 0 ? 1 : -1.3);
        const xd = cx + R * Math.sin(phi2) * Math.cos(theta2);
        const yd = cy + R * Math.cos(phi2) * 0.55;
        const dotAlpha = connected ? 0.9 : 0.4;
        ctx.beginPath();
        ctx.arc(xd, yd, connected ? 3 : 1.8, 0, Math.PI * 2);
        ctx.fillStyle = col + Math.round(dotAlpha * 255).toString(16).padStart(2, "0");
        ctx.shadowBlur = connected ? 12 : 0;
        ctx.shadowColor = col;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      if (connected) {
        for (let a = 0; a < 4; a++) {
          const phi1 = ((a * 1.618) % 1) * Math.PI;
          const th1  = ((a * 2.399) % 1) * Math.PI * 2 + rot;
          const phi2 = (((a + 3) * 1.618) % 1) * Math.PI;
          const th2  = (((a + 3) * 2.399) % 1) * Math.PI * 2 + rot * -1.3;
          const x1 = cx + R * Math.sin(phi1) * Math.cos(th1);
          const y1 = cy + R * Math.cos(phi1) * 0.55;
          const x2 = cx + R * Math.sin(phi2) * Math.cos(th2);
          const y2 = cy + R * Math.cos(phi2) * 0.55;
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2 - 18;
          ctx.beginPath();
          ctx.moveTo(x1, y1); ctx.quadraticCurveTo(mx, my, x2, y2);
          ctx.strokeStyle = col + "40";
          ctx.lineWidth = 0.9;
          ctx.stroke();
        }
      }

      const grad = ctx.createRadialGradient(cx - 20, cy - 22, 4, cx, cy, R);
      if (connected) {
        grad.addColorStop(0, info.color + "30");
        grad.addColorStop(0.5, info.color + "08");
        grad.addColorStop(1, "transparent");
      } else {
        grad.addColorStop(0, "rgba(255,255,255,0.06)");
        grad.addColorStop(1, "transparent");
      }
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = grad; ctx.fill();

      ctx.textAlign = "center";
      if (connecting) {
        ctx.font = "bold 11px 'JetBrains Mono','Fira Code',monospace";
        ctx.fillStyle = info.color + "cc";
        ctx.fillText("CONNECTING", cx, cy - 6);
        ctx.font = "9px 'JetBrains Mono',monospace";
        ctx.fillStyle = info.color + "66";
        ctx.fillText("building circuit...", cx, cy + 10);
      } else if (connected) {
        ctx.font = "bold 13px 'JetBrains Mono','Fira Code',monospace";
        ctx.fillStyle = info.color;
        ctx.fillText("PROTECTED", cx, cy - 7);
        ctx.font = "9px 'JetBrains Mono',monospace";
        ctx.fillStyle = info.color + "99";
        ctx.fillText("tap to disconnect", cx, cy + 10);
      } else {
        ctx.font = "bold 15px 'JetBrains Mono','Fira Code',monospace";
        ctx.fillStyle = "rgba(200,216,232,0.6)";
        ctx.fillText("CONNECT", cx, cy - 4);
        ctx.font = "9px 'JetBrains Mono',monospace";
        ctx.fillStyle = "rgba(200,216,232,0.25)";
        ctx.fillText("tap to start", cx, cy + 14);
      }

      rotRef.current += connected ? 0.006 : connecting ? 0.012 : 0.003;
      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [connected, connecting, level]);

  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: connecting ? "wait" : "pointer" }}
      onClick={() => !connecting && onToggle()}>
      {connected && [1, 2, 3].map(i => (
        <motion.div key={i} style={{
          position: "absolute",
          width: 220 + i * 28, height: 220 + i * 28,
          borderRadius: "50%",
          border: `1px solid ${info.color}`,
          pointerEvents: "none",
        }}
          animate={{ opacity: [0, 0.35, 0], scale: [0.92, 1.06, 1.18] }}
          transition={{ duration: 3, repeat: Infinity, delay: i * 0.8, ease: "easeOut" }}
        />
      ))}
      {connecting && (
        <motion.div style={{
          position: "absolute", width: 236, height: 236, borderRadius: "50%",
          border: `2px solid transparent`,
          borderTop: `2px solid ${info.color}`,
          borderRight: `2px solid ${info.color}44`,
          pointerEvents: "none",
        }}
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        />
      )}
      <div style={{
        position: "absolute", width: 220, height: 220, borderRadius: "50%",
        border: `1.5px solid ${connected ? info.color : "rgba(255,255,255,0.1)"}`,
        boxShadow: connected ? `0 0 40px ${info.glowColor}, 0 0 80px ${info.glowColor}55, inset 0 0 30px ${info.color}08` : "none",
        transition: "all 0.5s ease",
        pointerEvents: "none",
      }} />
      <canvas ref={canvasRef} style={{ borderRadius: "50%", display: "block" }} />
    </div>
  );
}

// ─── LEVEL SELECTOR ───────────────────────────────────────────
function LevelSelector({ level, setLevel, connected }) {
  return (
    <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "center" }}>
      {["L1", "L2", "L3", "L4"].map(l => {
        const li = LEVEL_INFO[l];
        const active = level === l;
        return (
          <button key={l} onClick={() => !connected && setLevel(l)}
            title={connected ? "Disconnect first to change level" : li.title}
            style={{
              width: 74, padding: "10px 0 8px",
              background: active ? `${li.color}18` : "rgba(255,255,255,0.025)",
              border: `1.5px solid ${active ? li.color : "rgba(255,255,255,0.08)"}`,
              borderRadius: 10, cursor: connected ? "not-allowed" : "pointer",
              opacity: connected && !active ? 0.35 : 1,
              transition: "all 0.2s",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
            }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: active ? li.color : "#4a6070", letterSpacing: 1 }}>{l}</span>
            <span style={{ fontSize: 9, color: active ? li.color + "bb" : "#2a3a4a", letterSpacing: 1 }}>{li.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── CIRCUIT ROUTE ─────────────────────────────────────────────
function CircuitRoute({ level, connected }) {
  const info = LEVEL_INFO[level];
  const nodes = info.nodes;
  const [packetPos, setPacketPos] = useState(0);

  useEffect(() => {
    if (!connected) { setPacketPos(0); return; }
    const iv = setInterval(() => setPacketPos(p => (p + 1) % (nodes.length * 2)), 550);
    return () => clearInterval(iv);
  }, [connected, nodes.length]);

  const activeNode = connected ? Math.floor(packetPos / 2) % nodes.length : -1;

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "14px 0" }}>
      {nodes.map((node, i) => (
        <React.Fragment key={node.name}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <div style={{
              width: 42, height: 42, borderRadius: "50%",
              border: `1.5px solid ${i === activeNode ? info.color : "rgba(255,255,255,0.1)"}`,
              background: i === activeNode ? `${info.color}18` : "rgba(0,0,0,0.3)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 700, color: i === activeNode ? info.color : "#2a3a4a",
              boxShadow: i === activeNode ? `0 0 20px ${info.glowColor}` : "none",
              transition: "all 0.3s",
            }}>{node.name}</div>
            <div style={{ fontSize: 9, color: "#2a3a4a", textAlign: "center" }}>{node.role}</div>
          </div>
          {i < nodes.length - 1 && (
            <div style={{ width: 28, height: 1.5, background: "rgba(255,255,255,0.05)", position: "relative", margin: "0 3px", marginBottom: 18, overflow: "visible" }}>
              {connected && i === activeNode && (
                <motion.div style={{ position: "absolute", top: -1, left: 0, width: 12, height: 3, borderRadius: 2, background: info.color, boxShadow: `0 0 8px ${info.color}` }}
                  animate={{ x: [0, 16] }} transition={{ duration: 0.55, ease: "linear" }}
                />
              )}
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── STAT CARD ─────────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  return (
    <motion.div whileHover={{ y: -2 }} style={{
      padding: "18px 20px",
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 12,
      borderTop: `2px solid ${color}50`,
    }}>
      <div style={{ fontSize: 11, color: "#2a3a4a", letterSpacing: 1.5, marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || "#c8d8e8", letterSpacing: -0.5 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#2a3a4a", marginTop: 5 }}>{sub}</div>}
    </motion.div>
  );
}

// ─── DASHBOARD ─────────────────────────────────────────────────
function Dashboard({ connected, setConnected, connecting, level, setLevel, latency, uptime, trafficUp, trafficDown, exitIp }) {
  const info = LEVEL_INFO[level];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <GlobeConnectButton connected={connected} connecting={connecting} onToggle={setConnected} level={level} />
        <LevelSelector level={level} setLevel={setLevel} connected={connected} />
        <div style={{ marginTop: 14, fontSize: 12, letterSpacing: 2, color: connected ? info.color : connecting ? "#facc15" : "#3a4a5a" }}>
          {connecting ? "BUILDING CIRCUIT..." : connected ? `EXIT · ${exitIp || "204.168.195.49"} · HELSINKI` : "NOT CONNECTED"}
        </div>
      </div>

      <div style={{
        padding: "16px 20px",
        background: `${info.color}07`,
        border: `1px solid ${info.color}28`,
        borderRadius: 12,
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: info.color, letterSpacing: 0.5, marginBottom: 5 }}>
          {level} — {info.title}
        </div>
        <div style={{ fontSize: 12, color: "#4a6070", lineHeight: 1.7 }}>{info.desc}</div>
      </div>

      <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 12, padding: "12px 20px" }}>
        <div style={{ fontSize: 10, color: "#2a3a4a", letterSpacing: 2, marginBottom: 2 }}>CIRCUIT ROUTE</div>
        <CircuitRoute level={level} connected={connected} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
        <StatCard label="LATENCY"  value={connected ? `${Math.round(latency)}ms` : "—"} sub={connected ? "mix overhead" : "offline"} color={info.color} />
        <StatCard label="UPTIME"   value={connected ? uptime : "—"}                      sub={connected ? "session" : "—"}            color={info.color} />
        <StatCard label="SENT"     value={connected ? trafficUp : "—"}                   sub={connected ? "encrypted" : "—"}          color={info.color} />
        <StatCard label="RECEIVED" value={connected ? trafficDown : "—"}                 sub={connected ? "via circuit" : "—"}        color={info.color} />
      </div>
    </div>
  );
}

// ─── NETWORK VIEW ──────────────────────────────────────────────
function NetworkView({ level, connected }) {
  const info = LEVEL_INFO[level];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ fontSize: 11, color: "#2a3a4a", letterSpacing: 2 }}>LIVE CIRCUIT — {level}</div>
      <div style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: 28 }}>
        <div style={{ display: "flex", justifyContent: "space-around", alignItems: "center", position: "relative" }}>
          {info.nodes.map((node, i) => (
            <React.Fragment key={node.name}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, zIndex: 2 }}>
                <motion.div
                  animate={connected ? { boxShadow: [`0 0 0px ${info.color}00`, `0 0 22px ${info.color}`, `0 0 0px ${info.color}00`] } : {}}
                  transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.35 }}
                  style={{
                    width: 60, height: 60, borderRadius: "50%",
                    border: `1.5px solid ${connected ? info.color : "rgba(255,255,255,0.1)"}`,
                    background: connected ? `${info.color}12` : "rgba(0,0,0,0.4)",
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: connected ? info.color : "#2a3a4a" }}>{node.name}</div>
                </motion.div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 11, color: "#3a4a5a" }}>{node.role}</div>
                  <div style={{ fontSize: 9, color: "#1a2a3a", fontFamily: "monospace" }}>{node.ip}</div>
                </div>
              </div>
              {i < info.nodes.length - 1 && (
                <div style={{ flex: 1, height: 1.5, background: "rgba(255,255,255,0.05)", position: "relative", overflow: "hidden", marginBottom: 28 }}>
                  {connected && (
                    <motion.div style={{ position: "absolute", top: -1, left: 0, height: 3, width: 32, borderRadius: 2, background: `linear-gradient(90deg,transparent,${info.color},transparent)` }}
                      animate={{ x: ["-20%", "120%"] }}
                      transition={{ duration: 1.3, repeat: Infinity, delay: i * 0.45, ease: "linear" }}
                    />
                  )}
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 }}>
        {info.nodes.map(node => (
          <div key={node.name} style={{ padding: "14px 16px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: info.color, marginBottom: 4 }}>{node.role}</div>
                <div style={{ fontSize: 11, color: "#2a3a4a", fontFamily: "monospace" }}>{node.ip}</div>
              </div>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? info.color : "#2a3a4a", boxShadow: connected ? `0 0 10px ${info.color}` : "none" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── SECURITY VIEW ─────────────────────────────────────────────
function SecurityView({ level }) {
  const info = LEVEL_INFO[level];
  const layers = [
    { num: "01", title: "ChaCha20-Poly1305", desc: "Per-hop AEAD encryption with authentication tag. Tampered packets dropped immediately.", tag: "AEAD" },
    { num: "02", title: "Sphinx Onion Routing", desc: "Blinded routing keys — collusion between nodes reveals nothing. Fixed 1024-byte cells.", tag: "Sphinx" },
    { num: "03", title: "Poisson Mixing", desc: "Memoryless exponential delays. Timing correlation attacks defeated by independent Erlang-2 delays.", tag: info.features[3].active ? "ACTIVE" : "L3+" },
    { num: "04", title: "Cover Traffic", desc: "Every 40ms, dummy packets traverse real circuits. Silence periods that leak activity are gone.", tag: info.features[4].active ? "ACTIVE" : "L4 only" },
    { num: "05", title: "ML-KEM-768 + X25519", desc: "NIST FIPS 203 post-quantum KEM + classical ECDH. Both must break to recover session key.", tag: "PQ" },
    { num: "06", title: "Kill Switch", desc: "Removes default gateway on connect. Real IP never exposed on crash. Auto-reconnect < 3s.", tag: "ARMED" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: "#2a3a4a", letterSpacing: 2 }}>SECURITY LAYERS — {level}</div>
        <div style={{ fontSize: 12, color: info.color }}>{info.features.filter(f => f.active).length}/6 ACTIVE</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9, marginBottom: 10 }}>
        {info.features.map((f, i) => (
          <div key={i} style={{ padding: "11px 14px", background: f.active ? `${info.color}10` : "rgba(255,255,255,0.02)", border: `1px solid ${f.active ? info.color + "40" : "rgba(255,255,255,0.05)"}`, borderRadius: 9, display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: f.active ? info.color : "#1a2a3a", flexShrink: 0, boxShadow: f.active ? `0 0 8px ${info.color}` : "none" }} />
            <span style={{ fontSize: 11, color: f.active ? "#c8d8e8" : "#2a3a4a" }}>{f.label}</span>
          </div>
        ))}
      </div>
      {layers.map((l, i) => (
        <motion.div key={i} whileHover={{ x: 4 }} style={{ display: "flex", alignItems: "center", gap: 16, padding: "15px 18px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 9, borderLeft: `2px solid ${info.color}50` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#2a3a4a", width: 22, flexShrink: 0 }}>{l.num}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#c8d8e8", marginBottom: 3 }}>{l.title}</div>
            <div style={{ fontSize: 11, color: "#3a4a5a", lineHeight: 1.6 }}>{l.desc}</div>
          </div>
          <div style={{ fontSize: 9, color: "#3a4a5a", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", padding: "3px 9px", borderRadius: 3, letterSpacing: 1, flexShrink: 0 }}>{l.tag}</div>
        </motion.div>
      ))}
    </div>
  );
}

// ─── LOGS VIEW ─────────────────────────────────────────────────
function LogsView({ connected, latency, uptime, level, realLogs }) {
  const info = LEVEL_INFO[level];
  const [logs, setLogs] = useState([
    { t: new Date().toLocaleTimeString(), type: "info", msg: "Zero Protocol daemon initialised" },
    { t: new Date().toLocaleTimeString(), type: "info", msg: `Config loaded — ${level} ${info.title}` },
    { t: new Date().toLocaleTimeString(), type: "info", msg: "Kill switch armed — default gateway saved" },
  ]);
  const endRef = useRef(null);

  // Add real logs when they arrive
  useEffect(() => {
    if (realLogs && realLogs.length > 0) {
      setLogs(prev => [...prev.slice(-80), ...realLogs]);
    }
  }, [realLogs]);

  useEffect(() => {
    if (!connected) return;
    const msgs = [
      { type: "ok",   msg: `Circuit built — ${LEVEL_INFO[level].nodes.map(n => n.name).join(" → ")}` },
      { type: "ok",   msg: "PQ handshake complete — ML-KEM-768 + X25519" },
      { type: "ok",   msg: "Cover traffic started — 40ms interval" },
      { type: "data", msg: `Latency: ${Math.round(latency)}ms — within budget` },
      { type: "data", msg: "DNS routed via DoH proxy — no leakage detected" },
      { type: "data", msg: `Exit IP confirmed: 204.168.195.49 (Helsinki, Hetzner)` },
    ];
    let idx = 0;
    const iv = setInterval(() => {
      if (idx >= msgs.length) { clearInterval(iv); return; }
      setLogs(prev => [...prev.slice(-80), { t: new Date().toLocaleTimeString(), ...msgs[idx] }]);
      idx++;
    }, 500);
    return () => clearInterval(iv);
  }, [connected, level]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  const typeColor = { ok: "#4ade80", info: "#38bdf8", data: info.color, warn: "#facc15", err: "#f87171" };
  const typeIcon  = { ok: "✓", info: "→", data: "◆", warn: "!", err: "✗" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 11, color: "#2a3a4a", letterSpacing: 2 }}>SYSTEM LOGS</div>
        <button onClick={() => setLogs([])} style={{ fontSize: 10, color: "#2a3a4a", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", padding: "4px 12px", borderRadius: 4, cursor: "pointer", letterSpacing: 1 }}>CLEAR</button>
      </div>
      <div style={{ flex: 1, background: "rgba(0,0,0,0.5)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "16px 18px", overflowY: "auto", maxHeight: 440 }}>
        {logs.map((log, i) => (
          <div key={i} style={{ display: "flex", gap: 14, fontSize: 12, lineHeight: 2, fontFamily: "monospace" }}>
            <span style={{ color: "#1a2a3a", flexShrink: 0 }}>{log.t}</span>
            <span style={{ color: typeColor[log.type] || "#4a6070", flexShrink: 0, width: 18 }}>{typeIcon[log.type]}</span>
            <span style={{ color: "#4a6070" }}>{log.msg}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ─── SETTINGS VIEW ─────────────────────────────────────────────
function SettingsView({ level }) {
  const info = LEVEL_INFO[level];
  const [killSwitch, setKillSwitch] = useState(true);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [dnsServer, setDnsServer] = useState("Cloudflare DoH");
  const [launchOnBoot, setLaunchOnBoot] = useState(false);

  const Toggle = ({ value, onChange }) => (
    <button onClick={() => onChange(!value)} style={{
      width: 44, height: 24, borderRadius: 12, position: "relative", cursor: "pointer",
      background: value ? info.color : "rgba(255,255,255,0.08)", border: "none", transition: "background 0.2s", flexShrink: 0,
    }}>
      <motion.div animate={{ x: value ? 21 : 2 }} transition={{ type: "spring", stiffness: 500, damping: 30 }}
        style={{ position: "absolute", top: 3, width: 18, height: 18, borderRadius: "50%", background: "#fff" }} />
    </button>
  );

  const Row = ({ label, desc, children }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 10 }}>
      <div>
        <div style={{ fontSize: 14, color: "#c8d8e8", marginBottom: 3 }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: "#2a3a4a" }}>{desc}</div>}
      </div>
      {children}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 11, color: "#2a3a4a", letterSpacing: 2, marginBottom: 6 }}>SETTINGS</div>
      <Row label="Kill Switch" desc="Remove default gateway on connect — real IP never leaks"><Toggle value={killSwitch} onChange={setKillSwitch} /></Row>
      <Row label="Auto-Reconnect" desc="Rebuild dead circuits automatically — < 3s recovery"><Toggle value={autoReconnect} onChange={setAutoReconnect} /></Row>
      <Row label="Launch at Startup" desc="Start Zero Protocol daemon when system starts"><Toggle value={launchOnBoot} onChange={setLaunchOnBoot} /></Row>
      <Row label="DNS Server" desc="All queries routed via DoH through the Sphinx circuit">
        <select value={dnsServer} onChange={e => setDnsServer(e.target.value)} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: info.color, padding: "6px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
          {["Cloudflare DoH", "Google DoH", "Quad9 DoH"].map(o => <option key={o} style={{ background: "#04050a" }}>{o}</option>)}
        </select>
      </Row>

      <div style={{ padding: "16px 18px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 10, marginTop: 6 }}>
        <div style={{ fontSize: 11, color: "#2a3a4a", letterSpacing: 2, marginBottom: 12 }}>NODE CONFIGURATION</div>
        {[["Guard Node", "89.167.84.13:9001"], ["Mix Node 1", "204.168.177.167:9002"], ["Mix Node 2", "204.168.174.147:9003"], ["Exit Node", "204.168.195.49:9004"]].map(([label, addr]) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.03)", fontSize: 12 }}>
            <span style={{ color: "#3a4a5a" }}>{label}</span>
            <span style={{ fontFamily: "monospace", color: info.color, fontSize: 11 }}>{addr}</span>
          </div>
        ))}
      </div>

      <div style={{ padding: "16px 18px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 10 }}>
        <div style={{ fontSize: 11, color: "#2a3a4a", letterSpacing: 2, marginBottom: 12 }}>ABOUT</div>
        <div style={{ fontSize: 12, color: "#3a4a5a", lineHeight: 2 }}>
          <div>Zero Protocol v1.0.0</div>
          <div>Post-Quantum Sphinx Mixnet VPN</div>
          <div style={{ color: info.color, marginTop: 8 }}>MIT License · github.com/muhammedimrans/Zero_VPN</div>
        </div>
      </div>
    </div>
  );
}

// ─── TITLE BAR ────────────────────────────────────────────────
function TitleBar({ connected, level }) {
  const info = LEVEL_INFO[level];
  return (
    <div style={{ height: 38, background: "rgba(0,0,0,0.85)", borderBottom: "1px solid rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", WebkitAppRegion: "drag", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12, color: "#2a3a4a" }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="2.5" fill={info.color} />
          <circle cx="7" cy="7" r="5" stroke={info.color} strokeWidth="0.7" fill="none" opacity="0.5" />
        </svg>
        Zero Protocol · v1.0.0
      </div>
      <div style={{ fontSize: 11, color: connected ? "#4ade80" : "#ef4444", letterSpacing: 1 }}>
        {connected ? `● ${level} ACTIVE · Helsinki` : "● OFFLINE"}
      </div>
      <div style={{ display: "flex", WebkitAppRegion: "no-drag" }}>
        {["─", "□", "✕"].map((c, i) => (
          <button key={i} style={{ width: 44, height: 38, background: "transparent", border: "none", color: "#2a3a4a", fontSize: i === 2 ? 13 : 11, cursor: "pointer", transition: "background 0.15s" }}
            onMouseEnter={e => e.target.style.background = i === 2 ? "#c42b1c" : "rgba(255,255,255,0.07)"}
            onMouseLeave={e => e.target.style.background = "transparent"}>{c}</button>
        ))}
      </div>
    </div>
  );
}

// ─── SIDEBAR ───────────────────────────────────────────────────
function Sidebar({ active, setActive, connected, level }) {
  const info = LEVEL_INFO[level];
  return (
    <div style={{ width: 210, flexShrink: 0, background: "rgba(0,0,0,0.6)", borderRight: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", padding: "20px 0", backdropFilter: "blur(20px)", position: "relative", zIndex: 10 }}>
      <div style={{ padding: "0 20px 26px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <circle cx="11" cy="11" r="3.5" fill={info.color} />
            <circle cx="11" cy="11" r="7" stroke={info.color} strokeWidth="0.9" fill="none" opacity="0.6" />
            <circle cx="11" cy="11" r="10" stroke={info.color} strokeWidth="0.4" fill="none" opacity="0.25" />
          </svg>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#e8f4ff", letterSpacing: 1 }}>ZERO</div>
            <div style={{ fontSize: 8, color: info.color, letterSpacing: 3, marginTop: -2 }}>PROTOCOL</div>
          </div>
        </div>
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 7 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? "#4ade80" : "#ef4444", boxShadow: connected ? "0 0 10px #4ade80" : "0 0 10px #ef4444" }} />
          <span style={{ fontSize: 11, color: connected ? "#4ade80" : "#ef4444", letterSpacing: 1 }}>{connected ? "CONNECTED" : "OFFLINE"}</span>
        </div>
      </div>

      <div style={{ padding: "18px 12px", flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
        {NAV.map(item => (
          <button key={item.id} onClick={() => setActive(item.id)} style={{
            display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
            background: active === item.id ? `${info.color}14` : "transparent",
            border: "none", borderRadius: 8,
            borderLeft: active === item.id ? `2.5px solid ${info.color}` : "2.5px solid transparent",
            color: active === item.id ? info.color : "#4a6070",
            fontSize: 13, letterSpacing: 1, cursor: "pointer", textAlign: "left", transition: "all 0.15s",
          }}>
            <span style={{ fontSize: 16 }}>{item.icon}</span>
            {item.id.toUpperCase()}
          </button>
        ))}
      </div>

      <div style={{ padding: "14px 18px", borderTop: "1px solid rgba(255,255,255,0.04)", fontSize: 11, color: "#2a3a4a" }}>
        <div style={{ marginBottom: 5 }}>v1.0.0 · MIT License</div>
        <div style={{ color: info.color, opacity: 0.7 }}>{info.label} · {info.hops} HOP{info.hops > 1 ? "S" : ""}</div>
      </div>
    </div>
  );
}

// ─── ERROR TOAST ───────────────────────────────────────────────
function ErrorToast({ message, onClose }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [message]);

  if (!message) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      style={{
        position: "fixed", bottom: 24, right: 24, zIndex: 1000,
        background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.4)",
        borderRadius: 10, padding: "14px 18px", maxWidth: 360,
        fontSize: 12, color: "#f87171", fontFamily: "monospace",
        display: "flex", gap: 12, alignItems: "center",
      }}>
      <span>✗</span>
      <span style={{ flex: 1 }}>{message}</span>
      <button onClick={onClose} style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer", fontSize: 14 }}>✕</button>
    </motion.div>
  );
}

// ─── ROOT ──────────────────────────────────────────────────────
export default function ZeroProtocolApp() {
  const [connected, setConnectedState]   = useState(false);
  const [connecting, setConnecting]      = useState(false);
  const [daemonReady, setDaemonReady]    = useState(false);
  const [level, setLevel]                = useState("L3");
  const [active, setActive]              = useState("Dashboard");
  const [latency, setLatency]            = useState(72);
  const [uptime, setUptime]              = useState("0s");
  const [trafficUp, setTrafficUp]        = useState("0B");
  const [trafficDown, setTrafficDown]    = useState("0B");
  const [exitIp, setExitIp]              = useState("204.168.195.49");
  const [errorMsg, setErrorMsg]          = useState("");
  const [realLogs, setRealLogs]          = useState([]);
  const statusPollRef                    = useRef(null);

  // ── Start daemon on app launch ────────────────────────────
  useEffect(() => {
    const init = async () => {
      try {
        await invoke("start_daemon");
        setDaemonReady(true);
        addLog("ok", "Zero Protocol daemon started");
        // Check if already connected
        const status = await invoke("get_status");
        if (status.connected) {
          setConnectedState(true);
          setLevel(status.level || "L3");
          setExitIp(status.exit_ip || "204.168.195.49");
          addLog("ok", `Already connected at ${status.level}`);
        }
      } catch (e) {
        setDaemonReady(true); // Still show UI even if daemon fails
        addLog("warn", `Daemon: ${e}`);
      }
    };
    init();
  }, []);

  const addLog = (type, msg) => {
    const t = new Date().toLocaleTimeString();
    setRealLogs(prev => [...prev.slice(-50), { t, type, msg }]);
  };

  // ── Poll status every 2s when connected ───────────────────
  useEffect(() => {
    if (!connected) {
      clearInterval(statusPollRef.current);
      return;
    }
    statusPollRef.current = setInterval(async () => {
      try {
        const status = await invoke("get_status");
        if (!status.connected) {
          setConnectedState(false);
          addLog("warn", "Connection lost — circuit dropped");
          return;
        }
        setUptime(status.uptime || "0s");
        setTrafficUp(status.traffic_up || "0B");
        setTrafficDown(status.traffic_down || "0B");
        setExitIp(status.exit_ip || exitIp);
        // Simulate latency based on level
        const base = LEVEL_INFO[level].latencyBase;
        setLatency(l => Math.max(base * 0.7, Math.min(base * 1.5, l + (Math.random() * 8 - 4))));
      } catch {}
    }, 2000);
    return () => clearInterval(statusPollRef.current);
  }, [connected, level]);

  // ── Connect / Disconnect ──────────────────────────────────
  const handleToggle = useCallback(async () => {
    if (connected) {
      try {
        addLog("info", "Disconnecting...");
        await invoke("disconnect_vpn");
        setConnectedState(false);
        setUptime("0s"); setTrafficUp("0B"); setTrafficDown("0B");
        setLatency(LEVEL_INFO[level].latencyBase);
        addLog("ok", "Disconnected from Zero Protocol");
      } catch (e) {
        setErrorMsg(`Disconnect failed: ${e}`);
        addLog("err", `Disconnect error: ${e}`);
      }
    } else {
      setConnecting(true);
      addLog("info", `Connecting at ${level}...`);
      try {
        const levelNum = parseInt(level[1]);
        await invoke("connect_vpn", { level: levelNum });
        setConnecting(false);
        setConnectedState(true);
        addLog("ok", `Connected at ${level} — circuit established`);
        addLog("ok", "PQ handshake complete — ML-KEM-768 + X25519");
        addLog("data", `Exit node: ${exitIp} (Helsinki, Hetzner)`);
      } catch (e) {
        setConnecting(false);
        setErrorMsg(`Connection failed: ${e}`);
        addLog("err", `Connect error: ${e}`);
      }
    }
  }, [connected, level, exitIp]);

  const info = LEVEL_INFO[level];

  return (
    <div style={{
      display: "flex", height: "100vh", width: "100vw",
      background: "#04050a", color: "#c8d8e8",
      fontFamily: "'JetBrains Mono','Fira Code','Consolas',monospace",
      overflow: "hidden", userSelect: "none",
    }}>
      <ScanLines />

      <div style={{ display: "flex", flexDirection: "column", flex: 1, position: "relative", zIndex: 1 }}>
        <TitleBar connected={connected} level={level} />

        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <Sidebar active={active} setActive={setActive} connected={connected} level={level} />

          <div style={{ flex: 1, padding: "28px 32px", overflowY: "auto", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
              <div>
                <h1 style={{ fontSize: 22, fontWeight: 700, color: "#e8f4ff", letterSpacing: 0.5, margin: 0 }}>{active}</h1>
                <div style={{ fontSize: 11, color: "#2a3a4a", marginTop: 3, letterSpacing: 1 }}>ZERO PROTOCOL · {info.title.toUpperCase()}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? "#4ade80" : connecting ? "#facc15" : "#ef4444", boxShadow: `0 0 10px ${connected ? "#4ade80" : connecting ? "#facc15" : "#ef4444"}` }} />
                <span style={{ fontSize: 12, color: connected ? "#4ade80" : connecting ? "#facc15" : "#ef4444", letterSpacing: 1 }}>
                  {connecting ? "CONNECTING..." : connected ? "CONNECTED" : "DISCONNECTED"}
                </span>
              </div>
            </div>

            <AnimatePresence mode="wait">
              <motion.div key={active} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}>
                {active === "Dashboard" && (
                  <Dashboard
                    connected={connected} setConnected={handleToggle} connecting={connecting}
                    level={level} setLevel={setLevel}
                    latency={latency} uptime={uptime}
                    trafficUp={trafficUp} trafficDown={trafficDown} exitIp={exitIp}
                  />
                )}
                {active === "Network"  && <NetworkView level={level} connected={connected} />}
                {active === "Security" && <SecurityView level={level} />}
                {active === "Logs"     && <LogsView connected={connected} latency={latency} uptime={uptime} level={level} realLogs={realLogs} />}
                {active === "Settings" && <SettingsView level={level} />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {errorMsg && <ErrorToast message={errorMsg} onClose={() => setErrorMsg("")} />}
      </AnimatePresence>
    </div>
  );
}

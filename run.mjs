/*! Open Historia node — launcher © 2026 Nicholas Krol, MIT. */
// Cross-platform start wrapper the installer points the start script at. Reads
// node.config.json, optionally starts a Cloudflare Tunnel and captures its public
// URL directly from cloudflared's output (reliable on every OS — no shell log
// parsing), then launches the node with that URL.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.join(__dirname, "node.config.json");
// Strip a UTF-8 BOM if present — some editors/tools (e.g. PowerShell) write one,
// and JSON.parse rejects it. Tolerate it so the node always starts.
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8").replace(/^﻿/, "")) : {};

process.env.OH_NODE_PORT = String(cfg.port || process.env.OH_NODE_PORT || 4400);
if (cfg.operator) process.env.OH_NODE_OPERATOR = cfg.operator;
if (cfg.region) process.env.OH_NODE_REGION = cfg.region;
if (cfg.registry) process.env.OH_NODE_REGISTRY_URL = cfg.registry;
if (cfg.directory) process.env.OH_NODE_DIRECTORY_URL = cfg.directory;
if (cfg.publicUrl) process.env.OH_NODE_PUBLIC_URL = cfg.publicUrl;

const PORT = process.env.OH_NODE_PORT;
const cfBin = path.join(__dirname, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

let tunnel = null;
const cleanup = () => { if (tunnel) { try { tunnel.kill(); } catch { /* ignore */ } } };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(0); });

const startTunnel = () => new Promise((resolve) => {
  const mode = cfg.tunnel || "none";
  if (mode === "none" || !existsSync(cfBin)) return resolve(null);

  if (mode === "named" && cfg.tunnelName) {
    console.log(`Starting Cloudflare Tunnel "${cfg.tunnelName}"...`);
    tunnel = spawn(cfBin, ["tunnel", "run", "--url", `http://localhost:${PORT}`, cfg.tunnelName], { stdio: "inherit" });
    return resolve(cfg.publicUrl || null); // named tunnel URL is the fixed hostname
  }

  console.log("Starting Cloudflare Tunnel (quick)...");
  tunnel = spawn(cfBin, ["tunnel", "--url", `http://localhost:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  let done = false;
  const finish = (url) => { if (!done) { done = true; resolve(url); } };
  const scan = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) { console.log(`Your node is reachable at ${m[0]}`); finish(m[0]); }
  };
  tunnel.stdout.on("data", scan);
  tunnel.stderr.on("data", scan);
  tunnel.on("error", (e) => { console.warn(`cloudflared failed to start: ${e.message}`); finish(null); });
  setTimeout(() => { if (!done) console.warn("Could not detect the tunnel URL yet (check the cloudflared window)."); finish(null); }, 60000);
});

const url = await startTunnel();
if (url) process.env.OH_NODE_PUBLIC_URL = url;
await import("./server.js");

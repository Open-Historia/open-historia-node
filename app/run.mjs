/*! Open Historia node — launcher © 2026 Nicholas Krol, MIT. */
// Cross-platform start wrapper the installer points the start script at. Reads
// node.config.json, optionally starts a Cloudflare Tunnel and captures its public
// URL directly from cloudflared's output (reliable on every OS — no shell log
// parsing), then launches the node with that URL.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The backend lives in app/; the operator-facing config and the install/start
// scripts sit one level up at the repo root, so node.config.json (and the .git
// the auto-updater pulls into) is a sibling of app/, not inside it.
const REPO_ROOT = path.join(__dirname, "..");
const cfgPath = path.join(REPO_ROOT, "node.config.json");
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

// Self-heal an empty content folder (the installer's populate was skipped or
// failed): download the map assets before serving, so a node never registers
// with nothing to serve.
const contentDir = process.env.OH_NODE_CONTENT_DIR || path.join(__dirname, "content");
const hasContent = existsSync(contentDir) && readdirSync(contentDir).some((n) => /^[a-f0-9]{64}$/.test(n));
if (!hasContent) {
  console.log("Content folder is empty — downloading map data (one time, ~180 MB)…");
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, "scripts", "populate.mjs")], { stdio: "inherit" });
    p.on("exit", resolve);
    p.on("error", (error) => { console.warn(`populate failed (will serve what it can): ${error.message}`); resolve(); });
  });
}

// --- Node-software auto-update ---------------------------------------------
// The admin panel bumps a monotonic `swVersion` in the root-key-SIGNED node
// directory (a forge-proof trigger — only the offline root key can raise it).
// server.js watches for it and exits 75; we (the supervisor) pull the new code
// and restart it. The tunnel keeps running throughout, so the node's public URL
// is stable across updates.
const UPDATE_EXIT = 75;
const SW_STATE = path.join(__dirname, ".node-version.json");
const readAppliedSw = () => { try { return Number(JSON.parse(readFileSync(SW_STATE, "utf8")).swVersion) || 0; } catch { return 0; } };
const writeAppliedSw = (v) => { try { writeFileSync(SW_STATE, `${JSON.stringify({ swVersion: v, appliedAt: new Date().toISOString() }, null, 2)}\n`); } catch { /* best-effort */ } };

// Fetch + cryptographically verify the signed directory; return its swVersion
// (0 if unset/unreachable/invalid — an unverified directory can never trigger an update).
const fetchSwVersion = async () => {
  const dirUrl = cfg.directory;
  if (!dirUrl) return 0;
  try {
    const [docRes, sigRes] = await Promise.all([
      fetch(dirUrl, { cache: "no-store" }),
      fetch(`${dirUrl}.sig`, { cache: "no-store" }),
    ]);
    if (!docRes.ok || !sigRes.ok) return 0;
    const bytes = Buffer.from(await docRes.arrayBuffer());
    const { verifySignedManifest } = await import("./lib/trust.js");
    const { valid, data } = verifySignedManifest(bytes, await sigRes.text());
    return valid ? (Number(data.swVersion) || 0) : 0;
  } catch { return 0; }
};

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", shell: process.platform === "win32" });
  return r.status === 0;
};

// Pull the latest node code + reinstall deps, then record the applied version.
// Git checkouts self-update; a plain-download install can't (git is required),
// so we mark it applied to avoid a restart loop and tell the operator to update.
const applyUpdate = async () => {
  const target = await fetchSwVersion();
  if (target <= readAppliedSw()) return; // nothing newer (or unverifiable)
  if (!existsSync(path.join(REPO_ROOT, ".git"))) {
    console.warn(`Update v${target} was requested, but this node isn't a git checkout — automatic updates need one.`);
    console.warn("Re-install with:  git clone https://github.com/Open-Historia/open-historia-node   (or re-download the latest release).");
    writeAppliedSw(target); // don't loop on an update we can't apply
    return;
  }
  console.log(`Applying node software update v${target}…`);
  const pulled = run("git", ["pull", "--ff-only"]) ||
    (run("git", ["fetch", "origin", "main"]) && run("git", ["reset", "--hard", "origin/main"]));
  if (!pulled) { console.warn("git pull failed — staying on the current version, will retry next cycle."); return; }
  run("npm", ["install", "--omit=dev"]);
  writeAppliedSw(target);
  console.log(`Node software updated to v${target}.`);
};

const url = await startTunnel();
if (url) process.env.OH_NODE_PUBLIC_URL = url;

// On a fresh install adopt the current version without updating (the download is
// already current) — only future bumps trigger an update.
if (!existsSync(SW_STATE)) writeAppliedSw(await fetchSwVersion());

// Supervise the content server: relaunch it whenever it exits asking for an
// update (75), applying the update in between. Any other exit ends the process.
for (;;) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "server.js")], { stdio: "inherit", env: process.env });
    child.on("exit", (c) => resolve(c ?? 0));
    child.on("error", (e) => { console.error(`node server failed to start: ${e.message}`); resolve(1); });
  });
  if (code !== UPDATE_EXIT) process.exit(code);
  await applyUpdate();
  console.log("Restarting node server…");
}

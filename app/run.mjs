/*! Open Historia node — launcher © 2026 Nicholas Krol, MIT. */
// Cross-platform start wrapper the installer points the start script at. Reads
// node.config.json, optionally starts a Cloudflare Tunnel and captures its public
// URL directly from cloudflared's output (reliable on every OS — no shell log
// parsing), then launches the node with that URL.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, rmSync, cpSync, statSync } from "node:fs";
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
// Where we hand the captured tunnel URL to server.js. Must match server.js's
// DATA_DIR (env override or app/data) so a URL detected AFTER the server already
// started (slow tunnels) is still picked up on its next registration attempt.
const DATA_DIR = process.env.OH_NODE_DATA_DIR || path.join(__dirname, "data");
const PUBLIC_URL_FILE = path.join(DATA_DIR, "public-url.txt");

let tunnel = null;
let stoppingTunnel = false; // true while WE kill it, so the exit handler doesn't fight us
const cleanup = () => { stoppingTunnel = true; if (tunnel) { try { tunnel.kill(); } catch { /* ignore */ } } };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(0); });

const startTunnel = () => new Promise((resolve) => {
  const mode = cfg.tunnel || "none";
  // Any leftover public-url.txt is from a PREVIOUS run and may be stale: a quick
  // tunnel gets a new hostname each launch, and a switch to none/named (or a
  // missing cloudflared binary) means there's no quick URL this run at all. Clear
  // it up front — before every early return below — so server.js never registers
  // a dead URL; a live quick tunnel rewrites it via capture() once detected. The
  // named/config-publicUrl cases carry their URL via env, not this file.
  try { unlinkSync(PUBLIC_URL_FILE); } catch { /* no stale file — fine */ }
  if (mode === "none" || !existsSync(cfBin)) return resolve(null);

  if (mode === "named" && cfg.tunnelName) {
    console.log(`Starting Cloudflare Tunnel "${cfg.tunnelName}"...`);
    tunnel = spawn(cfBin, ["tunnel", "run", "--url", `http://localhost:${PORT}`, cfg.tunnelName], { stdio: "inherit" });
    return resolve(cfg.publicUrl || null); // named tunnel URL is the fixed hostname
  }

  console.log("Starting Cloudflare Tunnel (quick)...");
  tunnel = spawn(cfBin, ["tunnel", "--url", `http://localhost:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  let done = false;
  let acc = "";
  const finish = (u) => { if (!done) { done = true; resolve(u); } };
  const capture = (u) => {
    // Hand the URL to server.js two ways: the env (used when we detect it before
    // spawning the server) and a file (used when the tunnel comes up LATE, after
    // the server already started — server.js re-reads this on every register try).
    process.env.OH_NODE_PUBLIC_URL = u;
    urlBornAt = Date.now(); // reachability grants a fresh URL a DNS warm-up grace
    try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(PUBLIC_URL_FILE, u); } catch { /* best-effort */ }
  };
  const scan = (buf) => {
    // Accumulate: cloudflared prints the URL inside an ASCII box and can split
    // one line across two stdout writes, so matching each chunk alone would miss
    // it. Keep scanning even after we resolve, to catch a late/renewed URL.
    acc += String(buf);
    const m = acc.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      console.log(done ? `Tunnel is up — registering now at ${m[0]}` : `Your node is reachable at ${m[0]}`);
      capture(m[0]);
      finish(m[0]);
      acc = "";
    } else if (acc.length > 65536) {
      acc = acc.slice(-4096); // bound memory, keep enough tail to catch a split URL
    }
  };
  tunnel.stdout.on("data", scan);
  tunnel.stderr.on("data", scan);
  tunnel.on("error", (e) => { console.warn(`cloudflared failed to start: ${e.message}`); finish(null); });
  // A tunnel that dies takes the node off the network SILENTLY: server.js keeps
  // serving localhost happily and keeps re-registering, so the registry (and the
  // operator's dashboard) still say "active" while nobody can reach it. Nothing
  // used to notice — which is why a 16-hour node went dark and only a full
  // close-and-reopen fixed it, while an update did not: an update restarts
  // server.js and deliberately leaves the tunnel alone (see UPDATE_EXIT below),
  // so it restarted the half that was fine.
  tunnel.on("exit", (code, signal) => {
    if (stoppingTunnel) return; // we're shutting down on purpose
    console.warn(`Cloudflare Tunnel exited (${signal || `code ${code}`}) — the node is unreachable until it is back. Restarting it…`);
    restartTunnel("cloudflared exited");
  });
  // Don't block startup forever. After 120s, start serving locally anyway; the
  // scan above stays attached, so once the tunnel is up the URL is captured and
  // the node registers on its next cycle (~30s) with no restart needed.
  setTimeout(() => {
    if (!done) console.warn("Tunnel URL not detected yet — starting the node anyway. It will register automatically once the tunnel is up (this can take a minute on a slow connection).");
    finish(null);
  }, 120000);
});

// --- Keeping the tunnel alive ------------------------------------------------
// Two ways a long-running node goes dark, both invisible from the inside:
//   1. cloudflared exits — handled by the exit hook above.
//   2. cloudflared is still running but its tunnel no longer routes. Quick
//      tunnels are anonymous and disposable; Cloudflare is free to drop one, and
//      a process that thinks it is connected will not tell us.
// Only an OUTSIDE-IN check can tell the difference, so we fetch our own public
// URL: out to Cloudflare's edge and back down the tunnel. If that round trip
// fails repeatedly, the tunnel is the problem — restart it, not the server.
const REACH_CHECK_MS = 5 * 60 * 1000;   // gentle while healthy: a keep-honest check, not a heartbeat
const REACH_RECHECK_MS = 60 * 1000;     // while failing: probe fast, so a dead tunnel rotates in minutes, not a quarter hour
const REACH_FAILS_BEFORE_RESTART = 3;   // still three real strikes before we act, so a blip is not a restart
// A just-minted quick-tunnel hostname can lag in DNS for a minute or two —
// Cloudflare prints the URL before the record is everywhere (we've watched a
// fresh tunnel NXDOMAIN even at 1.1.1.1). That warm-up must not count strikes
// or scare the operator; a tunnel that is still unreachable after this window
// is genuinely dead-on-arrival and starts striking.
const URL_GRACE_MS = 2 * 60 * 1000;
const TUNNEL_RESTART_BACKOFF_MS = 15000;
let reachFails = 0;
let restartingTunnel = false;
let urlBornAt = 0;        // when the current public URL was captured (0 = config/named URL, no grace needed)
let lastCheckedUrl = null;

const restartTunnel = async (why) => {
  if (restartingTunnel || stoppingTunnel) return;
  restartingTunnel = true;
  reachFails = 0;
  try {
    if (tunnel) {
      stoppingTunnel = true;               // suppress our own exit hook for this kill
      try { tunnel.kill(); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 2000));
      stoppingTunnel = false;
    }
    await new Promise((r) => setTimeout(r, TUNNEL_RESTART_BACKOFF_MS));
    console.log(`Restarting the Cloudflare Tunnel (${why})…`);
    // A quick tunnel comes back with a NEW hostname. capture() writes it to
    // public-url.txt, and server.js re-registers as soon as it sees the change —
    // so the directory follows us to the new URL without a full node restart.
    const next = await startTunnel();
    if (next) console.log(`Tunnel is back at ${next} — re-registering.`);
    else console.warn("Tunnel restart did not produce a URL yet; will keep checking.");
  } finally {
    restartingTunnel = false;
  }
};

const currentPublicUrl = () => {
  if (process.env.OH_NODE_PUBLIC_URL) return process.env.OH_NODE_PUBLIC_URL;
  try { return readFileSync(PUBLIC_URL_FILE, "utf8").trim() || null; } catch { return null; }
};

// Self-scheduling (not a fixed interval): healthy nodes are probed gently every
// 5 minutes, but the moment a check fails the cadence tightens to every minute —
// a tunnel that came up dead now rotates to a fresh hostname in single-digit
// minutes instead of pinning an unreachable URL in the directory for 15+.
const watchReachability = () => {
  const schedule = (ms) => {
    const timer = setTimeout(check, ms);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  };
  const check = async () => {
    if (stoppingTunnel) return;
    if (restartingTunnel) return schedule(REACH_RECHECK_MS);
    const url = currentPublicUrl();
    if (!url) return schedule(REACH_RECHECK_MS); // waiting on a tunnel — look again soon
    if (url !== lastCheckedUrl) {
      // A new URL starts with a clean slate — strikes against the old hostname
      // say nothing about this one.
      lastCheckedUrl = url;
      reachFails = 0;
    }
    let ok = false;
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/oh/v1/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      });
      ok = res.ok;
    } catch { ok = false; }
    if (ok) {
      if (reachFails > 0) console.log("Node is reachable again.");
      reachFails = 0;
      return schedule(REACH_CHECK_MS);
    }
    if (urlBornAt && Date.now() - urlBornAt < URL_GRACE_MS) {
      console.log(`Public URL not answering yet (fresh tunnel, DNS may still be propagating) — ${url}`);
      return schedule(REACH_RECHECK_MS);
    }
    reachFails += 1;
    console.warn(`Node did not answer on its public URL (${reachFails}/${REACH_FAILS_BEFORE_RESTART}) — ${url}`);
    if (reachFails >= REACH_FAILS_BEFORE_RESTART) await restartTunnel("public URL stopped answering");
    return schedule(REACH_RECHECK_MS);
  };
  return schedule(REACH_CHECK_MS);
};

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

// This node's id, from the identity server.js writes on first run. Used to find
// this node's own entry in the signed directory for per-node update targeting.
const nodeId = () => {
  try { return JSON.parse(readFileSync(path.join(DATA_DIR, "identity.json"), "utf8")).id || null; }
  catch { return null; }
};

// Fetch + cryptographically verify the signed directory; return the software
// version this node should run — the HIGHER of the directory-wide swVersion
// ("Update all nodes") and this node's own swVersion ("Update this node"). Returns
// 0 if unset/unreachable/invalid — an unverified directory can never trigger an
// update. Mirrors server.js's refreshControl so the two agree on the target.
const fetchSwVersion = async () => {
  const dirUrl = cfg.directory;
  if (!dirUrl) return 0;
  try {
    // Bounded: this now gates every startup (the offline-catch-up check), so a
    // network that stalls mustn't hang the node — time out and treat as "unknown"
    // (0), which serves current code and lets the periodic poll retry.
    const [docRes, sigRes] = await Promise.all([
      fetch(dirUrl, { cache: "no-store", signal: AbortSignal.timeout(10000) }),
      fetch(`${dirUrl}.sig`, { cache: "no-store", signal: AbortSignal.timeout(10000) }),
    ]);
    if (!docRes.ok || !sigRes.ok) return 0;
    const bytes = Buffer.from(await docRes.arrayBuffer());
    const { verifySignedManifest } = await import("./lib/trust.js");
    const { valid, data } = verifySignedManifest(bytes, await sigRes.text());
    if (!valid) return 0;
    const id = nodeId();
    const self = id ? (data.nodes || []).find((n) => n.id === id) : null;
    return Math.max(Number(data.swVersion) || 0, Number(self?.swVersion) || 0);
  } catch { return 0; }
};

// Run a hardcoded command line in the repo root. Uses shell:true with a single
// STRING (not an args array) to avoid Node's DEP0190 warning and to resolve
// git/npm on Windows via PATHEXT. Every command line here is constant — no
// untrusted input is interpolated — so shell concatenation is safe.
const run = (commandLine, cwd = REPO_ROOT) => {
  const r = spawnSync(commandLine, { cwd, stdio: "inherit", shell: true });
  return r.status === 0;
};
const APP_DIR = __dirname; // package.json + node_modules live in app/, not the root
const gitAvailable = () => {
  try { return spawnSync("git --version", { stdio: "ignore", shell: true }).status === 0; } catch { return false; }
};

// Where the node's code comes from when we self-update. The registry only ever
// tells us "version N exists" (a root-SIGNED signal — see fetchSwVersion); the
// code itself always comes from this hardcoded official repo over TLS, exactly
// like a git checkout's `git fetch origin`. A compromised registry can trigger a
// restart but can never point the node at attacker-controlled code.
const REPO_SLUG = process.env.OH_NODE_REPO_SLUG || "Open-Historia/open-historia-node";
// Branch is interpolated into the codeload URL and into git commands run with
// shell:true, so constrain it to safe branch-name characters and fall back to
// main on anything unexpected. It's operator-set, so this is hygiene, not a
// privilege boundary (an operator can already run any command).
const rawBranch = process.env.OH_NODE_UPDATE_BRANCH || "main";
const UPDATE_BRANCH = /^[A-Za-z0-9._/-]+$/.test(rawBranch) ? rawBranch : "main";

// A real git checkout self-updates cleanly and prunes files deleted upstream.
const applyGitUpdate = () =>
  // origin/<branch> explicitly (branch-config agnostic — a checkout tracking a
  // different local branch would otherwise break). Fast-forward if possible, else
  // hard-reset (a node has no local changes to keep). Same branch as the tarball
  // path, so both update paths stay consistent.
  run(`git fetch origin ${UPDATE_BRANCH}`) &&
  (run(`git merge --ff-only origin/${UPDATE_BRANCH}`) || run(`git reset --hard origin/${UPDATE_BRANCH}`));

// Most nodes are plain ZIP downloads with no .git, so they can't `git pull`.
// Download the official repo tarball and overlay it. The archive holds ONLY
// tracked files (code, installers, package manifests) — never content/, data/,
// node.config.json, .node-version.json, cloudflared, or node_modules (all
// gitignored) — so copying it over the install can't touch runtime state.
const applyTarballUpdate = async () => {
  const tgzUrl = `https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${UPDATE_BRANCH}`;
  // Keep these as direct children of REPO_ROOT: the tar call below uses their
  // bare names with cwd=REPO_ROOT so no absolute path (with a Windows "C:" drive
  // letter) is passed to tar — GNU tar would read "C:" as a remote host and fail.
  const TMP_NAME = ".oh-update-tmp";
  const TGZ_NAME = ".oh-update.tgz";
  const tmpDir = path.join(REPO_ROOT, TMP_NAME);
  const tgzPath = path.join(REPO_ROOT, TGZ_NAME);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tgzPath, { force: true });
    mkdirSync(tmpDir, { recursive: true });

    console.log(`Downloading the latest node code from ${tgzUrl} …`);
    // Bounded so a stalled download can't hang startup — 60s is ample for a small
    // code tarball; on timeout we serve current code and retry next cycle.
    const res = await fetch(tgzUrl, { redirect: "follow", signal: AbortSignal.timeout(60000) });
    if (!res.ok) { console.warn(`update download failed: HTTP ${res.status}`); return false; }
    writeFileSync(tgzPath, Buffer.from(await res.arrayBuffer()));

    // tar ships with Windows 10 1803+ (bsdtar), macOS (bsdtar), and Linux (GNU
    // tar); all handle a gzipped tarball with -xzf. Run from REPO_ROOT with bare
    // relative names (see TMP_NAME/TGZ_NAME above) so no drive-letter colon leaks.
    if (!run(`tar -xzf ${TGZ_NAME} -C ${TMP_NAME}`, REPO_ROOT)) {
      console.warn("update extract failed — 'tar' seems unavailable (Windows 10 1803+, macOS, and Linux all include it).");
      return false;
    }
    // codeload extracts to one top-level folder, e.g. open-historia-node-main/.
    const srcRoot = readdirSync(tmpDir)
      .map((n) => path.join(tmpDir, n))
      .find((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
    if (!srcRoot) { console.warn("update archive was empty."); return false; }

    // Overlay onto the install (force-overwrite code; leave runtime state alone —
    // it isn't in the archive). NB overlay doesn't delete files removed upstream;
    // acceptable — a stale unused file is harmless. Overwriting run.mjs while it
    // runs is fine (Node loads the script into memory and holds no lock on it);
    // the new launcher takes effect on the next full node restart.
    cpSync(srcRoot, REPO_ROOT, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.warn(`update failed: ${e.message}`);
    return false;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(tgzPath, { force: true }); } catch { /* best-effort */ }
  }
};

// Pull the latest node code + reinstall deps, then record the applied version.
const applyUpdate = async () => {
  const target = await fetchSwVersion();
  if (target <= readAppliedSw()) return; // nothing newer (or unverifiable)
  console.log(`Applying node software update v${target}…`);
  const gitCheckout = existsSync(path.join(REPO_ROOT, ".git")) && gitAvailable();
  const ok = gitCheckout ? applyGitUpdate() : await applyTarballUpdate();
  if (!ok) {
    // Leave the applied version behind so we retry next cycle. server.js only
    // re-triggers from its periodic/ping poll (not at startup), so a persistent
    // failure means a slow retry with the node still serving — not a tight loop.
    console.warn("Update didn't complete — staying on the current version; will retry later. The node keeps serving.");
    return;
  }
  // Sync deps to the new lockfile (in app/). If this fails we must NOT record the
  // version as applied: the new code is already on disk and may import a dep that
  // isn't installed yet, so leaving applied < target lets the next poll re-run
  // this (idempotent) update, and the supervise loop re-syncs deps if the fresh
  // server can't even boot. Recording it here would brick the node with no retry.
  if (!run("npm install --omit=dev", APP_DIR)) {
    console.warn("Dependency install failed — not recording the update as applied; will re-sync and retry. The node keeps serving if it can boot.");
    return;
  }
  writeAppliedSw(target);
  console.log(`Node software updated to v${target}. The new server starts now; a full restart also applies the launcher.`);
};

const url = await startTunnel();
if (url) process.env.OH_NODE_PUBLIC_URL = url;

// Watch the tunnel for the rest of this process's life. Only meaningful when WE
// own a tunnel: with tunnel "none" the operator fronts the node themselves (a
// reverse proxy, a port-forward) and it is not ours to restart.
if ((cfg.tunnel || "none") !== "none" && existsSync(cfBin)) {
  const reachTimer = watchReachability();
  if (typeof reachTimer.unref === "function") reachTimer.unref();
}

// Startup version reconciliation (runs on every launch — start.bat, start.sh,
// start.command, or the installer starting the node — since they all run this file):
//  - Fresh install: adopt the current signed version without updating (the
//    download is already current).
//  - Existing install: check ONCE for an update we may have missed while offline
//    — e.g. the admin bumped the version and pinged while this node was powered
//    off — and apply it before we start serving, instead of waiting for the first
//    5-min poll. applyUpdate is a no-op when already current (just one signed-
//    directory fetch) and never bricks: on failure it leaves the version
//    unapplied and the periodic poll retries.
if (!existsSync(SW_STATE)) writeAppliedSw(await fetchSwVersion());
else await applyUpdate();

// Open the local operator dashboard (the node's "interface") in the default
// browser once the server has had a moment to bind. Best-effort; headless boxes
// simply won't have a browser to open.
const dashUrl = `http://localhost:${Number(PORT) + 1}`;
setTimeout(() => {
  try {
    const [cmd, cmdArgs] = process.platform === "win32" ? ["cmd", ["/c", "start", "", dashUrl]]
      : process.platform === "darwin" ? ["open", [dashUrl]] : ["xdg-open", [dashUrl]];
    const opener = spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" });
    // A missing opener (e.g. no xdg-open on a headless Linux box) reports ENOENT
    // ASYNCHRONOUSLY via an 'error' event — the try/catch above can't catch that,
    // and an unhandled child 'error' would crash this supervisor and take the
    // tunnel (and the whole node) down. Swallow it: opening a browser is optional.
    opener.on("error", () => { /* no browser to open — fine */ });
    opener.unref();
  } catch { /* opening the dashboard is optional */ }
}, 2500);

// Supervise the content server: relaunch it whenever it exits asking for an
// update (75), applying the update in between. A clean exit (0 — e.g. the
// dashboard's graceful shutdown) or an operator Ctrl-C ends the process.
//
// Boot-crash self-heal: if server.js exits abnormally within seconds of launch,
// that's almost always an unsynced dependency — an update (applied here on a 75
// exit, OR at startup above from a missed ping) overlaid new code but npm install
// didn't finish. Re-run npm install and retry, bounded, so a bad-deps state heals
// itself instead of bricking the node. This is symptom-based (not tied to whether
// an update just ran here) so it covers the startup-applied case too. A server
// that runs a healthy stretch clears the budget.
let bootFailures = 0;
for (;;) {
  const startedAt = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "server.js")], { stdio: "inherit", env: process.env });
    child.on("exit", (c) => resolve(c ?? 0));
    child.on("error", (e) => { console.error(`node server failed to start: ${e.message}`); resolve(1); });
  });
  if (code === UPDATE_EXIT) { await applyUpdate(); bootFailures = 0; console.log("Restarting node server…"); continue; }
  const ranMs = Date.now() - startedAt;
  if (ranMs >= 15000) bootFailures = 0; // booted and ran fine — reset the repair budget
  if (code !== 0 && ranMs < 15000 && bootFailures < 3) {
    bootFailures += 1;
    console.warn(`Node exited (code ${code}) ${Math.round(ranMs / 1000)}s after launch — re-syncing dependencies and retrying (${bootFailures}/3)…`);
    run("npm install --omit=dev", APP_DIR);
    continue;
  }
  process.exit(code);
}

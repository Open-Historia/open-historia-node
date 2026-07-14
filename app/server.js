/*! Open Historia content node © 2026 Nicholas Krol, MIT. */
// A content node anyone can run to make Open Historia load faster for players.
// It serves ONLY hash-verified, read-only map data (addressed by SHA-256) — it
// never sees games, accounts, or API keys, and never runs player code. On start
// it registers itself with the project registry as "pending"; no player traffic
// reaches it until an admin accepts it into the project-signed node directory.
// Honest nodes also self-enforce pause/ban/rate-limit from that signed directory;
// the hard cutoff, though, is client-side — the game only ever contacts nodes in
// the current root-signed directory, so a node can't route traffic to itself.

import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createPrivateKey, createHash, sign as cryptoSign, randomUUID } from "node:crypto";
import { parseByteRange, isAllowedMirrorUrl } from "./lib/security.js";
import { verifySignedManifest } from "./lib/trust.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => (process.env[k] ?? d);

const PORT = Number(env("OH_NODE_PORT", 4400));
const HOST = env("OH_NODE_HOST", undefined);
const CONTENT_DIR = path.resolve(env("OH_NODE_CONTENT_DIR", path.join(__dirname, "content")));
const DATA_DIR = path.resolve(env("OH_NODE_DATA_DIR", path.join(__dirname, "data")));
const PUBLIC_URL = env("OH_NODE_PUBLIC_URL", "");
const REGISTRY_URL = env("OH_NODE_REGISTRY_URL", "");
const DIRECTORY_URL = env("OH_NODE_DIRECTORY_URL", "");
const OPERATOR = env("OH_NODE_OPERATOR", "");
const REGION = env("OH_NODE_REGION", "");
const DEFAULT_RATE_LIMIT = Number(env("OH_NODE_RATE_LIMIT", 600)); // requests/min/IP
const NODE_VERSION = 1;
const HASH_RE = /^[a-f0-9]{64}$/;

// --- Capacity: how many players this node will host at once, scaled by the
// machine's CPU threads (each thread comfortably serves several concurrent
// players of read-only content). "Users" are approximated by unique client IPs
// seen in the recent window — no per-user state, no player identity. ---
const THREADS = Math.max(1, os.cpus()?.length || 1);
const USERS_PER_THREAD = Math.max(1, Number(env("OH_NODE_USERS_PER_THREAD", 20)));
const MAX_USERS = THREADS * USERS_PER_THREAD;
const USER_WINDOW_MS = 5 * 60 * 1000;
const activeUsers = new Map(); // ip -> lastSeen (ms)
const clientIp = (req) =>
  req.headers["cf-connecting-ip"]
  || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
  || req.socket.remoteAddress || "unknown";
const touchUser = (req) => { activeUsers.set(clientIp(req), Date.now()); };
const currentUsers = () => {
  const cutoff = Date.now() - USER_WINDOW_MS;
  let n = 0;
  for (const [ip, seen] of activeUsers) { if (seen < cutoff) activeUsers.delete(ip); else n += 1; }
  return n;
};
const statusBody = () => {
  const users = currentUsers();
  if (users > stats.peakUsers) stats.peakUsers = users;
  // No operator name here — this endpoint is public. The operator is sent only in
  // registration (to the private admin record), never broadcast to players. While
  // draining we report "draining"/full so clients move to another node.
  return {
    id: identity.id, region: REGION, version: NODE_VERSION, status: draining ? "draining" : control.status,
    threads: THREADS, maxUsers: MAX_USERS, currentUsers: users, full: draining || users >= MAX_USERS,
  };
};

// --- Identity: a stable id + Ed25519 keypair, persisted on first run so the
// registry can confirm this node controls its id (prevents id hijacking). ---
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CONTENT_DIR, { recursive: true });
const IDENTITY_PATH = path.join(DATA_DIR, "identity.json");

const loadIdentity = () => {
  if (fs.existsSync(IDENTITY_PATH)) return JSON.parse(fs.readFileSync(IDENTITY_PATH, "utf8"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  const identity = {
    id: env("OH_NODE_ID", "") || `node-${randomUUID().slice(0, 8)}`,
    publicKey: rawPub,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
};
const identity = loadIdentity();

// Live control state, refreshed from the signed directory. Nodes are accepted
// automatically, so we default to active; the signed directory only ever
// downgrades us to paused/banned.
const control = { status: "active", rateLimit: DEFAULT_RATE_LIMIT, redirect: null };

// Operator-dashboard metrics + graceful-drain flag. While draining, the node
// stops serving content (so players fail over to other nodes) and then exits.
const stats = { startedAt: Date.now(), requests: 0, bytes: 0, peakUsers: 0 };
let draining = false;

// Applied node-software version (written by run.mjs after an update). When the
// signed directory's swVersion climbs past this, we exit 75 so run.mjs pulls the
// new code and restarts us.
const SW_STATE = path.join(__dirname, ".node-version.json");
const appliedSwVersion = () => {
  try { return Number(JSON.parse(fs.readFileSync(SW_STATE, "utf8")).swVersion) || 0; } catch { return 0; }
};
const UPDATE_EXIT_CODE = 75;

// --- Content server ---
const listContentHashes = () => {
  try {
    return fs.readdirSync(CONTENT_DIR).filter((n) => HASH_RE.test(n));
  } catch {
    return [];
  }
};

// --- Community-content mirror: because a node is a content-addressed cache, it
// can serve community scenarios/basemaps too, not just the canonical map data.
// On a cache miss the caller points us (?src=) at where the bundle lives; we
// fetch it from an allow-listed origin, verify its sha256 matches the requested
// hash, and atomically cache it under content/<hash>. Since the cache key IS the
// verified hash, a node can never be made to cache or serve anything that doesn't
// hash to exactly what was asked for. Size- and concurrency-capped so it can't be
// turned into a bandwidth sink for the volunteer running it. ---
const MAX_MIRROR_BYTES = 200 * 1024 * 1024;
const MAX_INFLIGHT_MIRRORS = 4;
let inflightMirrors = 0;

// Fetch a bundle from an allow-listed origin and cache it under its content hash.
// Follows redirects manually, re-checking every hop (a redirect:"follow" could
// chase a GitHub redirect off to an internal host). Returns { buffer, hash } or
// null. Caching under the COMPUTED hash is always safe: content/<h> is, by
// definition, exactly the bytes that hash to <h>.
const fetchAndCacheBundle = async (src) => {
  if (!isAllowedMirrorUrl(src)) return null;
  let current = src;
  let response = null;
  for (let hop = 0; hop < 6; hop += 1) {
    response = await fetch(current, { redirect: "manual" });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    let next;
    try { next = new URL(location, current).toString(); } catch { return null; }
    if (!isAllowedMirrorUrl(next)) return null;
    current = next;
  }
  if (!response || !response.ok) return null;
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared && declared > MAX_MIRROR_BYTES) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_MIRROR_BYTES) return null;
  const hash = createHash("sha256").update(buffer).digest("hex");
  try {
    const tmp = path.join(CONTENT_DIR, `.mirror-${hash}-${randomUUID()}.tmp`);
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, path.join(CONTENT_DIR, hash)); // atomic publish under the verified hash
  } catch { /* caching is best-effort; still return the bytes */ }
  return { buffer, hash };
};

// Hash-addressed mirror: cache the bundle and report whether it matched the hash
// the caller asked for (so /content/<hash>?src= only 404s, never serves a mismatch).
const mirrorCommunityContent = async (hash, src) => {
  const result = await fetchAndCacheBundle(src);
  return !!result && result.hash === hash;
};

const app = express();
app.disable("x-powered-by");

// Read-only public content: permissive CORS is safe (public bytes, verified
// client-side). GET/HEAD/OPTIONS only.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "HEAD"].includes(req.method)) return res.status(405).json({ error: "Only GET/HEAD are allowed." });
  return next();
});

// Per-IP fixed-window rate limit (admin can tighten via the signed directory).
const hits = new Map();
const rateTimer = setInterval(() => hits.clear(), 60000);
if (typeof rateTimer.unref === "function") rateTimer.unref();
app.use((req, res, next) => {
  const ip = req.headers["cf-connecting-ip"]
    || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket.remoteAddress || "unknown";
  const count = (hits.get(ip) || 0) + 1;
  hits.set(ip, count);
  if (count > control.rateLimit) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Rate limit exceeded." });
  }
  return next();
});

app.get("/oh/v1/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, id: identity.id, version: NODE_VERSION, status: control.status });
});

app.get("/oh/v1/manifest", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ id: identity.id, version: NODE_VERSION, caps: ["content", "mirror"], status: control.status, hashes: listContentHashes() });
});

// Live status the client uses to pick the best node (latency + free capacity).
// A pure read — does NOT count the caller as a user (so the home page pinging
// every node to compare them doesn't inflate anyone's load).
app.get("/oh/v1/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(statusBody());
});

// Heartbeat: the client calls this on connect and periodically while playing,
// so this player counts toward the node's live user count until they leave.
app.get("/oh/v1/ping", (req, res) => {
  touchUser(req);
  res.setHeader("Cache-Control", "no-store");
  res.json(statusBody());
});

// Honest nodes stop serving content when the signed directory says they're
// paused/banned. (Clients already won't route to them; this is a courtesy.)
const serveable = () => !draining && (control.status === "active" || control.status === "pending");

app.get("/oh/v1/content/:hash", async (req, res) => {
  if (!serveable()) return res.status(503).json({ error: `Node is ${control.status}.` });
  touchUser(req); // fetching content counts you as an active player of this node
  const hash = String(req.params.hash || "").toLowerCase();
  if (!HASH_RE.test(hash)) return res.status(400).json({ error: "Invalid content hash." });

  const filePath = path.join(CONTENT_DIR, hash);
  if (path.dirname(path.resolve(filePath)) !== CONTENT_DIR) {
    return res.status(400).json({ error: "Invalid content hash." });
  }
  if (!fs.existsSync(filePath)) {
    // Cache miss. If the caller tells us where this hash lives (community content),
    // lazily mirror + verify + cache it; otherwise it's simply not on this node.
    const src = req.query.src ? String(req.query.src) : "";
    if (!src) return res.status(404).json({ error: "Content not found." });
    if (inflightMirrors >= MAX_INFLIGHT_MIRRORS) {
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ error: "Node busy; retry shortly." });
    }
    inflightMirrors += 1;
    let mirrored = false;
    try { mirrored = await mirrorCommunityContent(hash, src); }
    catch { mirrored = false; }
    finally { inflightMirrors -= 1; }
    if (!mirrored) return res.status(404).json({ error: "Content not found." });
  }

  const { size } = fs.statSync(filePath);
  stats.requests += 1;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  const rangeHeader = req.headers.range;
  if (!rangeHeader) {
    res.setHeader("Content-Length", String(size));
    if (req.method === "HEAD") return res.status(200).end();
    stats.bytes += size;
    return fs.createReadStream(filePath).pipe(res);
  }
  const range = parseByteRange(rangeHeader, size);
  if (range.status === 416) {
    res.status(416).setHeader("Content-Range", `bytes */${size}`);
    return res.end();
  }
  res.status(206);
  res.setHeader("Content-Length", String(range.end - range.start + 1));
  res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  if (req.method === "HEAD") return res.end();
  stats.bytes += range.end - range.start + 1;
  return fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
});

// URL-based community-content proxy: the browser can't fetch GitHub-hosted
// scenario/basemap bundles directly (no CORS), so it asks a node to fetch one
// server-side and return it with CORS — offloading that from the central hub
// proxy. The bytes are cached under their content hash too, and that hash is
// returned (X-OH-Content-Hash) so a caller can verify or re-fetch by hash later.
app.get("/oh/v1/hub", async (req, res) => {
  if (!serveable()) return res.status(503).json({ error: `Node is ${control.status}.` });
  touchUser(req);
  const src = req.query.url ? String(req.query.url) : "";
  if (!isAllowedMirrorUrl(src)) return res.status(400).json({ error: "Only GitHub-hosted URLs are allowed." });
  if (inflightMirrors >= MAX_INFLIGHT_MIRRORS) {
    res.setHeader("Retry-After", "5");
    return res.status(503).json({ error: "Node busy; retry shortly." });
  }
  inflightMirrors += 1;
  try {
    const result = await fetchAndCacheBundle(src);
    if (!result) return res.status(502).json({ error: "Could not fetch that bundle." });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(result.buffer.length));
    res.setHeader("X-OH-Content-Hash", result.hash);
    res.setHeader("Cache-Control", "public, max-age=86400");
    if (req.method === "HEAD") return res.status(200).end();
    return res.status(200).end(result.buffer);
  } catch {
    return res.status(502).json({ error: "Could not fetch that bundle." });
  } finally {
    inflightMirrors -= 1;
  }
});

app.use((req, res) => res.status(404).json({ error: "Not found." }));

// --- Self-registration: announce this node to the project registry as pending.
// The registration is signed with the node's key so its id can't be hijacked. ---
const register = async () => {
  if (!REGISTRY_URL || !PUBLIC_URL) return;
  const payload = {
    id: identity.id,
    url: PUBLIC_URL,
    publicKey: identity.publicKey,
    caps: ["content", "mirror"],
    operator: OPERATOR,
    region: REGION,
    version: NODE_VERSION,
    threads: THREADS,
    maxUsers: MAX_USERS,
    hashes: listContentHashes().length,
    ts: new Date().toISOString(),
  };
  try {
    const body = JSON.stringify(payload);
    const signature = cryptoSign(null, Buffer.from(body), createPrivateKey(identity.privateKeyPem)).toString("base64");
    const res = await fetch(`${REGISTRY_URL.replace(/\/$/, "")}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Node-Signature": signature },
      body,
    });
    if (res.ok) console.log(`Registered with the registry as ${(await res.json().catch(() => ({}))).status || "pending"}.`);
    else console.warn(`registry: HTTP ${res.status}`);
  } catch (error) {
    console.warn(`registry unreachable: ${error.message}`);
  }
};

// --- Directory guard: poll the ROOT-SIGNED directory and self-enforce state. ---
const refreshControl = async () => {
  if (!DIRECTORY_URL) return;
  try {
    const base = DIRECTORY_URL.replace(/\.json$/, "");
    const [docRes, sigRes] = await Promise.all([
      fetch(DIRECTORY_URL, { cache: "no-store" }),
      fetch(`${DIRECTORY_URL}.sig`, { cache: "no-store" }),
    ]);
    if (!docRes.ok || !sigRes.ok) return;
    const bytes = Buffer.from(await docRes.arrayBuffer());
    const { valid, data } = verifySignedManifest(bytes, await sigRes.text());
    if (!valid) {
      console.warn("Ignoring node directory: signature invalid.");
      return;
    }
    void base;
    // Software-update signal (admin bumped swVersion in the signed, verified
    // directory). Exit so the run.mjs supervisor pulls the new code + restarts.
    if ((Number(data.swVersion) || 0) > appliedSwVersion()) {
      console.log(`Node software update v${Number(data.swVersion)} requested — restarting to apply…`);
      process.exit(UPDATE_EXIT_CODE);
    }
    const self = (data.nodes || []).find((n) => n.id === identity.id);
    if (!self) {
      control.status = "active"; // auto-accepted: not listed = not banned = active
      control.rateLimit = DEFAULT_RATE_LIMIT;
      control.redirect = null;
      return;
    }
    control.status = self.status || "active";
    control.rateLimit = Number.isFinite(Number(self.rateLimit)) && Number(self.rateLimit) > 0 ? Number(self.rateLimit) : DEFAULT_RATE_LIMIT;
    control.redirect = self.redirect || null;
  } catch (error) {
    console.warn(`directory poll failed: ${error.message}`);
  }
};

const listenArgs = HOST ? [PORT, HOST] : [PORT];
const server = app.listen(...listenArgs, async () => {
  console.log(`Open Historia content node "${identity.id}" on http://${HOST || "0.0.0.0"}:${PORT}`);
  console.log(`Serving ${listContentHashes().length} object(s) from ${CONTENT_DIR}`);
  if (PUBLIC_URL) console.log(`Public URL: ${PUBLIC_URL}`);
  console.log(
    REGISTRY_URL && PUBLIC_URL
      ? `Registry: ${REGISTRY_URL} — registering (nodes are accepted automatically; an admin can ban via the panel).`
      : "Not registering: OH_NODE_REGISTRY_URL and OH_NODE_PUBLIC_URL must both be set (the installer's Cloudflare Tunnel does this). No player traffic reaches an unregistered node.",
  );
  // Startup tasks must never crash the node (Node aborts on an unhandled rejection).
  try {
    await refreshControl();
    await register();
  } catch (error) {
    console.warn(`startup tasks failed (will retry): ${error.message}`);
  }
  const registerTimer = setInterval(register, 15 * 60 * 1000);
  const controlTimer = setInterval(refreshControl, 5 * 60 * 1000);
  if (typeof registerTimer.unref === "function") registerTimer.unref();
  if (typeof controlTimer.unref === "function") controlTimer.unref();
});
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Close the other program using it, or set OH_NODE_PORT to a free port.`);
  } else {
    console.error(`Server error: ${error.message}`);
  }
  process.exit(1);
});

// --- Local operator dashboard (127.0.0.1 ONLY — the Cloudflare tunnel forwards
// only the content port, so the stats + shutdown control are local-machine-only).
// Shows live stats and offers a graceful shutdown that first drains players to
// other nodes (their games are saved to their account, not the node), then exits.
const DASHBOARD_PORT = Number(env("OH_NODE_DASHBOARD_PORT", PORT + 1));
const DRAIN_MS = Number(env("OH_NODE_DRAIN_MS", 12000));
let dashboardHtml = "";
try { dashboardHtml = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8"); } catch { /* fall back to a plain message */ }

const gracefulShutdown = () => {
  if (draining) return;
  draining = true; // content now 503s → players fail over to another node
  console.log(`Graceful shutdown: draining for ${Math.round(DRAIN_MS / 1000)}s so players move to other nodes…`);
  setTimeout(() => { console.log("Node shut down."); process.exit(0); }, DRAIN_MS);
};

const dash = express();
dash.disable("x-powered-by");
dash.get("/stats", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const users = currentUsers();
  if (users > stats.peakUsers) stats.peakUsers = users;
  res.json({
    id: identity.id, region: REGION, version: NODE_VERSION, status: control.status, draining,
    currentUsers: users, maxUsers: MAX_USERS, peakUsers: stats.peakUsers, threads: THREADS,
    requests: stats.requests, bytes: stats.bytes, contentObjects: listContentHashes().length,
    uptimeMs: Date.now() - stats.startedAt, publicUrl: PUBLIC_URL, dashboardPort: DASHBOARD_PORT,
  });
});
dash.post("/shutdown", (req, res) => { res.json({ ok: true, draining: true }); gracefulShutdown(); });
dash.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dashboardHtml || "Open Historia node is running.");
});
const dashServer = dash.listen(DASHBOARD_PORT, "127.0.0.1", () => console.log(`Operator dashboard: http://localhost:${DASHBOARD_PORT}`));
dashServer.on("error", (e) => console.warn(`Dashboard didn't start (${e.code || e.message}); the node is still serving content.`));

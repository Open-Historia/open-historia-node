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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createPrivateKey, sign as cryptoSign, randomUUID } from "node:crypto";
import { parseByteRange } from "./lib/security.js";
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

// Live control state, refreshed from the signed directory.
const control = { status: "pending", rateLimit: DEFAULT_RATE_LIMIT, redirect: null };

// --- Content server ---
const listContentHashes = () => {
  try {
    return fs.readdirSync(CONTENT_DIR).filter((n) => HASH_RE.test(n));
  } catch {
    return [];
  }
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
  res.json({ id: identity.id, version: NODE_VERSION, caps: ["content"], status: control.status, hashes: listContentHashes() });
});

// Honest nodes stop serving content when the signed directory says they're
// paused/banned. (Clients already won't route to them; this is a courtesy.)
const serveable = () => control.status === "active" || control.status === "pending";

app.get("/oh/v1/content/:hash", (req, res) => {
  if (!serveable()) return res.status(503).json({ error: `Node is ${control.status}.` });
  const hash = String(req.params.hash || "").toLowerCase();
  if (!HASH_RE.test(hash)) return res.status(400).json({ error: "Invalid content hash." });

  const filePath = path.join(CONTENT_DIR, hash);
  if (path.dirname(path.resolve(filePath)) !== CONTENT_DIR || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Content not found." });
  }

  const { size } = fs.statSync(filePath);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  const rangeHeader = req.headers.range;
  if (!rangeHeader) {
    res.setHeader("Content-Length", String(size));
    if (req.method === "HEAD") return res.status(200).end();
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
  return fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
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
    caps: ["content"],
    operator: OPERATOR,
    region: REGION,
    version: NODE_VERSION,
    hashes: listContentHashes().length,
    ts: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);
  const signature = cryptoSign(null, Buffer.from(body), createPrivateKey(identity.privateKeyPem)).toString("base64");
  try {
    const res = await fetch(`${REGISTRY_URL.replace(/\/$/, "")}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Node-Signature": signature },
      body,
    });
    if (!res.ok) console.warn(`registry: HTTP ${res.status}`);
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
    const self = (data.nodes || []).find((n) => n.id === identity.id);
    if (!self) {
      control.status = "pending"; // accepted nodes appear here; not listed = pending
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
app.listen(...listenArgs, async () => {
  console.log(`Open Historia content node "${identity.id}" on http://${HOST || "0.0.0.0"}:${PORT}`);
  console.log(`Serving ${listContentHashes().length} object(s) from ${CONTENT_DIR}`);
  if (PUBLIC_URL) console.log(`Public URL: ${PUBLIC_URL}`);
  console.log(REGISTRY_URL ? `Registry: ${REGISTRY_URL} (registering as pending — an admin must accept this node)` : "No registry configured — this node will not receive player traffic until it is added to the signed directory.");

  await refreshControl();
  await register();
  const registerTimer = setInterval(register, 15 * 60 * 1000);
  const controlTimer = setInterval(refreshControl, 5 * 60 * 1000);
  if (typeof registerTimer.unref === "function") registerTimer.unref();
  if (typeof controlTimer.unref === "function") controlTimer.unref();
});

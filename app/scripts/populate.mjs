/*! Open Historia node — content populator © 2026 Nicholas Krol, MIT. */
// Downloads the canonical Open Historia map assets from the project's GitHub
// Release, verifies each SHA-256, and stores it under content/<sha256>. A node
// therefore only ever holds — and can only ever serve — bytes that match the
// project's published hashes. Safe to re-run (skips already-present objects).
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR = path.resolve(process.env.OH_NODE_CONTENT_DIR || path.join(ROOT, "content"));
const manifest = JSON.parse(readFileSync(path.join(ROOT, "map-assets.json"), "utf8"));
const RELEASE_BASE = `https://github.com/${manifest.owner}/${manifest.repo}/releases/download/${manifest.release}`;

mkdirSync(CONTENT_DIR, { recursive: true });

const sha256Of = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (d) => hash.update(d)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });

let done = 0;
let failed = 0;
for (const asset of manifest.assets ?? []) {
  const target = path.join(CONTENT_DIR, asset.sha256);
  if (existsSync(target)) {
    console.log(`have  ${asset.asset} (${asset.sha256.slice(0, 12)}…)`);
    done += 1;
    continue;
  }
  const tmp = `${target}.download`;
  try {
    process.stdout.write(`get   ${asset.asset} … `);
    const res = await fetch(`${RELEASE_BASE}/${asset.asset}`, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmp, buf);
    const actual = await sha256Of(tmp);
    if (actual !== asset.sha256) throw new Error(`sha256 mismatch (got ${actual.slice(0, 12)}…)`);
    renameSync(tmp, target); // atomic: only a verified file lands under its hash
    console.log(`ok (${(buf.length / 1048576).toFixed(1)} MB)`);
    done += 1;
  } catch (error) {
    console.log(`FAILED: ${error.message}`);
    failed += 1;
  }
}
console.log(`\ncontent dir: ${CONTENT_DIR}\nready ${done}, failed ${failed}`);
if (failed) process.exitCode = 1;

/*! Open Historia node — signature verification © 2026 Nicholas Krol, MIT. */
// Verifies the project-signed node directory + software-update manifests against
// the pinned root key, using Node's built-in crypto. A node obeys a directory
// (or applies an update) ONLY when it is validly signed, from a known key, and
// not expired — so a tampered directory can never re-route or un-ban a node.
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PINNED_ROOT_KEYS, findPinnedKey } from "./pinned-key.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const rawToPublicKey = (b64) =>
  createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(b64, "base64")]), format: "der", type: "spki" });

const KEY_OBJECTS = PINNED_ROOT_KEYS.map((k) => ({ keyid: k.keyid, key: rawToPublicKey(k.publicKey) }));

export const verifyDetached = (bytes, sigB64, keyid) => {
  let sig;
  try {
    sig = Buffer.from(String(sigB64).trim(), "base64");
  } catch {
    return false;
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const candidates = keyid ? KEY_OBJECTS.filter((k) => k.keyid === keyid) : KEY_OBJECTS;
  for (const { key } of candidates) {
    try {
      if (cryptoVerify(null, buffer, key, sig)) return true;
    } catch {
      // try the next pinned key
    }
  }
  return false;
};

// Verify a signed JSON manifest's bytes + detached signature, enforcing keyid +
// freshness. Returns { valid, data, reason }.
export const verifySignedManifest = (bytes, sigB64) => {
  let data;
  try {
    data = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { valid: false, data: null, reason: "bad-json" };
  }
  if (data.keyid && !findPinnedKey(data.keyid)) return { valid: false, data: null, reason: "unknown-keyid" };
  if (!verifyDetached(bytes, sigB64, data.keyid)) return { valid: false, data: null, reason: "bad-signature" };
  if (data.expires && Date.parse(data.expires) < Date.now()) return { valid: false, data: null, reason: "expired" };
  return { valid: true, data, reason: "ok" };
};

/*! Open Historia node — pinned root public key(s) © 2026 Nicholas Krol, MIT. */
// The Open Historia project's ROOT public key(s). The signed node directory that
// controls this node (accept / pause / ban / rate-limit / redirect) is verified
// against these keys, so a node only ever obeys directives the project actually
// signed. This MUST match trust/pinned-key.js in the main open-historia repo.
export const PINNED_ROOT_KEYS = [
  { keyid: "oh-root-1", alg: "ed25519", publicKey: "XGC4cpxoVNAhTtpPC2aqmOOND3U7oBrwzCPwTs1eHZk=" },
];

export const findPinnedKey = (keyid) =>
  PINNED_ROOT_KEYS.find((k) => k.keyid === keyid) || null;

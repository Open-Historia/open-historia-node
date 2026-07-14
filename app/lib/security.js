/*! Open Historia node — security helpers © 2026 Nicholas Krol, MIT. */
// Pure, dependency-light helpers for path containment and HTTP Range parsing.
import path from "node:path";

// A child name must resolve to a DIRECT child of baseDir (blocks "../", separators,
// absolute paths). Throws on anything unsafe; returns the absolute path.
export const resolveChildPath = (baseDir, name, label = "id") => {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, String(name ?? ""));
  if (path.dirname(resolved) !== base) throw new Error(`Invalid ${label}: ${name}`);
  return resolved;
};

// Parse an HTTP Range header against a file of totalSize bytes. Returns
// { status: 416 } for an unsatisfiable range, else inclusive { start, end }.
// Suffix ranges ("bytes=-N") mean the FINAL N bytes.
export const parseByteRange = (rangeHeader, totalSize) => {
  const match = /bytes=(\d*)-(\d*)/i.exec(String(rangeHeader || ""));
  if (!match || (!match[1] && !match[2])) return { status: 416 };

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number.parseInt(match[2], 10);
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    const s = Number.parseInt(match[1], 10);
    if (s >= totalSize) return { status: 416 };
    const e = match[2] ? Number.parseInt(match[2], 10) : totalSize - 1;
    start = Math.max(0, Math.min(s, totalSize - 1));
    end = Math.max(start, Math.min(e, totalSize - 1));
  }
  if (start >= totalSize) return { status: 416 };
  return { start, end };
};

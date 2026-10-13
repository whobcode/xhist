import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** A readable, collision-safe filename for a key such as a URL. */
export function cacheName(key) {
  const slug = key.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 10);
  return `${slug}-${hash}.json`;
}

export async function readCached(dir, key) {
  if (!dir) return null;
  try {
    return JSON.parse(await readFile(path.join(dir, cacheName(key)), "utf8"));
  } catch {
    return null;
  }
}

export async function writeCached(dir, key, value) {
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, cacheName(key)), JSON.stringify(value));
}

/** Return the cached value for `key`, or compute, store and return it. */
export async function cached(dir, key, fresh, fn) {
  if (!fresh) {
    const hit = await readCached(dir, key);
    if (hit !== null) return hit;
  }
  const v = await fn();
  if (v !== undefined && v !== null) await writeCached(dir, key, v);
  return v;
}

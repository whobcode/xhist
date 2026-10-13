/** `(key, fn)` cache over KV, the shape `src/sources/*` expect. */
export function kvCache(env, prefix, ttlSeconds) {
  return async (key, fn) => {
    const k = `${prefix}:${key}`;
    const hit = await env.XHIST_KV.get(k, "json");
    if (hit !== null) return hit;
    const v = await fn();
    if (v !== undefined && v !== null) await env.XHIST_KV.put(k, JSON.stringify(v), { expirationTtl: ttlSeconds });
    return v;
  };
}

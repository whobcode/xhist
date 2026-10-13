/**
 * `(key, fn)` cache over KV, the shape `src/sources/*` expect. Cache trouble
 * never fails a lookup: a read or write error just means no cache this time.
 */
export function kvCache(env, prefix, ttlSeconds) {
  return async (key, fn) => {
    const k = `${prefix}:${key}`;
    const hit = await env.XHIST_KV.get(k, "json").catch(() => null);
    if (hit !== null) return hit;
    const v = await fn();
    if (v !== undefined && v !== null) {
      await env.XHIST_KV.put(k, JSON.stringify(v), { expirationTtl: ttlSeconds })
        .catch(e => console.error(`kv put ${k}: ${e.message}`));
    }
    return v;
  };
}

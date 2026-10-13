/**
 * memory.lol: historical screen names by account ID, with first/last-seen
 * dates. Free and fast, but thin for accounts created after ~2024.
 *
 *   /v1/tw/id/<id>   → { id_str, screen_names: { handle: [first, last?] } }
 *   /v1/tw/<handle>  → { accounts: [ { id_str, screen_names } ] }
 *
 * Runs in Node and in the Worker: caching is injected, not imported.
 */

const BASE = "https://api.memory.lol/v1/tw";
const noCache = (key, fn) => fn();

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "xhist (personal, low-volume)" } });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`memory.lol ${res.status}`);
  return res.json();
}

export function accountsOf(json) {
  if (Array.isArray(json?.accounts)) return json.accounts;
  return json?.screen_names ? [json] : [];
}

const idOf = a => String(a.id_str ?? a.id);

export async function memoryLolById(restId, { cache = noCache, log = () => {} } = {}) {
  try {
    const json = await cache(`id:${restId}`, () => getJson(`${BASE}/id/${restId}`));
    return accountsOf(json).find(a => idOf(a) === restId)?.screen_names ?? {};
  } catch (e) {
    log(`memory.lol by id failed: ${e.message}`);
    return null;
  }
}

/** Every account memory.lol has seen using `handle`: `[{ userId, screenNames }]`. */
export async function memoryLolAccounts(handle, { cache = noCache, log = () => {} } = {}) {
  try {
    const json = await cache(`h:${handle.toLowerCase()}`, () => getJson(`${BASE}/${encodeURIComponent(handle)}`));
    return accountsOf(json).map(a => ({ userId: idOf(a), screenNames: a.screen_names ?? {} }));
  } catch (e) {
    log(`memory.lol @${handle} failed: ${e.message}`);
    return null;
  }
}

/** Only entries whose account ID is the target's: old handles get re-used. */
export async function memoryLolByHandle(handle, restId, opts = {}) {
  const accounts = await memoryLolAccounts(handle, opts);
  if (!accounts) return null;
  return accounts.find(a => a.userId === restId)?.screenNames ?? {};
}

/** `{ handle: [first, last?] }` → observations at each listed date. */
export function memoryLolObservations(...maps) {
  const out = [];
  const seen = new Set();
  for (const m of maps) {
    for (const [handle, dates] of Object.entries(m ?? {})) {
      for (const d of dates ?? []) {
        if (!/^\d{4}-\d{2}-\d{2}/.test(d ?? "")) continue;
        const key = `${handle.toLowerCase()}@${d}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ handle, at: `${d.slice(0, 10)}T00:00:00.000Z`, source: "memory_lol", tweetId: null });
      }
    }
  }
  return out;
}

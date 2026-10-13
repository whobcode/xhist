/**
 * Wayback Machine CDX: capture timestamps for a profile URL, as independent
 * evidence that a handle existed when. Snapshots are not fetched.
 * Runs in Node and in the Worker: caching is injected, not imported.
 */

const CDX = "https://web.archive.org/cdx/search/cdx";

async function captures(host, handle) {
  const url = `${CDX}?url=${host}/${encodeURIComponent(handle)}&output=json&limit=20&fl=timestamp,original,statuscode`;
  const res = await fetch(url, { headers: { "user-agent": "xhist (personal, low-volume)" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`CDX ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return [];
  const [, ...rows] = JSON.parse(text);
  return rows.map(([timestamp, original, statuscode]) => ({ timestamp, original, statuscode }));
}

export async function waybackTimestamps(handle, { cache = (key, fn) => fn(), log = () => {} } = {}) {
  try {
    const rows = await cache(`wb:${handle.toLowerCase()}`, async () => {
      const [a, b] = await Promise.all([captures("twitter.com", handle), captures("x.com", handle)]);
      return [...a, ...b];
    });
    return [...new Set(rows.map(r => r.timestamp))].sort();
  } catch (e) {
    log(`wayback @${handle} failed: ${e.message}`);
    return null;
  }
}

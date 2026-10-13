/**
 * Step 7: observations → handle intervals → change windows, reconciled with
 * the About panel. Pure: `now` is passed in so tests are deterministic.
 */

export const REREGISTER_WARNING =
  "Old handles can be re-registered by anyone. Whoever holds it now may be unrelated.";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

export const day = iso => (iso ? iso.slice(0, 10) : null);

/** "August 2026" → [first ms, last ms] of that month (UTC). */
export function monthRange(s) {
  const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const idx = MONTH_NAMES.findIndex(n => n.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 3)));
  if (idx < 0) return null;
  const y = Number(m[2]);
  return [Date.UTC(y, idx, 1), Date.UTC(y, idx + 1, 1) - 1];
}

export function monthName(ms) {
  const d = new Date(ms);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Most-observed casing wins for display; grouping is case-insensitive. */
function displayCasing(casings) {
  return [...casings.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function confidence(iv) {
  if (iv.sources.size >= 2) return "high";
  if (iv.sources.has("memory_lol")) return "medium";
  return iv.count >= 2 ? "medium" : "low";
}

/**
 * Group observations by handle. The current handle is always present, always
 * last, and its lastSeen is `now`.
 */
export function buildIntervals(observations, { currentHandle, now }) {
  const groups = new Map();
  const get = h => {
    const k = h.toLowerCase();
    if (!groups.has(k)) groups.set(k, { key: k, casings: new Map(), firstSeen: null, lastSeen: null, count: 0, sources: new Set(), tweetIds: [] });
    return groups.get(k);
  };
  for (const o of observations) {
    const g = get(o.handle);
    g.casings.set(o.handle, (g.casings.get(o.handle) ?? 0) + 1);
    g.count++;
    g.sources.add(o.source);
    if (o.tweetId && g.tweetIds.length < 5) g.tweetIds.push(o.tweetId);
    if (o.at) {
      if (!g.firstSeen || o.at < g.firstSeen) g.firstSeen = o.at;
      if (!g.lastSeen || o.at > g.lastSeen) g.lastSeen = o.at;
    }
  }
  const cur = get(currentHandle);
  const intervals = [...groups.values()].map(g => ({
    handle: g.key === cur.key ? currentHandle : displayCasing(g.casings),
    firstSeen: g.firstSeen,
    lastSeen: g.key === cur.key ? now : g.lastSeen,
    count: g.count,
    sources: g.sources,
    tweetIds: g.tweetIds,
    current: g.key === cur.key,
  }));
  const old = intervals.filter(i => !i.current && i.firstSeen)
    .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
  return [...old, intervals.find(i => i.current)];
}

/** Adjacent intervals with different handles imply a change between them. */
export function buildChanges(intervals, { now }) {
  const changes = [];
  for (let i = 1; i < intervals.length; i++) {
    const prev = intervals[i - 1];
    const next = intervals[i];
    const a = prev.lastSeen;
    const b = next.firstSeen ?? now;
    const c = { from: prev.handle, to: next.handle, window: [day(a), day(b)] };
    if (b < a) { c.window = [day(b), day(a)]; c.overlap = true; }
    changes.push(c);
  }
  return changes;
}

/**
 * Everything in step 7. `about` may be null (login wall); `oldestPostAt` is
 * the oldest of the target's own posts that the harvest saw.
 */
export function buildTimeline({ observations, currentHandle, createdAt, about, oldestPostAt, now }) {
  const intervals = buildIntervals(observations, { currentHandle, now });
  const changes = buildChanges(intervals, { now });
  const notes = [];
  let unrecovered = 0;
  let lastChange = null;

  for (const c of changes.filter(c => c.overlap)) {
    notes.push(c.to === currentHandle
      ? `@${c.to} was observed before the last sighting of @${c.from}; the current handle may have been used before (re-use), or the data is noisy.`
      : `Observations of @${c.from} and @${c.to} overlap; the change window is uncertain.`);
  }

  if (about && Number.isInteger(about.changeCount)) {
    const known = intervals.length;
    const expected = about.changeCount + 1;
    if (known < expected) {
      unrecovered = expected - known;
      if (oldestPostAt && createdAt && day(oldestPostAt) > day(createdAt)) {
        notes.push(`Original handle predates earliest surviving post (${day(oldestPostAt)}).`);
      }
    } else if (known > expected) {
      notes.push(`Found ${known} handles but X reports ${about.changeCount} username change(s); some observations may be noise, or memory.lol saw changes X no longer counts.`);
    }

    const month = about.lastChangedAt ? monthName(about.lastChangedAt) : about.lastChangeMonth;
    const range = monthRange(month);
    const last = changes.at(-1);
    if (range && last) {
      const a = Date.parse(last.window[0]);
      const b = Date.parse(last.window[1]) + 86400000 - 1;
      const overlaps = a <= range[1] && b >= range[0];
      lastChange = { month, window: last.window, overlaps };
      if (!overlaps) notes.push(`Last change window ${last.window[0]} → ${last.window[1]} does not overlap X's "Last on ${month}". A change is probably missing between the last old handle and @${currentHandle}.`);
    }
  }

  const handles = intervals.map(iv => {
    const h = {
      handle: iv.handle,
      firstSeen: iv.firstSeen,
      lastSeen: iv.current ? "now" : iv.lastSeen,
      observations: iv.count,
      sources: [...iv.sources].sort(),
    };
    if (iv.current) h.current = true;
    else {
      h.confidence = confidence(iv);
      h.examples = iv.tweetIds;
      h.warning = REREGISTER_WARNING;
    }
    return h;
  });

  return { handles, changes, unrecovered, lastChange, notes };
}

/**
 * Which threads to open: the n oldest own posts, plus n around each suspected
 * change (half just before the window, half just after). Posts known to have
 * no replies are skipped.
 */
export function pickReplyTargets(own, changes, n) {
  const usable = own.filter(t => t.createdAt && t.replyCount !== 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const picked = new Set(usable.slice(0, n).map(t => t.id));
  const half = Math.ceil(n / 2);
  for (const c of changes) {
    const [a, b] = c.window;
    usable.filter(t => t.createdAt.slice(0, 10) <= a).slice(-half).forEach(t => picked.add(t.id));
    usable.filter(t => t.createdAt.slice(0, 10) >= b).slice(0, half).forEach(t => picked.add(t.id));
  }
  return [...picked];
}

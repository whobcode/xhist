/**
 * Pure functions over captured GraphQL JSON. Nothing in here touches the
 * network or the browser, so every rule about where a handle is frozen can be
 * tested against fixtures.
 */

export const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

// `x.com/i/status/<id>` is a real URL shape, and "i" would pass HANDLE_RE.
const RESERVED = new Set(["i", "intent", "home", "search", "hashtag", "settings"]);

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "Wed Oct 10 20:19:24 +0000 2018" → ISO string. Falls back to Date parsing. */
export function parseCreatedAt(s) {
  if (!s) return null;
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(s);
  if (m && m[1] in MONTHS) {
    const [, mon, d, hh, mm, ss, sign, oh, om, y] = m;
    const offset = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
    const t = Date.UTC(Number(y), MONTHS[mon], Number(d), Number(hh), Number(mm), Number(ss)) - offset * 60000;
    return new Date(t).toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Walk any JSON value and yield every Tweet object, unwrapping
 * TweetWithVisibilityResults. Quoted and retweeted tweets are nested inside
 * their parent and are found by the same walk. Deduplicated by rest_id.
 */
export function collectTweets(json, into = new Map()) {
  const stack = [json];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    // Children are pushed in reverse so tweets come out in document order.
    if (Array.isArray(v)) { for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]); continue; }
    if (v.__typename === "TweetWithVisibilityResults" && v.tweet) {
      const t = { ...v.tweet, __typename: "Tweet" };
      if (t.rest_id && !into.has(t.rest_id)) into.set(t.rest_id, t);
    } else if (v.__typename === "Tweet" && v.rest_id && v.legacy) {
      if (!into.has(v.rest_id)) into.set(v.rest_id, v);
    }
    const keys = Object.keys(v);
    for (let i = keys.length - 1; i >= 0; i--) {
      const x = v[keys[i]];
      if (x && typeof x === "object") stack.push(x);
    }
  }
  return into;
}

/** Twitter entity indices count the unescaped text; full_text arrives escaped. */
function unescapeText(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function userScreenName(u) {
  return u?.core?.screen_name ?? u?.legacy?.screen_name ?? null;
}

/** Flatten a raw Tweet into the fields the extractors need. */
export function normalizeTweet(raw) {
  const l = raw.legacy ?? {};
  const author = raw.core?.user_results?.result;
  const media = [...(l.entities?.media ?? []), ...(l.extended_entities?.media ?? [])];
  return {
    id: raw.rest_id ?? l.id_str,
    userId: l.user_id_str ?? author?.rest_id ?? null,
    authorHandle: userScreenName(author),
    createdAt: parseCreatedAt(l.created_at),
    text: unescapeText(l.full_text ?? ""),
    range: Array.isArray(l.display_text_range) ? l.display_text_range : null,
    inReplyToUserId: l.in_reply_to_user_id_str ?? null,
    replyCount: typeof l.reply_count === "number" ? l.reply_count : null,
    mediaUrls: media.map(m => m.expanded_url).filter(Boolean),
    urls: (l.entities?.urls ?? []).map(u => u.expanded_url).filter(Boolean),
    mentions: (l.entities?.user_mentions ?? []).map(m => ({
      id: m.id_str ?? null, screenName: m.screen_name ?? null, indices: m.indices ?? null,
    })),
  };
}

/** All tweets in a list of captures, normalized. */
export function tweetsFromCaptures(captures, opPrefixes = null) {
  const map = new Map();
  for (const c of captures) {
    if (opPrefixes && !opPrefixes.some(p => c.op?.startsWith(p))) continue;
    collectTweets(c.json, map);
  }
  return [...map.values()].map(normalizeTweet).filter(t => t.id);
}

const STATUS_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:[/?#]|$)/;

/** The handle in a status URL, only when the URL points at `tweetId` itself. */
export function handleFromStatusUrl(url, tweetId) {
  const m = STATUS_URL.exec(url);
  if (!m || m[2] !== tweetId || RESERVED.has(m[1].toLowerCase())) return null;
  return m[1];
}

/** Media URLs on the target's own posts freeze the handle at post time. */
export function mediaUrlObservations(t, restId) {
  if (t.userId !== restId || !t.createdAt) return [];
  const seen = new Set();
  const out = [];
  for (const url of [...t.mediaUrls, ...t.urls]) {
    const h = handleFromStatusUrl(url, t.id);
    if (!h || seen.has(h.toLowerCase())) continue;
    seen.add(h.toLowerCase());
    out.push({ handle: h, at: t.createdAt, source: "media_url", tweetId: t.id });
  }
  return out;
}

/** Slice by code points, the unit Twitter indices count in. */
function sliceCp(text, a, b) {
  return Array.from(text).slice(a, b).join("");
}

function mentionAsTyped(t, m) {
  if (!Array.isArray(m.indices)) return null;
  const s = sliceCp(t.text, m.indices[0], m.indices[1]).replace(/^[@＠]/, "");
  return HANDLE_RE.test(s) ? s : null;
}

/**
 * A reply to the target starts with "@<handle as it was when replying>".
 * in_reply_to_screen_name shows the *current* handle and is deliberately
 * ignored.
 */
export function replyPrefixObservations(t, restId) {
  if (t.inReplyToUserId !== restId || !t.createdAt) return [];
  const start = t.range?.[0] ?? 0;
  if (start <= 0) return [];

  // Best: a mention entity that resolves to the target, read as typed.
  const ent = t.mentions.find(m => m.id === restId && Array.isArray(m.indices) && m.indices[0] < start);
  let handle = ent ? mentionAsTyped(t, ent) : null;

  // Otherwise: the first leading @handle that isn't the replier's own.
  if (!handle) {
    const own = t.authorHandle?.toLowerCase();
    const found = [...sliceCp(t.text, 0, start).matchAll(/@([A-Za-z0-9_]{1,15})/g)].map(m => m[1]);
    handle = found.find(h => h.toLowerCase() !== own) ?? null;
  }
  return handle ? [{ handle, at: t.createdAt, source: "reply_prefix", tweetId: t.id }] : [];
}

/** Body-text mentions of the target by others, read as typed. */
export function mentionObservations(t, restId) {
  if (t.userId === restId || !t.createdAt) return [];
  const start = t.range?.[0] ?? 0;
  const out = [];
  for (const m of t.mentions) {
    if (m.id !== restId || !Array.isArray(m.indices) || m.indices[0] < start) continue;
    const h = mentionAsTyped(t, m);
    if (h) out.push({ handle: h, at: t.createdAt, source: "mention", tweetId: t.id });
  }
  return out.slice(0, 1);
}

/** Every observation in a set of normalized tweets, deduplicated. */
export function observationsFromTweets(tweets, restId) {
  const seen = new Set();
  const out = [];
  for (const t of tweets) {
    for (const o of [
      ...mediaUrlObservations(t, restId),
      ...replyPrefixObservations(t, restId),
      ...mentionObservations(t, restId),
    ]) {
      const key = `${o.source}:${o.tweetId}:${o.handle.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(o);
    }
  }
  return out;
}

/** The `UserByScreenName` payload → account summary and status. */
export function parseUser(json) {
  const r = json?.data?.user?.result;
  if (!r) return { status: "not_found" };
  if (r.__typename === "UserUnavailable") {
    const reason = String(r.reason ?? r.unavailable_message?.text ?? "").toLowerCase();
    return { status: reason.includes("suspend") ? "suspended" : "unavailable", reason: r.reason ?? null };
  }
  const l = r.legacy ?? {};
  const protectedFlag = r.privacy?.protected ?? l.protected ?? false;
  return {
    status: protectedFlag ? "protected" : "ok",
    restId: r.rest_id ?? null,
    screenName: r.core?.screen_name ?? l.screen_name ?? null,
    name: r.core?.name ?? l.name ?? null,
    createdAt: parseCreatedAt(r.core?.created_at ?? l.created_at),
    tweets: r.tweet_counts?.tweets ?? l.statuses_count ?? null,
    protected: protectedFlag,
  };
}

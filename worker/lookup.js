/**
 * The two lookups behind the page. Both return the CLI's result shape, so the
 * page renders a CLI report, a basic lookup and a detailed lookup the same way.
 *
 * basic    — memory.lol + Wayback only. No sign-in, no X requests.
 * detailed — the signed-in user's X API token: own posts for media-URL
 *            handles, full-archive search for the oldest posts and replies.
 */
import { observationsFromTweets } from "../src/extract.js";
import { buildTimeline, pickReplyTargets, day } from "../src/timeline.js";
import { normalizeV2Page } from "../src/xapi.js";
import { memoryLolAccounts, memoryLolById, memoryLolByHandle, memoryLolObservations } from "../src/sources/memorylol.js";
import { waybackTimestamps } from "../src/sources/wayback.js";
import { xclient, XApiError } from "./xclient.js";
import { kvCache } from "./kv.js";

const DAY = 86_400_000;
const MAX_WAYBACK = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const latestDate = dates => (dates ?? []).filter(Boolean).sort().at(-1) ?? null;

async function waybackFor(handles, cache) {
  const out = {};
  await Promise.all(handles.slice(0, MAX_WAYBACK).map(async h => { out[h] = await waybackTimestamps(h, { cache }); }));
  return out;
}

export async function basicLookup(input, env) {
  const cache = kvCache(env, "src", 86400);
  const now = new Date().toISOString();
  const accounts = await memoryLolAccounts(input, { cache });
  if (accounts === null) return { mode: "basic", input, status: "source_down", message: "memory.lol could not be reached. Try again shortly." };
  if (!accounts.length) {
    return {
      mode: "basic", input, status: "no_record",
      message: `memory.lol has no record of @${input}. Newer accounts often aren't covered — sign in with X for a live lookup.`,
    };
  }

  // Several accounts may have held this handle. Lead with the most recent holder.
  const seenAs = a => latestDate(Object.entries(a.screenNames).find(([h]) => h.toLowerCase() === input.toLowerCase())?.[1]) ?? "";
  accounts.sort((a, b) => seenAs(b).localeCompare(seenAs(a)));
  const [primary, ...others] = accounts;

  const byId = (await memoryLolById(primary.userId, { cache })) ?? {};
  const names = { ...primary.screenNames, ...byId };
  const [currentHandle, currentDates] = Object.entries(names)
    .sort((a, b) => (latestDate(a[1]) ?? "").localeCompare(latestDate(b[1]) ?? "")).at(-1);
  const lastSighting = latestDate(currentDates);

  const t = buildTimeline({
    observations: memoryLolObservations(names), currentHandle,
    createdAt: null, about: null, oldestPostAt: null, now,
  });
  // memory.lol can't say whether the latest name is still in use.
  const cur = t.handles.find(h => h.current);
  if (cur) { cur.lastSeen = lastSighting; cur.current = "latest"; }

  const old = t.handles.filter(h => h.current !== "latest").map(h => h.handle);
  const notes = [
    `Basic lookup uses memory.lol's archive only. @${currentHandle} is the latest name it recorded (${day(lastSighting) ?? "date unknown"}). Sign in with X for a live check against the account's own posts.`,
    ...t.notes,
  ];
  if (currentHandle.toLowerCase() !== input.toLowerCase()) notes.unshift(`@${input} was a previous name of this account; it was later renamed.`);
  if (others.length) notes.push(`@${input} was also used by ${others.length} other account(s). Handles can be re-registered, so those are listed separately.`);

  return {
    mode: "basic",
    status: "ok",
    input,
    userId: primary.userId,
    currentHandle,
    createdAt: null,
    generatedAt: now,
    about: null,
    handles: t.handles,
    changes: t.changes,
    unrecovered: 0,
    memoryLol: { byId: names, byHandle: {} },
    wayback: await waybackFor(old, cache),
    otherAccounts: others.map(a => ({ userId: a.userId, screenNames: a.screenNames })),
    notes,
  };
}

function userStatus(resp) {
  const err = resp?.errors?.[0];
  const text = `${err?.title ?? ""} ${err?.detail ?? ""}`.toLowerCase();
  if (text.includes("suspend")) return "suspended";
  if (text.includes("not found") || text.includes("could not find")) return "not_found";
  return "unavailable";
}

export async function detailedLookup(input, session, env) {
  const x = xclient(session.accessToken);
  const srcCache = kvCache(env, "src", 86400);
  // Full-archive search allows about one request per second per app.
  const gap = () => sleep(env.API_GAP_MS !== undefined ? Number(env.API_GAP_MS) : 1100);
  const now = new Date().toISOString();
  const notes = [];

  const u = await x.userByUsername(input);
  if (!u?.data) return { mode: "detailed", input, status: userStatus(u), message: u?.errors?.[0]?.detail ?? "Account unavailable." };
  const user = u.data;
  const restId = user.id;
  const handle = user.username;
  const createdAt = user.created_at ? new Date(user.created_at).toISOString() : null;
  const profile = { name: user.name, avatar: user.profile_image_url ?? null, posts: user.public_metrics?.tweet_count ?? null, protected: !!user.protected };
  if (user.protected) return { mode: "detailed", input, status: "protected", userId: restId, currentHandle: handle, profile, message: "This account is protected; its posts are not visible." };

  const cacheKey = `detail:${restId}`;
  const hit = await env.XHIST_KV.get(cacheKey, "json").catch(() => null);
  if (hit) return { ...hit, cached: true };

  // Anything that leaves the result incomplete is cached briefly, not for 12 h.
  let partial = false;
  const apiNote = (what, e) => {
    partial = true;
    console.error(`X API ${e.status} while ${what}: ${JSON.stringify(e.body ?? null).slice(0, 300)}`);
    if (e.rateLimited) return `X API rate limit hit while ${what}; results are partial.`;
    if (e.status === 402) return `X API credits ran out while ${what}; results are partial.`;
    return `X API error ${e.status} while ${what}; results are partial.`;
  };

  // Own recent posts (up to 3,200).
  const tweets = new Map();
  const add = list => list.forEach(t => tweets.set(t.id, t));
  const tl = await x.timeline(restId, Number(env.TIMELINE_PAGES) || 5);
  add(tl.pages.flatMap(normalizeV2Page));
  if (tl.error) notes.push(apiNote("reading posts", tl.error));

  // Oldest posts: full-archive search forward from the creation date. Results
  // come newest-first, so a window's oldest posts are on its *last* page. Walk
  // windows from `lo`: an empty window moves `lo` past it and widens; a window
  // too dense to read within the page budget is narrowed from the same `lo`.
  // The first window read to the end that has posts holds the oldest ones.
  let archive = true;
  if (createdAt) {
    const HOUR = 3_600_000;
    const latest = Date.now() - 30_000;
    const maxPages = Number(env.ARCHIVE_PAGES) || 3;
    const readWindow = async (lo, hi) => {
      let token;
      let found = 0;
      for (let i = 0; i < maxPages; i++) {
        const p = await x.searchAll(`from:${restId} -is:retweet`, {
          start_time: new Date(lo).toISOString(), end_time: new Date(hi).toISOString(), next_token: token,
        });
        const got = normalizeV2Page(p);
        add(got);
        found += got.length;
        token = p?.meta?.next_token;
        await gap();
        if (!token) return { found, unread: false };
      }
      return { found, unread: true };
    };
    let lo = Date.parse(createdAt);
    let span = 7 * DAY;
    let settled = false;
    try {
      for (let w = 0; w < 12 && lo < latest; w++) {
        const hi = Math.min(lo + span, latest);
        const r = await readWindow(lo, hi);
        if (!r.unread) {
          if (r.found) { settled = true; break; }
          lo = hi;
          span *= 4;
        } else if (hi - lo <= HOUR) {
          break;
        } else {
          span = (hi - lo) / 8;
        }
      }
      if (lo >= latest) settled = true; // searched up to now: nothing older exists
      if (!settled) {
        partial = true;
        notes.push("Archive search couldn't reach this account's very first posts within its page budget; the original handle may be missing.");
      }
    } catch (e) {
      if (!(e instanceof XApiError)) throw e;
      archive = false;
      // 403 means the plan has no full-archive search, which won't change by retrying.
      if (e.status === 403) notes.push("Full-archive search isn't on this X API plan, so only the most recent 3,200 posts were checked.");
      else notes.push(apiNote("searching the archive", e));
    }
  }

  const own = [...tweets.values()].filter(t => t.userId === restId && t.createdAt);
  const oldestPostAt = own.reduce((m, t) => (!m || t.createdAt < m ? t.createdAt : m), null);
  const byId = await memoryLolById(restId, { cache: srcCache });

  // Replies to the oldest posts and around each suspected change. Search only
  // looks back 30 days unless told otherwise, so start at the post itself.
  let threads = 0;
  if (archive) {
    const prelim = buildTimeline({
      observations: [...observationsFromTweets(own, restId), ...memoryLolObservations(byId)],
      currentHandle: handle, createdAt, about: null, oldestPostAt, now,
    });
    const postedAt = new Map(own.map(t => [t.id, t.createdAt]));
    const targets = pickReplyTargets(own, prelim.changes, Number(env.REPLY_THREADS) || 6);
    for (const id of targets) {
      try {
        add(normalizeV2Page(await x.searchAll(`conversation_id:${id} -from:${restId}`, { start_time: postedAt.get(id) })));
        threads++;
      } catch (e) {
        if (!(e instanceof XApiError)) throw e;
        notes.push(apiNote("reading replies", e));
        break;
      }
      await gap();
    }
  }

  const observations = observationsFromTweets([...tweets.values()], restId);
  const candidates = [...new Map(
    [...observations.map(o => o.handle), ...Object.keys(byId ?? {})].map(h => [h.toLowerCase(), h]),
  ).values()];
  const byHandle = {};
  for (const h of candidates) {
    const r = await memoryLolByHandle(h, restId, { cache: srcCache });
    if (r === null) partial = true;
    else if (Object.keys(r).length) byHandle[h] = r;
  }

  const t = buildTimeline({
    observations: [...observations, ...memoryLolObservations(byId, ...Object.values(byHandle))],
    currentHandle: handle, createdAt, about: null, oldestPostAt, now,
  });
  const oldHandles = candidates.filter(h => h.toLowerCase() !== handle.toLowerCase());
  if (!byId) { partial = true; notes.push("memory.lol could not be reached."); }
  notes.push("X's username-change count (About panel) isn't in the API; run the CLI for that cross-check.");

  const wayback = await waybackFor(oldHandles, srcCache);
  if (Object.values(wayback).some(v => v === null)) partial = true;

  const result = {
    mode: "detailed",
    status: "ok",
    input,
    userId: restId,
    currentHandle: handle,
    createdAt,
    generatedAt: now,
    profile,
    about: null,
    handles: t.handles,
    changes: t.changes,
    unrecovered: t.unrecovered,
    memoryLol: { byId: byId ?? {}, byHandle },
    wayback,
    stats: { ownPosts: own.length, oldestPost: oldestPostAt, threadsOpened: threads, observations: observations.length },
    notes: [...notes, ...t.notes],
  };
  await env.XHIST_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: partial ? 1800 : 12 * 3600 })
    .catch(e => console.error(`kv put ${cacheKey}: ${e.message}`));
  return result;
}

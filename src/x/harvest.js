/**
 * Steps 4–5: gather the target's own posts (search pagination + profile
 * timelines) and the reply threads under selected posts.
 */
import { tweetsFromCaptures } from "../extract.js";
import { isLoginWall } from "../browser.js";
export { pickReplyTargets } from "../timeline.js";

// Prefixes, not exact names: X renames these ops from time to time.
const TIMELINE_OPS = ["SearchTimeline", "UserTweets", "UserMedia", "UserVideoTimeline", "UserOriginalsTimeline"];
const DAY = 86_400_000;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

export async function harvestOwnPosts(session, handle, restId, { maxPages = 50, log = () => {} } = {}) {
  const tweets = new Map();
  const add = (v, ops) => {
    let fresh = 0;
    for (const t of tweetsFromCaptures(v.captures, ops)) {
      if (!tweets.has(t.id)) { tweets.set(t.id, t); if (t.userId === restId) fresh++; }
    }
    return fresh;
  };
  let loginWall = false;

  for (const tab of ["", "/with_replies", "/media"]) {
    const v = await session.visit(`https://x.com/${handle}${tab}`, { waitFor: ["User"], scrolls: 40 });
    if (isLoginWall(v.finalUrl)) { loginWall = true; break; }
    log(`  /${handle}${tab}: +${add(v, TIMELINE_OPS)} own posts`);
  }

  // Latest-mode search, walking `until:` backwards to the oldest post.
  // Progress is judged against what search has returned, not against the
  // timelines: page one is mostly posts the profile tabs already found.
  const searchSeen = new Set();
  let until = isoDay(Date.now() + DAY);
  let pages = 0;
  while (pages < maxPages && !loginWall) {
    const q = `from:${handle} until:${until}`;
    const v = await session.visit(`https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`, { waitFor: ["SearchTimeline"], scrolls: 6 });
    pages++;
    if (isLoginWall(v.finalUrl)) { loginWall = true; break; }

    const own = tweetsFromCaptures(v.captures, ["SearchTimeline"]).filter(t => t.userId === restId && t.createdAt);
    const progressed = own.filter(t => !searchSeen.has(t.id)).length;
    own.forEach(t => searchSeen.add(t.id));
    const fresh = add(v, ["SearchTimeline"]);
    log(`  search until:${until}: ${own.length} posts, +${fresh} new`);
    if (!progressed) break;

    // `until:` is exclusive. Re-include the oldest day unless that would not move us back.
    const oldest = Math.min(...own.map(t => Date.parse(t.createdAt)));
    let next = isoDay(oldest + DAY);
    if (next >= until) next = isoDay(oldest);
    if (next >= until) break;
    until = next;
  }

  const own = [...tweets.values()].filter(t => t.userId === restId && t.createdAt);
  const oldestPostAt = own.reduce((m, t) => (!m || t.createdAt < m ? t.createdAt : m), null);
  return { tweets: [...tweets.values()], own, oldestPostAt, searchPages: pages, loginWall };
}

export async function harvestReplies(session, tweetIds, { log = () => {} } = {}) {
  const tweets = new Map();
  let i = 0;
  for (const id of tweetIds) {
    const v = await session.visit(`https://x.com/i/status/${id}`, { waitFor: ["TweetDetail"], scrolls: 3 });
    if (isLoginWall(v.finalUrl)) return { tweets: [...tweets.values()], loginWall: true };
    for (const t of tweetsFromCaptures(v.captures, ["TweetDetail"])) tweets.set(t.id, t);
    if (++i % 5 === 0 || i === tweetIds.length) log(`  threads ${i}/${tweetIds.length}`);
  }
  return { tweets: [...tweets.values()], loginWall: false };
}

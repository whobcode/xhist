/** Step 1: handle → rest_id and account summary. */
import { parseUser } from "../extract.js";
import { isLoginWall } from "../browser.js";

export async function resolve(session, handle) {
  const v = await session.visit(`https://x.com/${handle}`, { waitFor: ["UserByScreenName"], html: true, cache: false });

  // Hover cards and sidebars can fetch other users; take the one we asked for.
  const payloads = v.captures.filter(c => c.op === "UserByScreenName").map(c => parseUser(c.json));
  const mine = payloads.find(u => u.screenName?.toLowerCase() === handle.toLowerCase())
    ?? payloads.find(u => u.status !== "ok" && u.status !== "protected");
  if (mine) return mine;

  const banner = /profile_banners\/(\d+)/.exec(v.html ?? "");
  if (banner) {
    return { status: "ok", restId: banner[1], screenName: handle, name: null, createdAt: null, tweets: null, protected: false, partial: true };
  }
  if (isLoginWall(v.finalUrl)) return { status: "login_required" };
  // No GraphQL at all means X served nothing usable (logged out, blocked
  // headless, or an error page), which is not the same as "no such account".
  if (!v.captures.length) return { status: "no_data" };
  return { status: "not_found" };
}

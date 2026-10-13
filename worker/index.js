/**
 * xhist.hwmnbn.me — static page from ./public plus a small JSON API.
 *
 *   GET  /api/me                 sign-in state
 *   GET  /api/lookup?u=&mode=    basic | detailed
 *   GET  /auth/login             → X consent screen
 *   GET  /auth/callback          ← X consent screen
 *   POST /auth/logout
 */
import { HANDLE_RE } from "../src/extract.js";
import { login, callback, logout, getSession, authConfigured, allowedDetailed } from "./auth.js";
import { basicLookup, detailedLookup } from "./lookup.js";
import { XApiError } from "./xclient.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function limited(req, env) {
  if (!env.LOOKUP_LIMITER) return false;
  const key = req.headers.get("cf-connecting-ip") ?? "anon";
  const { success } = await env.LOOKUP_LIMITER.limit({ key });
  return !success;
}

/**
 * X bills API reads to the developer app, not to the visitor whose token is
 * used, so each signed-in account gets DETAILED_DAILY_LIMIT fresh detailed
 * lookups per UTC day (0 = unlimited). The slot is reserved *before* the
 * lookup, which takes tens of seconds, and refunded if nothing was billed.
 * KV has no atomic increment, so a burst of parallel requests could still
 * share a slot; DETAILED_LIMITER (per account, per minute) bounds that.
 */
async function reserveDetailed(env, session) {
  const id = String(session.userId ?? session.username ?? "");
  if (env.DETAILED_LIMITER && id) {
    const { success } = await env.DETAILED_LIMITER.limit({ key: id });
    if (!success) return { ok: false, reason: "burst" };
  }
  const limit = Number(env.DETAILED_DAILY_LIMIT ?? 25);
  if (!limit || !id) return { ok: true, refund: async () => {} };
  const key = `quota:${id}:${new Date().toISOString().slice(0, 10)}`;
  const read = async () => Number(await env.XHIST_KV.get(key).catch(() => null)) || 0;
  const used = await read();
  if (used >= limit) return { ok: false, reason: "daily", limit };
  await env.XHIST_KV.put(key, String(used + 1), { expirationTtl: 2 * 86400 }).catch(() => {});
  return {
    ok: true,
    refund: async () => {
      const now = await read();
      if (now > 0) await env.XHIST_KV.put(key, String(now - 1), { expirationTtl: 2 * 86400 }).catch(() => {});
    },
  };
}

async function lookup(req, env) {
  const url = new URL(req.url);
  const input = (url.searchParams.get("u") ?? "").trim().replace(/^@/, "");
  if (!HANDLE_RE.test(input)) return json({ error: "Enter a valid X username (letters, numbers, underscore; up to 15)." }, 400);
  if (await limited(req, env)) return json({ error: "Too many lookups. Wait a minute and try again." }, 429);

  if (url.searchParams.get("mode") === "detailed") {
    const session = await getSession(req, env);
    if (!session) return json({ error: "Sign in with X to run a detailed lookup.", signIn: true }, 401);
    if (!allowedDetailed(env, session)) return json({ error: "Detailed lookups are limited to approved accounts." }, 403);
    const slot = await reserveDetailed(env, session);
    if (!slot.ok) {
      return json({ error: slot.reason === "burst"
        ? "Detailed lookups are limited to a couple a minute per account. Wait a moment and try again."
        : `You've used today's ${slot.limit} detailed lookups. Basic lookups are still available.` }, 429);
    }
    let billed = false;
    try {
      const result = await detailedLookup(input, session, env);
      billed = !result.cached && result.status === "ok";
      return json(result);
    } catch (e) {
      if (e instanceof XApiError) {
        console.error(`X API ${e.status}: ${JSON.stringify(e.body ?? null).slice(0, 300)}`);
        if (e.rateLimited) return json({ error: "X API rate limit reached. Try again in a few minutes." }, 429);
        if (e.status === 401) return json({ error: "Your X sign-in expired. Sign in again.", signIn: true }, 401);
        return json({ error: `X API error ${e.status}.` }, 502);
      }
      throw e;
    } finally {
      if (!billed) await slot.refund();
    }
  }
  return json(await basicLookup(input, env));
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === "/api/me" && req.method === "GET") {
        const s = await getSession(req, env).catch(e => { console.error(`getSession: ${e.message}`); return null; });
        return json({ authAvailable: authConfigured(env), signedIn: !!s, username: s?.username ?? null, avatar: s?.avatar ?? null });
      }
      if (pathname === "/api/lookup" && req.method === "GET") return await lookup(req, env);
      if (pathname === "/auth/login" && req.method === "GET") return await login(req, env);
      if (pathname === "/auth/callback" && req.method === "GET") return await callback(req, env);
      if (pathname === "/auth/logout" && req.method === "POST") return await logout(req, env);
      if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "Something went wrong." }, 500);
    }
    return env.ASSETS.fetch(req);
  },
};

/**
 * "Sign in with X": OAuth 2.0 authorization code + PKCE against X's own
 * consent screen. Each visitor signs in with their own X account; xhist never
 * sees a password. Access and refresh tokens live in KV under a random
 * session ID; the browser only holds that ID in an HttpOnly cookie, so page
 * scripts can never read a token.
 *
 * Configuration: X_CLIENT_ID (a plain var in wrangler.jsonc). Register the X
 * app as a "Native App" — a public PKCE client — and no secret is needed: the
 * client ID is public anyway, since it appears in every sign-in URL.
 * X_CLIENT_SECRET is optional and only for an app registered as a "Web App"
 * (confidential client); when it is set, token calls use Basic auth.
 */

const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const TOKEN = "https://api.x.com/2/oauth2/token";
const REVOKE = "https://api.x.com/2/oauth2/revoke";
const SCOPES = "tweet.read users.read offline.access";
// __Host- cookies must be Secure, Path=/ and host-only, so a sibling
// *.hwmnbn.me subdomain can't plant or overwrite them.
const SESSION_COOKIE = "__Host-xhist_sid";
const FLOW_COOKIE = "__Host-xhist_oauth";
const SESSION_TTL = 30 * 86400;
const FLOW_TTL = 600;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomId = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const ID_RE = /^[A-Za-z0-9_-]{20,}$/;

export const authConfigured = env => Boolean(env.X_CLIENT_ID);

function redirectUri(req) {
  return new URL("/auth/callback", req.url).toString();
}

export function cookieOf(req, name) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Constant-time string compare, so the state check doesn't leak by timing. */
function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Request init for X's token and revoke endpoints. Public clients identify
 * themselves with client_id in the body; confidential clients add Basic auth.
 */
export function clientRequestInit(env, params) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (env.X_CLIENT_SECRET) headers.authorization = `Basic ${btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`)}`;
  return { method: "POST", headers, body: new URLSearchParams({ client_id: env.X_CLIENT_ID, ...params }).toString() };
}

export class TokenError extends Error {
  constructor(status, code) {
    super(`token endpoint ${status}${code ? ` ${code}` : ""}`);
    this.status = status;
    this.code = code;
  }
  /** X rejected the grant itself (spent or revoked refresh token), not a passing failure. */
  get dead() { return this.status === 400 || this.status === 401 || this.code === "invalid_grant"; }
}

async function tokenRequest(env, params) {
  let res;
  try {
    res = await fetch(TOKEN, clientRequestInit(env, params));
  } catch {
    throw new TokenError(0, "network");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let code = null;
    try { code = JSON.parse(body).error ?? null; } catch { /* not JSON */ }
    console.error(`X token endpoint ${res.status}: ${body.slice(0, 300)}`);
    throw new TokenError(res.status, code);
  }
  const t = await res.json();
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: Date.now() + (Number(t.expires_in) || 7200) * 1000,
  };
}

/**
 * Start sign-in. The state and PKCE verifier ride in a short-lived HttpOnly
 * cookie rather than KV: that binds the flow to this browser (no login CSRF)
 * and means an unauthenticated GET costs no storage write.
 */
export async function login(req, env) {
  if (!authConfigured(env)) return new Response("Sign-in is not configured.", { status: 503 });
  const state = randomId(16);
  const verifier = randomId(48); // 64 chars, within PKCE's 43–128
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const u = new URL(AUTHORIZE);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: env.X_CLIENT_ID,
    redirect_uri: redirectUri(req),
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return new Response(null, {
    status: 302,
    headers: { location: u.toString(), "set-cookie": cookie(FLOW_COOKIE, `${state}.${verifier}`, FLOW_TTL), "cache-control": "no-store" },
  });
}

export async function callback(req, env) {
  const url = new URL(req.url);
  const home = new URL("/", req.url);
  const back = reason => new Response(null, {
    status: 302,
    headers: { location: `${home}?signin=${reason}`, "set-cookie": cookie(FLOW_COOKIE, "", 0) },
  });
  if (!authConfigured(env)) return back("failed");

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !state || !code) return back("cancelled");

  // The state must match the one this browser was given at /auth/login.
  const [flowState, verifier] = (cookieOf(req, FLOW_COOKIE) ?? "").split(".");
  if (!flowState || !verifier) return back("expired");
  if (!sameString(flowState, state)) return back("failed");

  let tokens;
  try {
    tokens = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(req), code_verifier: verifier });
  } catch {
    return back("failed");
  }

  // Without the account's identity there is no session worth keeping.
  const meRes = await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url", {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => null);
  const me = meRes?.ok ? await meRes.json().catch(() => null) : null;
  if (!me?.data?.id) {
    const detail = meRes && !meRes.ok ? (await meRes.text().catch(() => "")).slice(0, 300) : "";
    console.error(`X /2/users/me at sign-in: ${meRes?.status ?? "network error"} ${detail}`);
    return back("failed");
  }

  const sid = randomId();
  const session = {
    ...tokens,
    userId: me.data.id,
    username: me.data.username ?? null,
    avatar: me.data.profile_image_url ?? null,
  };
  await env.XHIST_KV.put(`sess:${sid}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });
  const headers = new Headers({ location: home.toString() });
  headers.append("set-cookie", cookie(SESSION_COOKIE, sid, SESSION_TTL));
  headers.append("set-cookie", cookie(FLOW_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

const fresh = s => s && s.expiresAt >= Date.now() + 60_000;

/**
 * The signed-in session with a usable access token, or null.
 *
 * X rotates refresh tokens, so two requests refreshing at once race: the
 * loser's refresh token is already spent. A rejected refresh therefore
 * re-reads the session a few times before giving up, and a passing failure
 * (network, 5xx, 429) never deletes a session whose refresh token may still
 * be good — that request just goes without.
 */
export async function getSession(req, env) {
  const sid = cookieOf(req, SESSION_COOKIE);
  if (!sid || !ID_RE.test(sid)) return null;
  const key = `sess:${sid}`;
  const s = await env.XHIST_KV.get(key, "json");
  if (!s) return null;
  if (fresh(s)) return s;
  if (!s.refreshToken) return null;

  try {
    const t = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: s.refreshToken });
    Object.assign(s, t, { refreshToken: t.refreshToken ?? s.refreshToken });
    await env.XHIST_KV.put(key, JSON.stringify(s), { expirationTtl: SESSION_TTL }).catch(e => console.error(`session put: ${e.message}`));
    return s;
  } catch (e) {
    if (!(e instanceof TokenError) || !e.dead) return null;
    for (const wait of [400, 1200]) {
      await sleep(wait);
      const again = await env.XHIST_KV.get(key, "json");
      if (!again) return null;
      if (fresh(again)) return again;
      if (again.refreshToken !== s.refreshToken) return null; // someone else refreshed; next request will see it
    }
    await env.XHIST_KV.delete(key);
    return null;
  }
}

/** Same-origin check for state-changing requests. */
export function sameOrigin(req) {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}

export async function logout(req, env) {
  if (!sameOrigin(req)) return new Response(null, { status: 403 });
  const sid = cookieOf(req, SESSION_COOKIE);
  if (sid && ID_RE.test(sid)) {
    const s = await env.XHIST_KV.get(`sess:${sid}`, "json");
    if (s && authConfigured(env)) {
      // Revoke the refresh token too: the access token is often already expired.
      const revoke = [
        s.refreshToken && { token: s.refreshToken, token_type_hint: "refresh_token" },
        s.accessToken && { token: s.accessToken, token_type_hint: "access_token" },
      ].filter(Boolean);
      await Promise.all(revoke.map(p => fetch(REVOKE, clientRequestInit(env, p)).catch(() => {})));
    }
    await env.XHIST_KV.delete(`sess:${sid}`);
  }
  return new Response(null, { status: 204, headers: { "set-cookie": cookie(SESSION_COOKIE, "", 0) } });
}

/**
 * Optional allowlist (ALLOWED_X_USERS, comma-separated) for detailed lookups.
 * Numeric entries match the account ID, which never changes; other entries
 * match the username, which can be renamed or re-registered by someone else.
 */
export function allowedDetailed(env, session) {
  const list = String(env.ALLOWED_X_USERS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  return list.some(e => /^\d+$/.test(e)
    ? e === String(session?.userId ?? "")
    : e === String(session?.username ?? "").toLowerCase());
}

/**
 * "Sign in with X": OAuth 2.0 authorization code + PKCE against X's own
 * consent screen. xhist never sees a password. Access and refresh tokens live
 * in KV under a random session ID; the browser only holds that ID in an
 * HttpOnly cookie, so page scripts can never read a token.
 *
 * Secrets (set with `wrangler secret put`): X_CLIENT_ID, X_CLIENT_SECRET.
 */

const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const TOKEN = "https://api.x.com/2/oauth2/token";
const REVOKE = "https://api.x.com/2/oauth2/revoke";
const SCOPES = "tweet.read users.read offline.access";
const COOKIE = "xhist_sid";
const SESSION_TTL = 30 * 86400;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomId = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export const authConfigured = env => Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET);

function redirectUri(req) {
  return new URL("/auth/callback", req.url).toString();
}

function cookieOf(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get("cookie") ?? "");
  return m ? m[1] : null;
}

function setCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function basicAuth(env) {
  return `Basic ${btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`)}`;
}

export async function login(req, env) {
  if (!authConfigured(env)) return new Response("Sign-in is not configured.", { status: 503 });
  const state = randomId(16);
  const verifier = randomId(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  await env.XHIST_KV.put(`oauth:${state}`, verifier, { expirationTtl: 600 });
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
  return Response.redirect(u.toString(), 302);
}

async function tokenRequest(env, params) {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(env) },
    body: new URLSearchParams({ client_id: env.X_CLIENT_ID, ...params }),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  const t = await res.json();
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: Date.now() + (Number(t.expires_in) || 7200) * 1000,
  };
}

export async function callback(req, env) {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const home = new URL("/", req.url);
  if (url.searchParams.get("error") || !state || !code) return Response.redirect(`${home}?signin=cancelled`, 302);

  const verifier = await env.XHIST_KV.get(`oauth:${state}`);
  if (!verifier) return Response.redirect(`${home}?signin=expired`, 302);
  await env.XHIST_KV.delete(`oauth:${state}`);

  let tokens;
  try {
    tokens = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(req), code_verifier: verifier });
  } catch {
    return Response.redirect(`${home}?signin=failed`, 302);
  }
  const me = await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url", {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  }).then(r => (r.ok ? r.json() : null)).catch(() => null);

  const sid = randomId();
  const session = { ...tokens, username: me?.data?.username ?? null, avatar: me?.data?.profile_image_url ?? null };
  await env.XHIST_KV.put(`sess:${sid}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });
  return new Response(null, { status: 302, headers: { location: home.toString(), "set-cookie": setCookie(sid, SESSION_TTL) } });
}

/** The signed-in session with a fresh access token, or null. */
export async function getSession(req, env) {
  const sid = cookieOf(req, COOKIE);
  if (!sid || !/^[A-Za-z0-9_-]{20,}$/.test(sid)) return null;
  const s = await env.XHIST_KV.get(`sess:${sid}`, "json");
  if (!s) return null;
  if (s.expiresAt < Date.now() + 60_000) {
    if (!s.refreshToken) return null;
    try {
      Object.assign(s, await tokenRequest(env, { grant_type: "refresh_token", refresh_token: s.refreshToken }));
      await env.XHIST_KV.put(`sess:${sid}`, JSON.stringify(s), { expirationTtl: SESSION_TTL });
    } catch {
      await env.XHIST_KV.delete(`sess:${sid}`);
      return null;
    }
  }
  return s;
}

export async function logout(req, env) {
  const sid = cookieOf(req, COOKIE);
  if (sid) {
    const s = await env.XHIST_KV.get(`sess:${sid}`, "json");
    if (s?.accessToken && authConfigured(env)) {
      await fetch(REVOKE, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(env) },
        body: new URLSearchParams({ token: s.accessToken, token_type_hint: "access_token", client_id: env.X_CLIENT_ID }),
      }).catch(() => {});
    }
    await env.XHIST_KV.delete(`sess:${sid}`);
  }
  return new Response(null, { status: 204, headers: { "set-cookie": setCookie("", 0) } });
}

/** Optional comma-separated allowlist of X usernames that may run detailed lookups. */
export function allowedDetailed(env, session) {
  const list = String(env.ALLOWED_X_USERS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return !list.length || list.includes(String(session?.username ?? "").toLowerCase());
}

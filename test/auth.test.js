import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authConfigured, clientRequestInit, allowedDetailed, login, callback, getSession, sameOrigin, cookieOf,
} from "../worker/auth.js";

const ENV = { X_CLIENT_ID: "abc" };

function fakeKV(initial = {}) {
  const m = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = real; });
}

const req = (url, headers = {}) => new Request(url, { headers });
const SID = "a".repeat(43);

test("sign-in needs only a client ID", () => {
  assert.equal(authConfigured({ X_CLIENT_ID: "abc" }), true);
  assert.equal(authConfigured({ X_CLIENT_ID: "" }), false);
  assert.equal(authConfigured({}), false);
});

test("public client: client_id in the body, no Authorization header", () => {
  const init = clientRequestInit(ENV, { grant_type: "authorization_code", code: "c", code_verifier: "v" });
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, undefined);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
    client_id: "abc", grant_type: "authorization_code", code: "c", code_verifier: "v",
  });
});

test("confidential client: Basic auth when a secret is set", () => {
  const init = clientRequestInit({ X_CLIENT_ID: "abc", X_CLIENT_SECRET: "s3" }, { grant_type: "refresh_token", refresh_token: "r" });
  assert.equal(init.headers.authorization, `Basic ${btoa("abc:s3")}`);
});

test("login: PKCE S256 redirect, state+verifier in a host-only HttpOnly cookie", async () => {
  const res = await login(req("https://xhist.hwmnbn.me/auth/login"), ENV);
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(to.searchParams.get("redirect_uri"), "https://xhist.hwmnbn.me/auth/callback");
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  assert.equal(to.searchParams.get("scope"), "tweet.read users.read offline.access");
  const set = res.headers.get("set-cookie");
  assert.match(set, /^__Host-xhist_oauth=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  const [state, verifier] = set.split(";")[0].split("=")[1].split(".");
  assert.equal(state, to.searchParams.get("state"));
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = Buffer.from(digest).toString("base64url");
  assert.equal(to.searchParams.get("code_challenge"), challenge);
});

test("login is off without a client ID", async () => {
  assert.equal((await login(req("https://xhist.hwmnbn.me/auth/login"), {})).status, 503);
});

test("callback rejects a state this browser wasn't given (login CSRF)", async () => {
  let called = false;
  await withFetch(async () => { called = true; return new Response("{}"); }, async () => {
    const noCookie = await callback(req("https://xhist.hwmnbn.me/auth/callback?state=S&code=C"), ENV);
    assert.match(noCookie.headers.get("location"), /signin=expired/);
    const wrong = await callback(req("https://xhist.hwmnbn.me/auth/callback?state=S&code=C", { cookie: "__Host-xhist_oauth=T.verifier" }), ENV);
    assert.match(wrong.headers.get("location"), /signin=failed/);
  });
  assert.equal(called, false);
});

test("callback: no session without the account's identity", async () => {
  const kv = fakeKV();
  await withFetch(async url => String(url).includes("/oauth2/token")
    ? new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 7200 }))
    : new Response("{}", { status: 403 }), async () => {
    const res = await callback(req("https://xhist.hwmnbn.me/auth/callback?state=S&code=C", { cookie: "__Host-xhist_oauth=S.verifier" }), { ...ENV, XHIST_KV: kv });
    assert.match(res.headers.get("location"), /signin=failed/);
  });
  assert.equal(kv.m.size, 0);
});

test("callback: success stores tokens + user ID and sets the session cookie", async () => {
  const kv = fakeKV();
  let tokenBody;
  await withFetch(async (url, init) => {
    if (String(url).includes("/oauth2/token")) { tokenBody = Object.fromEntries(new URLSearchParams(init.body)); return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 7200 })); }
    return new Response(JSON.stringify({ data: { id: "42", username: "me" } }));
  }, async () => {
    const res = await callback(req("https://xhist.hwmnbn.me/auth/callback?state=S&code=C", { cookie: "__Host-xhist_oauth=S.verifier" }), { ...ENV, XHIST_KV: kv });
    assert.equal(res.headers.get("location"), "https://xhist.hwmnbn.me/");
    assert.match(res.headers.get("set-cookie"), /__Host-xhist_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure/);
  });
  assert.equal(tokenBody.code_verifier, "verifier");
  assert.equal(tokenBody.redirect_uri, "https://xhist.hwmnbn.me/auth/callback");
  const [[key, val]] = [...kv.m];
  assert.match(key, /^sess:/);
  assert.equal(JSON.parse(val).userId, "42");
});

test("refresh: a passing X failure keeps the session", async () => {
  const kv = fakeKV({ [`sess:${SID}`]: { accessToken: "old", refreshToken: "rt", expiresAt: 0, userId: "42" } });
  await withFetch(async () => new Response("busy", { status: 503 }), async () => {
    assert.equal(await getSession(req("https://x/", { cookie: `__Host-xhist_sid=${SID}` }), { ...ENV, XHIST_KV: kv }), null);
  });
  assert.ok(kv.m.has(`sess:${SID}`));
});

test("refresh: rotated token is stored", async () => {
  const kv = fakeKV({ [`sess:${SID}`]: { accessToken: "old", refreshToken: "rt", expiresAt: 0, userId: "42" } });
  await withFetch(async () => new Response(JSON.stringify({ access_token: "new", refresh_token: "rt2", expires_in: 7200 })), async () => {
    const s = await getSession(req("https://x/", { cookie: `__Host-xhist_sid=${SID}` }), { ...ENV, XHIST_KV: kv });
    assert.equal(s.accessToken, "new");
  });
  assert.equal(JSON.parse(kv.m.get(`sess:${SID}`)).refreshToken, "rt2");
});

test("refresh: losing a race to a parallel refresh uses the winner's tokens", async () => {
  const kv = fakeKV({ [`sess:${SID}`]: { accessToken: "old", refreshToken: "rt", expiresAt: 0, userId: "42" } });
  await withFetch(async () => {
    // The parallel request has already rotated the token by the time X answers us.
    kv.m.set(`sess:${SID}`, JSON.stringify({ accessToken: "won", refreshToken: "rt2", expiresAt: Date.now() + 3_600_000 }));
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  }, async () => {
    const s = await getSession(req("https://x/", { cookie: `__Host-xhist_sid=${SID}` }), { ...ENV, XHIST_KV: kv });
    assert.equal(s.accessToken, "won");
  });
});

test("refresh: a dead refresh token ends the session", async () => {
  const kv = fakeKV({ [`sess:${SID}`]: { accessToken: "old", refreshToken: "rt", expiresAt: 0 } });
  await withFetch(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }), async () => {
    assert.equal(await getSession(req("https://x/", { cookie: `__Host-xhist_sid=${SID}` }), { ...ENV, XHIST_KV: kv }), null);
  });
  assert.equal(kv.m.has(`sess:${SID}`), false);
});

test("cookie parsing and same-origin check", () => {
  assert.equal(cookieOf(req("https://x/", { cookie: "a=1; __Host-xhist_sid=abc; b=2" }), "__Host-xhist_sid"), "abc");
  assert.equal(cookieOf(req("https://x/", { cookie: "x__Host-xhist_sid=evil" }), "__Host-xhist_sid"), null);
  assert.equal(sameOrigin(req("https://xhist.hwmnbn.me/auth/logout", { "sec-fetch-site": "same-origin" })), true);
  assert.equal(sameOrigin(req("https://xhist.hwmnbn.me/auth/logout", { "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOrigin(req("https://xhist.hwmnbn.me/auth/logout", { origin: "https://evil.example" })), false);
});

test("allowlist: IDs match the account, usernames match the name", () => {
  assert.equal(allowedDetailed({ ALLOWED_X_USERS: "" }, { userId: "1", username: "anyone" }), true);
  assert.equal(allowedDetailed({ ALLOWED_X_USERS: "42" }, { userId: "42", username: "renamed" }), true);
  assert.equal(allowedDetailed({ ALLOWED_X_USERS: "42" }, { userId: "7", username: "42" }), false);
  assert.equal(allowedDetailed({ ALLOWED_X_USERS: "Me, you" }, { userId: "9", username: "me" }), true);
  assert.equal(allowedDetailed({ ALLOWED_X_USERS: "me" }, { userId: "9", username: "other" }), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";

const SID = "s".repeat(43);
const ID = "42";

function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

function env(extra = {}) {
  const kv = fakeKV();
  kv.m.set(`sess:${SID}`, JSON.stringify({ accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000, userId: ID, username: "me" }));
  return { XHIST_KV: kv, X_CLIENT_ID: "abc", API_GAP_MS: "0", DETAILED_DAILY_LIMIT: "1", ...extra };
}

// A minimal X: every account exists, has no posts, and memory.lol/Wayback know nothing.
async function xMock(input) {
  const u = new URL(String(input));
  const json = b => new Response(JSON.stringify(b));
  if (u.pathname.startsWith("/2/users/by/username/")) {
    const name = u.pathname.split("/").pop();
    if (name === "ghost") return json({ errors: [{ title: "Not Found Error", detail: "Could not find user." }] });
    return json({ data: { id: `9${name.length}`, username: name, name, created_at: "2024-01-01T00:00:00.000Z" } });
  }
  if (u.hostname === "web.archive.org") return new Response("");
  return json({ data: [], meta: {} });
}

async function lookup(e, u) {
  const real = globalThis.fetch;
  globalThis.fetch = xMock;
  try {
    const res = await worker.fetch(new Request(`https://xhist.hwmnbn.me/api/lookup?u=${u}&mode=detailed`, { headers: { cookie: `__Host-xhist_sid=${SID}` } }), e);
    return { status: res.status, body: await res.json() };
  } finally {
    globalThis.fetch = real;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

test("daily cap: slot is taken before the lookup and the next one is refused", async () => {
  const e = env();
  const first = await lookup(e, "alice");
  assert.equal(first.status, 200);
  assert.equal(e.XHIST_KV.m.get(`quota:${ID}:${today()}`), "1");
  const second = await lookup(e, "bobby");
  assert.equal(second.status, 429);
  assert.match(second.body.error, /today's 1 detailed lookups/);
});

test("daily cap: nothing billed (not found, or served from cache) gives the slot back", async () => {
  const e = env();
  assert.equal((await lookup(e, "ghost")).body.status, "not_found");
  assert.equal(e.XHIST_KV.m.get(`quota:${ID}:${today()}`), "0");
  e.XHIST_KV.m.set(`detail:95`, JSON.stringify({ mode: "detailed", status: "ok", userId: "95", handles: [] }));
  const cached = await lookup(e, "carol");
  assert.equal(cached.body.cached, true);
  assert.equal(e.XHIST_KV.m.get(`quota:${ID}:${today()}`), "0");
});

test("burst limiter is keyed on the X account and refuses before any X call", async () => {
  const keys = [];
  const e = env({ DETAILED_DAILY_LIMIT: "0", DETAILED_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } });
  const r = await lookup(e, "alice");
  assert.equal(r.status, 429);
  assert.match(r.body.error, /a couple a minute/);
  assert.deepEqual(keys, [ID]);
});

test("/api/me survives a KV failure", async () => {
  const e = env();
  e.XHIST_KV.get = async () => { throw new Error("kv down"); };
  const res = await worker.fetch(new Request("https://xhist.hwmnbn.me/api/me", { headers: { cookie: `__Host-xhist_sid=${SID}` } }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { authAvailable: true, signedIn: false, username: null, avatar: null });
});

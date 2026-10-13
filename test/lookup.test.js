import { test } from "node:test";
import assert from "node:assert/strict";
import { detailedLookup } from "../worker/lookup.js";

const ID = "1806000000000000001";
const CREATED = "2024-06-28T18:48:58.000Z";

function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k, v, opts) { m.set(k, v); m.set(`ttl:${k}`, String(opts?.expirationTtl)); },
    async delete(k) { m.delete(k); },
  };
}

const post = (id, at, handle, extra = {}) => ({
  id, author_id: ID, created_at: at, text: "pic https://t.co/x",
  entities: { urls: [{ expanded_url: `https://x.com/${handle}/status/${id}/photo/1` }] },
  public_metrics: { reply_count: 2 }, ...extra,
});
const page = (data, next) => ({ data, includes: { users: [{ id: ID, username: "newname" }] }, meta: next ? { next_token: next } : {} });

function xapi({ timelineFailsOnPage2 = false } = {}) {
  const calls = [];
  const impl = async input => {
    const u = new URL(String(input));
    calls.push(u);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.hostname === "api.memory.lol") return json({ accounts: [] });
    if (u.hostname === "web.archive.org") return new Response("");
    if (u.pathname === "/2/users/by/username/newname") {
      return json({ data: { id: ID, username: "newname", name: "N", created_at: CREATED, protected: false, public_metrics: { tweet_count: 9 } } });
    }
    if (u.pathname === `/2/users/${ID}/tweets`) {
      if (!u.searchParams.get("pagination_token")) return json(page([post("900", "2026-09-01T00:00:00.000Z", "newname")], "p2"));
      if (timelineFailsOnPage2) return json({ title: "Too Many Requests" }, 429);
      return json(page([post("800", "2026-08-25T00:00:00.000Z", "newname")]));
    }
    if (u.pathname === "/2/tweets/search/all") {
      const q = u.searchParams.get("query");
      if (q === `from:${ID}`) {
        // Newest-first: the window's oldest post is only on page 2.
        if (!u.searchParams.get("next_token")) return json(page([post("120", "2024-07-20T00:00:00.000Z", "oldname")], "n2"));
        return json(page([post("100", "2024-07-01T00:00:00.000Z", "oldname")]));
      }
      if (q.startsWith("conversation_id:")) {
        const conv = q.split(" ")[0].split(":")[1];
        return json({
          data: [{ id: `r${conv}`, author_id: "500", created_at: "2024-07-21T00:00:00.000Z", text: "@oldname nice", in_reply_to_user_id: ID,
            entities: { mentions: [{ start: 0, end: 8, username: "newname", id: ID }] } }],
          includes: { users: [{ id: "500", username: "fan" }] },
        });
      }
    }
    return json({ errors: [{ title: "unexpected" }] }, 404);
  };
  return { calls, impl };
}

async function run(env, opts) {
  const { calls, impl } = xapi(opts);
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const kv = fakeKV();
    const r = await detailedLookup("newname", { accessToken: "t" }, { XHIST_KV: kv, API_GAP_MS: "0", ...env });
    return { r, calls, kv };
  } finally {
    globalThis.fetch = real;
  }
}

test("archive search pages to the window's oldest post", async () => {
  const { r, calls } = await run({});
  const archive = calls.filter(u => u.pathname === "/2/tweets/search/all" && u.searchParams.get("query") === `from:${ID}`);
  assert.equal(archive.length, 2);
  assert.equal(archive[1].searchParams.get("next_token"), "n2");
  assert.equal(r.stats.oldestPost, "2024-07-01T00:00:00.000Z");
  assert.equal(r.handles.find(h => h.handle === "oldname").firstSeen, "2024-07-01T00:00:00.000Z");
});

test("reply searches start at the post, not X's 30-day default", async () => {
  const { calls } = await run({});
  const replies = calls.filter(u => u.searchParams.get("query")?.startsWith("conversation_id:"));
  assert.ok(replies.length > 0);
  for (const u of replies) assert.ok(u.searchParams.get("start_time"), `no start_time on ${u.searchParams.get("query")}`);
  const r100 = replies.find(u => u.searchParams.get("query").startsWith("conversation_id:100 "));
  assert.equal(r100.searchParams.get("start_time"), "2024-07-01T00:00:00.000Z");
});

test("reply prefixes and media URLs both count for the old handle", async () => {
  const { r } = await run({});
  const old = r.handles.find(h => h.handle === "oldname");
  assert.deepEqual(old.sources, ["media_url", "reply_prefix"]);
  assert.equal(old.confidence, "high");
});

test("a failed later timeline page keeps earlier pages and caches briefly", async () => {
  const { r, kv } = await run({}, { timelineFailsOnPage2: true });
  assert.ok(r.handles.some(h => h.current && h.observations > 0), "page 1 post kept");
  assert.ok(r.notes.some(n => /rate limit hit while reading posts/.test(n)));
  assert.equal(kv.m.get(`ttl:detail:${ID}`), "1800");
});

test("a complete result is cached for 12 hours", async () => {
  const { kv } = await run({});
  assert.equal(kv.m.get(`ttl:detail:${ID}`), String(12 * 3600));
});

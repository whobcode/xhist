import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, buildIntervals, monthRange, pickReplyTargets, REREGISTER_WARNING } from "../src/timeline.js";
import { memoryLolObservations } from "../src/sources/memorylol.js";

const NOW = "2026-10-12T12:00:00.000Z";
const o = (handle, at, source, tweetId = at) => ({ handle, at, source, tweetId });

const base = [
  o("oldname", "2024-07-15T12:00:00.000Z", "media_url"),
  o("OldName", "2024-08-01T09:30:00.000Z", "media_url"),
  o("oldname", "2024-07-16T08:00:00.000Z", "reply_prefix"),
  o("newname", "2026-08-20T08:00:00.000Z", "media_url"),
];

test("intervals group case-insensitively and keep the common casing", () => {
  const iv = buildIntervals(base, { currentHandle: "newname", now: NOW });
  assert.equal(iv.length, 2);
  assert.equal(iv[0].handle, "oldname");
  assert.equal(iv[0].firstSeen, "2024-07-15T12:00:00.000Z");
  assert.equal(iv[0].lastSeen, "2024-08-01T09:30:00.000Z");
  assert.equal(iv[0].count, 3);
  assert.equal(iv[1].current, true);
  assert.equal(iv[1].lastSeen, NOW);
});

test("change window, high confidence, and unrecovered from About count", () => {
  const t = buildTimeline({
    observations: base, currentHandle: "newname", createdAt: "2024-06-28T18:48:58.000Z",
    about: { changeCount: 2, lastChangeMonth: "August 2026" },
    oldestPostAt: "2024-07-15T12:00:00.000Z", now: NOW,
  });
  assert.deepEqual(t.changes, [{ from: "oldname", to: "newname", window: ["2024-08-01", "2026-08-20"] }]);
  assert.equal(t.unrecovered, 1);
  assert.deepEqual(t.notes, ["Original handle predates earliest surviving post (2024-07-15)."]);
  assert.equal(t.lastChange.overlaps, true);
  assert.equal(t.handles[0].confidence, "high");
  assert.deepEqual(t.handles[0].sources, ["media_url", "reply_prefix"]);
  assert.equal(t.handles[0].warning, REREGISTER_WARNING);
  assert.deepEqual(t.handles[1], {
    handle: "newname", firstSeen: "2026-08-20T08:00:00.000Z", lastSeen: "now",
    observations: 1, sources: ["media_url"], current: true,
  });
});

test("last change window that misses X's month is flagged", () => {
  const t = buildTimeline({
    observations: [o("a", "2024-07-15T00:00:00.000Z", "media_url"), o("b", "2025-01-10T00:00:00.000Z", "media_url")],
    currentHandle: "b", createdAt: "2024-07-01T00:00:00.000Z",
    about: { changeCount: 1, lastChangeMonth: "August 2026" }, oldestPostAt: "2024-07-15T00:00:00.000Z", now: NOW,
  });
  assert.equal(t.unrecovered, 0);
  assert.equal(t.lastChange.overlaps, false);
  assert.match(t.notes[0], /does not overlap/);
});

test("current handle with no observations closes the window at now", () => {
  const t = buildTimeline({
    observations: [o("a", "2026-07-30T00:00:00.000Z", "media_url")],
    currentHandle: "b", createdAt: null, about: null, oldestPostAt: null, now: NOW,
  });
  assert.deepEqual(t.changes[0].window, ["2026-07-30", "2026-10-12"]);
  assert.equal(t.handles[0].confidence, "low");
  assert.equal(t.unrecovered, 0);
});

test("confidence: medium from repeated single-source or memory.lol alone", () => {
  const t = buildTimeline({
    observations: [
      o("a", "2024-01-01T00:00:00.000Z", "media_url"), o("a", "2024-02-01T00:00:00.000Z", "media_url"),
      ...memoryLolObservations({ c: ["2023-05-01"] }),
    ],
    currentHandle: "b", createdAt: null, about: { changeCount: 2 }, oldestPostAt: null, now: NOW,
  });
  assert.deepEqual(t.handles.map(h => [h.handle, h.confidence]), [["c", "medium"], ["a", "medium"], ["b", undefined]]);
  assert.deepEqual(t.changes.map(c => c.window), [["2023-05-01", "2024-01-01"], ["2024-02-01", "2026-10-12"]]);
});

test("re-used current handle shows up as an overlapping window", () => {
  const t = buildTimeline({
    observations: [
      o("a", "2020-01-01T00:00:00.000Z", "media_url"), o("b", "2021-01-01T00:00:00.000Z", "media_url"),
      o("a", "2023-01-01T00:00:00.000Z", "media_url"),
    ],
    currentHandle: "a", createdAt: null, about: null, oldestPostAt: null, now: NOW,
  });
  assert.equal(t.changes.length, 1);
  assert.equal(t.changes[0].overlap, true);
  assert.match(t.notes[0], /re-use/);
});

test("month range", () => {
  assert.deepEqual(monthRange("August 2026"), [Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1) - 1]);
  assert.equal(monthRange("garbage"), null);
});

test("reply targets: oldest posts plus both sides of each change, skipping zero-reply posts", () => {
  const post = (id, day, replyCount = 1) => ({ id, createdAt: `${day}T00:00:00.000Z`, replyCount });
  const own = [
    post("1", "2024-01-01"), post("2", "2024-02-01", 0), post("3", "2024-03-01"),
    post("4", "2024-06-01"), post("5", "2024-07-01"), post("6", "2024-08-01"), post("7", "2024-09-01"),
  ];
  const ids = pickReplyTargets(own, [{ window: ["2024-06-01", "2024-08-01"] }], 2);
  assert.deepEqual(ids.sort(), ["1", "3", "4", "6"]);
});

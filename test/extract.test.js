import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  collectTweets, normalizeTweet, tweetsFromCaptures, observationsFromTweets,
  replyPrefixObservations, mediaUrlObservations, parseUser, parseCreatedAt, handleFromStatusUrl,
} from "../src/extract.js";
import { parseAboutGraphql, parseAboutText } from "../src/x/about.js";
import { opName } from "../src/browser.js";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const TARGET = "1806000000000000001";
const search = [{ op: "SearchTimeline", json: fixture("search-timeline.json") }];
const detail = [{ op: "TweetDetail", json: fixture("tweet-detail.json") }];

test("created_at parses to UTC ISO", () => {
  assert.equal(parseCreatedAt("Mon Jul 15 12:00:00 +0000 2024"), "2024-07-15T12:00:00.000Z");
  assert.equal(parseCreatedAt("Mon Jul 15 12:00:00 +0200 2024"), "2024-07-15T10:00:00.000Z");
  assert.equal(parseCreatedAt(undefined), null);
});

test("GraphQL op name comes from the URL path", () => {
  assert.equal(opName("https://x.com/i/api/graphql/AbC123/SearchTimeline?variables=%7B%7D"), "SearchTimeline");
  assert.equal(opName("https://x.com/home"), null);
});

test("walker finds plain, wrapped, and nested (quoted) tweets once each", () => {
  const map = collectTweets(search[0].json);
  assert.deepEqual([...map.keys()].sort(), [
    "1810000000000000001", "1810000000000000002", "1810000000000000003",
    "1810000000000000004", "1810000000000000005", "999",
  ]);
  collectTweets(search[0].json, map);
  assert.equal(map.size, 6);
});

test("media expanded_url handle wins over the author's current screen_name", () => {
  const t = tweetsFromCaptures(search).find(t => t.id === "1810000000000000001");
  assert.equal(t.authorHandle, "newname");
  assert.deepEqual(mediaUrlObservations(t, TARGET), [
    { handle: "oldname", at: "2024-07-15T12:00:00.000Z", source: "media_url", tweetId: "1810000000000000001" },
  ]);
});

test("media observations: own posts only, own status id only, no /i/status/", () => {
  const obs = observationsFromTweets(tweetsFromCaptures(search), TARGET);
  assert.deepEqual(obs.map(o => [o.tweetId, o.handle]), [
    ["1810000000000000001", "oldname"],
    ["1810000000000000002", "OldName"],
    ["1810000000000000003", "newname"],
  ]);
  assert.equal(handleFromStatusUrl("https://x.com/i/status/5/photo/1", "5"), null);
  assert.equal(handleFromStatusUrl("https://x.com/abc/status/55/photo/1", "5"), null);
});

test("reply prefix gives the handle as typed, ignoring in_reply_to_screen_name", () => {
  const t = normalizeTweet({
    __typename: "Tweet", rest_id: "1",
    legacy: {
      user_id_str: "500", created_at: "Tue Jul 16 08:00:00 +0000 2024",
      full_text: "@oldname hi", display_text_range: [9, 11],
      in_reply_to_user_id_str: TARGET, in_reply_to_screen_name: "newname",
      entities: { user_mentions: [] },
    },
  });
  assert.deepEqual(replyPrefixObservations(t, TARGET), [
    { handle: "oldname", at: "2024-07-16T08:00:00.000Z", source: "reply_prefix", tweetId: "1" },
  ]);
});

test("thread: entity match, replier-skipping fallback, and body mention after &amp;", () => {
  const obs = observationsFromTweets(tweetsFromCaptures(detail), TARGET);
  assert.deepEqual(obs.map(o => [o.source, o.handle, o.tweetId]), [
    ["media_url", "oldname", "1810000000000000001"],
    ["reply_prefix", "oldname", "1810000000000000101"],
    ["reply_prefix", "oldname", "1810000000000000102"],
    ["mention", "OldName", "1810000000000000103"],
  ]);
});

test("UserByScreenName → account summary; unavailable → status", () => {
  assert.deepEqual(parseUser(fixture("user-by-screen-name.json")), {
    status: "ok", restId: TARGET, screenName: "newname", name: "Example",
    createdAt: "2024-06-28T18:48:58.000Z", tweets: 120, protected: false,
  });
  assert.equal(parseUser(fixture("user-suspended.json")).status, "suspended");
  assert.equal(parseUser({}).status, "not_found");
});

test("About panel: GraphQL fields and text fallback", () => {
  assert.deepEqual(parseAboutGraphql([{ json: fixture("about-account.json") }]), {
    changeCount: 2, lastChangedAt: 1786000000000, accountBasedIn: "Somewhere",
  });
  assert.equal(parseAboutGraphql([{ json: {} }]), null);
  const text = "About this account\nDate joined\nJune 2024\nAccount based in\nSomewhere\n2 username changes\nLast on August 2026";
  assert.deepEqual(parseAboutText(text), {
    changeCount: 2, lastChangeMonth: "August 2026", dateJoined: "June 2024", accountBasedIn: "Somewhere",
  });
  assert.equal(parseAboutText("Sign in to X"), null);
});

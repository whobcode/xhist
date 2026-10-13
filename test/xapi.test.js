import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeV2Page, leadingMentionsLength } from "../src/xapi.js";
import { observationsFromTweets } from "../src/extract.js";

const TARGET = "1806000000000000001";

// Shapes follow X API v2: media links live in entities.urls, mentions carry start/end.
const page = {
  data: [
    {
      id: "1810000000000000001", author_id: TARGET, created_at: "2024-07-15T12:00:00.000Z",
      text: "first light https://t.co/a",
      entities: { urls: [{ url: "https://t.co/a", expanded_url: "https://x.com/oldname/status/1810000000000000001/photo/1", media_key: "3_1" }] },
      public_metrics: { reply_count: 3 },
    },
    {
      id: "1810000000000000101", author_id: "500", created_at: "2024-07-16T08:00:00.000Z",
      text: "@replier @oldname hi &amp; bye", in_reply_to_user_id: TARGET,
      entities: { mentions: [{ start: 9, end: 17, username: "newname", id: TARGET }] },
    },
    {
      id: "1810000000000000102", author_id: "501", created_at: "2024-07-17T08:00:00.000Z",
      text: "@replier2 @oldname yes", in_reply_to_user_id: TARGET,
    },
  ],
  includes: { users: [{ id: TARGET, username: "newname" }, { id: "500", username: "replier" }, { id: "501", username: "replier2" }] },
};

test("leading mention run length", () => {
  assert.equal(leadingMentionsLength("@a @b hello"), 6);
  assert.equal(leadingMentionsLength("hello @a"), 0);
});

test("v2 tweets produce the same observations as GraphQL ones", () => {
  const tweets = normalizeV2Page(page);
  assert.equal(tweets[1].authorHandle, "replier");
  assert.deepEqual(tweets[1].range, [18, 26]); // measured on the unescaped text
  assert.deepEqual(observationsFromTweets(tweets, TARGET).map(o => [o.source, o.handle, o.tweetId]), [
    ["media_url", "oldname", "1810000000000000001"],
    ["reply_prefix", "oldname", "1810000000000000101"],
    ["reply_prefix", "oldname", "1810000000000000102"],
  ]);
});

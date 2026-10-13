/**
 * X API v2 → the normalized tweet shape `extract.js` works on, so the same
 * observation rules apply to scraped GraphQL and to the official API.
 * Pure: no fetches here.
 */

function unescapeText(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Length in code points of the leading "@a @b " run, the hidden reply prefix. */
export function leadingMentionsLength(text) {
  const m = /^(?:[@＠][A-Za-z0-9_]{1,15}\s+)+/.exec(text);
  return m ? Array.from(m[0]).length : 0;
}

/** `usersById`: Map of id → username, from `includes.users`. */
export function normalizeV2Tweet(t, usersById = new Map()) {
  const text = unescapeText(t.text ?? "");
  const urls = (t.entities?.urls ?? []).map(u => u.expanded_url).filter(Boolean);
  let range = Array.isArray(t.display_text_range) ? t.display_text_range : null;
  if (!range && t.in_reply_to_user_id) range = [leadingMentionsLength(text), Array.from(text).length];
  return {
    id: t.id,
    userId: t.author_id ?? null,
    authorHandle: usersById.get(t.author_id) ?? null,
    createdAt: t.created_at ? new Date(t.created_at).toISOString() : null,
    text,
    range,
    inReplyToUserId: t.in_reply_to_user_id ?? null,
    replyCount: t.public_metrics?.reply_count ?? null,
    // v2 has no media expanded_url; the media link sits in entities.urls.
    mediaUrls: [],
    urls,
    mentions: (t.entities?.mentions ?? []).map(m => ({
      id: m.id ?? null, screenName: m.username ?? null, indices: [m.start, m.end],
    })),
  };
}

/** A v2 list response (`data` + `includes.users`) → normalized tweets. */
export function normalizeV2Page(page) {
  const users = new Map((page?.includes?.users ?? []).map(u => [u.id, u.username]));
  return (page?.data ?? []).map(t => normalizeV2Tweet(t, users));
}

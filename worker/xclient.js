/**
 * Read-only X API v2 calls with the signed-in user's token. What works
 * depends on the X developer app's access level: full-archive search is not
 * on every plan, so callers treat 401/403 as "not available" rather than a
 * failure.
 */

const API = "https://api.x.com/2";
const TWEET_FIELDS = "created_at,entities,in_reply_to_user_id,conversation_id,author_id,public_metrics,display_text_range";

export class XApiError extends Error {
  constructor(status, body) {
    super(`X API ${status}`);
    this.status = status;
    this.body = body;
  }
  get unavailable() { return this.status === 401 || this.status === 403; }
  get rateLimited() { return this.status === 429; }
}

export function xclient(token) {
  async function get(path, params = {}) {
    const u = new URL(API + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new XApiError(res.status, body);
    return body;
  }

  return {
    userByUsername: username => get(`/users/by/username/${encodeURIComponent(username)}`, {
      "user.fields": "created_at,protected,public_metrics,profile_image_url,name",
    }),

    /**
     * Up to `maxPages` × 100 of the user's most recent posts (X caps at 3,200).
     * A failure part-way keeps the pages already fetched (and paid for).
     */
    async timeline(userId, maxPages) {
      const pages = [];
      let token;
      for (let i = 0; i < maxPages; i++) {
        try {
          const p = await get(`/users/${userId}/tweets`, {
            max_results: 100, pagination_token: token, exclude: "retweets",
            "tweet.fields": TWEET_FIELDS, expansions: "author_id", "user.fields": "username",
          });
          pages.push(p);
          token = p?.meta?.next_token;
          if (!token) break;
        } catch (e) {
          if (!(e instanceof XApiError)) throw e;
          return { pages, error: e };
        }
      }
      return { pages, error: null };
    },

    /** Full-archive search, one page. Pass `next_token` from a previous page to continue. */
    searchAll: (query, extra = {}) => get("/tweets/search/all", {
      query, max_results: 100, "tweet.fields": TWEET_FIELDS, expansions: "author_id", "user.fields": "username", ...extra,
    }),
  };
}

# xhist

Recover an X (Twitter) account's **previous handles**, with evidence and approximate dates.

Two ways to use it:

- **CLI** (`src/`). It drives your own logged-in browser profile with Playwright and reads the GraphQL responses x.com already makes. This is the most thorough path: it reads the "About this account" change count and walks search back to the oldest post.
- **Web** at **https://xhist.hwmnbn.me** (`worker/` + `public/`). Type a username:
  - **Basic** needs no sign-in. It uses memory.lol and the Wayback Machine.
  - **Detailed**: visitors sign in with their own X account (X's official OAuth consent screen, read-only scopes). The lookup reads posts and replies through the X API using that visitor's token.
  - You can also open a `.json` report from the CLI on the page.

> **Terms of service:** automated access to X may violate X's Terms of Service. The CLI is for personal, low-volume use.
> It is read-only: it never posts, likes, follows or DMs, and never types or stores your password.

## How it works

An account's user ID never changes, but some places freeze its handle as it was at the time:

| Evidence | Where | Frozen at |
|---|---|---|
| `media_url` | `expanded_url` on the account's own photos and videos: `x.com/<HANDLE>/status/<id>/photo/1` | post time |
| `reply_prefix` | the leading `@handle` in other people's replies (`in_reply_to_screen_name` is ignored because it shows the *current* handle) | reply time |
| `mention` | `@handle` typed in other people's posts, matched to the account by ID | post time |
| `memory_lol` | memory.lol's archive of screen names by ID | first/last seen |

Observations are grouped into per-handle intervals. The gap between adjacent intervals is the change window. Results are then checked against X's About panel: N username changes means N + 1 handles. Any shortfall is reported as `unrecovered`.

**Confidence:** **high** means two or more independent sources. **medium** means repeated sightings from one source, or memory.lol alone. **low** means a single sighting.

Old handles can be re-registered by anyone, so whoever holds one now may be unrelated.

## CLI

```bash
npm install
npx playwright install chromium
npx xhist login            # log in once in a visible window; the session stays in ./.xhist-profile
npx xhist somehandle       # writes xhist-out/<user_id>.json and .md
```

```
xhist <handle> [--json] [--out dir] [--max-pages N] [--replies N] [--headed]
               [--no-wayback] [--fresh] [--debug]
```

- Page loads are spaced at least 1.5 s apart with jitter. On HTTP 429 the CLI waits until X's reset time.
- Raw GraphQL responses are cached in `./.xhist-cache/<user_id>/`, so re-runs are cheap. Use `--fresh` to reload.
- `--debug` logs each page's GraphQL operation names. Use it if X renames an operation and a step comes back empty.
- If headless Chromium is blocked or logged out, use `--headed`.

## Web (Cloudflare Worker)

```bash
npm run dev       # http://localhost:8787 — basic lookups work with no setup
npm run deploy
```

One-time setup for deploys:

1. `npx wrangler kv namespace create XHIST_KV`, then put the id in `wrangler.jsonc`. (Already done for xhist.hwmnbn.me.)
2. To turn on **Sign in with X** for Detailed lookups, register an app at developer.x.com. No secrets are needed.
   - User authentication settings: OAuth 2.0, type of app **Native App** (a public PKCE client)
   - App permissions: **Read**
   - Callback URI: `https://xhist.hwmnbn.me/auth/callback`; Website URL: `https://xhist.hwmnbn.me`
   - Copy the **OAuth 2.0 Client ID** into `X_CLIENT_ID` under `vars` in `wrangler.jsonc`, then run `npm run deploy`.

   The client ID isn't a secret, since it appears in every sign-in URL. Each visitor signs in with their own X account on X's consent screen, and their lookups run on their own token. xhist never sees a password. (If you register a confidential "Web App" instead, also run `npx wrangler secret put X_CLIENT_SECRET`.)
3. **Cost:** X bills every API read to the developer app, whoever signed in. A visitor's own token doesn't move the charge to them. To keep that bounded:
   - `DETAILED_DAILY_LIMIT` (default 25) caps fresh detailed lookups per X account per day. Cached results are free. Set it to `"0"` for no cap.
   - `ALLOWED_X_USERS` (optional) limits detailed lookups to listed accounts. Use numeric account IDs where you can: usernames can be renamed or re-registered by someone else.
   - Set a spending limit in the X developer console as well.

What Detailed can reach depends on the app's X API access level. It always reads the most recent 3,200 posts. It also reads the oldest posts and their reply threads, but only if the plan includes full-archive search; without it, the page says so.

## Tests

```bash
npm test
```

The tests use hand-built GraphQL and API v2 payloads in `test/fixtures/` with made-up users only.

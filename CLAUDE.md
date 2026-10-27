# xhist — working notes

Recovers an X account's previous handles. The CLI (`src/cli.js`, Playwright)
and the Worker (`worker/`, xhist.hwmnbn.me) share the pure core in `src/`.

## Layer rule

- `src/extract.js`, `src/timeline.js`, `src/xapi.js` are **pure**: no fetch, no
  fs, no browser. Everything that decides *which handle a piece of evidence
  shows* lives here and is covered by `node:test` against fixtures.
- `src/sources/*` fetch, but take caching as an injected `cache(key, fn)` so the
  same code runs in Node (disk) and in the Worker (KV). Don't import `node:*`
  there.
- `src/browser.js` is the only module that imports Playwright. `worker/` must
  never import it, or anything that does (`src/x/*`, `src/cli.js`). The CI dry-run
  deploy catches this.

## Things that are the way they are on purpose

- **The user ID is the key, never the handle.** Caches, memory.lol matches,
  and `from:` in API search all use `rest_id`.
- **`in_reply_to_screen_name` is ignored.** It shows the current handle. The
  reply's leading text shows the handle as typed.
- **Mention text is sliced, not read from `screen_name`.** The entity's
  `screen_name` is resolved now; the text slice is what was typed then.
- **Indices count code points of the *unescaped* text.** `full_text` arrives
  with `&amp;`; unescape first, slice with `Array.from`.
- **`x.com/i/status/<id>` is not a handle.** `RESERVED` in extract.js.
- **No GraphQL query IDs in code.** X rotates them. We load real pages and
  match operation names by prefix.
- **Search progress is judged against search alone.** Page one of `from:` search
  is mostly posts the profile tabs already found; counting those as "nothing new"
  stopped pagination after one page.
- **The current handle is always the last interval** and its lastSeen is now.
  An overlap into it is reported as possible re-use, not silently reordered.
- **Basic web lookups never claim a handle is current.** memory.lol can only
  say "latest known", and the UI labels it that way.
- **OAuth tokens never reach the browser.** KV session behind an HttpOnly
  `__Host-` cookie; the page only sees `/api/me`.
- **Sign-in needs only X_CLIENT_ID** (public PKCE client, "Native App"). The
  OAuth state + verifier live in a short-lived `__Host-` cookie, which binds the
  flow to the browser that started it and keeps `/auth/login` free of KV writes.
- **A failed refresh never deletes or rewrites the session.** X rotates
  refresh tokens, so parallel refreshes race, and KV is last-write-wins with
  delayed visibility: any write from the loser can erase the winner's new
  tokens. The loser re-reads briefly for the winner's result, else returns
  null. A dead session just reads as signed out until re-sign-in or TTL.
- **Archive and reply searches set start_time.** X's search defaults to the
  last 30 days.
- **The archive walk narrows dense windows instead of accepting them.** Search
  is newest-first, so a window cut off by the page budget is missing exactly
  the oldest posts. Empty windows move `lo` forward and widen; dense ones
  shrink from the same `lo`; only a window read to its end counts.
- **Partial detailed results are cached for 30 minutes, complete ones 12 hours.**
  A passing 429 shouldn't pin a thin history for everyone.
- **X bills the app, not the visitor.** DETAILED_DAILY_LIMIT caps fresh
  detailed lookups per X account per day; the slot is reserved before the
  lookup (which takes tens of seconds) and refunded if nothing was billed.
  DETAILED_LIMITER covers the bursts a non-atomic KV counter can't.

## Non-goals

No cross-platform identity linking, no real-name or location inference, no
bulk mode, no bypassing protected accounts or login walls.

## Deploying

Every `npm run deploy` / `wrangler deploy` is paired with a commit of exactly
the code that went live, then a push to origin — no deployed change stays
uncommitted, however small. Run `npm test` first and put the deployed version
ID in the commit message.

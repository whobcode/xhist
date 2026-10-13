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
  cookie; the page only sees `/api/me`.

## Non-goals

No cross-platform identity linking, no real-name or location inference, no
bulk mode, no bypassing protected accounts or login walls.

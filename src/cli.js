#!/usr/bin/env node
/**
 * xhist <handle> — recover an X account's previous handles.
 * Read-only: it loads pages in your own logged-in profile and reads what
 * they return. It never posts, likes, follows, or DMs.
 */
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openSession } from "./browser.js";
import { resolve } from "./x/resolve.js";
import { readAbout } from "./x/about.js";
import { harvestOwnPosts, harvestReplies, pickReplyTargets } from "./x/harvest.js";
import { observationsFromTweets, HANDLE_RE } from "./extract.js";
import { cached } from "./cache.js";
import { memoryLolById, memoryLolByHandle, memoryLolObservations } from "./sources/memorylol.js";
import { waybackTimestamps } from "./sources/wayback.js";
import { buildTimeline } from "./timeline.js";
import { renderMarkdown } from "./report.js";

const USAGE = `Usage:
  xhist <handle> [--json] [--out dir] [--max-pages N] [--replies N] [--headed]
                 [--no-wayback] [--fresh] [--debug]
  xhist login      open a browser window and log in to X once

Options:
  --json         print the result JSON to stdout
  --out dir      where to write <user_id>.json and .md (default ./xhist-out)
  --max-pages N  search result pages to walk back through (default 50)
  --replies N    threads to open per selection (oldest posts, each change) (default 15)
  --headed       show the browser; if logged out, wait for you to log in
  --no-wayback   skip Wayback Machine CDX lookups
  --fresh        ignore ./.xhist-cache and reload everything
  --debug        log the GraphQL operations each page made`;

const PROFILE_DIR = path.resolve(".xhist-profile");
const CACHE_ROOT = path.resolve(".xhist-cache");

const log = msg => process.stderr.write(`${msg}\n`);

async function main() {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      out: { type: "string", default: "xhist-out" },
      "max-pages": { type: "string", default: "50" },
      replies: { type: "string", default: "15" },
      headed: { type: "boolean", default: false },
      "no-wayback": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (o.help || positionals.length !== 1) { log(USAGE); return o.help ? 0 : 1; }

  if (positionals[0] === "login") {
    const s = await openSession({ profileDir: PROFILE_DIR, headed: true, log });
    try {
      const ok = await s.waitForLogin();
      log(ok ? `Logged in. Session saved in ${PROFILE_DIR}` : "Not logged in.");
      return ok ? 0 : 1;
    } finally { await s.close(); }
  }

  const input = positionals[0].replace(/^@/, "");
  if (!HANDLE_RE.test(input)) { log(`Not a valid handle: ${positionals[0]}`); return 1; }
  const maxPages = Math.max(1, Number(o["max-pages"]) || 50);
  const replies = Math.max(0, Number(o.replies) || 0);
  const now = new Date().toISOString();

  const session = await openSession({ profileDir: PROFILE_DIR, headed: o.headed, fresh: o.fresh, debug: o.debug, log });
  try {
    if (!(await session.loggedIn())) {
      if (o.headed) {
        if (!(await session.waitForLogin())) { log("Login did not complete."); return 1; }
      } else {
        log("warning: not logged in; search and the About panel need a session. Run `xhist login` once.");
      }
    }

    // 1. Resolve
    log(`[1/7] resolving @${input}`);
    const user = await resolve(session, input);
    if (user.status !== "ok") {
      const msg = {
        protected: "Account is protected; its posts are not visible.",
        suspended: "Account is suspended.",
        unavailable: `Account is unavailable${user.reason ? ` (${user.reason})` : ""}.`,
        not_found: "No such account.",
        login_required: "X requires login to view this profile. Run `xhist login` once.",
        no_data: "X returned no profile data. Run `xhist login` once, or retry with --headed.",
      }[user.status] ?? user.status;
      log(msg);
      if (o.json) process.stdout.write(JSON.stringify({ input, status: user.status, userId: user.restId ?? null }, null, 2) + "\n");
      return 2;
    }
    const { restId } = user;
    const handle = user.screenName ?? input;
    const cacheDir = path.join(CACHE_ROOT, restId);
    session.setCacheDir(cacheDir);
    const srcOpts = { cache: (key, fn) => cached(path.join(cacheDir, "sources"), key, o.fresh, fn), log };
    log(`      user ID ${restId}, @${handle}, created ${user.createdAt?.slice(0, 10) ?? "?"}, ${user.tweets ?? "?"} posts`);

    // 2. About panel
    log("[2/7] reading About panel");
    const { about, loginRequired, ops } = await readAbout(session, handle);
    if (loginRequired) log("      About needs login; run `xhist --headed` once to log in.");
    else if (!about) log(`      could not read the About panel${ops?.length ? ` (ops seen: ${ops.join(", ")})` : ""}`);
    else log(`      ${about.changeCount ?? "?"} username change(s), last on ${about.lastChangeMonth ?? "?"}`);

    // 3. memory.lol by ID
    log("[3/7] memory.lol");
    const byId = await memoryLolById(restId, srcOpts);
    log(`      ${byId ? Object.keys(byId).length : "?"} screen name(s) on record`);

    // 4. Own posts
    log("[4/7] harvesting own posts");
    const own = await harvestOwnPosts(session, handle, restId, { maxPages, log });
    let observations = observationsFromTweets(own.tweets, restId);
    log(`      ${own.own.length} own posts, oldest ${own.oldestPostAt?.slice(0, 10) ?? "?"}, ${observations.length} observations`);

    // 5. Reply threads: oldest posts and posts around each suspected change
    log("[5/7] harvesting replies");
    const prelim = buildTimeline({
      observations: [...observations, ...memoryLolObservations(byId)],
      currentHandle: handle, createdAt: user.createdAt, about, oldestPostAt: own.oldestPostAt, now,
    });
    const targets = replies && !own.loginWall ? pickReplyTargets(own.own, prelim.changes, replies) : [];
    const thread = targets.length ? await harvestReplies(session, targets, { log }) : { tweets: [], loginWall: false };
    observations = observationsFromTweets([...own.tweets, ...thread.tweets], restId);
    log(`      ${targets.length} threads, ${observations.length} observations total`);

    // 3b. memory.lol for every discovered handle, kept only when the ID matches
    const candidates = [...new Map(
      [...observations.map(x => x.handle), ...Object.keys(byId ?? {})].map(h => [h.toLowerCase(), h]),
    ).values()];
    const byHandle = {};
    for (const h of candidates) {
      const r = await memoryLolByHandle(h, restId, srcOpts);
      if (r && Object.keys(r).length) byHandle[h] = r;
    }

    // 6. Wayback
    const oldHandles = candidates.filter(h => h.toLowerCase() !== handle.toLowerCase());
    const wayback = {};
    if (!o["no-wayback"]) {
      log(`[6/7] Wayback CDX for ${oldHandles.length} old handle(s)`);
      for (const h of oldHandles) wayback[h] = await waybackTimestamps(h, srcOpts);
    } else log("[6/7] Wayback skipped");

    // 7. Timeline
    log("[7/7] building timeline");
    const t = buildTimeline({
      observations: [...observations, ...memoryLolObservations(byId, ...Object.values(byHandle))],
      currentHandle: handle, createdAt: user.createdAt, about, oldestPostAt: own.oldestPostAt, now,
    });
    const notes = [...t.notes];
    if (loginRequired || own.loginWall || thread.loginWall) notes.push("Some pages needed login and were skipped. Run `xhist login` once, then re-run.");
    if (!byId) notes.push("memory.lol could not be reached.");
    if (user.partial) notes.push("Account resolved from page HTML only; creation date and post count are unknown.");

    const result = {
      input,
      userId: restId,
      currentHandle: handle,
      createdAt: user.createdAt,
      generatedAt: now,
      about,
      handles: t.handles,
      changes: t.changes,
      unrecovered: t.unrecovered,
      lastChange: t.lastChange,
      memoryLol: { byId: byId ?? {}, byHandle },
      wayback,
      stats: {
        ownPosts: own.own.length,
        oldestPost: own.oldestPostAt,
        searchPages: own.searchPages,
        threadsOpened: targets.length,
        observations: observations.length,
        pageLoads: session.loads,
      },
      notes,
    };

    const outDir = path.resolve(o.out);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, `${restId}.json`), JSON.stringify(result, null, 2) + "\n");
    await writeFile(path.join(outDir, `${restId}.md`), renderMarkdown(result));
    log(`wrote ${path.join(outDir, `${restId}.json`)} and .md`);

    if (o.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else log("\n" + renderMarkdown(result));
    return 0;
  } finally {
    await session.close();
  }
}

main().then(code => { process.exitCode = code; }, e => { log(e.stack ?? String(e)); process.exitCode = 1; });

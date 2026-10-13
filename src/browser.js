/**
 * The only module that drives a browser. It loads real x.com pages in the
 * user's persistent profile and records the GraphQL responses those pages
 * make. It never fills a form, clicks a control, or calls GraphQL itself:
 * query IDs rotate, so we let X's own client choose them.
 */
import { chromium } from "playwright";
import path from "node:path";
import { readCached, writeCached } from "./cache.js";

const GRAPHQL = "/i/api/graphql/";
const MIN_GAP_MS = 1500;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (base, spread) => base + Math.random() * spread;

/** `.../graphql/<queryId>/<OperationName>?...` → OperationName. */
export function opName(url) {
  const p = new URL(url).pathname;
  const i = p.indexOf(GRAPHQL);
  if (i < 0) return null;
  return p.slice(i + GRAPHQL.length).split("/")[1] || null;
}

export function isLoginWall(url) {
  return /\/i\/flow\/login|\/login(?:[/?]|$)|\/i\/flow\/signup/.test(new URL(url).pathname + new URL(url).search);
}

export async function openSession({ profileDir, headed = false, fresh = false, debug = false, log = () => {} }) {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !headed,
    viewport: { width: 1280, height: 1400 },
    locale: "en-US",
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return new Session(context, page, { fresh, debug, log });
}

class Session {
  constructor(context, page, { fresh, debug, log }) {
    this.context = context;
    this.page = page;
    this.fresh = fresh;
    this.debug = debug;
    this.log = log;
    this.cacheDir = null;
    this.active = null;
    this.pending = new Set();
    this.lastLoad = 0;
    this.rateLimitedUntil = 0;
    this.loads = 0;

    page.on("response", res => {
      const bucket = this.active;
      if (!bucket) return;
      const url = res.url();
      if (!url.includes(GRAPHQL)) return;
      const op = opName(url);
      const status = res.status();
      if (status === 429) this.noteRateLimit(res.headers()["x-rate-limit-reset"]);
      const p = res.json()
        .then(json => { bucket.push({ op, status, json }); }, () => {})
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    });
  }

  /** Visits are cached under `.xhist-cache/<user_id>/visits/` once the ID is known. */
  setCacheDir(dir) {
    this.cacheDir = dir ? path.join(dir, "visits") : null;
  }

  async loggedIn() {
    const cookies = await this.context.cookies("https://x.com");
    return cookies.some(c => c.name === "auth_token");
  }

  /** Headed only: open the login page and wait for the user to finish. */
  async waitForLogin({ timeoutMs = 10 * 60 * 1000 } = {}) {
    if (await this.loggedIn()) return true;
    await this.page.goto("https://x.com/i/flow/login", { waitUntil: "domcontentloaded" });
    this.log("Log in to X in the browser window. Waiting (up to 10 min)…");
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.page.isClosed()) return false;
      if (await this.loggedIn()) return true;
      await sleep(1500);
    }
    return false;
  }

  noteRateLimit(resetHeader) {
    const reset = Number(resetHeader) * 1000;
    const until = Number.isFinite(reset) && reset > Date.now()
      ? Math.min(reset + 2000, Date.now() + MAX_BACKOFF_MS)
      : Date.now() + 60_000;
    if (until > this.rateLimitedUntil) this.rateLimitedUntil = until;
  }

  async throttle() {
    const now = Date.now();
    const wait = Math.max(this.lastLoad + jitter(MIN_GAP_MS, 1000) - now, this.rateLimitedUntil - now, 0);
    if (this.rateLimitedUntil > now) this.log(`rate limited by X; waiting ${Math.ceil(wait / 1000)}s`);
    if (wait > 0) await sleep(wait);
  }

  async waitForCapture(bucket, prefixes, timeoutMs) {
    const hit = () => prefixes?.length
      ? bucket.some(c => prefixes.some(p => c.op?.startsWith(p)))
      : bucket.length > 0;
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && !hit()) await sleep(250);
    return hit();
  }

  /** Scroll until no new GraphQL responses arrive for three rounds. */
  async scroll(bucket, maxScrolls) {
    let idle = 0;
    for (let i = 0; i < maxScrolls && idle < 3; i++) {
      const before = bucket.length;
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      const until = Date.now() + jitter(2500, 1000);
      while (Date.now() < until && bucket.length === before) await sleep(200);
      idle = bucket.length > before ? 0 : idle + 1;
      if (this.rateLimitedUntil > Date.now()) break;
      await sleep(jitter(500, 700));
    }
  }

  /**
   * Load `url`, optionally scroll, and return every GraphQL response it made.
   * Options: waitFor (op-name prefixes), scrolls, text (main.innerText),
   * html (page source), cache (default true).
   */
  async visit(url, { waitFor = [], scrolls = 0, text = false, html = false, cache = true } = {}) {
    if (cache && !this.fresh) {
      const hit = await readCached(this.cacheDir, url);
      if (hit) {
        if (this.debug) this.log(`cache ${url}`);
        return hit;
      }
    }

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const bucket = [];
      this.active = bucket;
      let res = null;
      try {
        res = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      } catch (e) {
        this.log(`load failed: ${url} (${e.message.split("\n")[0]})`);
      }
      this.lastLoad = Date.now();
      this.loads++;

      if (res?.status() === 429) this.noteRateLimit(res.headers()["x-rate-limit-reset"]);
      const limited = () => this.rateLimitedUntil > Date.now();

      if (!limited()) {
        await this.waitForCapture(bucket, waitFor, 15_000);
        if (scrolls && !isLoginWall(this.page.url())) await this.scroll(bucket, scrolls);
      }
      await Promise.allSettled([...this.pending]);
      this.active = null;

      const ok = bucket.filter(c => c.status === 200);
      if (limited() && ok.length === 0 && attempt < 3) continue;

      const finalUrl = this.page.url();
      const out = { url, finalUrl, at: new Date().toISOString(), captures: ok };
      if (text) out.text = await this.page.evaluate(() => (document.querySelector("main") ?? document.body)?.innerText ?? "").catch(() => "");
      if (html) out.html = await this.page.content().catch(() => "");

      if (this.debug) {
        const ops = [...new Set(bucket.map(c => `${c.op}${c.status === 200 ? "" : `(${c.status})`}`))];
        this.log(`load ${url} → ${ops.join(", ") || "no GraphQL"}`);
      }
      // A partial or walled page is not worth replaying from cache.
      if (cache && !limited() && !isLoginWall(finalUrl) && ok.length) await writeCached(this.cacheDir, url, out);
      return out;
    }
  }

  async close() {
    await this.context.close().catch(() => {});
  }
}

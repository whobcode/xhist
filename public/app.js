// xhist page: one username in, its handle history out. Everything is built
// with DOM nodes and textContent; nothing from a lookup is parsed as HTML.

const $ = sel => document.querySelector(sel);
const results = $("#results");
const form = $("#search");
const input = $("#u");
const hint = $("#mode-hint");

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const SOURCE_LABEL = { media_url: "Media URL", reply_prefix: "Reply text", mention: "Mention", memory_lol: "memory.lol" };
const CONF_LABEL = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const state = { me: null, mode: "basic", last: null, controller: null };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function svg(path) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  s.append(p);
  return s;
}
const ICON_X = "M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z";
const ICON_UP = "M12 20V7.83l5.59 5.58L19 12l-7-7-7 7 1.41 1.41L11 7.83V20z";
const ICON_HIST = "M13 3a9 9 0 0 0-9 9H1l3.9 3.9.1.1L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z";

const date = iso => {
  if (!iso || iso === "now") return iso === "now" ? "now" : "—";
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(t) ? iso : fmt.format(t);
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/* ---------- account / sign-in ---------- */

async function loadMe() {
  try {
    const r = await fetch("/api/me", { credentials: "same-origin" });
    state.me = r.ok ? await r.json() : { authAvailable: false, signedIn: false };
  } catch {
    state.me = { authAvailable: false, signedIn: false };
  }
  renderAccount();
  renderModes();
}

function renderAccount() {
  const box = $("#account");
  box.replaceChildren();
  const me = state.me;
  if (!me?.authAvailable) {
    box.append(h("button", { class: "btn btn-light", type: "button", disabled: true, title: "Sign-in with X isn't connected on this site yet" }, svg(ICON_X), "Sign in"));
    return;
  }
  if (me.signedIn) {
    if (me.avatar) box.append(h("img", { src: me.avatar, alt: "" }));
    box.append(
      h("span", { class: "who" }, `@${me.username ?? "you"}`),
      h("button", { class: "btn btn-outline", type: "button", onclick: signOut }, "Sign out"),
    );
  } else {
    box.append(h("a", { class: "btn btn-light", href: "/auth/login" }, svg(ICON_X), "Sign in"));
  }
}

async function signOut() {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  if (state.mode === "detailed") setMode("basic");
  await loadMe();
}

/* ---------- mode toggle ---------- */

function setMode(mode) {
  state.mode = mode;
  store.set("xhist:mode", mode);
  renderModes();
}

function renderModes() {
  const me = state.me ?? {};
  for (const b of document.querySelectorAll(".modes button")) {
    const on = b.dataset.mode === state.mode;
    b.setAttribute("aria-checked", String(on));
    const tag = b.querySelector(".tag");
    if (tag) tag.hidden = !!me.signedIn;
  }
  hint.textContent = state.mode === "detailed"
    ? (me.signedIn
      ? "Reads the account's own posts and replies through the X API. Takes up to a minute."
      : me.authAvailable ? "Sign in with X to run a detailed lookup." : "Sign-in with X isn't connected on this site yet, so only basic lookups work for now.")
    : "Uses archived name records from memory.lol and the Wayback Machine. No sign-in needed.";
}

for (const b of document.querySelectorAll(".modes button")) {
  b.addEventListener("click", () => setMode(b.dataset.mode));
}

/* ---------- lookup ---------- */

function showLoading(handle, mode) {
  results.replaceChildren(
    h("div", { class: "loading" }, h("div", { class: "spinner", role: "status", "aria-label": "Loading" }),
      h("span", {}, mode === "detailed" ? `Reading @${handle}'s posts and replies…` : `Looking up @${handle}…`)),
    ...[0, 1, 2].map(() => h("div", { class: "skeleton" }, h("div", { class: "a" }),
      h("div", { class: "b" }, h("i", { class: "w40" }), h("i", { class: "w70" }), h("i", { class: "w55" })))),
  );
}

function notice(title, text, { error = false, action = null } = {}) {
  results.replaceChildren(h("div", { class: `notice${error ? " error" : ""}` }, h("h2", {}, title), h("p", {}, text), action));
}

async function lookup(handle, mode, { push = true } = {}) {
  handle = handle.trim().replace(/^@/, "");
  if (!HANDLE_RE.test(handle)) {
    notice("That doesn't look like a username", "Use letters, numbers and underscores, up to 15 characters.", { error: true });
    return;
  }
  input.value = handle;
  if (push) {
    const q = new URLSearchParams({ u: handle });
    if (mode === "detailed") q.set("mode", "detailed");
    history.pushState({ u: handle, mode }, "", `/?${q}`);
  }
  document.title = `@${handle} · xhist`;

  if (mode === "detailed" && state.me && !state.me.signedIn) {
    notice(state.me.authAvailable ? "Sign in for a detailed lookup" : "Detailed lookups aren't available",
      state.me.authAvailable
        ? "A detailed lookup reads the account's own posts through the X API, so it needs you signed in with X. xhist only asks for read access."
        : "Sign-in with X isn't connected on this site yet, so detailed lookups are off. Basic lookups still work.",
      { action: state.me.authAvailable ? h("a", { class: "btn btn-light", href: "/auth/login" }, svg(ICON_X), "Sign in with X") : null });
    return;
  }

  state.controller?.abort();
  const ctrl = state.controller = new AbortController();
  showLoading(handle, mode);
  try {
    const r = await fetch(`/api/lookup?${new URLSearchParams({ u: handle, mode })}`, { signal: ctrl.signal, credentials: "same-origin" });
    const data = await r.json().catch(() => ({ error: `Server error (${r.status}).` }));
    if (ctrl !== state.controller) return;
    if (!r.ok) {
      notice("Lookup failed", data.error ?? `Server error (${r.status}).`, {
        error: true,
        action: data.signIn && state.me?.authAvailable ? h("a", { class: "btn btn-light", href: "/auth/login" }, svg(ICON_X), "Sign in with X") : null,
      });
      return;
    }
    render(data);
  } catch (e) {
    if (e.name !== "AbortError") notice("Lookup failed", "Couldn't reach xhist. Check your connection and try again.", { error: true });
  }
}

form.addEventListener("submit", e => {
  e.preventDefault();
  lookup(input.value, state.mode);
});

window.addEventListener("popstate", () => {
  const q = new URLSearchParams(location.search);
  if (q.get("u")) {
    setMode(q.get("mode") === "detailed" ? "detailed" : "basic");
    lookup(q.get("u"), state.mode, { push: false });
  } else {
    results.replaceChildren();
    input.value = "";
  }
});

/* ---------- rendering ---------- */

const STATUS_TEXT = {
  no_record: "No history on record",
  not_found: "Account not found",
  suspended: "Account suspended",
  protected: "Account is protected",
  unavailable: "Account unavailable",
  source_down: "Archive unreachable",
};

function render(r) {
  state.last = r;
  if (r.status && r.status !== "ok") {
    const signIn = r.status === "no_record" && state.me?.authAvailable && !state.me?.signedIn;
    const goDetailed = r.status === "no_record" && state.me?.signedIn;
    notice(STATUS_TEXT[r.status] ?? "No result", r.message ?? "", {
      error: r.status !== "no_record",
      action: signIn ? h("a", { class: "btn btn-light", href: "/auth/login" }, svg(ICON_X), "Sign in with X")
        : goDetailed ? h("button", { class: "btn btn-primary", type: "button", onclick: () => { setMode("detailed"); lookup(r.input, "detailed"); } }, "Run detailed lookup")
        : null,
    });
    return;
  }

  document.title = `@${r.currentHandle} · xhist`;
  const handles = r.handles ?? [];
  const old = handles.filter(x => !x.current);
  const modeLabel = { basic: "Basic", detailed: "Detailed" }[r.mode] ?? "CLI report";

  const nodes = [];

  // Profile
  const p = r.profile ?? {};
  nodes.push(h("div", { class: "profile" },
    p.avatar ? h("img", { class: "avatar", src: p.avatar.replace("_normal", "_200x200"), alt: "" })
      : h("div", { class: "avatar", "aria-hidden": "true" }, (r.currentHandle ?? "?").slice(0, 1).toUpperCase()),
    h("div", {},
      h("div", { class: "name" }, p.name ?? `@${r.currentHandle}`, h("span", { class: "badge" }, modeLabel)),
      h("div", { class: "muted" }, h("a", { href: `https://x.com/i/user/${r.userId}`, target: "_blank", rel: "noopener" }, p.name ? `@${r.currentHandle}` : "View on X ↗")),
      h("div", { class: "meta muted" },
        h("span", {}, `ID ${r.userId}`),
        r.createdAt ? h("span", {}, `Joined ${date(r.createdAt)}`) : null,
        p.posts != null ? h("span", {}, `${Number(p.posts).toLocaleString()} posts`) : null,
        r.cached ? h("span", {}, "cached") : null),
    ),
  ));

  // Summary
  const total = handles.length + (r.unrecovered || 0);
  nodes.push(h("div", { class: "summary muted" },
    h("span", {}, h("b", {}, String(total)), total === 1 ? " handle" : " handles"),
    h("span", {}, h("b", {}, String(Math.max(0, total - 1))), total - 1 === 1 ? " change" : " changes"),
    r.about?.changeCount != null ? h("span", {}, "X reports ", h("b", {}, String(r.about.changeCount)),
      r.about.lastChangeMonth ? ` · last ${r.about.lastChangeMonth}` : "") : null,
    r.stats?.ownPosts != null ? h("span", {}, h("b", {}, r.stats.ownPosts.toLocaleString()), " posts checked") : null,
  ));

  // Timeline, newest first
  const list = h("ol", { class: "timeline" });
  const changes = r.changes ?? [];
  for (let i = handles.length - 1; i >= 0; i--) {
    list.append(entry(handles[i], r));
    const c = changes[i - 1];
    if (c) list.append(changeRow(c));
  }
  for (let i = 0; i < (r.unrecovered || 0); i++) {
    list.append(h("li", { class: "entry missing" },
      h("div", { class: "rail" }, h("div", { class: "dot" }, "?")),
      h("div", { class: "body" },
        h("div", { class: "handle muted" }, "Unrecovered handle"),
        h("div", { class: "dates muted" }, "X counts a change that left no surviving evidence, most likely the original handle."))));
  }
  nodes.push(list);

  // Other accounts that used this handle
  if (r.otherAccounts?.length) {
    nodes.push(h("div", { class: "section" },
      h("h2", {}, `Other accounts that used @${r.input}`),
      h("ul", {}, r.otherAccounts.map(a => h("li", {},
        h("a", { href: `https://x.com/i/user/${a.userId}`, target: "_blank", rel: "noopener" }, `ID ${a.userId}`), ": ",
        Object.entries(a.screenNames).map(([n, d], j) => [j ? ", " : "", h("b", {}, `@${n}`), ` (${(d ?? []).map(date).join(" – ")})`]))))));
  }

  // Notes
  if (r.notes?.length) {
    nodes.push(h("div", { class: "section" }, h("h2", {}, "Notes"), h("ul", {}, r.notes.map(n => h("li", {}, n)))));
  }
  if (old.length) {
    nodes.push(h("div", { class: "callout" }, "Old handles can be re-registered by anyone. Whoever holds one now may be unrelated."));
  }

  // Actions
  nodes.push(h("div", { class: "actions" },
    h("button", { class: "btn btn-outline", type: "button", onclick: downloadJson }, "Download JSON"),
    r.mode ? h("button", { class: "btn btn-outline", type: "button", onclick: copyLink }, "Copy link") : null,
    r.mode === "basic" && state.me?.signedIn
      ? h("button", { class: "btn btn-primary", type: "button", onclick: () => { setMode("detailed"); lookup(r.input, "detailed"); } }, "Run detailed lookup")
      : null,
  ));

  results.replaceChildren(...nodes);
}

function entry(x, r) {
  const isCurrent = !!x.current;
  const label = x.current === "latest" ? "Latest known" : isCurrent ? "Current" : null;
  const wb = r.wayback?.[x.handle] ?? r.wayback?.[Object.keys(r.wayback ?? {}).find(k => k.toLowerCase() === x.handle.toLowerCase())];
  const examples = x.examples ?? [];
  return h("li", { class: `entry${isCurrent ? " current" : ""}` },
    h("div", { class: "rail" }, h("div", { class: "dot" }, isCurrent ? svg(ICON_HIST) : x.handle.slice(0, 1).toUpperCase())),
    h("div", { class: "body" },
      h("div", { class: "line1" },
        h("span", { class: "handle" }, `@${x.handle}`),
        label ? h("span", { class: "pill now" }, label) : null,
        x.confidence ? h("span", { class: `pill ${x.confidence}` }, CONF_LABEL[x.confidence]) : null),
      h("div", { class: "dates muted" },
        `${date(x.firstSeen)} – ${x.current === true ? "now" : date(x.lastSeen)}`,
        ` · ${x.observations} ${x.observations === 1 ? "sighting" : "sightings"}`),
      x.sources?.length ? h("div", { class: "chips" }, x.sources.map(s => h("span", { class: "chip" }, SOURCE_LABEL[s] ?? s))) : null,
      (examples.length || wb?.length) ? h("div", { class: "evidence" },
        examples.map((id, i) => h("a", { href: `https://x.com/i/status/${id}`, target: "_blank", rel: "noopener" }, `Post ${i + 1} ↗`)),
        wb?.length ? h("a", { href: `https://web.archive.org/web/*/twitter.com/${encodeURIComponent(x.handle)}`, target: "_blank", rel: "noopener" },
          `${wb.length} Wayback capture${wb.length === 1 ? "" : "s"} ↗`) : null) : null,
    ));
}

function changeRow(c) {
  return h("li", { class: `change${c.overlap ? " warn" : ""}` },
    h("div", { class: "rail" }, svg(ICON_UP)),
    h("span", {}, `Renamed @${c.from} → @${c.to} between ${date(c.window[0])} and ${date(c.window[1])}`,
      c.overlap ? " (evidence overlaps)" : ""));
}

function downloadJson() {
  const r = state.last;
  if (!r) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: "application/json" }));
  const a = h("a", { href: url, download: `xhist-${r.currentHandle ?? r.input}-${r.userId ?? "result"}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyLink(e) {
  try {
    await navigator.clipboard.writeText(location.href);
    e.target.textContent = "Copied";
  } catch {
    e.target.textContent = "Copy failed";
  }
  setTimeout(() => { e.target.textContent = "Copy link"; }, 1500);
}

/* ---------- CLI report viewer ---------- */

async function openReport(file) {
  try {
    const r = JSON.parse(await file.text());
    if (!Array.isArray(r?.handles) || !r.userId) throw new Error("shape");
    history.pushState({}, "", "/");
    input.value = r.currentHandle ?? "";
    render({ ...r, mode: r.mode ?? null });
  } catch {
    notice("Couldn't open that file", "Choose a .json report written by the xhist CLI.", { error: true });
  }
}

$("#file").addEventListener("change", e => { if (e.target.files[0]) openReport(e.target.files[0]); e.target.value = ""; });

const drop = $("#drop");
let dragDepth = 0;
window.addEventListener("dragenter", e => { if ([...e.dataTransfer.types].includes("Files")) { dragDepth++; drop.hidden = false; } });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) openReport(f);
});

/* ---------- boot ---------- */

(async () => {
  const q = new URLSearchParams(location.search);
  state.mode = q.get("mode") === "detailed" ? "detailed"
    : q.get("u") ? "basic"
    : store.get("xhist:mode") === "detailed" ? "detailed" : "basic";
  renderModes();
  await loadMe();

  const signin = q.get("signin");
  if (signin) {
    history.replaceState({}, "", "/");
    notice("Sign-in didn't finish", { cancelled: "You cancelled the X sign-in.", expired: "The sign-in took too long. Try again.", failed: "X didn't accept the sign-in. Try again." }[signin] ?? "Try again.", { error: true });
  } else if (q.get("u")) {
    lookup(q.get("u"), state.mode, { push: false });
  } else {
    input.focus();
  }
})();

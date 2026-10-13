/** One-screen Markdown summary of a result object. */
import { day, REREGISTER_WARNING } from "./timeline.js";

const SOURCE_LABEL = { media_url: "media URL", reply_prefix: "reply prefix", mention: "mention", memory_lol: "memory.lol" };

export function renderMarkdown(r) {
  const L = [];
  L.push(`# @${r.currentHandle} — handle history`, "");
  L.push(`User ID \`${r.userId}\` · created ${day(r.createdAt) ?? "?"} · generated ${day(r.generatedAt)}`, "");

  if (r.about) {
    const a = r.about;
    L.push(`**X About panel:** ${a.changeCount ?? "?"} username change(s)` +
      (a.lastChangeMonth ? `, last on ${a.lastChangeMonth}` : "") +
      (a.accountBasedIn ? ` · based in ${a.accountBasedIn}` : ""), "");
  } else {
    L.push("**X About panel:** unavailable (log in with `xhist login`).", "");
  }

  L.push("| Handle | First seen | Last seen | Obs. | Sources | Confidence |", "|---|---|---|---:|---|---|");
  for (const h of r.handles) {
    L.push(`| ${h.current ? "**@" + h.handle + "** (current)" : "@" + h.handle} | ${day(h.firstSeen) ?? "—"} | ${h.current ? "now" : day(h.lastSeen)} | ${h.observations} | ${h.sources.map(s => SOURCE_LABEL[s] ?? s).join(", ") || "—"} | ${h.confidence ?? "—"} |`);
  }
  if (r.unrecovered) L.push("", `**${r.unrecovered} handle(s) unrecovered** — X counts more changes than the evidence shows.`);
  L.push("");

  if (r.changes.length) {
    L.push("## Changes", "");
    for (const c of r.changes) L.push(`- @${c.from} → @${c.to}: between ${c.window[0]} and ${c.window[1]}${c.overlap ? " (overlapping evidence)" : ""}`);
    L.push("");
  }

  const evidence = r.handles.filter(h => !h.current && h.examples?.length);
  if (evidence.length) {
    L.push("## Evidence", "");
    for (const h of evidence) L.push(`- @${h.handle}: ${h.examples.map(id => `[${id}](https://x.com/i/status/${id})`).join(", ")}`);
    L.push("");
  }

  const wb = Object.entries(r.wayback ?? {}).filter(([, ts]) => ts?.length);
  if (wb.length) {
    L.push("## Wayback captures", "");
    for (const [h, ts] of wb) L.push(`- @${h}: ${ts.length} capture(s), ${ts[0].slice(0, 8)} … ${ts.at(-1).slice(0, 8)}`);
    L.push("");
  }

  if (r.notes.length) {
    L.push("## Notes", "");
    for (const n of r.notes) L.push(`- ${n}`);
    L.push("");
  }
  if (r.handles.some(h => !h.current)) L.push(`> ${REREGISTER_WARNING}`, "");
  return L.join("\n");
}

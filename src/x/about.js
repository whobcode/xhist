/**
 * Step 2: the "About this account" panel. It gives the number of username
 * changes and the month of the last one, but never the old names.
 */
import { isLoginWall } from "../browser.js";

/** Find username-change data anywhere in a GraphQL payload. */
export function parseAboutGraphql(captures) {
  let changes = null;
  let basedIn = null;
  const stack = captures.map(c => c.json);
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (v.username_changes && typeof v.username_changes === "object" && !changes) changes = v.username_changes;
    if (typeof v.account_based_in === "string" && !basedIn) basedIn = v.account_based_in;
    for (const k in v) if (v[k] && typeof v[k] === "object") stack.push(v[k]);
  }
  if (!changes) return null;
  const count = Number(changes.count);
  const ms = Number(changes.last_changed_at_msec);
  return {
    changeCount: Number.isFinite(count) ? count : null,
    lastChangedAt: Number.isFinite(ms) && ms > 0 ? ms : null,
    accountBasedIn: basedIn,
  };
}

/** Fallback: the panel's visible text. Raw strings only. */
export function parseAboutText(text) {
  if (!text) return null;
  const count = /(\d+)\s+username changes?/i.exec(text);
  const none = /no username changes/i.test(text);
  const last = /Last on\s+([A-Za-z]+ \d{4})/.exec(text);
  const joined = /Date joined\s*\n?\s*([^\n]+)/.exec(text);
  const based = /Account based in\s*\n?\s*([^\n]+)/.exec(text);
  if (!count && !none && !last && !joined) return null;
  return {
    changeCount: count ? Number(count[1]) : none ? 0 : null,
    lastChangeMonth: last ? last[1] : null,
    dateJoined: joined ? joined[1].trim() : null,
    accountBasedIn: based ? based[1].trim() : null,
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

export async function readAbout(session, handle) {
  const v = await session.visit(`https://x.com/${handle}/about`, { text: true });
  if (isLoginWall(v.finalUrl)) return { about: null, loginRequired: true };

  const gql = parseAboutGraphql(v.captures);
  const txt = parseAboutText(v.text);
  if (!gql && !txt) return { about: null, loginRequired: false, ops: [...new Set(v.captures.map(c => c.op))] };

  const lastChangedAt = gql?.lastChangedAt ?? null;
  const fromMs = lastChangedAt
    ? `${MONTHS[new Date(lastChangedAt).getUTCMonth()]} ${new Date(lastChangedAt).getUTCFullYear()}`
    : null;
  return {
    loginRequired: false,
    about: {
      changeCount: gql?.changeCount ?? txt?.changeCount ?? null,
      lastChangeMonth: fromMs ?? txt?.lastChangeMonth ?? null,
      lastChangedAt,
      dateJoined: txt?.dateJoined ?? null,
      accountBasedIn: gql?.accountBasedIn ?? txt?.accountBasedIn ?? null,
      source: gql ? "graphql" : "text",
      raw: (v.text ?? "").trim().slice(0, 2000),
    },
  };
}

// Shared Slice 18 fixtures: one request per dad-scoped BFF route, in an
// order where each is valid for its own dad (synthetic Alex only).
// `ctx` collects ids that later routes need.

export const MINT_ROUTES = ["POST /vault/provision"];

export function routeCases(dad_id, ctx = {}) {
  const q = (p, extra = "") => `${p}?dad_id=${dad_id}${extra}`;
  return [
    ["POST", "/vault/intake", { dad_id, text: "They cancelled my visit with the kids this Friday.", make_notice: true }],
    ["POST", "/vault/notice", { dad_id }],
    ["POST", "/vault/return", { dad_id }],
    ["POST", "/vault/tell", { dad_id, channel: "talk", story: "Pickup went fine and the kids were happy." }],
    ["POST", "/vault/missing/seed", { dad_id }],
    ["POST", "/vault/missing/fill", { dad_id, answer: "3rd grade" }],
    ["GET", q("/vault/state")],
    ["PUT", "/vault/state", { dad_id }],
    ["PATCH", "/vault/state", { dad_id }],
    ["GET", q("/vault/progress")],
    ["GET", q("/vault/candidates"), undefined, (d) => { ctx.candidate_id = d?.[0]?.id ?? d?.candidates?.[0]?.id; }],
    ["POST", "/vault/candidates/review", () => ({ dad_id, id: ctx.candidate_id, review: "keep" })],
    ["POST", "/vault/plan/topics/ensure", { dad_id }],
    ["GET", q("/vault/plan/topics")],
    ["POST", "/vault/plan/answer", { dad_id, topic: "exchanges", choice: "curbside" }],
    ["POST", "/vault/plan/stuck", { dad_id, topic: "holidays" }],
    ["POST", "/vault/plan/park", { dad_id, topic: "rofr" }],
    ["POST", "/vault/plan/draft/regenerate", { dad_id, kind: "full" }],
    ["GET", q("/vault/plan/draft")],
    ["POST", "/vault/translate/explain", { dad_id, term: "mediation" }],
    ["GET", q("/vault/translate/last")],
    ["GET", q("/vault/translate/list")],
    ["POST", "/vault/involvement/ensure", { dad_id, kid: "sam" }],
    ["GET", q("/vault/involvement")],
    ["POST", "/vault/involvement/field", { dad_id, kid: "sam", field: "grade", value: "3rd" }],
    ["GET", q("/vault/involvement/next")],
    ["GET", q("/vault/involvement/export", "&kid=sam")],
    ["POST", "/vault/legal/intake", { dad_id, who: "school", what: "Report card came home.", urgency: "this_month" }],
    ["GET", q("/vault/legal/intake")],
    ["POST", "/vault/legal/handoff", { dad_id }],
    ["POST", "/vault/checkins/ensure", { dad_id, date: "2026-09-27", tz_offset_minutes: -240 }],
    ["GET", q("/vault/notifications"), undefined, (d) => { ctx.notification_id = (d?.items ?? d)?.[0]?.id; }],
    ["POST", "/vault/notifications/mark", () => ({ dad_id, id: ctx.notification_id, status: "read" })],
    ["GET", q("/vault/chip_entry")],
    ["POST", "/vault/comms/cold", { dad_id, body_cold: "Confirming pickup at 5pm Friday.", channel: "ofw" }],
    ["POST", "/vault/comms/draft", { dad_id, body: "Can we swap Friday for Saturday?" }],
    ["GET", q("/vault/comms/drafts")],
    ["POST", "/vault/comms/pull", { dad_id, channel: "ofw", source_ref: "ofw:alex:1", body_cold: "Pickup confirmed.", sent_at: "2026-09-20T17:00:00Z" }],
    ["GET", q("/vault/export/verified")],
    ["GET", q("/vault/search", "&q=pickup")],
    // Slice 20 — these kill tokens, so they run last and on a fresh token.
    ["POST", "/vault/logout", { dad_id }, undefined, true],
    ["POST", "/vault/token/revoke", { dad_id }, undefined, true],
  ].map(([method, path, body, after, consumes = false]) => ({ method, path, body, after, consumes }));
}

export async function jsonReq(base, method, path, body, { token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/** Swap every dad_id (query + body) for another value. */
export function retarget(c, other) {
  const path = c.path.replace(/dad_id=[^&]+/, `dad_id=${other}`);
  const b = typeof c.body === "function" ? c.body() : c.body;
  return { ...c, path, body: b ? { ...b, dad_id: other } : undefined };
}

/**
 * Runs the full auth matrix for every dad-scoped route.
 * a, b: provisioned dads {dad_id, token}; unknown: an unprovisioned uuid.
 * mint(dad_id) → a fresh raw token, used by token-killing routes (Slice 20).
 * Returns rows [{route, own, none, bad, cross, unknown}].
 */
export async function authMatrix(base, a, b, unknown, mint) {
  const ctx = {};
  const rows = [];
  for (const c of routeCases(a.dad_id, ctx)) {
    const body = typeof c.body === "function" ? c.body() : c.body;
    const route = `${c.method} ${c.path.split("?")[0]}`;
    const token = c.consumes ? await mint(a.dad_id) : a.token;
    const none = (await jsonReq(base, c.method, c.path, body)).status;
    const bad = (await jsonReq(base, c.method, c.path, body, { token: "not-a-real-token" })).status;
    const x = retarget({ ...c, body }, b.dad_id);
    const cross = (await jsonReq(base, x.method, x.path, x.body, { token })).status;
    const u = retarget({ ...c, body }, unknown);
    const unk = (await jsonReq(base, u.method, u.path, u.body, { token })).status;
    const res = await jsonReq(base, c.method, c.path, body, { token });
    if (c.after) c.after(res.data);
    rows.push({ route, own: res.status, none, bad, cross, unknown: unk, error: res.status >= 400 ? res.data : null });
  }
  return rows;
}

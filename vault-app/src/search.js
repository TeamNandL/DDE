// Shared search option parsing for GET /vault/search.
// Tenancy (dad_id) is enforced by the HTTP gate + vault WHERE clauses.

export const SEARCH_TYPES = new Set([
  "events",
  "communications",
  "documents",
  "state",
  "month_summary",
  "all",
]);

export const SEARCH_PIPES = new Set(["claim", "verified"]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Normalize query params for vault.search.
 * Throws Error with .status = 400 on bad input.
 */
export function parseSearchOpts({ dad_id, q, pipe, type, from, to, limit } = {}) {
  if (typeof dad_id !== "string" || !dad_id.trim()) {
    const err = new Error("dad_id is required and must be a uuid");
    err.status = 400;
    throw err;
  }

  const qStr = q == null || q === "" ? "" : String(q).trim();

  let pipeVal = null;
  if (pipe != null && pipe !== "") {
    pipeVal = String(pipe).trim().toLowerCase();
    if (!SEARCH_PIPES.has(pipeVal)) {
      const err = new Error("pipe must be claim or verified");
      err.status = 400;
      throw err;
    }
  }

  let typeVal = "all";
  if (type != null && type !== "") {
    typeVal = String(type).trim().toLowerCase();
    if (!SEARCH_TYPES.has(typeVal)) {
      const err = new Error(
        "type must be events|communications|documents|state|month_summary|all",
      );
      err.status = 400;
      throw err;
    }
  }

  let fromIso = null;
  let toIso = null;
  if (from != null && from !== "") {
    const d = new Date(String(from));
    if (Number.isNaN(d.getTime())) {
      const err = new Error("from must be an ISO date/time");
      err.status = 400;
      throw err;
    }
    fromIso = d.toISOString();
  }
  if (to != null && to !== "") {
    const d = new Date(String(to));
    if (Number.isNaN(d.getTime())) {
      const err = new Error("to must be an ISO date/time");
      err.status = 400;
      throw err;
    }
    toIso = d.toISOString();
  }

  let lim = DEFAULT_LIMIT;
  if (limit != null && limit !== "") {
    lim = Number(limit);
    if (!Number.isFinite(lim) || lim < 1) {
      const err = new Error("limit must be a positive integer");
      err.status = 400;
      throw err;
    }
    lim = Math.min(Math.floor(lim), MAX_LIMIT);
  }

  return {
    dad_id: dad_id.trim(),
    q: qStr,
    pipe: pipeVal,
    type: typeVal,
    from: fromIso,
    to: toIso,
    limit: lim,
  };
}

/** Short snippet for memory/substring path — never returns full long bodies. */
export function makeSnippet(text, q, maxLen = 120) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (!q) {
    return raw.length <= maxLen ? raw : raw.slice(0, maxLen - 1) + "…";
  }
  const lower = raw.toLowerCase();
  const needle = q.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) {
    return raw.length <= maxLen ? raw : raw.slice(0, maxLen - 1) + "…";
  }
  const half = Math.floor((maxLen - needle.length) / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(raw.length, idx + needle.length + half);
  let snip = raw.slice(start, end);
  if (start > 0) snip = "…" + snip;
  if (end < raw.length) snip = snip + "…";
  return snip;
}

export function textIncludes(hay, needle) {
  if (!needle) return true;
  return String(hay ?? "")
    .toLowerCase()
    .includes(String(needle).toLowerCase());
}

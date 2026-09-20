// Vault search — shared parameter validation + the in-memory engine.
//
// Hard tenancy rail: dad_id is REQUIRED on every search. There is no code
// path that searches without one, and every backend filters each row on
// dad_id. App-enforced (RLS is still off per the Phase 1 auth-gate
// decision).
//
// Two-pipe rail: search may return claim and verified rows, each labeled
// with its pipe; the optional pipe filter narrows to one. Reporting /
// exhibit paths still read verified_export ONLY — search is a seat surface
// (Intake / Edge / Front Door), never a Reporting input.
//
// Log hygiene rail: the query text is user content (it can contain kid
// names). It is NEVER logged — only dad id, query length, and hit count.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SEARCH_TYPES = new Set([
  "events",
  "communications",
  "documents",
  "state",
  "month_summary",
  "all",
]);

const PIPES = new Set(["claim", "verified"]);

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Normalizes and validates the §5-style search params. Throws 400-shaped
// errors; returns { dadId, q, pipe, type, from, to, limit }.
export function validateSearchParams(params = {}) {
  const dadId = params.dad_id;
  if (typeof dadId !== "string" || !UUID_RE.test(dadId)) {
    throw bad("dad_id is required and must be a uuid");
  }

  const q = typeof params.q === "string" && params.q.trim() ? params.q.trim() : null;

  let pipe = null;
  if (params.pipe !== undefined && params.pipe !== null && params.pipe !== "") {
    if (!PIPES.has(params.pipe)) throw bad("pipe must be 'claim' or 'verified'");
    pipe = params.pipe;
  }

  let type = "all";
  if (params.type !== undefined && params.type !== null && params.type !== "") {
    if (!SEARCH_TYPES.has(params.type)) {
      throw bad(
        "type must be one of events|communications|documents|state|month_summary|all",
      );
    }
    type = params.type;
  }

  const parseTs = (v, name) => {
    if (v === undefined || v === null || v === "") return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw bad(`${name} must be a valid timestamp`);
    return d;
  };
  const from = parseTs(params.from, "from");
  const to = parseTs(params.to, "to");

  let limit = 20;
  if (params.limit !== undefined && params.limit !== null && params.limit !== "") {
    limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw bad("limit must be an integer between 1 and 50");
    }
  }

  return { dadId, q, pipe, type, from, to, limit };
}

// ---------------------------------------------------------------------------
// In-memory engine — mirrors vault_search() in vault/003_search.sql.

function tokens(q) {
  return q
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
}

function joinArr(a) {
  return Array.isArray(a) ? a.join(" ") : "";
}

function candidateRows(vault, type) {
  const out = [];
  const want = (t) => type === "all" || type === t;

  if (want("events")) {
    for (const e of vault.events) {
      out.push({
        source_table: "events",
        row: e,
        ts: e.occurred_at,
        haystack: [e.raw_quote, e.notes, e.location, e.event_type, joinArr(e.kids)],
        snippetSource: e.raw_quote ?? e.notes ?? "",
      });
    }
  }
  if (want("communications")) {
    for (const c of vault.communications) {
      out.push({
        source_table: "communications",
        row: c,
        ts: c.sent_at ?? c.created_at,
        haystack: [c.body_cold, c.raw_quote, c.channel, c.direction],
        snippetSource: c.body_cold ?? c.raw_quote ?? "",
      });
    }
  }
  if (want("documents")) {
    for (const d of vault.documents) {
      const extracted = d.extracted ? JSON.stringify(d.extracted) : "";
      out.push({
        source_table: "documents",
        row: d,
        ts: d.created_at,
        haystack: [d.doc_type, extracted],
        snippetSource: extracted || d.doc_type || "",
      });
    }
  }
  if (want("state")) {
    for (const s of vault.state.values()) {
      out.push({
        source_table: "state",
        row: s,
        ts: s.updated_at,
        haystack: [s.this_week, s.next_action, s.phase, joinArr(s.missing)],
        snippetSource: `${s.next_action ?? ""} ${joinArr(s.missing)}`.trim(),
      });
    }
  }
  if (want("month_summary")) {
    for (const m of vault.month_summary) {
      out.push({
        source_table: "month_summary",
        row: m,
        ts: m.month,
        haystack: [m.summary_text, joinArr(m.highlights), joinArr(m.pattern_tags)],
        snippetSource: m.summary_text ?? "",
      });
    }
  }
  return out;
}

function snippetAround(text, token) {
  const lower = text.toLowerCase();
  const at = lower.indexOf(token);
  if (at < 0) return text.slice(0, 160);
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + token.length + 100);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

// The ONLY in-memory search path — params must come from
// validateSearchParams, so dadId is always present.
export function memorySearch(vault, { dadId, q, pipe, type, from, to, limit }) {
  const toks = q ? tokens(q) : [];
  const hits = [];

  for (const cand of candidateRows(vault, type)) {
    const r = cand.row;
    if (r.dad_id !== dadId) continue; // hard tenancy — every row, every table
    if (pipe && r.pipe !== pipe) continue;
    const ts = cand.ts ? new Date(cand.ts) : null;
    if (from && (!ts || ts < from)) continue;
    if (to && (!ts || ts > to)) continue;

    let rank = 0;
    let snippet;
    if (toks.length) {
      const hay = cand.haystack
        .filter((h) => typeof h === "string" && h)
        .join(" ")
        .toLowerCase();
      if (!toks.every((t) => hay.includes(t))) continue;
      for (const t of toks) {
        let i = hay.indexOf(t);
        while (i !== -1) {
          rank += 1;
          i = hay.indexOf(t, i + t.length);
        }
      }
      snippet = snippetAround(cand.snippetSource, toks[0]);
    } else {
      snippet = cand.snippetSource.slice(0, 160);
    }

    hits.push({
      source_table: cand.source_table,
      id: r.id,
      dad_id: r.dad_id,
      pipe: r.pipe,
      rank,
      snippet,
      ts: cand.ts ?? null,
      created_at: r.created_at ?? null,
    });
  }

  hits.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    return new Date(b.ts ?? 0) - new Date(a.ts ?? 0);
  });
  return hits.slice(0, limit);
}

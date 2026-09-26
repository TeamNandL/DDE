// Exhibit packet — the court-facing output of the vault (Phase 5).
//
// This is the payoff surface: everything Intake, notice, and the record pipe
// feed ends up here, shaped the way an exhibit list is shaped — lettered,
// dated, cited, cold.
//
// Rails baked into the builder, not bolted on after:
//   * verified ONLY. The packet is built from `verified_export` — the same
//     single read surface Reporting uses — so a claim row cannot reach an
//     exhibit by construction. A final assertion re-checks every entry and
//     throws rather than emit a packet with a claim row in it.
//   * source_ref REQUIRED. An exhibit a court cannot trace to its source is
//     not an exhibit; rows without one are counted as excluded, never listed.
//   * cold descriptions. Deterministic templates over structured fields —
//     no LLM, no characterization of the co-parent, no adjectives. The
//     dad's raw_quote is never used: claim language never enters the packet.
//   * PII-stripped on the way out, belt-and-braces over the intake strip.
//   * nothing invented. No verified rows → an empty packet, not an error and
//     not a placeholder.

import { log } from "./logger.js";
import { stripPii } from "./pii.js";

// Longest description we will carry into an exhibit line. An exhibit entry is
// a pointer to evidence, not the evidence itself.
const DESCRIPTION_MAX = 240;

/**
 * `verified_export` arrives in two shapes: SqlVault returns the view's
 * `row` jsonb column beside the key columns, the memory vault returns the
 * row flat. Both callers (this module and the spreadsheet views) need the
 * inner row, so the unwrapping lives here once.
 */
export function verifiedInnerRow(row) {
  return row?.row && typeof row.row === "object" && !Array.isArray(row.row) ? row.row : row;
}

/**
 * Exhibit labels in the order a filing uses them: A–Z, then AA, AB, … .
 * Index is zero-based.
 */
export function exhibitLabel(index) {
  let n = Number(index);
  if (!Number.isInteger(n) || n < 0) throw new Error("exhibit label index must be a non-negative integer");
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function isoDate(v) {
  if (v == null || v === "") return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function clockTime(v) {
  if (v == null || v === "") return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(11, 16);
}

// Event types rendered as the cold noun a filing would use.
const EVENT_LABELS = {
  late_exchange: "Late exchange",
  denied_visit: "Denied visit",
  exchange: "Exchange",
  visit: "Visit",
  call: "Call",
  other: "Logged event",
};

const CHANNEL_LABELS = {
  ofw: "OFW",
  text: "Text message",
  email: "Email",
  other: "Message",
};

const DOC_LABELS = {
  statement: "Statement",
  tax_return: "Tax return",
  photo: "Photograph",
  screenshot: "Screenshot",
  court: "Court filing",
  other: "Document",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthName(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function sentence(parts) {
  const text = parts.filter((p) => p != null && String(p).trim() !== "").join(" ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

function truncate(text) {
  if (text.length <= DESCRIPTION_MAX) return text;
  return `${text.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`;
}

/**
 * Cold, deterministic one-liner per verified row. Structured fields only:
 * `raw_quote` (the dad's words — claim language) is never read here.
 */
export function describeVerifiedRow(sourceTable, inner) {
  if (sourceTable === "events") {
    const label = EVENT_LABELS[inner.event_type] ?? EVENT_LABELS.other;
    const on = isoDate(inner.occurred_at);
    const at = inner.location ? `at ${inner.location}` : "";
    const scheduled = clockTime(inner.scheduled_at);
    const occurred = clockTime(inner.occurred_at);
    const times = scheduled && occurred ? `scheduled ${scheduled}, recorded ${occurred}` : "";
    return sentence([label, on ? `on ${on}` : "", at, times ? `(${times})` : ""]);
  }

  if (sourceTable === "communications") {
    const channel = CHANNEL_LABELS[inner.channel] ?? CHANNEL_LABELS.other;
    const when = isoDate(inner.sent_at) || isoDate(inner.created_at);
    const head =
      inner.direction === "pull"
        ? `${channel} record pulled`
        : inner.direction === "incoming"
          ? `${channel} message received`
          : `${channel} message sent`;
    const body = inner.body_cold ? `— ${String(inner.body_cold).trim()}` : "";
    return sentence([head, when ? `on ${when}` : "", body]);
  }

  if (sourceTable === "documents") {
    const label = DOC_LABELS[inner.doc_type] ?? DOC_LABELS.other;
    const start = isoDate(inner.period_start);
    const end = isoDate(inner.period_end);
    const period = start && end ? (start === end ? `dated ${start}` : `covering ${start} to ${end}`) : start ? `dated ${start}` : "";
    return sentence([label, period]);
  }

  if (sourceTable === "month_summary") {
    const month = monthName(inner.month);
    const text = inner.summary_text ? `— ${String(inner.summary_text).trim()}` : "";
    return sentence([month ? `Month summary for ${month}` : "Month summary", text]);
  }

  return sentence(["Verified record"]);
}

// The date an exhibit is filed under: when the thing happened, not when the
// row was written. Falls back down the chain and finally to created_at.
function exhibitDate(sourceTable, inner) {
  if (sourceTable === "events") return isoDate(inner.occurred_at) || isoDate(inner.created_at);
  if (sourceTable === "communications") return isoDate(inner.sent_at) || isoDate(inner.created_at);
  if (sourceTable === "documents") return isoDate(inner.period_start) || isoDate(inner.created_at);
  if (sourceTable === "month_summary") return isoDate(inner.month) || isoDate(inner.created_at);
  return isoDate(inner.created_at);
}

const KIND_BY_TABLE = {
  events: "event",
  communications: "communication",
  documents: "document",
  month_summary: "month_summary",
};

/**
 * Build the exhibit packet for one dad from the verified read surface.
 *
 * Returns
 *   { dad_id, generated_at, count, exhibits: [...], excluded: { no_source_ref } }
 *
 * `exhibits` is chronological, then lettered A, B, C … — so the letters are
 * gapless and stable for a given set of rows. Empty vault → count 0 and an
 * empty list.
 */
export async function buildExhibitPacket(vault, dadId) {
  const rows = (await vault.verifiedExport(dadId)) ?? [];

  let noSourceRef = 0;
  const candidates = [];

  for (const row of rows) {
    const inner = verifiedInnerRow(row);
    const sourceTable = row.source_table ?? inner.source_table ?? "";
    const pipe = row.pipe ?? inner.pipe;
    // Belt: the read surface is verified-only, but never trust that here —
    // a claim row reaching an exhibit is the one failure this packet cannot
    // ship with.
    if (pipe !== "verified") continue;

    const sourceRef = row.source_ref ?? inner.source_ref ?? "";
    if (!String(sourceRef).trim()) {
      noSourceRef += 1;
      continue;
    }

    candidates.push({
      kind: KIND_BY_TABLE[sourceTable] ?? "record",
      source_table: sourceTable,
      id: row.id ?? inner.id ?? "",
      pipe,
      dated: exhibitDate(sourceTable, inner),
      description: truncate(stripPii(describeVerifiedRow(sourceTable, inner)).text),
      // The citation is stripped too: this list is court-facing, and a
      // source_ref that carried an account number would put it in a filing.
      // Traceability does not depend on the ref surviving intact — every
      // exhibit also carries the vault row `id`, which is the key that
      // resolves it back to the record.
      source_ref: stripPii(String(sourceRef)).text,
    });
  }

  candidates.sort((a, b) => {
    if (a.dated !== b.dated) return a.dated < b.dated ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });

  const exhibits = candidates.map((entry, i) => ({ label: exhibitLabel(i), ...entry }));

  // Brace: assert the rail on the way out. A claim row here means a store
  // bug, and the right answer is to refuse the packet, not to file it.
  for (const ex of exhibits) {
    if (ex.pipe !== "verified") {
      throw new Error("exhibit packet gate: non-verified row reached the exhibit list");
    }
    if (!ex.source_ref) {
      throw new Error("exhibit packet gate: exhibit without source_ref");
    }
  }

  log("exhibit.packet", {
    dad: dadId,
    exhibits: exhibits.length,
    excluded_no_source_ref: noSourceRef,
  });

  return {
    dad_id: dadId,
    generated_at: new Date().toISOString(),
    count: exhibits.length,
    exhibits,
    excluded: { no_source_ref: noSourceRef },
  };
}

/**
 * Financial-disclosure rows — the `affidavit_support` view, flattened the
 * same way in both stores. Verified documents + verified events only; this
 * is the narrow sheet the affidavit's financial section cites, not the whole
 * exhibit list.
 */
export async function affidavitSupportRows(vault, dadId) {
  if (typeof vault.affidavitSupport !== "function") return [];
  const rows = (await vault.affidavitSupport(dadId)) ?? [];
  return rows.map((r) => ({
    dad_id: r.dad_id,
    kind: r.kind,
    id: r.id,
    detail: r.detail ?? "",
    extracted: r.extracted == null ? "" : JSON.stringify(r.extracted),
    period_start: isoDate(r.period_start),
    period_end: isoDate(r.period_end),
  }));
}

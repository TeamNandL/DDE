// Dad export bundle (Slice 21) — everything the vault holds for ONE dad,
// as a zip of JSON + readable text, in two SEPARATE buckets:
//
//   claims/    — what he said (pipe = 'claim') plus every bot-owned working
//                record (candidates, plan, translations, involvement, legal
//                intake, check-ins, state). Never proof.
//   verified/  — only rows with pipe = 'verified' (the same set the
//                verified_export view serves). A claim is NEVER packaged here.
//
// Every string in the bundle goes through stripPii (no SSNs, no account
// numbers) and token masking (any dde-stub- token → last 4). The dad's own
// ids stay intact so he can cite a row. Nothing here is written back.

import { createHash } from "node:crypto";
import { stripPii } from "./pii.js";
import { zipStore } from "./zip.js";

export const CLAIM_TABLES = [
  "events", "communications", "documents", "month_summary", "state",
  "candidate_facts", "notifications", "plan_topics", "plan_drafts",
  "translations", "translator_calendar_candidates", "involvement_fields",
  "legal_intakes", "legal_handoff_drafts", "evidence_log",
];

/** Tables that carry a pipe column and can therefore hold verified rows. */
export const PIPE_TABLES = ["events", "communications", "documents", "month_summary"];

const TOKEN_RE = /dde-stub-[\w-]+/g;

export function maskTokensInText(s) {
  return String(s).replace(TOKEN_RE, (m) => `…${m.slice(-4)}`);
}

/** Deep-sanitize: strings → PII-stripped + token-masked. Structure untouched. */
export function sanitizeDeep(v) {
  if (typeof v === "string") return maskTokensInText(stripPii(v).text);
  if (Array.isArray(v)) return v.map(sanitizeDeep);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = sanitizeDeep(val);
    return out;
  }
  return v;
}

function iso(v) {
  return v instanceof Date ? v.toISOString() : v == null ? "" : String(v);
}

function renderRows(table, rows) {
  if (!rows.length) return `## ${table}\n(none)\n`;
  const lines = [`## ${table} (${rows.length})`];
  for (const r of rows) {
    const head = [r.id, iso(r.created_at ?? r.updated_at)].filter(Boolean).join(" · ");
    lines.push(`- ${head}`);
    for (const [k, v] of Object.entries(r)) {
      if (k === "id" || k === "dad_id" || v == null || v === "") continue;
      const s = typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : iso(v);
      lines.push(`    ${k}: ${s}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Split a full per-table dump into claim / verified buckets.
 * @param {Record<string, any[]>} all  table → rows (this dad only)
 */
export function splitBuckets(all) {
  const claims = {};
  const verified = {};
  for (const t of CLAIM_TABLES) {
    const rows = all[t] ?? [];
    if (PIPE_TABLES.includes(t)) {
      claims[t] = rows.filter((r) => r.pipe !== "verified");
      verified[t] = rows.filter((r) => r.pipe === "verified");
    } else {
      claims[t] = rows; // bot-owned working records are never verified
    }
  }
  return { claims, verified };
}

/**
 * Build the bundle. `all` is the raw per-table dump from vault.exportAll().
 * Returns { zip, sha256, bytes, counts } — the receipt fields come from here.
 */
export function buildDadExport({ dad_id, all, now = Date.now() }) {
  const at = new Date(now).toISOString();
  const { claims, verified } = splitBuckets(sanitizeDeep(all));
  const count = (b) => Object.values(b).reduce((n, rows) => n + rows.length, 0);
  const counts = { claims: count(claims), verified: count(verified) };

  const readme = [
    "DDE — your export",
    "",
    `dad_id: ${dad_id}`,
    `exported_at: ${at}`,
    "",
    "claims/    — what you told DDE, and DDE's working notes for you. Not proof.",
    "verified/  — only records that were verified against a source (OFW pull, document).",
    "",
    "A claim is never placed in verified/. Tokens are masked to their last 4.",
    "Tax ids, account numbers, phone numbers and street addresses were removed.",
    "",
    "This is a copy. Nothing in this file changes what DDE holds.",
    "",
  ].join("\n");

  const text = (bucket) =>
    Object.entries(bucket)
      .map(([t, rows]) => renderRows(t, rows))
      .join("\n");

  const entries = [
    { name: "README.txt", data: readme },
    { name: "claims/claims.json", data: JSON.stringify(claims, null, 2) + "\n" },
    { name: "claims/claims.txt", data: `# CLAIMS — not proof\n\n${text(claims)}` },
    { name: "verified/verified.json", data: JSON.stringify(verified, null, 2) + "\n" },
    { name: "verified/verified.txt", data: `# VERIFIED — source-checked rows only\n\n${text(verified)}` },
  ];
  const zip = zipStore(entries, { now });
  const sha256 = createHash("sha256").update(zip).digest("hex");
  return { zip, sha256, bytes: zip.length, counts, exported_at: at };
}

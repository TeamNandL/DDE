// Spreadsheet views generated on demand from the vault.
// The vault is the source of truth. These files are outputs — do not load
// them back in, and do not commit them as data.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

export const VIEW_EVENTS = "events";
export const VIEW_STATE = "state";
export const VIEW_VERIFIED = "verified";
export const ALL_VIEWS = [VIEW_EVENTS, VIEW_STATE, VIEW_VERIFIED];

export const EVENTS_HEADERS = [
  "id",
  "dad_id",
  "pipe",
  "event_type",
  "occurred_at",
  "scheduled_at",
  "location",
  "kids",
  "notes",
  "source_ref",
  "raw_quote",
  "created_at",
];

export const STATE_HEADERS = [
  "dad_id",
  "phase",
  "this_week",
  "next_action",
  "missing_index",
  "missing_item",
  "is_next_action",
  "updated_at",
];

export const VERIFIED_HEADERS = [
  "source_table",
  "id",
  "dad_id",
  "pipe",
  "created_at",
  "source_ref",
  "event_type",
  "occurred_at",
  "direction",
  "channel",
  "body_cold",
  "sent_at",
  "doc_type",
  "month",
  "summary_text",
];

function iso(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function kidsCell(v) {
  if (Array.isArray(v)) return v.join(", ");
  if (v == null) return "";
  return String(v);
}

function cell(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.join(", ");
  return v;
}

export function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(esc).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => esc(row[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

export async function toXlsx(sheets, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "DDE vault-app";
  wb.created = new Date();
  const generated = wb.addWorksheet("_generated");
  generated.columns = [
    { header: "key", key: "key", width: 22 },
    { header: "value", key: "value", width: 80 },
  ];
  generated.addRow({ key: "source_of_truth", value: "vault — this workbook is a generated view, not a store" });
  generated.addRow({ key: "generated_at", value: new Date().toISOString() });
  generated.addRow({ key: "view", value: meta.view ?? sheets.map((s) => s.name).join(",") });
  generated.addRow({ key: "dad_id", value: meta.dad_id ?? "" });
  generated.addRow({ key: "store", value: meta.store ?? "" });

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    ws.columns = sheet.headers.map((h) => ({
      header: h,
      key: h,
      width: Math.min(48, Math.max(14, h.length + 2)),
    }));
    for (const row of sheet.rows) {
      const mapped = {};
      for (const h of sheet.headers) mapped[h] = cell(row[h]);
      ws.addRow(mapped);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function eventsTimeLog(vault, dadId) {
  const events = await vault.listEvents(dadId);
  return events.map((e) => ({
    id: e.id,
    dad_id: e.dad_id,
    pipe: e.pipe,
    event_type: e.event_type,
    occurred_at: iso(e.occurred_at),
    scheduled_at: iso(e.scheduled_at),
    location: e.location ?? "",
    kids: kidsCell(e.kids),
    notes: e.notes ?? "",
    source_ref: e.source_ref ?? "",
    raw_quote: e.raw_quote ?? "",
    created_at: iso(e.created_at),
  }));
}

export async function stateMissingChecklist(vault, dadId) {
  const state = await vault.getState(dadId);
  if (!state) return [];
  const missing = Array.isArray(state.missing) ? state.missing : [];
  if (missing.length === 0) {
    return [
      {
        dad_id: state.dad_id,
        phase: state.phase ?? "",
        this_week: state.this_week ?? "",
        next_action: state.next_action ?? "",
        missing_index: "",
        missing_item: "",
        is_next_action: "",
        updated_at: iso(state.updated_at),
      },
    ];
  }
  return missing.map((item, i) => ({
    dad_id: state.dad_id,
    phase: state.phase ?? "",
    this_week: state.this_week ?? "",
    next_action: state.next_action ?? "",
    missing_index: i + 1,
    missing_item: item,
    is_next_action: item === state.next_action ? "yes" : "",
    updated_at: iso(state.updated_at),
  }));
}

function flattenVerified(row) {
  const inner = row.row && typeof row.row === "object" && !Array.isArray(row.row) ? row.row : row;
  return {
    source_table: row.source_table ?? inner.source_table ?? "",
    id: row.id,
    dad_id: row.dad_id,
    pipe: row.pipe,
    created_at: iso(row.created_at ?? inner.created_at),
    source_ref: row.source_ref ?? inner.source_ref ?? "",
    event_type: inner.event_type ?? "",
    occurred_at: iso(inner.occurred_at),
    direction: inner.direction ?? "",
    channel: inner.channel ?? "",
    body_cold: inner.body_cold ?? "",
    sent_at: iso(inner.sent_at),
    doc_type: inner.doc_type ?? "",
    month: inner.month ?? "",
    summary_text: inner.summary_text ?? "",
  };
}

export async function verifiedExportView(vault, dadId) {
  const rows = await vault.verifiedExport(dadId);
  return rows.map(flattenVerified);
}

const VIEW_BUILDERS = {
  [VIEW_EVENTS]: {
    file: "events_time_log",
    sheet: "events",
    headers: EVENTS_HEADERS,
    build: eventsTimeLog,
  },
  [VIEW_STATE]: {
    file: "state_missing_checklist",
    sheet: "state_missing",
    headers: STATE_HEADERS,
    build: stateMissingChecklist,
  },
  [VIEW_VERIFIED]: {
    file: "verified_export",
    sheet: "verified_export",
    headers: VERIFIED_HEADERS,
    build: verifiedExportView,
  },
};

export async function buildView(vault, dadId, view) {
  const spec = VIEW_BUILDERS[view];
  if (!spec) throw new Error(`unknown export view: ${view}`);
  const rows = await spec.build(vault, dadId);
  return { ...spec, view, rows };
}

export async function writeExports({ vault, dadId, outDir, views = ALL_VIEWS, store = "" }) {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const view of views) {
    const spec = await buildView(vault, dadId, view);
    const csvPath = resolve(dir, `${spec.file}.csv`);
    const xlsxPath = resolve(dir, `${spec.file}.xlsx`);
    writeFileSync(csvPath, toCsv(spec.headers, spec.rows), "utf8");
    const buf = await toXlsx([{ name: spec.sheet, headers: spec.headers, rows: spec.rows }], {
      view: spec.file,
      dad_id: dadId,
      store,
    });
    writeFileSync(xlsxPath, buf);
    written.push({
      view,
      rows: spec.rows.length,
      csv: csvPath,
      xlsx: xlsxPath,
    });
  }
  return { dir, written };
}

export function defaultExportDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../exports");
}

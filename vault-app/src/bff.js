// Thin BFF (§5) — seats never touch the vault directly.
//
// Phase 1: function signatures + one working implementation each, mapped
// 1:1 to the contract routes. Optional HTTP lives in server.js
// (`npm run serve` / `--http`) — this module stays framework-free.
//
// Minimal token gate (not OAuth/JWT): POST /vault/provision issues an opaque
// token. Only the SHA-256 hash is persisted via the durable token store
// (Postgres when vault is on DATABASE_URL; else .dde-tokens.json). Mutating
// routes and sensitive reads check Authorization: Bearer / X-DDE-Token via
// checkToken against that store.
//
// Rule (§5): there is NO endpoint that returns claim rows to Reporting.

import { randomUUID } from "node:crypto";
import { extract, harmCheck, hasVenom, stripVenom } from "./extract.js";
import { log } from "./logger.js";
import { stripPii } from "./pii.js";
import { clampProgressPatch, progressChipLine, progressLine, softGrade } from "./progress.js";
import { createMemoryTokenStore, hashToken, isTokenExpired, shouldTouch, tokenTtlMs } from "./tokens.js";
import { buildDadExport } from "./dadexport.js";
import { createMemoryOpsStore, deleteGraceMs, exportFreshMs } from "./opsstore.js";
import { parseSearchOpts } from "./search.js";
import {
  candidateFacts,
  checkinWindows,
  crossCheck,
  effectiveStatus,
  factLine,
} from "./courtprep.js";
import {
  DRAFT_KINDS,
  LAWYER_LINE,
  PLAN_TOPICS,
  TOPIC_KEYS,
  checkAnswer,
  nextTopic,
  renderDraft,
  topicDef,
  topicPrompt,
} from "./plan.js";
import {
  CLAIM_FOOTER as INVOLVEMENT_FOOTER,
  FIELDS as INVOLVEMENT_FIELDS,
  MAX_KIDS,
  checkFieldUpdate,
  checkKid,
  fieldDef as involvementFieldDef,
  fieldStatus,
  missingNext,
  renderOnePager,
} from "./involvement.js";
import {
  DRAFT_FOOTER as LEGAL_DRAFT_FOOTER,
  FLAG_LABELS as LEGAL_FLAG_LABELS,
  HUMAN_LINE as LEGAL_HUMAN_LINE,
  LAWYER_LINE as LEGAL_LAWYER_LINE,
  capture as legalCapture,
  needsHuman as legalNeedsHuman,
  nextStep as legalNextStep,
  renderPacket as legalRenderPacket,
} from "./legalintake.js";
import { DEFEAT_SAY, FAILSAFE_SAY, SAFETY_SAY, coach } from "./calmdraft.js";
import { LAWYER_LINE as TRANSLATOR_LAWYER_LINE, explain as translatorExplain } from "./translator.js";

function unknownDad() {
  const err = new Error("unknown dad");
  err.status = 404;
  return err;
}

// Tone flags the GRADE catches but the venom STRIP does not drop —
// "This is stupid." is storable, just not send-ready as written.
const TONE_RE = /\b(stupid|ridiculous|pathetic|idiotic|insane|absurd|a joke)\b/i;

// Draft soft grade — ONE heuristic, no LLM: "ready" = no venom (neither
// stripped at write nor present), no tone flag, and fits one cold-ask
// breath (<= 280 chars); otherwise "tighten". Coaching, never a gate.
// The grade is computed ONCE at the draft POST and PERSISTED — reads
// must return the stored grade, never recompute from the cleaned body
// (the venom that earned "tighten" is already gone from it).
export function draftSoftGrade(bodyText, venomWasStripped = false) {
  const text = String(bodyText ?? "");
  return !venomWasStripped && !hasVenom(text) && !TONE_RE.test(text) && text.length <= 280
    ? "ready"
    : "tighten";
}

// Coach / Tone (vent hot → send cold). Drift 2 — de-escalate vs document:
// most drafts are de-escalation (sending is optional; silence is fine), but
// a draft that ASKS the co-parent for something the dad wants on the
// record (appointments, calendar, school, records, schedule) flips to
// "document" — here silence throws the evidence away. Behavior words only;
// never the co-parent's motive. One heuristic, no LLM.
const ASK_RE = /\b(please|can you|could you|would you|will you|i'?m asking|i am asking|i request|let me know|confirm)\b/i;
const RECORD_RE =
  /\b(calendar|appointments?|doctor|dentist|counsel\w*|therap\w*|medical|school|teacher|records?|schedule|pick-?up|drop-?off|exchange)\b/i;

export function draftMode(bodyText) {
  const text = String(bodyText ?? "");
  return ASK_RE.test(text) && RECORD_RE.test(text) ? "document" : "de_escalate";
}

// The ONE beat Chip says after showing the draft body: draft ≠ send plus
// exactly one Next. No "hang tight", no second step, no menu.
export function draftSayLine(mode) {
  return mode === "document"
    ? "Not sent. Next: send it yourself — it puts your ask on the record."
    : "Not sent. Next: read it once; send it only if it still fits.";
}

// Missing-seed packs: PII-safe blank LABELS only — prompts for facts the
// dad fills in later via /vault/missing/fill, never case data themselves.
// ≤ 7 items (checklist rail) and ≤ 80 chars each.
export const SEED_PACKS = {
  kids_facts: [
    "Kids school name",
    "Teacher name (oldest)",
    "Pediatrician / clinic name",
    "After-school pickup person",
    "Emergency contact relationship",
  ],
};

// Return-loop greeting for Chip. Plain text only — never a token, URL, or
// dad_id (Chip carries auth separately). Null when there is no Next: an
// empty Next is never invented into a "last time". PII-stripped as a
// guarantee even though next_action is chase text.
export function returnLine(lastNext) {
  if (!lastNext) return null;
  return stripPii(`Last time: ${lastNext}. How'd it go?`).text;
}

// Cold-ask variant: when the last Next was a cold ask, greet with its
// short summary instead of the raw next_action wording. Same rails:
// plain speech, PII-stripped, null when there is nothing to say.
export function coldAskLine(summary) {
  if (typeof summary !== "string" || !summary.trim()) return null;
  return stripPii(`Last time: cold ask — ${summary.trim()}. How'd it go?`).text;
}

// Notice path (walk paste 1): the dad-facing line Chip speaks after a
// cancelled/denied-visit vent — one plain noticed sentence, then "Matter to
// you?". No date, no claim/verification jargon (that stays in
// noticed_text, the record-facing string), no Next. Weekday only when the
// dad said one. Null for every other event type — nothing invented.
const WEEKDAY_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

export function noticeSayLine(text, eventType) {
  if (eventType !== "denied_visit") return null;
  const lower = String(text ?? "").toLowerCase();
  const day = lower.match(WEEKDAY_RE)?.[1];
  const visit = day ? `your ${day[0].toUpperCase()}${day.slice(1)} visit` : "your visit";
  const said = /\b(cancel\w*|called off)\b/.test(lower)
    ? `They cancelled ${visit}.`
    : `${visit[0].toUpperCase()}${visit.slice(1)} didn't happen.`;
  return `${said} Matter to you?`;
}

// Talk/text fork (Slice 4, locked): every intake offers ONE short fork —
// the dad picks talk or text — and either way he gets the same feedback:
// an ack, claim ≠ verified in plain words, and exactly one Next. Talk is
// the dad speaking to Chip (Chip hands the vault the words); text is
// typed. Same pipe, same rails, same outcome.
export const FORK_LINE = "Want to tell me? Talk or text.";
export const TELL_CHANNELS = ["talk", "text"];

export function tellFeedback(nextAction) {
  const next = nextAction ? stripPii(String(nextAction)).text.trim() : "";
  const nextPart = next ? `Next: ${next.replace(/[.!?]+$/, "")}.` : "Next: tell me when something new happens.";
  return `I heard you. It's kept as your account — not proof yet. ${nextPart}`;
}

/**
 * @param {object} vault
 * @param {{ tokenStore?: object }} [opts]
 */
export function makeBff(vault, opts = {}) {
  const tokenStore = opts.tokenStore || createMemoryTokenStore();
  const ttlMs = opts.tokenTtlMs ?? tokenTtlMs();
  // Slice 21 ledger: export receipts + deletions (operator metadata only).
  const opsStore = opts.opsStore || createMemoryOpsStore();
  const freshMs = opts.exportFreshMs ?? exportFreshMs();
  const graceMs = opts.deleteGraceMs ?? deleteGraceMs();

  async function requireDad(dad_id) {
    const state = await vault.getState(dad_id);
    if (!state) throw unknownDad();
    return state;
  }

  // Court-prep capture (COURT_PREP_PRINCIPLES §2–§4). Runs AFTER the harm
  // rail (callers never reach here on harm) on PII- and venom-stripped
  // text: every keyword-hit sentence becomes one low-confidence candidate,
  // cross-checked against stored OFW rows (read-only). Statement drops are
  // money (Track 2, parked) and are not captured here.
  async function captureCandidates(dad_id, text, source, opts = {}, source_event_id = null) {
    const clean = stripVenom(stripPii(text).text);
    const facts = candidateFacts(clean, opts.referenceDate ?? new Date());
    if (facts.length === 0) return 0;
    const ofw = await vault.listOfwPulls(dad_id);
    for (const fact of facts) {
      const check = crossCheck(fact, ofw);
      await vault.insertCandidate(dad_id, {
        ...fact,
        source,
        source_event_id,
        status: check.status,
        ofw_ref: check.ofw_ref,
        line: factLine(fact, check),
      });
    }
    // §5: the dad's words inside an open check-in window answer it.
    await vault.completeOpenCheckins(dad_id, new Date(opts.now ?? Date.now()).toISOString());
    log("candidates.capture", { dad: dad_id, source, n: facts.length });
    return facts.length;
  }

  // Re-run the OFW stub over the dad's candidates (after a new OFW pull).
  // Updates the candidate rows only — the OFW rows are never touched.
  async function recheckCandidates(dad_id) {
    const ofw = await vault.listOfwPulls(dad_id);
    let changed = 0;
    for (const c of await vault.listCandidates(dad_id)) {
      const check = crossCheck(c, ofw);
      const line = factLine(c, check);
      if (check.status !== c.status || line !== c.line) {
        await vault.updateCandidateCheck(dad_id, c.id, { ...check, line });
        changed += 1;
      }
    }
    log("candidates.recheck", { dad: dad_id, changed });
    return changed;
  }

  const REVIEW_LABEL = { needs_reviewed: "Needs reviewed", kept: "Kept", tossed: "Tossed" };

  // ---- Parenting Plan seat helpers (Slice 14) -------------------------------
  async function planRows(dad_id) {
    await vault.ensurePlanTopics(
      dad_id,
      PLAN_TOPICS.map((t, i) => ({ key: t.key, position: i + 1 })),
    );
    return vault.listPlanTopics(dad_id);
  }

  function planBad(msg, status = 400) {
    return Object.assign(new Error(msg), { status });
  }

  function planTopicView(r) {
    const def = topicDef(r.topic_key);
    const pick = (list, key) => list.find((o) => o.key === key)?.label ?? null;
    return {
      topic: r.topic_key,
      title: def.title,
      status: r.status,
      choice: r.choice ?? null,
      choice_label: r.choice ? pick(def.options, r.choice) : null,
      stance: r.stance ?? null,
      depth: r.depth ?? "simple",
      detail: r.detail ?? null,
      detail_label: r.detail ? pick(def.deeper.options, r.detail) : null,
    };
  }

  function planNext(rows, depth = "simple") {
    const key = nextTopic(rows);
    return key ? topicPrompt(key, depth) : null;
  }

  // ---- Involvement Cheat Sheet helpers (Slice 16) ---------------------------
  function todayIso() {
    return new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
  }

  async function involvementRows(dad_id, kid) {
    const kids = await vault.listInvolvementKids(dad_id);
    if (!kids.includes(kid) && kids.length >= MAX_KIDS) {
      throw Object.assign(new Error(`at most ${MAX_KIDS} kids`), { status: 400 });
    }
    const created = await vault.ensureInvolvement(
      dad_id,
      kid,
      INVOLVEMENT_FIELDS.map((f, i) => ({ key: f.key, position: i + 1 })),
    );
    return { created, rows: await vault.listInvolvement(dad_id, kid) };
  }

  function involvementView(r) {
    return {
      field: r.field_key,
      label: involvementFieldDef(r.field_key).label,
      status: fieldStatus(r),
      value: r.value ?? null,
      asked_on: r.asked_on ?? null,
      asked_via: r.asked_via ?? null,
      outcome: r.outcome ?? null,
      claim: true,
      verified: false,
    };
  }

  function involvementCounts(rows) {
    const c = { filled: 0, asked: 0, blank: 0 };
    for (const r of rows) c[fieldStatus(r)] += 1;
    return c;
  }

  // One Missing + one Next: the requested kid, else the first kid (by key)
  // with anything left, else the first kid.
  async function involvementSpeak(dad_id, kid) {
    const kids = kid ? [kid] : await vault.listInvolvementKids(dad_id);
    let first = null;
    for (const k of kids) {
      const mn = missingNext(await vault.listInvolvement(dad_id, k), todayIso());
      first ??= mn;
      if (mn.missing) return mn;
    }
    return first ?? { missing: null, next: { job: "re_engagement", line: "Add a kid to start the cheat sheet." }, left: 0 };
  }

  // ---- Legal Intake helpers (Slice 17) ---------------------------------------
  function publicHandoff(d) {
    if (!d) return null;
    return {
      id: d.id,
      version: d.version,
      body: d.body,
      created_at: d.created_at,
      sent_at: null, // draft ≠ send — there is no send path
      status: "draft",
    };
  }

  function publicLegalIntake(rec, draft) {
    const human = legalNeedsHuman(rec);
    return {
      id: rec.id,
      created_at: rec.created_at,
      who: rec.who,
      urgency: rec.urgency,
      what: rec.what_cold,
      flags: [...rec.flags],
      flag_lines: rec.flags.map((f) => LEGAL_FLAG_LABELS[f]),
      human_review: human,
      human_line: human ? LEGAL_HUMAN_LINE : null,
      route: rec.route,
      claim: true,
      verified: false,
      next: legalNextStep(rec, Boolean(draft)),
      handoff: publicHandoff(draft),
      lawyer_line: LEGAL_LAWYER_LINE,
    };
  }

  async function requireLegalIntake(dad_id, id) {
    if (id !== undefined && (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
      throw Object.assign(new Error("id must be an intake id"), { status: 400 });
    }
    const rec = id ? await vault.getLegalIntake(dad_id, id) : await vault.latestLegalIntake(dad_id);
    if (!rec) throw Object.assign(new Error("no intake yet"), { status: 404 });
    return rec;
  }

  // Process Translator view: the stored, cold result + private candidates.
  // Never the raw paste; the cold input stays in the row only.
  function publicTranslation(rec) {
    return {
      id: rec.id,
      created_at: rec.created_at,
      input_kind: rec.input_kind,
      term_keys: [...(rec.term_keys ?? [])],
      verdict_request: Boolean(rec.verdict_request),
      clock_flag: Boolean(rec.clock_flag),
      ...rec.result,
      calendar_candidates: (rec.calendar_candidates ?? []).map((c) => ({
        id: c.id,
        label: c.label,
        date_text: c.date_text,
        on_date: c.on_date ?? null,
        visibility: c.visibility,
        status: c.status,
        verified: false,
        write_target: null,
      })),
      lawyer_line: TRANSLATOR_LAWYER_LINE,
    };
  }

  function publicCandidate(c) {
    return {
      id: c.id,
      what: c.what,
      who: c.who ?? [],
      when_text: c.when_text ?? null,
      when_on: c.when_on ?? null,
      kids: c.kids ?? [],
      confidence: c.confidence ?? "low",
      review: c.review ?? "needs_reviewed",
      label: REVIEW_LABEL[c.review ?? "needs_reviewed"],
      status: c.status,
      line: c.line,
      quote: c.quote ?? null,
      source: c.source,
      created_at: c.created_at,
    };
  }

  function publicNotification(n, now) {
    return {
      id: n.id,
      kind: n.kind,
      slot: n.slot,
      for_date: n.for_date,
      title: n.title,
      due_start: new Date(n.due_start).toISOString(),
      due_end: new Date(n.due_end).toISOString(),
      status: effectiveStatus(n, now),
    };
  }


  return {
    /** Durable (or memory) token store. Exposed for tests/docs only. */
    _tokenStore: tokenStore,

    async requireDad(dad_id) {
      return requireDad(dad_id);
    },

    /**
     * Verify opaque provision token for dad_id against durable store.
     * missing/unknown/revoked token → 401; requested dad does not exist
     * (wiped or never provisioned) → 401 with the SAME body, checked before
     * the cross-dad test so nothing leaks (Slice 21 F1); idle past the TTL →
     * 401 "token expired" (and the row is revoked on the spot, so the death
     * survives a rollback); token belongs to another existing dad → 403. An
     * accepted token has its last_seen_at slid forward (throttled) — 30 days
     * of INACTIVITY.
     */
    async checkToken(dad_id, token) {
      if (typeof token !== "string" || !token.trim()) {
        const err = new Error("unauthorized");
        err.status = 401;
        throw err;
      }
      const token_hash = hashToken(token.trim());
      const row = await tokenStore.lookupActive(token_hash);
      if (!row) {
        const err = new Error("unauthorized");
        err.status = 401;
        throw err;
      }
      if (!(await vault.getState(dad_id))) {
        const err = new Error("unauthorized"); // unknown dad: identical to revoked
        err.status = 401;
        throw err;
      }
      if (row.dad_id !== dad_id) {
        const err = new Error("forbidden");
        err.status = 403;
        throw err;
      }
      const nowMs = opts.now ?? Date.now();
      if (isTokenExpired(row, nowMs, ttlMs)) {
        await tokenStore.revoke(token_hash);
        log("token.expired", { dad: dad_id });
        const err = new Error("token expired");
        err.status = 401;
        throw err;
      }
      if (shouldTouch(row, nowMs)) {
        await tokenStore.touch(token_hash, new Date(nowMs).toISOString());
      }
      return true;
    },

    // — Token lifecycle (Slice 20). Callers are already past the bearer gate.
    // POST /vault/logout {dad_id} (also POST /vault/panic) ->
    // {logged_out: true, revoked: n}. ALL-DEVICE: every token this dad holds
    // dies now, the caller's included. Threat model: a device left at the
    // other house — single-device logout would leave that one alive.
    async postVaultLogout({ dad_id }) {
      await requireDad(dad_id);
      const revoked = await tokenStore.revokeAllForDad(dad_id);
      log("token.logout_all", { dad: dad_id, revoked });
      return { logged_out: true, revoked };
    },

    // Operator only (Nick, CLI) — never an HTTP route. Kills every token
    // for the dad. Vault data untouched.
    async revokeDad({ dad_id }) {
      await requireDad(dad_id);
      const revoked = await tokenStore.revokeAllForDad(dad_id);
      log("token.revoke", { dad: dad_id, revoked });
      return { revoked };
    },

    // Operator only (CLI / tests) — never an HTTP route. Mints one more
    // token for an existing dad. Raw token returned once; hash stored.
    async mintToken({ dad_id }) {
      await requireDad(dad_id);
      // A dad inside the deletion window gets no new token until Nick cancels.
      const del = await opsStore.getDeletion(dad_id);
      if (del && !del.cancelled_at && !del.purged_at) {
        const err = new Error("deletion pending — cancel it first");
        err.status = 409;
        throw err;
      }
      const token = `dde-stub-${randomUUID()}`;
      const at = new Date(opts.now ?? Date.now()).toISOString();
      await tokenStore.insert({
        dad_id,
        token_hash: hashToken(token),
        created_at: at,
        last_seen_at: at,
      });
      log("token.mint", { dad: dad_id });
      return { dad_id, token };
    },

    // Operator only — revoke every token for the dad, then mint a fresh one
    // (lost phone, leaked link, idle-expired link).
    async reissueToken({ dad_id }) {
      await requireDad(dad_id);
      const revoked = await tokenStore.revokeAllForDad(dad_id);
      const out = await this.mintToken({ dad_id });
      log("token.reissue", { dad: dad_id, revoked });
      return { ...out, revoked };
    },

    // ---- Slice 21: export (dad-facing OK) + delete (Nick only) ------------

    /** Ledger. Exposed for tests/docs only. */
    _opsStore: opsStore,

    /**
     * Build the dad's bundle and record a receipt. actor: 'dad' (HTTP, past
     * the gate) or 'operator' (CLI). Returns the zip + receipt; the receipt is
     * what later unlocks a delete.
     */
    async exportDad({ dad_id, actor = "dad", now }) {
      await requireDad(dad_id);
      const nowMs = now ?? opts.now ?? Date.now();
      const all = await vault.exportAll(dad_id);
      const built = buildDadExport({ dad_id, all, now: nowMs });
      const receipt = await opsStore.insertReceipt({
        dad_id,
        sha256: built.sha256,
        bytes: built.bytes,
        actor,
        created_at: new Date(nowMs).toISOString(),
      });
      log("export.receipt", { dad: dad_id, actor, bytes: built.bytes, claims: built.counts.claims, verified: built.counts.verified });
      return { ...built, receipt };
    },

    // GET /vault/export {dad_id} -> application/zip. Dad-facing; same gate.
    async getVaultExportZip({ dad_id }) {
      return this.exportDad({ dad_id, actor: "dad" });
    },

    /**
     * SOFT delete (Nick CLI only — no HTTP path exists). Server rail: refused
     * (412) unless a receipt newer than DDE_EXPORT_FRESH_DAYS exists. Revokes
     * every token now; data stays intact and cancelable until purge_at.
     */
    async requestDelete({ dad_id, now }) {
      await requireDad(dad_id);
      const nowMs = now ?? opts.now ?? Date.now();
      const receipt = await opsStore.latestReceipt(dad_id);
      const fresh = receipt && nowMs - Date.parse(receipt.created_at) <= freshMs;
      if (!fresh) {
        const err = new Error("export receipt required — export this dad first");
        err.status = 412;
        throw err;
      }
      const row = await opsStore.requestDeletion({
        dad_id,
        receipt_id: receipt.id,
        requested_at: new Date(nowMs).toISOString(),
        purge_at: new Date(nowMs + graceMs).toISOString(),
      });
      const revoked = await tokenStore.revokeAllForDad(dad_id);
      log("delete.soft", { dad: dad_id, revoked, purge_at: row.purge_at });
      return { ...row, revoked };
    },

    /** Cancel inside the window. Data untouched; tokens stay revoked (reissue). */
    async cancelDelete({ dad_id, now }) {
      await requireDad(dad_id);
      const nowMs = now ?? opts.now ?? Date.now();
      const row = await opsStore.cancelDeletion(dad_id, new Date(nowMs).toISOString());
      if (!row) {
        const err = new Error("no pending deletion");
        err.status = 404;
        throw err;
      }
      log("delete.cancel", { dad: dad_id });
      return row;
    },

    /**
     * HARD wipe every deletion whose window has passed (optionally one dad).
     * Re-checks the receipt gate at wipe time. Irreversible: rows are gone
     * from every table and the token rows are dropped. A tombstone
     * (dad_id + timestamps + counts) stays in dde_deletions.
     */
    async purgeDue({ now, dad_id } = {}) {
      const nowMs = now ?? opts.now ?? Date.now();
      const due = (await opsStore.listDue(nowMs)).filter((d) => !dad_id || d.dad_id === dad_id);
      const purged = [];
      for (const d of due) {
        const receipt = await opsStore.latestReceipt(d.dad_id);
        if (!receipt) {
          log("delete.purge_refused", { dad: d.dad_id, reason: "no_receipt" });
          continue;
        }
        const counts = await vault.wipeDad(d.dad_id);
        counts.tokens = await tokenStore.purgeDad(d.dad_id);
        const at = new Date(nowMs).toISOString();
        await opsStore.markPurged(d.dad_id, at, counts);
        log("delete.purged", { dad: d.dad_id, rows: Object.values(counts).reduce((a, b) => a + b, 0) });
        purged.push({ dad_id: d.dad_id, purged_at: at, counts });
      }
      return { purged, due: due.length };
    },

    // POST /vault/intake {dad_id, text, make_notice?} -> {written, chase}
    // — Intake writes claim. Requires provisioned dad — never creates state.
    // make_notice=true additionally notices the first written event and adds
    // {noticed_text, event_id}; the plain response shape is unchanged.
    async postVaultIntake({ dad_id, text, make_notice, source }, opts = {}) {
      await requireDad(dad_id);
      const { written, chase, event_ids = [], event_types = [] } = await extract(vault, dad_id, text, {
        ...opts,
        source: source ?? opts.source,
      });
      const out = { written, chase };
      if (make_notice === true && event_ids.length > 0) {
        const noticed = await vault.noticeEvent(dad_id, event_ids[0]);
        out.noticed_text = noticed.noticed_text;
        out.event_id = noticed.event_id;
        // Dad-facing line (denied/cancelled visit only). Chip says `say`
        // verbatim and stops — never noticed_text, never a Next this turn.
        const say = noticeSayLine(text, event_types[0]);
        if (say) out.say = say;
      }
      // Fork on every Chip intake (make_notice) — never on harm, where the
      // only job is real help.
      if (make_notice === true && !harmCheck(text)) out.fork = FORK_LINE;
      if (!harmCheck(text) && (source ?? opts.source) !== "statement") {
        await captureCandidates(dad_id, text, "intake", opts, event_ids[0] ?? null);
      }
      return out;
    },

    // POST /vault/return {dad_id, answer?}
    //   -> {last_next, line, progress_line, written?}
    // Return loop: stamps state.last_next from the current One Next and hands
    // Chip the greeting line ({line: null} when no Next — nothing invented).
    // An answer rides the intake rails — harm first (heard → discarded,
    // written:0), then PII strip, then venom strip — and becomes exactly ONE
    // claim event ('other', notes name the return beat, raw_quote = the
    // stripped answer). Never verified. No answer → no claim write, no
    // written key (existing behavior).
    async postVaultReturn({ dad_id, answer }, opts = {}) {
      const state = await requireDad(dad_id);
      const { last_next, last_next_kind, last_ask_summary } = await vault.beginReturn(dad_id);
      // Cold-ask hook: prefer the ask summary; otherwise the generic line.
      const line =
        last_next_kind === "cold_ask" && last_ask_summary
          ? coldAskLine(last_ask_summary)
          : returnLine(last_next);
      // Optional second beat for Chip: the soft-progress line, spoken once.
      // Null when there is nothing to say (return stamping never alters
      // the progress fields, so the pre-stamp state is accurate).
      const out = { last_next, line, progress_line: progressChipLine(state) };
      if (typeof answer === "string" && answer.trim()) {
        if (harmCheck(answer)) {
          // §4 rail: zero rows, zero retention, zero log lines.
          out.written = 0;
        } else {
          const cold = stripVenom(stripPii(answer).text).trim();
          const rec = await vault.insertEvent(dad_id, {
            event_type: "other",
            occurred_at: opts.referenceDate
              ? new Date(opts.referenceDate).toISOString()
              : new Date().toISOString(),
            pipe: "claim",
            raw_quote: cold || null,
            notes:
              last_next_kind === "cold_ask"
                ? "Return: cold ask follow-up"
                : "Return: how'd it go",
            kids: [],
          });
          out.written = 1;
          await captureCandidates(dad_id, answer, "return", opts, rec.id);
          log("return.answer", { dad: dad_id, event: rec.id });
        }
      }
      log("return", {
        dad: dad_id,
        has_next: Boolean(last_next),
        answered: Boolean(typeof answer === "string" && answer.trim()),
      });
      return out;
    },

    // POST /vault/tell {dad_id, channel: "talk"|"text", story}
    //   -> {written: 0|1, channel, feedback}
    // The dad's answer to the fork. Rides the intake rails — harm first
    // (heard → discarded, written:0, feedback null: Chip points to real
    // help), then PII strip, then venom strip — and becomes exactly ONE
    // claim event ('other', notes record the channel). Never verified.
    // Feedback is identical for talk and text.
    async postVaultTell({ dad_id, channel, story }, opts = {}) {
      const state = await requireDad(dad_id);
      if (!TELL_CHANNELS.includes(channel)) {
        const err = new Error("channel must be talk or text");
        err.status = 400;
        throw err;
      }
      if (harmCheck(story)) {
        return { written: 0, channel, feedback: null };
      }
      const cold = stripVenom(stripPii(story).text).trim();
      const rec = await vault.insertEvent(dad_id, {
        event_type: "other",
        occurred_at: opts.referenceDate
          ? new Date(opts.referenceDate).toISOString()
          : new Date().toISOString(),
        pipe: "claim",
        raw_quote: cold || null,
        notes: channel === "talk" ? "Told by talk" : "Told by text",
        kids: [],
      });
      log("tell", { dad: dad_id, event: rec.id, channel });
      await captureCandidates(dad_id, story, "tell", opts, rec.id);
      return { written: 1, channel, feedback: tellFeedback(state.next_action) };
    },

    // GET /vault/candidates {dad_id} -> {candidates: [...]}
    // Court-prep candidate facts, oldest first. Every one is claim / low
    // confidence; status is not_proof_yet | matched | conflict and `line`
    // is the one sentence the parent sees. Never verified.
    // Sticky notes: every candidate starts "Needs reviewed". The dad keeps
    // what's true and tosses junk; tossed notes are hidden here (pass
    // include_tossed to see them) but never deleted.
    async getVaultCandidates({ dad_id, include_tossed = false }) {
      await requireDad(dad_id);
      const rows = (await vault.listCandidates(dad_id)).filter(
        (c) => include_tossed || (c.review ?? "needs_reviewed") !== "tossed",
      );
      log("candidates.list", { dad: dad_id, n: rows.length });
      return {
        needs_reviewed: rows.filter((c) => (c.review ?? "needs_reviewed") === "needs_reviewed").length,
        candidates: rows.map(publicCandidate),
      };
    },

    // POST /vault/candidates/review {dad_id, id, review: keep|toss}
    // Keep ≠ true: a kept note is still the dad's account (claim, low,
    // status untouched) — only OFW can make it match. Toss hides, never deletes.
    async postCandidateReview({ dad_id, id, review }) {
      await requireDad(dad_id);
      const REVIEW = { keep: "kept", toss: "tossed" };
      if (!REVIEW[review]) {
        const err = new Error("review must be keep or toss");
        err.status = 400;
        throw err;
      }
      const rec = await vault.setCandidateReview(dad_id, id, REVIEW[review]);
      if (!rec) {
        const err = new Error("unknown candidate");
        err.status = 404;
        throw err;
      }
      log("candidates.review", { dad: dad_id, id, review: REVIEW[review] });
      return publicCandidate(rec);
    },

    // POST /vault/checkins/ensure {dad_id, date?, tz_offset_minutes?}
    //   -> {created, items}
    // Idempotently creates the day's two check-in windows (morning 8–12,
    // evening 18–22 local) as Notification items. Chip calls it at entry.
    async postCheckinsEnsure({ dad_id, date, tz_offset_minutes }, opts = {}) {
      await requireDad(dad_id);
      const now = new Date(opts.now ?? Date.now());
      const offset = tz_offset_minutes === undefined || tz_offset_minutes === null ? 0 : Number(tz_offset_minutes);
      if (!Number.isInteger(offset) || Math.abs(offset) > 14 * 60) {
        const err = new Error("tz_offset_minutes must be an integer within ±840");
        err.status = 400;
        throw err;
      }
      const forDate = date ?? new Date(now.getTime() + offset * 60_000).toISOString().slice(0, 10);
      let windows;
      try {
        windows = checkinWindows(forDate, offset);
      } catch {
        const err = new Error("date must be YYYY-MM-DD");
        err.status = 400;
        throw err;
      }
      const created = await vault.ensureNotifications(dad_id, windows);
      const items = (await vault.listNotifications(dad_id))
        .filter((n) => n.for_date === forDate)
        .map((n) => publicNotification(n, now));
      log("checkins.ensure", { dad: dad_id, created });
      return { created, items };
    },

    // GET /vault/notifications {dad_id} -> {unread, items}
    // The Notifications tab: check-ins with due window + status
    // (unread | read | done | missed — missed is computed past due_end).
    async getVaultNotifications({ dad_id }, opts = {}) {
      await requireDad(dad_id);
      const now = new Date(opts.now ?? Date.now());
      const items = (await vault.listNotifications(dad_id)).map((n) => publicNotification(n, now));
      return { unread: items.filter((i) => i.status === "unread").length, items };
    },

    // POST /vault/notifications/mark {dad_id, id, status: read|done}
    async postNotificationMark({ dad_id, id, status }, opts = {}) {
      await requireDad(dad_id);
      if (!["read", "done"].includes(status)) {
        const err = new Error("status must be read or done");
        err.status = 400;
        throw err;
      }
      const rec = await vault.setNotificationStatus(dad_id, id, status);
      if (!rec) {
        const err = new Error("unknown notification");
        err.status = 404;
        throw err;
      }
      log("notifications.mark", { dad: dad_id, id, status });
      return publicNotification(rec, new Date(opts.now ?? Date.now()));
    },

    // ---- Parenting Plan seat (Slice 14) ------------------------------------
    // Menus only, one question at a time (easiest → hardest), every term
    // explained first, any question skippable. Answers never touch intake,
    // Coach drafts, candidates, or OFW. The draft is bot-owned: regenerated
    // from answers, versioned, never edited from outside.

    // POST /vault/plan/topics/ensure {dad_id} -> {created, topics, next}
    async postPlanEnsure({ dad_id }) {
      await requireDad(dad_id);
      const created = await vault.ensurePlanTopics(
        dad_id,
        PLAN_TOPICS.map((t, i) => ({ key: t.key, position: i + 1 })),
      );
      const rows = await vault.listPlanTopics(dad_id);
      log("plan.ensure", { dad: dad_id, created });
      return { created, topics: rows.map(planTopicView), next: planNext(rows), lawyer_line: LAWYER_LINE };
    },

    // GET /vault/plan/topics {dad_id, depth?} -> {topics, next, counts}
    async getPlanTopics({ dad_id, depth = "simple" }) {
      await requireDad(dad_id);
      if (!["simple", "deeper"].includes(depth)) throw planBad("depth must be simple or deeper");
      const rows = await planRows(dad_id);
      const count = (st) => rows.filter((r) => r.status === st).length;
      return {
        topics: rows.map(planTopicView),
        counts: { open: count("open"), answered: count("answered"), parked: count("parked") },
        next: planNext(rows, depth),
        lawyer_line: LAWYER_LINE,
      };
    },

    // POST /vault/plan/answer {dad_id, topic, choice, stance?, depth?, detail?}
    async postPlanAnswer({ dad_id, topic, choice, stance, depth, detail }) {
      await requireDad(dad_id);
      const a = checkAnswer({
        topic,
        choice,
        stance: stance ?? "want",
        depth: depth ?? "simple",
        detail: detail ?? null,
      });
      await planRows(dad_id);
      const rec = await vault.updatePlanTopic(dad_id, a.topic, {
        status: "answered",
        choice: a.choice,
        detail: a.detail,
        stance: a.stance,
        depth: a.depth,
      });
      const rows = await vault.listPlanTopics(dad_id);
      log("plan.answer", { dad: dad_id, topic: a.topic, stance: a.stance, depth: a.depth });
      return { topic: planTopicView(rec), next: planNext(rows), lawyer_line: LAWYER_LINE };
    },

    // POST /vault/plan/stuck {dad_id, topic}
    // Stuck rule: the FIRST stuck gets one example; the next stuck parks the
    // topic and moves on. Never a second example.
    async postPlanStuck({ dad_id, topic }) {
      await requireDad(dad_id);
      const def = topicDef(topic);
      if (!def) throw planBad("unknown topic");
      const rows = await planRows(dad_id);
      const row = rows.find((r) => r.topic_key === topic);
      if (!row.example_shown && row.status !== "parked") {
        await vault.updatePlanTopic(dad_id, topic, { example_shown: true });
        log("plan.stuck", { dad: dad_id, topic, step: "example" });
        return {
          parked: false,
          example: def.example,
          line: "Here's one example. Pick from the menu — or say stuck again and we'll park it and move on.",
          prompt: topicPrompt(topic),
          lawyer_line: LAWYER_LINE,
        };
      }
      return this.postPlanPark({ dad_id, topic }, "stuck");
    },

    // POST /vault/plan/park {dad_id, topic}
    async postPlanPark({ dad_id, topic }, via = "park") {
      await requireDad(dad_id);
      if (!topicDef(topic)) throw planBad("unknown topic");
      await planRows(dad_id);
      const rec = await vault.updatePlanTopic(dad_id, topic, { status: "parked" });
      const rows = await vault.listPlanTopics(dad_id);
      log("plan.park", { dad: dad_id, topic, via });
      return {
        parked: true,
        topic: planTopicView(rec),
        line: "Parked. We'll move on — this one goes to your lawyer.",
        next: planNext(rows),
        lawyer_line: LAWYER_LINE,
      };
    },

    // POST /vault/plan/draft/regenerate {dad_id, kind: full|prep} -> new version
    async postPlanRegenerate({ dad_id, kind = "full" }) {
      await requireDad(dad_id);
      if (!DRAFT_KINDS.includes(kind)) throw planBad("kind must be full or prep");
      const rows = await planRows(dad_id);
      // Version is assigned by the store; render with the number it will get.
      const current = Math.max(
        (await vault.latestPlanDraft(dad_id, "full"))?.version ?? 0,
        (await vault.latestPlanDraft(dad_id, "prep"))?.version ?? 0,
      );
      const rec = await vault.insertPlanDraft(dad_id, { kind, body: renderDraft(kind, rows, current + 1) });
      return { version: rec.version, kind: rec.kind, body: rec.body, lawyer_line: LAWYER_LINE };
    },

    // GET /vault/plan/draft {dad_id, kind?} -> latest version of that kind
    async getPlanDraft({ dad_id, kind = "full" }) {
      await requireDad(dad_id);
      if (!DRAFT_KINDS.includes(kind)) throw planBad("kind must be full or prep");
      const rec = await vault.latestPlanDraft(dad_id, kind);
      if (!rec) throw planBad("no draft yet — regenerate first", 404);
      return {
        version: rec.version,
        kind: rec.kind,
        body: rec.body,
        created_at: rec.created_at,
        lawyer_line: LAWYER_LINE,
      };
    },

    // ---- Process Translator (Slice 15) --------------------------------------
    // Dictionary, not coach. V1 input = pasted text OR a named term. Writes
    // only translations + private_only calendar candidates — never an
    // intake event, Coach draft, OFW row, court-prep candidate, plan row,
    // or any calendar. Logs: ids + term keys only.

    // POST /vault/translate/explain {dad_id, term? | text?}
    async postTranslateExplain({ dad_id, term, text }) {
      await requireDad(dad_id);
      const t = translatorExplain({ term, text });
      const rec = await vault.insertTranslation(dad_id, t, t.calendar_candidates);
      log("translate.explain", {
        dad: dad_id,
        id: rec.id,
        kind: t.input_kind,
        terms: t.term_keys.slice(0, 5),
        verdict: t.verdict_request ? 1 : 0,
        clock: t.clock_flag ? 1 : 0,
      });
      return publicTranslation(rec);
    },

    // GET /vault/translate/last {dad_id}
    async getTranslateLast({ dad_id }) {
      await requireDad(dad_id);
      const rec = await vault.lastTranslation(dad_id);
      if (!rec) throw Object.assign(new Error("nothing translated yet"), { status: 404 });
      return publicTranslation(rec);
    },

    // GET /vault/translate/list {dad_id, limit?} -> [{id, created_at, input_kind, term_keys, ...}]
    async getTranslateList({ dad_id, limit = 20 }) {
      await requireDad(dad_id);
      const n = Math.max(1, Math.min(50, Number(limit) || 20));
      return { items: await vault.listTranslations(dad_id, n), lawyer_line: TRANSLATOR_LAWYER_LINE };
    },

    // ---- Involvement Cheat Sheet (Slice 16) ---------------------------------
    // Living one-pager per kid. Dad-entered claims only (never verified).
    // Speaks ONE Missing + ONE Next. Writes involvement_fields only — never
    // OFW, intake, Coach, plan, or translator rows. Logs: ids + field keys.

    // POST /vault/involvement/ensure {dad_id, kid}
    async postInvolvementEnsure({ dad_id, kid }) {
      await requireDad(dad_id);
      checkKid(kid);
      const { created, rows } = await involvementRows(dad_id, kid);
      log("involvement.ensure", { dad: dad_id, created });
      return {
        kid,
        created,
        counts: involvementCounts(rows),
        speak: missingNext(rows, todayIso()),
        claim_footer: INVOLVEMENT_FOOTER,
      };
    },

    // GET /vault/involvement {dad_id, kid?} -> {kids:[{kid, fields, counts}], speak}
    // The full sheet is for display; Chip says `speak` only.
    async getInvolvement({ dad_id, kid }) {
      await requireDad(dad_id);
      if (kid) checkKid(kid);
      const keys = kid ? [kid] : await vault.listInvolvementKids(dad_id);
      const kids = [];
      for (const k of keys) {
        const rows = await vault.listInvolvement(dad_id, k);
        if (rows.length) kids.push({ kid: k, fields: rows.map(involvementView), counts: involvementCounts(rows) });
      }
      if (kid && kids.length === 0) throw Object.assign(new Error("no sheet for that kid — ensure first"), { status: 404 });
      return { kids, speak: await involvementSpeak(dad_id, kid), claim_footer: INVOLVEMENT_FOOTER };
    },

    // POST /vault/involvement/field {dad_id, kid, field, value | asked_on+asked_via+outcome}
    async postInvolvementField({ dad_id, kid, field, value, asked_on, asked_via, outcome }) {
      await requireDad(dad_id);
      checkKid(kid);
      const u = checkFieldUpdate({ field, value, asked_on, asked_via, outcome });
      await involvementRows(dad_id, kid);
      const rec = await vault.updateInvolvementField(dad_id, kid, u.field, u.patch);
      const rows = await vault.listInvolvement(dad_id, kid);
      log("involvement.field", { dad: dad_id, field: u.field, kind: "value" in u.patch ? "value" : "ask" });
      return {
        field: involvementView(rec),
        speak: missingNext(rows, todayIso()),
        claim_footer: INVOLVEMENT_FOOTER,
      };
    },

    // GET /vault/involvement/next {dad_id, kid?} -> {missing, next, left}
    async getInvolvementNext({ dad_id, kid }) {
      await requireDad(dad_id);
      if (kid) checkKid(kid);
      return { ...(await involvementSpeak(dad_id, kid)), claim_footer: INVOLVEMENT_FOOTER };
    },

    // GET /vault/involvement/export {dad_id, kid} -> one-pager text
    async getInvolvementExport({ dad_id, kid }) {
      await requireDad(dad_id);
      checkKid(kid);
      const rows = await vault.listInvolvement(dad_id, kid);
      if (!rows.length) throw Object.assign(new Error("no sheet for that kid — ensure first"), { status: 404 });
      log("involvement.export", { dad: dad_id });
      return {
        kid,
        as_of: todayIso(),
        body: renderOnePager(kid, rows, todayIso()),
        claim: true,
        verified: false,
        claim_footer: INVOLVEMENT_FOOTER,
      };
    },

    // ---- Legal Intake seat (Slice 17) ----------------------------------------
    // Intake + triage + handoff DRAFT. Never answers the law. Writes only
    // legal_intakes + legal_handoff_drafts (sent_at locked null) — never a
    // Quill event, Coach draft, OFW row, plan or translator row. Logs: ids,
    // route, flag keys only.

    // POST /vault/legal/intake {dad_id, who, what, urgency}
    async postLegalIntake({ dad_id, who, what, urgency }) {
      await requireDad(dad_id);
      const c = legalCapture({ who, what, urgency });
      const rec = await vault.insertLegalIntake(dad_id, c);
      log("legal.capture", { dad: dad_id, id: rec.id, route: c.route, flags: c.flags });
      return publicLegalIntake(rec, null);
    },

    // GET /vault/legal/intake {dad_id, id?} -> that intake (or latest) + latest draft
    async getLegalIntake({ dad_id, id }) {
      await requireDad(dad_id);
      const rec = await requireLegalIntake(dad_id, id);
      return publicLegalIntake(rec, await vault.latestHandoffDraft(rec.id));
    },

    // POST /vault/legal/handoff {dad_id, id?} -> new draft version (never sent)
    async postLegalHandoff({ dad_id, id }) {
      await requireDad(dad_id);
      const rec = await requireLegalIntake(dad_id, id);
      if (rec.route === "process_translator") {
        throw Object.assign(
          new Error("this is a what-does-this-mean question — use the Process Translator"),
          { status: 409 },
        );
      }
      const version = ((await vault.latestHandoffDraft(rec.id))?.version ?? 0) + 1;
      const today = new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
      const draft = await vault.insertHandoffDraft(dad_id, rec.id, version, legalRenderPacket(rec, version, today));
      return { ...publicLegalIntake(rec, draft), draft_footer: LEGAL_DRAFT_FOOTER };
    },

    // GET /vault/chip_entry {dad_id}
    //   -> {progress_line, missing_one, next_action, return_line}
    // Read-only speakable bundle: everything Chip says at entry without
    // composing. Nulls when there is nothing — counters and greetings are
    // never invented. return_line is the SAME text POST /vault/return
    // would greet with, composed from state without stamping last_next —
    // the return POST remains the only write on that path.
    async getChipEntry({ dad_id }) {
      const state = await requireDad(dad_id);
      const next = state.next_action ? stripPii(String(state.next_action)).text : null;
      const firstMissing = state.missing?.[0];
      const return_line =
        state.last_next_kind === "cold_ask" && state.last_ask_summary
          ? coldAskLine(state.last_ask_summary)
          : returnLine(next);
      const out = {
        progress_line: progressChipLine(state),
        missing_one: firstMissing ? stripPii(String(firstMissing)).text : null,
        next_action: next,
        return_line,
      };
      // Latest-draft hint: newest draft only, read-only, omitted entirely
      // when the dad has no drafts. preview = first ~80 chars of the
      // stored (already-stripped) body, belt-stripped for legacy rows;
      // soft_grade recomputed with the same heuristic as the draft POST.
      const drafts = await vault.listDrafts(dad_id);
      if (drafts.length > 0) {
        const newest = drafts[drafts.length - 1];
        const bodyText = stripPii(String(newest.body_cold ?? "")).text;
        out.latest_draft = {
          // STORED grade — must match what the draft POST returned.
          // Recompute only for legacy rows written before persistence.
          soft_grade: newest.soft_grade ?? draftSoftGrade(bodyText),
          preview: bodyText.slice(0, 80),
        };
      }
      log("chip_entry", {
        dad: dad_id,
        has_progress: Boolean(out.progress_line),
        has_next: Boolean(next),
      });
      return out;
    },

    // POST /vault/missing/seed {dad_id, pack?} -> {written, missing_one, progress_line}
    // Seeds an EMPTY checklist with PII-safe blanks (labels only, no case
    // data). Non-empty missing is never overwritten. Counters are set to
    // 5/0 only when BOTH are null — existing counters are never invented
    // over. No event/comms rows — claim ≠ verified untouched.
    async postMissingSeed({ dad_id, pack }) {
      const packName = pack ?? "kids_facts";
      const labels = SEED_PACKS[packName];
      if (!labels) {
        const err = new Error("unknown pack");
        err.status = 400;
        throw err;
      }
      const state = await requireDad(dad_id);
      const missing = state.missing ?? [];
      if (missing.length > 0) {
        // No overwrite: report what's already open, write nothing.
        return {
          written: 0,
          missing_one: stripPii(String(missing[0])).text,
          progress_line: progressChipLine(state),
        };
      }
      const patch = { missing: labels.map((l) => stripPii(l).text) };
      if (state.this_week_total == null && state.this_week_done == null) {
        patch.this_week_total = labels.length;
        patch.this_week_done = 0;
      }
      const newState = await vault.updateState(dad_id, patch);
      log("missing.seed", { dad: dad_id, pack: packName, items: labels.length });
      return {
        written: 1,
        missing_one: newState.missing?.[0] ?? null,
        progress_line: progressChipLine(newState),
      };
    },

    // POST /vault/missing/fill {dad_id, answer}
    //   -> {written, missing_one, progress_line}
    // Chip asked about missing[0]; the dad's answer closes it. The answer
    // rides the same rails as intake: harm first (heard → discarded,
    // nothing shifted), then PII strip, then venom strip. The closed item
    // becomes ONE claim event ('other', notes name the item, raw_quote =
    // the stripped answer) — simplest durable path, never verified.
    // this_week_done bumps only when a total is set and not yet reached.
    async postMissingFill({ dad_id, answer }, opts = {}) {
      const state = await requireDad(dad_id);
      const missing = state.missing ?? [];
      if (missing.length === 0) {
        // Empty checklist: nothing to close, nothing invented.
        return { written: 0, missing_one: null, progress_line: null };
      }
      if (harmCheck(answer)) {
        // §4 rail: zero rows, zero retention, nothing shifted or bumped.
        return {
          written: 0,
          missing_one: stripPii(String(missing[0])).text,
          progress_line: progressChipLine(state),
        };
      }
      const cold = stripVenom(stripPii(answer).text).trim();
      const item = stripPii(String(missing[0])).text;
      const rec = await vault.insertEvent(dad_id, {
        event_type: "other",
        occurred_at: opts.referenceDate
          ? new Date(opts.referenceDate).toISOString()
          : new Date().toISOString(),
        pipe: "claim",
        raw_quote: cold || null,
        notes: `Checklist item closed: ${item}`,
        kids: [],
      });
      const patch = { missing: missing.slice(1) };
      const total = state.this_week_total ?? null;
      const done = state.this_week_done ?? 0;
      if (total !== null && done < total) patch.this_week_done = done + 1;
      const newState = await vault.updateState(dad_id, patch);
      log("missing.fill", { dad: dad_id, event: rec.id, left: patch.missing.length });
      return {
        written: 1,
        missing_one: newState.missing?.[0] ? stripPii(String(newState.missing[0])).text : null,
        progress_line: progressChipLine(newState),
      };
    },

    // POST /vault/notice {dad_id, event_id?} -> {noticed_text, event_id}
    // event_id omitted → the dad's latest event. Marks it noticed; pipe is
    // untouched (claim until verified — Exhibit never sees claim-only rows).
    async postVaultNotice({ dad_id, event_id }) {
      await requireDad(dad_id);
      const noticed = await vault.noticeEvent(dad_id, event_id ?? null);
      log("notice", { dad: dad_id, event: noticed.event_id, pipe: noticed.pipe });
      return { noticed_text: noticed.noticed_text, event_id: noticed.event_id };
    },

    // GET /vault/state {dad_id} -> state row — Edge / Front Door read (never creates)
    async getVaultState({ dad_id }) {
      return vault.getState(dad_id);
    },

    // POST /vault/provision {dad_id?} -> {dad_id, token, missing_one, progress_line}
    // ONLY path that creates state. Returns raw token once; store keeps hash only.
    // Auto-seeds the kids_facts checklist via the SAME seed helper (no
    // duplicate pack): a fresh provision has empty missing + null counters,
    // so the helper applies 5 blanks and total=5/done=0; its no-overwrite
    // guard keeps any non-empty missing untouched. missing_one +
    // progress_line come back so Chip can speak immediately.
    async postVaultProvision({ dad_id } = {}) {
      const id = dad_id || randomUUID();
      await vault.provisionState(id);
      const { token } = await this.mintToken({ dad_id: id });
      const seeded = await this.postMissingSeed({ dad_id: id });
      log("provision", { dad: id, seeded: seeded.written });
      return {
        dad_id: id,
        token,
        missing_one: seeded.missing_one,
        progress_line: seeded.progress_line,
      };
    },

    // PUT /vault/state {dad_id, phase?, this_week?, missing?, next_action?,
    //                   this_week_done?, this_week_total?}
    // Update-only — missing dad → 404 (no silent upsert). Progress rails
    // clamp here, once, for both stores: total 3..7, done 0..total,
    // missing ≤ 7 short strings.
    async putVaultState({ dad_id, ...patch }) {
      await requireDad(dad_id);
      const clamped = clampProgressPatch(patch);
      if (typeof vault.updateState === "function") {
        return vault.updateState(dad_id, clamped);
      }
      return vault.upsertState(dad_id, clamped);
    },

    // GET /vault/progress {dad_id} -> {line, missing_one, grade}
    // Plain Chip speech, read-only. line null until both counters exist;
    // grade is warm or null — never shame; missing_one = first checklist
    // item or null (empty missing is fine).
    async getVaultProgress({ dad_id }) {
      const state = await requireDad(dad_id);
      // missing_one is spoken by Chip; the write path strips PII, and this
      // read-side strip covers rows written before that rail existed.
      const firstMissing = state.missing?.[0];
      const out = {
        line: progressLine(state),
        missing_one: firstMissing ? stripPii(String(firstMissing)).text : null,
        grade: softGrade(state),
        // The one ADHD-short line Chip speaks: counters + at most one open
        // item, or null — never invented.
        progress_line: progressChipLine(state),
      };
      log("progress", { dad: dad_id, has_line: Boolean(out.line), has_grade: Boolean(out.grade) });
      return out;
    },

    // POST /vault/comms/cold {dad_id, body_cold, channel} -> {id}
    async postCommsCold({ dad_id, body_cold, channel }) {
      await requireDad(dad_id);
      const rec = await vault.insertCommunication(dad_id, {
        direction: "outgoing",
        channel,
        body_cold,
        sent_at: new Date().toISOString(),
        pipe: "claim",
      });
      return { id: rec.id };
    },

    // POST /vault/comms/draft {dad_id, body, kind?} -> {written, draft_id, body}
    // Cold draft store — draft ≠ send. Harm first (heard → discarded,
    // written:0, no row, no log line), then PII strip, then venom strip;
    // the draft lands as direction='draft', sent_at null, pipe='claim' —
    // never sent, never verified. NO send endpoint exists for drafts.
    async postCommsDraft({ dad_id, body, kind, on_record }) {
      await requireDad(dad_id);
      if (on_record !== undefined && on_record !== null && typeof on_record !== "boolean") {
        const err = new Error("on_record must be true or false");
        err.status = 400;
        throw err;
      }
      if (kind !== undefined && kind !== null && kind !== "cold_ask") {
        const err = new Error("unknown draft kind");
        err.status = 400;
        throw err;
      }
      if (harmCheck(body)) {
        // No soft_grade on a discarded draft — nothing to grade.
        return { written: 0 };
      }
      const piiClean = stripPii(body).text;
      // Slice 19 — heat (swearing, diagnosing the other parent, "tell her
      // off"): never strip-and-keep (that returned hot fragments). Build a
      // complete calm draft from the real issue + real ask, or fail safe:
      // no body, nothing stored, a plain say — the vent is never echoed.
      // 19b: EVERY draft goes through the calm rewrite — no heat gate. The
      // body is never the dad's input or a slice of it. Safety reports and
      // worn-out vents are never drafted; anything that can't become one
      // clean, complete message fails safe (no body, nothing stored).
      const r = coach(piiClean);
      if (r.kind === "safety") {
        log("comms.draft.safety", { dad: dad_id });
        return { written: 0, rewritten: false, route: "safety", say: SAFETY_SAY, facts: r.facts };
      }
      if (r.kind === "defeat") {
        log("comms.draft.checkin", { dad: dad_id });
        return { written: 0, rewritten: false, route: "check_in", say: DEFEAT_SAY };
      }
      if (r.kind !== "draft") {
        log("comms.draft.failsafe", { dad: dad_id });
        return { written: 0, rewritten: false, say: FAILSAFE_SAY };
      }
      const cold = r.body;
      const onRecord = r.on_record;
      // Template rebuilds are send-ready; the kept-sentence path grades
      // "tighten" when heat was dropped (the dad's words changed).
      const venomStripped = r.topic === "kept" && r.dropped;
      // Grade from the PRE-strip knowledge, persisted with the row so
      // reads return the same grade the POST did.
      // Graded on the dad's own kept words (r.core), not the added "Thank you."
      const soft_grade = draftSoftGrade(r.core, venomStripped);
      const rec = await vault.insertCommunication(dad_id, {
        direction: "draft",
        channel: null,
        body_cold: cold,
        sent_at: null,
        pipe: "claim",
        draft_kind: kind ?? null,
        soft_grade,
      });
      // De-escalate vs document-this: the dad saying he wants this request
      // ON THE RECORD forces document mode even when the wording heuristic
      // misses it. on_record:false never downgrades a detected record ask.
      const mode = on_record === true || onRecord ? "document" : draftMode(cold);
      log("comms.draft", { dad: dad_id, id: rec.id, kind: kind ?? "none", grade: soft_grade, mode, topic: r.topic });
      return { written: 1, draft_id: rec.id, body: cold, soft_grade, mode, say: draftSayLine(mode), rewritten: true };
    },

    // GET /vault/comms/drafts {dad_id} -> [{draft_id, body, kind, created_at}]
    // Drafts ONLY — sent/pulled communications never appear here.
    async getCommsDrafts({ dad_id }) {
      await requireDad(dad_id);
      const rows = await vault.listDrafts(dad_id);
      log("comms.drafts.list", { dad: dad_id, drafts: rows.length });
      return rows.map((r) => ({
        draft_id: r.id,
        body: r.body_cold ?? "",
        kind: r.draft_kind ?? null,
        created_at: r.created_at,
      }));
    },

    // POST /vault/comms/pull {dad_id, channel, source_ref, ...} -> {id}
    async postCommsPull({ dad_id, channel, source_ref, body_cold, sent_at }) {
      await requireDad(dad_id);
      const rec = await vault.insertCommunication(dad_id, {
        direction: "pull",
        channel,
        source_ref,
        body_cold: body_cold ?? null,
        sent_at: sent_at ?? null,
        pipe: "verified",
      });
      // A new OFW record may confirm or contradict earlier candidates.
      if (channel === "ofw") await recheckCandidates(dad_id);
      return { id: rec.id };
    },


    // GET /vault/search {dad_id, q?, pipe?, type?, from?, to?, limit?}
    // Claim|verified allowed. Export/Exhibit stay verified-only (unchanged).
    async getVaultSearch(raw) {
      const opts = parseSearchOpts(raw);
      await requireDad(opts.dad_id);
      if (typeof vault.search !== "function") {
        const err = new Error("search not available on this store");
        err.status = 501;
        throw err;
      }
      const result = await vault.search(opts);
      log("search", {
        dad: opts.dad_id,
        hits: result.hits?.length ?? 0,
        mode: result.mode,
        q_len: (opts.q || "").length,
      });
      return result;
    },

    // GET /vault/export/verified {dad_id} -> rows — Reporting ONLY (verified pipe).
    async getVaultExportVerified({ dad_id }) {
      await requireDad(dad_id);
      const rows = await vault.verifiedExport(dad_id);
      log("export.verified", { dad: dad_id, rows: rows.length });
      return rows;
    },
  };
}

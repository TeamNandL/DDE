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
import { createMemoryTokenStore, hashToken } from "./tokens.js";
import { parseSearchOpts } from "./search.js";
import {
  candidateFacts,
  checkinWindows,
  crossCheck,
  effectiveStatus,
  factLine,
} from "./courtprep.js";

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

  function publicCandidate(c) {
    return {
      id: c.id,
      what: c.what,
      who: c.who ?? [],
      when_text: c.when_text ?? null,
      when_on: c.when_on ?? null,
      kids: c.kids ?? [],
      confidence: c.confidence ?? "low",
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
     * missing/unknown token → 401; token belongs to another dad → 403.
     */
    async checkToken(dad_id, token) {
      if (typeof token !== "string" || !token.trim()) {
        const err = new Error("unauthorized");
        err.status = 401;
        throw err;
      }
      const row = await tokenStore.lookupActive(hashToken(token.trim()));
      if (!row) {
        const err = new Error("unauthorized");
        err.status = 401;
        throw err;
      }
      if (row.dad_id !== dad_id) {
        const err = new Error("forbidden");
        err.status = 403;
        throw err;
      }
      return true;
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
    async getVaultCandidates({ dad_id }) {
      await requireDad(dad_id);
      const rows = await vault.listCandidates(dad_id);
      log("candidates.list", { dad: dad_id, n: rows.length });
      return { candidates: rows.map(publicCandidate) };
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
      const token = `dde-stub-${randomUUID()}`;
      await tokenStore.insert({
        dad_id: id,
        token_hash: hashToken(token),
        created_at: new Date().toISOString(),
      });
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
    async postCommsDraft({ dad_id, body, kind }) {
      await requireDad(dad_id);
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
      const venomStripped = hasVenom(piiClean);
      const cold = stripVenom(piiClean).trim();
      if (!cold) {
        // Nothing storable survived the strips (pure venom) — no row.
        return { written: 0 };
      }
      // Grade from the PRE-strip knowledge, persisted with the row so
      // reads return the same grade the POST did.
      const soft_grade = draftSoftGrade(cold, venomStripped);
      const rec = await vault.insertCommunication(dad_id, {
        direction: "draft",
        channel: null,
        body_cold: cold,
        sent_at: null,
        pipe: "claim",
        draft_kind: kind ?? null,
        soft_grade,
      });
      const mode = draftMode(cold);
      log("comms.draft", { dad: dad_id, id: rec.id, kind: kind ?? "none", grade: soft_grade, mode });
      return { written: 1, draft_id: rec.id, body: cold, soft_grade, mode, say: draftSayLine(mode) };
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

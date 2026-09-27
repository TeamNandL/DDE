# COURT_PREP_PRINCIPLES — standing source-level rules

Non-negotiable defaults for the semi-conversation bot (Chip) and court-prep
logging. Code, seats, and later slices must obey these. Do not weaken them
in product copy, BFF behavior, or review passes.

Locked by Nick Rigano on 2026-09-26 (voice). Exact wording below is
canonical; change only with Nick exact-yes.

---

## 1. Over-capture is the default

Never drop or filter data at ingestion. All filtering, weeding, and
promotion of noise vs. signal happens in a later human-supervised pass.
Prefer capturing everything over missing something.

## 2. Keyword hits flag candidates only — they never assert truth

When the bot's ears perk up on a keyword (days, times, events,
cancellations, attendance, people names, etc.), it logs a candidate fact
with low confidence until verified. It does not decide what is true.

## 3. Conversation-derived facts stay unverified until OFW cross-check

Conversation-derived facts stay unverified until cross-checked against
Family Wizard (OFW). OFW is the verified record and is never
auto-overwritten by conversation data. Conflicts surface as one clear
line for the parent; OFW-silent entries stay parent-asserted only, marked
"not proof yet."

## 4. Factual utterances become structured account facts

Factual utterances must be written to the account as structured facts
(who, what, when, kids involved), not left as ephemeral speech. The
tagging gap is closed: things like "Friday cancel," "Quinn did come,"
"time with daughter tonight" become writable account facts.

## 5. Court-prep collection is proactive

The bot initiates check-ins (target twice daily, hard floor once) rather
than waiting to be asked. Check-ins surface in a Notifications tab as
unread items with due window and status.

---

## Related

- Chip vault contract: [`CHIP_APP.md`](CHIP_APP.md)
- OFW / verified export lane stays separate; conversation candidates never
  merge into verified rows without an explicit human-supervised promote.

## Operating spine

Product mindset for DDE seats and court-prep work: see
[`MAMBA_PRINCIPLES.md`](MAMBA_PRINCIPLES.md).

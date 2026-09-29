# DDE — COMPLETE PROGRESS RECAP
Everything from the first major build (~one week ago) through Sept 26, 2026.
Purpose: give Claude Code / Cowork the full context in one place so nothing gets skipped.

========================================================
PART 1 — WHAT DDE IS
========================================================
Divorced Dad's Edge ("Edge" / "DDE"). A teaching-bot product that helps non-technical, overwhelmed dads going through divorce gather evidence, communicate without hurting themselves on the record, and survive the process. Framing: a toolkit, NOT legal advice. "A tool that teaches you how to use the tool." Sold DIRECT to dads, not through lawyers. Pricing DECIDED: $500/month, framed as cheaper than one hour with your lawyer.

Launch is PARKED until Nick's own final judgment is signed. Building continues; launching does not. No corporation established yet, so nothing formally owned (flagged: ask lawyer whether IP built during the open case could be a marital asset).

========================================================
PART 2 — ARCHITECTURE (locked)
========================================================
TWO TRACKS + a THIRD:
- Track 1 = KIDS (emotional, urgent). Order, locked (= order of a dad's real pain):
  1) move to written, logged communication (Our Family Wizard is the gold standard)
  2) Communication Coach bot (daily)
  3) time log (every visit and denied visit, timestamped)
  4) Parenting Plan bot
- Track 2 = MONEY (cold, later). Statements, accounts, affidavit. Business branch activates on "I own a business."
- Track 3 = THE MAN / RESILIENCE. The moat competitors won't build; turns a 9-month subscription into multi-year. v1 ships only the vent piece; Mindset/Gratitude built after signal.

ONE SHARED MEMORY, many specialist bots, voice-first. The dad experiences ONE continuous conversation; routing is invisible. Shared memory is non-negotiable — all reports/evidence are assembled from what every bot collects.

========================================================
PART 3 — THE CORE THESES (the "why it's worth $500")
========================================================
1. The court is PREDICTABLE. Every dad needs the same affidavit, parenting plan, financials, evidence. We already know what the court will ask, so we start compiling from day one, before the lawyer says the word. "The most organized man wins more often than the best-sounding one."
2. Divorce is a POWER STRUGGLE between two leverages: one party holds the MONEY, the other holds the KIDS. Naming the game for a dad is blanket-useful, not legal advice.
3. THE SLOW STARVATION (backbone emotional register): not the Hunger Games (quick, merciful) — it's a game of MILES not inches, slow meticulous starvation, eating yourself alive to survive. The tool must meet prolonged deprivation, not a single blow. Nick's anchor: chose to leave April 19; ~7 months without sleeping in the same house as his kids as of late Sept.
4. The isolation hits IMMEDIATELY — the second a dad picks up the bag and walks out — not at month 6. The tool has to meet that immediate, total moment of need.

========================================================
PART 4 — THE BOTS / SEATS
========================================================
Core four that carry the product: Front Door, Intake, Communication Coach, Edge (+ vault = real product).

- COMMUNICATION COACH (most-used, most urgent). "Vent hot, send cold": dad dumps raw anger, bot returns the OFW-ready version. Three rules: brief, emotionless, court-safe (write as if the judge reads it aloud). NEVER helps fire back. RAIL: never use live financial figures (validated by real slip this week — see Part 6). Merged with OFW Coach into one Communication seat: navigate+pull from OFW, digest by month, find patterns (gatekeeping/denial), plus the tone engine.
- PARENTING PLAN BOT (undervalued — move UP the queue). Explains what a parenting plan even is, then one question at a time easiest-to-hardest. Output: clean draft to hand the lawyer. Every term explained before it's asked; any question skippable.
- EVIDENCE & RECORDS (merged Evidence + Accountant). A PROMPT ENGINE that surfaces places the dad ALREADY has legit access to (phone, shared family photo/cloud plans, joint accounts, old emails). Clean-hands rail: if the door is already open to him, look; never force a door (don't change passwords, don't break into devices never his). Handles image evidence, not just docs.
- MINDSET (Gratitude merged in). Daily resilience practice / devotional. Strong-manhood register (SEALs, first responders, POWs, athletes, Stoics — all public domain). Never "real men don't need help" — strength includes calling your team. Draws on Nick's sobriety training ("sit with the cactus").
- CROSSROADS (separate seat, highest-risk). The go-back-vs-rebuild question. NEVER answers whether to reconcile. Any sign of abuse -> only job is safety + handoff to a real human.
- REPORTING / EXHIBIT. Turns shared memory into attorney/judge-ready reports, verified data only.

RAIL across everything: NEVER label or diagnose the ex. Document observable, repeatable behavior only.

========================================================
PART 5 — TECHNICAL / BUILD STATE
========================================================
DISTRIBUTION MODEL (locked): each dad gets his own Grok account -> installs the public "Chip" template -> Chip runs on DDE rails. DDE owns a multi-tenant vault (dad_id per dad). "Chip is the app" — no separate app store app or custom site for v1. Runtime brain effectively = Grok by distribution.

SHARED MEMORY SPINE — 3 layers: (1) capture (voice/text in), (2) extract+vault (pull structured fields, keep raw quote, write one record — the ONLY custom-built part), (3) view (all outputs generated by querying the vault on demand). Store data UNDERNEATH the spreadsheet, never the spreadsheet. Nick's Obsidian+Excel method IS this, done by hand.

BUILD vs BUY: rent everything, build only the middle layer. Brain = Claude/Grok API; voice = ElevenLabs; vault = Supabase (chosen over Firebase — Postgres fits structured rows); doc parsing = OCR service; charts/PDF = libraries.

TWO-PIPE EVIDENCE RULE (critical): never let what a dad SAYS masquerade as evidence. TALK pipe = vent/claims (never exported as evidence alone). RECORD pipe = OFW exports + bank statements (the evidence layer). Dad's input logged as "claim," source data as "verified." Court reports draw ONLY from verified. His claim points the flashlight; the system confirms the real number from the record.

LIVE STATE (last stop point, Sept 20):
- Tip live on Railway, commit 79fbce1, 112/112 Postgres tests passing, PR #8.
- Landed: read-only GET state (404 unknown), POST provision (409 dup), tenancy/auth (Razor PASS), durable SHA-256 tokens in Postgres, cold-draft store (draft != send), soft grade, return/cold-ask memory, Missing-fill + progress, statement paste -> one noticed sentence.
- Vault BFF on Railway; Supabase behind it.
- Product folder: Documents/Claude/Projects/DDE-PRODUCT/
- Seat names in code: Chip (front door/one Next), Eddie (Edge/state), Quill (vent->claim/intake), Stan (OFW verified pull), Tone (cold draft), Exhibit (reports, verified only), Rob (kids ops/portals — BLOCKED on dad logins), Grant, Tim.
- Engineering seats: Forge = Claude Code build, Razor = cold-check, Patch = Grok quarterback.

WHO-BUILDS-WHAT governance: separate DESIGNER from BUILDER from CHECKER. Design fleet writes spec -> Claude Code (Forge) builds -> Grok (Razor) checks cold against spec -> Nick gives exact-yes. Builder never grades its own homework. Expect Claude and Grok to disagree — the disagreement is the signal.

TESTING SEQUENCE (corrected): (1) AI-vs-AI (second AI plays a furious dad; cheap safety+plumbing test run thousands of times) -> (2) Nick as tester for CONTENT/ACCURACY only (worst judge of ease-of-use — can't un-know what he knows) -> (3) one real STRANGER at the start of the journey, on the fake family fixture -> (4) only then money.

========================================================
PART 6 — WHAT HAPPENED SINCE THE FIRST BIG BUILD (the story)
========================================================
- FIRST BIG BUILD (~a week ago, while Nick was in Hawaii): the concept turned into a real build. Nick bounced between Claude and Grok, handed plans to Grok to execute in Claude Code. Then PAUSED — not because of the divorce, but because the codebase got hard to work with.
- ROOT PROBLEM Nick diagnosed himself: source info fed into Claude Code was never indexed or categorized, so it hallucinates when it can't find what it needs. Same data-hygiene problem as his affidavit work. Fix = index/categorize FIRST, point Claude Code at the map, then resume one bot at a time.
- AFFIDAVIT DETOUR: the urgent priority became Form 12.902(c). Numbers were FROZEN Sept 22 (FROZEN_NUMBERS_2026-09-22.xlsx). Nick ran an overnight self-audit (trace every line to source, green/yellow/red buckets, output only 5-10 plain-English decisions). TODAY (Sept 26) is the day he's finalizing the affidavit documents. RAIL reminder: don't quote live dollar figures anywhere that could differ from the frozen affidavit.
- COMMUNICATION COACH VALIDATION (this week): Leah sent a threatening low-balance message ("put money in or I talk to my lawyers"). Nick wrote back himself and quoted dollar figures — exactly the slip the Coach's no-live-figures rail exists to prevent, and dangerous right before signing the affidavit.
- TODAY'S LEAH INTERACTION (medical calendar): Nick asked Leah to put the kids' doctor/dentist/counseling appointments on the shared calendar (he only has school access). She replied "you've never wanted to know about that in 14 years." His other Claude said leave it alone; this session said reply with a clean on-the-record restatement, ignore the jab.

========================================================
PART 7 — TWO NEW DESIGN RAILS (Sept 26 — make sure these get in)
========================================================
1. DE-ESCALATE vs DOCUMENT: the Communication Coach must NOT always default to walk-away. Some silences throw away evidence. It has to flag when a message contains a request the dad wants ON THE RECORD (the medical-calendar ask is the textbook case). Second gear: flip from protect-your-peace to document-this.
2. NEVER DIAGNOSE THE EX'S MOTIVE: document behavior + effect on access only. Intent is a rabbit hole that pulls the dad back into the emotional story.

CANON DYNAMIC (why Kids track stays first): Canon is 14. In Florida a 14-year-old's stated preference carries real weight; the judge may interview him and he could refuse the 50-50 Nick is requesting. If the wedge severs the relationship, the fracture becomes legally load-bearing. Every logged appointment Nick is kept out of, and every documented request to be included, does double duty: evidence of gatekeeping AND Nick fighting to preserve the relationship the interview turns on.

CHILD-COERCION pattern to document (behavior only, never diagnose): leading questions to the kids ("did dad do this, you can tell me"); can be laundered through a therapist or religious framing ("your dad is compromised / no longer safe"). Nick has video of Leah coercing the kids. Leah's specific line: Nick "has been compromised and is no longer safe." Note: Nick genuinely WANTS the kids around Leah's church/baptism/volunteering — his concern is the religious framing used as a weapon, not the faith itself.

========================================================
PART 8 — OPEN DECISIONS (answer these to unblock the build)
========================================================
1. CORE DEFINITION: handoff drifted to "statement drop = one noticed sentence," but locked core is "vent -> one next step." Which is it? (one sentence)
2. PASTE vs LINK for chip_entry.
3. VOICE: Grok runtime vs Nick's own ElevenLabs voice clone. The Grok distribution pivot conflicts with using his voice — Grok can't run a custom ElevenLabs voice. Pick convenience or his voice for v1. (Nick has a partial clone done — ~1 of 3 hours.)
4. PROVISION "kids-facts 0/5" must be one question at a time, not a form.
5. AUTH GAP flagged: no auth on the BFF — public template + public URL + dad_id = anyone can read/write any dad. Auth gate + RLS required before any real dad is provisioned.
6. MULTI-AI question still open: Nick liked ChatGPT and Claude's voice; disliked Grok's voice feature. Whether/how to split platforms across components is undecided.

========================================================
PART 9 — FIRST ACTION THIS WEEKEND
========================================================
Run the Chip walk on the synthetic Alex Rivera fixture (never Nick's real redacted statement). Let the friction tell you what to build. Then answer the open decisions in Part 8. Respect the stop rule: code only from walk friction; case work stays in the Divorce vault.

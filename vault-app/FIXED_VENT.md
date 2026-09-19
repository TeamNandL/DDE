# FIXED_VENT — standard Intake test input

Speaker: **Alex Rivera** (fake demo dad). Co-parent: **Jordan Lee**.
Kids: **Sam** (8), **Taylor** (5). This is the fixed vent every Intake test
runs against. It intentionally contains venom (characterizations to strip),
a count claim (to chase, not store), kid names, an amount, and one
observable late-exchange fact pattern.

---

Jordan was supposed to meet us at 6pm at the Maple Street parking lot for
the exchange and didn't show up until 6:45. This is the third time this
month. Sam and Taylor were sitting in the back seat the whole time asking
where she was. She is doing this on purpose, she's spiteful and she's
destroying any stability the kids have. I had to pay the sitter $30 extra
because we missed the start of her shift.

---

Expected extraction (claim pipe):

- one `events` row: `event_type='late_exchange'`, scheduled 6:00pm,
  occurred 6:45pm, location "Maple Street parking lot", kids Sam + Taylor
- venom sentence ("on purpose … spiteful … destroying …") dropped entirely —
  stored nowhere, including `raw_quote`
- count claim ("third time this month") never stored as a number anywhere;
  instead `state.missing` gains: `verify count in OFW record for September`
- verified export from this session: zero rows

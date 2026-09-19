// Fake-family demo fixtures only. Never load real case data.
// Alex Rivera · Jordan Lee · Sam (8) · Taylor (5).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const DEMO_DAD_ID = "11111111-1111-4111-8111-111111111111";
export const DEMO_MONDAY = new Date("2026-09-14T12:00:00");

export function readFixedVent() {
  return readFileSync(join(here, "..", "FIXED_VENT.md"), "utf8")
    .split(/^---$/m)[1]
    .replace(/\s+/g, " ")
    .trim();
}

// All writes go through the BFF — same app path as Intake / product bots.
export async function seedDemo(bff, dadId = DEMO_DAD_ID) {
  const intake = await bff.postVaultIntake(
    { dad_id: dadId, text: readFixedVent() },
    { referenceDate: DEMO_MONDAY },
  );
  const cold = await bff.postCommsCold({
    dad_id: dadId,
    channel: "ofw",
    body_cold: "Confirming I was at the Maple Street parking lot at the scheduled exchange time.",
  });
  const pull = await bff.postCommsPull({
    dad_id: dadId,
    channel: "ofw",
    source_ref: "ofw:demo:2026-09-14",
    body_cold: "OFW thread pulled for the September 14 exchange.",
    sent_at: "2026-09-14T18:00:00.000Z",
  });
  return { dad_id: dadId, intake, cold, pull };
}

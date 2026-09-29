#!/usr/bin/env node
// Nick-only dad lifecycle (Slice 21): export / delete / cancel / purge.
// Not an HTTP surface. Runs where the server's DATABASE_URL (or the JSON
// fallbacks DDE_TOKENS_PATH / DDE_OPS_PATH) is set.
//
//   npm run dad:export        -- --dad-id <uuid> [--out file.zip]   # bundle + receipt
//   npm run dad:delete        -- --dad-id <uuid>                    # SOFT: needs a fresh receipt
//   npm run dad:cancel-delete -- --dad-id <uuid>                    # inside the 14 days
//   npm run dad:purge         [-- --dad-id <uuid>]                  # HARD wipe of every due deletion
//
// There is no dad-facing delete. Delete protects the dad from himself.
// Output masks ids to their last 4.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeBff } from "./bff.js";
import { mask } from "./logger.js";
import { databaseUrl, openStore } from "./store.js";
import { defaultJsonPath, openTokenStore } from "./tokens.js";
import { defaultOpsPath, openOpsStore } from "./opsstore.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMANDS = ["export", "delete", "cancel-delete", "purge"];

function usage() {
  return `Usage: node src/cli-dad.js <export|delete|cancel-delete|purge> [--dad-id <uuid>] [--out <file.zip>]

  export         Write the dad's bundle (zip) and record an export receipt.
  delete         SOFT-delete: revoke every token, schedule the hard wipe 14 days out.
                 Refused unless an export receipt newer than DDE_EXPORT_FRESH_DAYS (7) exists.
  cancel-delete  Cancel a pending deletion inside the window. Data untouched. Reissue a token after.
  purge          HARD-wipe every deletion whose window has passed (or only --dad-id). Irreversible.
`;
}

/**
 * @param {string[]} argv
 * @param {{ bff?: object, write?: (s: string) => void, now?: number }} [deps]
 */
export async function runDadCli(argv = process.argv.slice(2), deps = {}) {
  const write = deps.write || ((s) => process.stdout.write(s));
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "dad-id": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const cmd = positionals[0];
  if (values.help || !COMMANDS.includes(cmd)) {
    write(usage());
    return { ok: Boolean(values.help), code: values.help ? 0 : 2 };
  }
  const dad_id = values["dad-id"];
  if (cmd !== "purge" && !UUID_RE.test(String(dad_id || ""))) {
    write("--dad-id <uuid> is required\n");
    return { ok: false, code: 2 };
  }
  if (dad_id && !UUID_RE.test(dad_id)) {
    write("--dad-id must be a uuid\n");
    return { ok: false, code: 2 };
  }

  let bff = deps.bff;
  let close = async () => {};
  if (!bff) {
    const url = databaseUrl();
    const store = await openStore({ databaseUrl: url });
    const tokenStore = url
      ? await openTokenStore({ query: store.query })
      : await openTokenStore({ jsonPath: process.env.DDE_TOKENS_PATH || defaultJsonPath() });
    const opsStore = url ? await openOpsStore({ query: store.query }) : await openOpsStore({ jsonPath: defaultOpsPath() });
    bff = makeBff(store.vault, { tokenStore, opsStore });
    close = async () => {
      await tokenStore.close();
      await opsStore.close();
      await store.close();
    };
  }
  const now = deps.now ?? Date.now();

  try {
    if (cmd === "export") {
      const out = await bff.exportDad({ dad_id, actor: "operator", now });
      const file = values.out ? resolve(values.out) : resolve(`dde-export-${dad_id.slice(-4)}-${out.exported_at.slice(0, 10)}.zip`);
      writeFileSync(file, out.zip);
      write(`exported dad ${mask(dad_id)} → ${file} (${out.bytes} bytes, sha256 ${out.sha256.slice(0, 12)}…)\n` +
        `receipt ${mask(out.receipt.id)} at ${out.receipt.created_at}; claims ${out.counts.claims}, verified ${out.counts.verified}\n`);
      return { ok: true, code: 0, file, ...out };
    }
    if (cmd === "delete") {
      const d = await bff.requestDelete({ dad_id, now });
      write(`soft-deleted dad ${mask(dad_id)}: tokens revoked ${d.revoked}; hard wipe due ${d.purge_at}\n` +
        `cancel with: npm run dad:cancel-delete -- --dad-id <uuid>\n`);
      return { ok: true, code: 0, ...d };
    }
    if (cmd === "cancel-delete") {
      const d = await bff.cancelDelete({ dad_id, now });
      write(`cancelled deletion for dad ${mask(dad_id)}. Data untouched. Tokens stay revoked — reissue one.\n`);
      return { ok: true, code: 0, ...d };
    }
    const res = await bff.purgeDue({ now, dad_id: dad_id || undefined });
    for (const p of res.purged) write(`PURGED dad ${mask(p.dad_id)} at ${p.purged_at}: ${JSON.stringify(p.counts)}\n`);
    if (!res.purged.length) write("nothing due\n");
    return { ok: true, code: 0, ...res };
  } catch (err) {
    const msg = err?.status === 404 ? "unknown dad" : err?.message || "failed";
    write(`refused: ${mask(msg)} (dad ${mask(dad_id || "")})\n`);
    return { ok: false, code: 1, error: msg };
  } finally {
    await close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const { code } = await runDadCli();
  process.exitCode = code;
}

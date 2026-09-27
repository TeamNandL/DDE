#!/usr/bin/env node
// Operator token lifecycle (Slice 20). Not an HTTP route — needs the same
// DATABASE_URL / DDE_TOKENS_PATH the server uses.
//
//   npm run token:revoke  -- --dad-id <uuid>   # kill every token for a dad
//   npm run token:reissue -- --dad-id <uuid>   # revoke all, mint one fresh
//
// reissue prints the raw token ONCE (to stdout); only its hash is stored.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeBff } from "./bff.js";
import { databaseUrl, openStore } from "./store.js";
import { defaultJsonPath, openTokenStore } from "./tokens.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage() {
  return `Usage: node src/cli-token.js <revoke|reissue> --dad-id <uuid>

  revoke    Revoke every live token for the dad (lost phone, leaked link).
  reissue   Revoke every live token, then mint one fresh token (printed once).

Tokens expire DDE_TOKEN_TTL_DAYS (default 30) after mint.
`;
}

/**
 * @param {string[]} argv
 * @param {{ bff?: object, write?: (s: string) => void }} [deps] tests inject a bff
 */
export async function runTokenCli(argv = process.argv.slice(2), deps = {}) {
  const write = deps.write || ((s) => process.stdout.write(s));
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "dad-id": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const cmd = positionals[0];
  if (values.help || !["revoke", "reissue"].includes(cmd)) {
    write(usage());
    return { ok: Boolean(values.help), code: values.help ? 0 : 2 };
  }
  const dad_id = values["dad-id"];
  if (!UUID_RE.test(String(dad_id || ""))) {
    write("--dad-id <uuid> is required\n");
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
    bff = makeBff(store.vault, { tokenStore });
    close = async () => {
      await tokenStore.close();
      await store.close();
    };
  }

  try {
    if (cmd === "revoke") {
      const { revoked } = await bff.postVaultTokenRevoke({ dad_id });
      write(`revoked ${revoked} token(s) for ${dad_id}\n`);
      return { ok: true, code: 0, revoked };
    }
    const out = await bff.reissueToken({ dad_id });
    write(
      `revoked ${out.revoked} token(s) for ${dad_id}\n` +
        `token ${out.token}\n` +
        `expires_at ${out.expires_at}\n`,
    );
    return { ok: true, code: 0, ...out };
  } catch (err) {
    write(`${err?.status === 404 ? "unknown dad" : "failed"}: ${dad_id}\n`);
    return { ok: false, code: 1 };
  } finally {
    await close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const { code } = await runTokenCli();
  process.exitCode = code;
}

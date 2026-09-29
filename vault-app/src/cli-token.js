#!/usr/bin/env node
// Nick-only token lifecycle (Slice 20). Not an HTTP route — runs where the
// server's DATABASE_URL (or DDE_TOKENS_PATH) is set, so only the operator
// can reach it. Dads log out from the app (POST /vault/logout, all-device).
//
//   npm run token:revoke  -- --dad-id <uuid>   # kill every token for one dad
//   npm run token:reissue -- --dad-id <uuid>   # revoke all, mint one fresh
//   npm run token:sweep                        # durably revoke every idle-expired token
//   npm run token:revoke-all -- --yes          # NUCLEAR: every token, every dad (rollback step)
//
// reissue prints the raw token ONCE (to stdout); only its hash is stored.
// Everything else prints masked ids (last 4) — never a full token or dad_id.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeBff } from "./bff.js";
import { mask } from "./logger.js";
import { databaseUrl, openStore } from "./store.js";
import { defaultJsonPath, openTokenStore, tokenTtlMs } from "./tokens.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMANDS = ["revoke", "reissue", "sweep", "revoke-all"];

function usage() {
  return `Usage: node src/cli-token.js <revoke|reissue|sweep|revoke-all> [--dad-id <uuid>] [--yes]

  revoke      Revoke every live token for one dad (lost phone, leaked link).
  reissue     Revoke every live token for one dad, then mint one (printed once).
  sweep       Durably revoke every token idle past DDE_TOKEN_TTL_DAYS (run before a rollback).
  revoke-all  Revoke EVERY live token for EVERY dad. Needs --yes. Rollback kill switch.

Tokens expire after DDE_TOKEN_TTL_DAYS (default 30) of inactivity.
`;
}

/**
 * @param {string[]} argv
 * @param {{ bff?: object, tokenStore?: object, write?: (s: string) => void, now?: number }} [deps] tests inject a bff
 */
export async function runTokenCli(argv = process.argv.slice(2), deps = {}) {
  const write = deps.write || ((s) => process.stdout.write(s));
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "dad-id": { type: "string" },
      yes: { type: "boolean", default: false },
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
  const needsDad = cmd === "revoke" || cmd === "reissue";
  if (needsDad && !UUID_RE.test(String(dad_id || ""))) {
    write("--dad-id <uuid> is required\n");
    return { ok: false, code: 2 };
  }
  if (cmd === "revoke-all" && !values.yes) {
    write("revoke-all logs out EVERY dad on EVERY device. Re-run with --yes.\n");
    return { ok: false, code: 2 };
  }

  let bff = deps.bff;
  let tokenStore = deps.tokenStore || bff?._tokenStore;
  let close = async () => {};
  if (!bff) {
    const url = databaseUrl();
    const store = await openStore({ databaseUrl: url });
    tokenStore = url
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
      const { revoked } = await bff.revokeDad({ dad_id });
      write(`revoked ${revoked} token(s) for dad ${mask(dad_id)}\n`);
      return { ok: true, code: 0, revoked };
    }
    if (cmd === "reissue") {
      const out = await bff.reissueToken({ dad_id });
      write(`revoked ${out.revoked} token(s) for dad ${mask(dad_id)}\n` + `token ${out.token}\n`);
      return { ok: true, code: 0, ...out };
    }
    if (cmd === "sweep") {
      const revoked = await tokenStore.revokeIdle(tokenTtlMs(), deps.now ?? Date.now());
      write(`swept ${revoked} idle-expired token(s)\n`);
      return { ok: true, code: 0, revoked };
    }
    const revoked = await tokenStore.revokeAll();
    write(`revoked ${revoked} token(s) — every dad must be reissued\n`);
    return { ok: true, code: 0, revoked };
  } catch (err) {
    write(`${err?.status === 404 ? "unknown dad" : "failed"}: ${mask(dad_id)}\n`);
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

#!/usr/bin/env node
// Optional HTTP surface for the Phase 1 BFF.
// Off unless you start this process (`npm run serve` or `node src/server.js --http`).
// Product bots call these routes; seats still never touch the vault directly.
//
// Minimal token gate: provision returns {dad_id, token}; mutating routes and
// sensitive reads require Authorization: Bearer <token> or X-DDE-Token matching
// that dad. Token *hashes* persist via tokens.js (Postgres when vault is on
// DATABASE_URL; else .dde-tokens.json). Bind to 127.0.0.1 by default locally.
// Production / container hosts (Docker, Fly, Render) listen on 0.0.0.0:$PORT
// — see HOSTING.md.

import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeBff } from "./bff.js";
import { databaseUrl, openStore } from "./store.js";
import { defaultJsonPath, openTokenStore } from "./tokens.js";
import { DEMO_DAD_ID, seedDemo } from "./demo.js";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHIP_ENTRY_HTML = readFileSync(resolve(__dirname, "../public/chip-entry.html"), "utf8");

export const CHIP_ENTRY_PATHS = ["/app", "/chip/entry"];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_BODY = 64 * 1024;

export const PHASE1_ROUTES = [
  "POST /vault/intake",
  "POST /vault/notice",
  "POST /vault/return",
  "POST /vault/missing/fill",
  "POST /vault/missing/seed",
  "POST /vault/provision",
  "GET /vault/state",
  "PUT /vault/state",
  "GET /vault/progress",
  "GET /vault/chip_entry",
  "POST /vault/comms/cold",
  "POST /vault/comms/draft",
  "GET /vault/comms/drafts",
  "POST /vault/comms/pull",
  "GET /vault/export/verified",
  "GET /vault/search",
];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function send(res, status, body, contentType = "application/json; charset=utf-8") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY) {
        const err = new Error("payload too large");
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error("invalid json");
        err.status = 400;
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function requireDadId(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    const err = new Error("dad_id is required and must be a uuid");
    err.status = 400;
    throw err;
  }
  return value;
}

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/** Bearer <token> or X-DDE-Token */
export function extractToken(req) {
  const auth = req.headers?.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)/i.exec(auth.trim());
    if (m) return m[1];
  }
  const x = req.headers?.["x-dde-token"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return null;
}

/**
 * Tenancy + auth for every dad-scoped route except provision.
 * Order: dad exists → 404 unknown dad; then token → 401/403.
 * (Unprovisioned curls without a token must still get 404, not 401.)
 */
async function gateDad(bff, req, dad_id) {
  const state = await bff.getVaultState({ dad_id });
  if (!state) {
    const err = new Error("unknown dad");
    err.status = 404;
    throw err;
  }
  await bff.checkToken(dad_id, extractToken(req));
}

export async function handleBffRequest(bff, req, url, body) {
  const path = normalizePath(url.pathname);
  const method = req.method || "GET";
  const q = url.searchParams;

  // Host healthcheck — no vault, no DB, no dad_id.
  if (method === "GET" && path === "/health") {
    return { status: 200, body: { ok: true } };
  }

  // Chip deep-link entry — static minimal HTML (same origin as BFF).
  if (method === "GET" && CHIP_ENTRY_PATHS.includes(path)) {
    return {
      status: 200,
      body: CHIP_ENTRY_HTML,
      contentType: "text/html; charset=utf-8",
    };
  }

  if (method === "GET" && path === "/") {
    return {
      status: 200,
      body: {
        ok: true,
        name: "dde-vault-bff",
        phase: 1,
        routes: PHASE1_ROUTES,
        chip_entry: CHIP_ENTRY_PATHS,
      },
    };
  }

  // ONLY create path — no prior token required.
  if (method === "POST" && path === "/vault/provision") {
    const dad_id =
      body.dad_id === undefined || body.dad_id === null || body.dad_id === ""
        ? undefined
        : requireDadId(body.dad_id);
    const out = await bff.postVaultProvision({ dad_id });
    log("http.provision", { dad: out.dad_id });
    return { status: 200, body: out };
  }

  if (method === "POST" && path === "/vault/intake") {
    const dad_id = requireDadId(body.dad_id);
    await gateDad(bff, req, dad_id);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      const err = new Error("text is required");
      err.status = 400;
      throw err;
    }
    let source;
    if (body.source !== undefined && body.source !== null && body.source !== "") {
      if (body.source !== "statement") {
        const err = new Error("unknown source");
        err.status = 400;
        throw err;
      }
      source = body.source;
    }
    log("http.intake", { dad: dad_id, source: source ?? "vent" });
    return {
      status: 200,
      body: await bff.postVaultIntake({
        dad_id,
        text,
        make_notice: body.make_notice === true,
        source,
      }),
    };
  }

  if (method === "POST" && path === "/vault/return") {
    const dad_id = requireDadId(body.dad_id);
    await gateDad(bff, req, dad_id);
    // Absent answer = greeting only; a PRESENT answer must carry words.
    let answer;
    if (body.answer !== undefined && body.answer !== null) {
      if (typeof body.answer !== "string" || !body.answer.trim()) {
        const err = new Error("answer must be a non-empty string");
        err.status = 400;
        throw err;
      }
      answer = body.answer;
    }
    // Log hygiene: ids/flags only — never the line or the answer.
    log("http.return", { dad: dad_id, answered: Boolean(answer) });
    return { status: 200, body: await bff.postVaultReturn({ dad_id, answer }) };
  }

  if (method === "POST" && path === "/vault/missing/seed") {
    const dad_id = requireDadId(body.dad_id);
    await gateDad(bff, req, dad_id);
    let pack;
    if (body.pack !== undefined && body.pack !== null && body.pack !== "") {
      if (typeof body.pack !== "string") {
        const err = new Error("pack must be a string");
        err.status = 400;
        throw err;
      }
      pack = body.pack;
    }
    log("http.missing.seed", { dad: dad_id });
    return { status: 200, body: await bff.postMissingSeed({ dad_id, pack }) };
  }

  if (method === "POST" && path === "/vault/missing/fill") {
    const dad_id = requireDadId(body.dad_id);
    await gateDad(bff, req, dad_id);
    const answer = typeof body.answer === "string" ? body.answer : "";
    if (!answer.trim()) {
      const err = new Error("answer is required");
      err.status = 400;
      throw err;
    }
    // Log hygiene: ids only — never the answer or the item.
    log("http.missing.fill", { dad: dad_id });
    return { status: 200, body: await bff.postMissingFill({ dad_id, answer }) };
  }

  if (method === "POST" && path === "/vault/notice") {
    const dad_id = requireDadId(body.dad_id);
    await gateDad(bff, req, dad_id);
    let event_id = null;
    if (body.event_id !== undefined && body.event_id !== null && body.event_id !== "") {
      if (typeof body.event_id !== "string" || !UUID_RE.test(body.event_id)) {
        const err = new Error("event_id must be a uuid");
        err.status = 400;
        throw err;
      }
      event_id = body.event_id;
    }
    // Log hygiene: ids only — never noticed_text.
    log("http.notice", { dad: dad_id });
    return { status: 200, body: await bff.postVaultNotice({ dad_id, event_id }) };
  }

  if (method === "GET" && path === "/vault/state") {
    // Read-only: never insert/upsert/create on GET.
    const dad_id = requireDadId(body.dad_id || q.get("dad_id"));
    await gateDad(bff, req, dad_id);
    const state = await bff.getVaultState({ dad_id });
    if (!state) return { status: 404, body: { error: "unknown dad" } };
    log("http.state.get", { dad: dad_id });
    return { status: 200, body: state };
  }

  if ((method === "PUT" || method === "PATCH") && path === "/vault/state") {
    const dad_id = requireDadId(body.dad_id);
    await gateDad(bff, req, dad_id);
    const state = await bff.putVaultState(body);
    log("http.state.put", { dad: dad_id });
    return { status: 200, body: state };
  }

  if (method === "GET" && path === "/vault/chip_entry") {
    // Read-only: never writes, never stamps last_next.
    const dad_id = requireDadId(body.dad_id || q.get("dad_id"));
    await gateDad(bff, req, dad_id);
    log("http.chip_entry", { dad: dad_id });
    return { status: 200, body: await bff.getChipEntry({ dad_id }) };
  }

  if (method === "GET" && path === "/vault/progress") {
    // Read-only, same gate as state.
    const dad_id = requireDadId(body.dad_id || q.get("dad_id"));
    await gateDad(bff, req, dad_id);
    log("http.progress", { dad: dad_id });
    return { status: 200, body: await bff.getVaultProgress({ dad_id }) };
  }

  if (method === "POST" && path === "/vault/comms/cold") {
    const dad_id = requireDadId(body.dad_id);
    await gateDad(bff, req, dad_id);
    if (typeof body.body_cold !== "string" || !body.body_cold.trim()) {
      const err = new Error("body_cold is required");
      err.status = 400;
      throw err;
    }
    log("http.comms.cold", { dad: dad_id });
    return { status: 200, body: await bff.postCommsCold(body) };
  }

  if (method === "POST" && path === "/vault/comms/draft") {
    const dad_id = requireDadId(body.dad_id);
    await gateDad(bff, req, dad_id);
    if (typeof body.body !== "string" || !body.body.trim()) {
      const err = new Error("body is required");
      err.status = 400;
      throw err;
    }
    // Log hygiene: ids only — never the draft text.
    log("http.comms.draft", { dad: dad_id });
    return {
      status: 200,
      body: await bff.postCommsDraft({ dad_id, body: body.body, kind: body.kind }),
    };
  }

  if (method === "GET" && path === "/vault/comms/drafts") {
    const dad_id = requireDadId(body.dad_id || q.get("dad_id"));
    await gateDad(bff, req, dad_id);
    log("http.comms.drafts", { dad: dad_id });
    return { status: 200, body: await bff.getCommsDrafts({ dad_id }) };
  }

  if (method === "POST" && path === "/vault/comms/pull") {
    const dad_id = requireDadId(body.dad_id);
    await gateDad(bff, req, dad_id);
    if (typeof body.source_ref !== "string" || !body.source_ref.trim()) {
      const err = new Error("source_ref is required");
      err.status = 400;
      throw err;
    }
    log("http.comms.pull", { dad: dad_id });
    return { status: 200, body: await bff.postCommsPull(body) };
  }

  if (method === "GET" && path === "/vault/export/verified") {
    const dad_id = requireDadId(body.dad_id || q.get("dad_id"));
    await gateDad(bff, req, dad_id);
    const rows = await bff.getVaultExportVerified({ dad_id });
    return { status: 200, body: rows };
  }


  if (method === "GET" && path === "/vault/search") {
    const dad_id = requireDadId(body.dad_id || q.get("dad_id"));
    await gateDad(bff, req, dad_id);
    const result = await bff.getVaultSearch({
      dad_id,
      q: q.get("q") ?? body.q ?? "",
      pipe: q.get("pipe") ?? body.pipe ?? "",
      type: q.get("type") ?? body.type ?? "all",
      from: q.get("from") ?? body.from ?? "",
      to: q.get("to") ?? body.to ?? "",
      limit: q.get("limit") ?? body.limit ?? "",
    });
    // Log hygiene: ids/counts only — never raw_quote / body / snippet.
    log("http.search", {
      dad: dad_id,
      hits: result.hits?.length ?? 0,
      mode: result.mode,
      q_len: String(q.get("q") ?? "").length,
    });
    return { status: 200, body: result };
  }

  return { status: 404, body: { error: "not found" } };
}

export function createServer(bff) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      let body = {};
      if (req.method !== "GET" && req.method !== "HEAD") {
        body = await readBody(req);
      }
      const result = await handleBffRequest(bff, req, url, body);
      const ct = result.contentType || "application/json; charset=utf-8";
      send(res, result.status, result.body, ct);
    } catch (err) {
      const status = Number(err?.status);
      const msg = String(err?.message || "bad request");
      if (status >= 400 && status < 600) {
        json(res, status, { error: status >= 500 ? "internal error" : msg });
        return;
      }
      if (/required|must be|unknown |pipe |invalid /i.test(msg)) {
        json(res, 400, { error: msg });
        return;
      }
      json(res, 500, { error: "internal error" });
    }
  });
}

export async function listenServer(server, { host, port }) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address();
}

// Local default is loopback. Production (NODE_ENV=production or HOST=)
// binds all interfaces so Fly/Render/Docker can reach the process.
export function resolveListenHostPort({ host, port, env = process.env } = {}) {
  const listenHost =
    host || env.HOST || (env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  const listenPort = Number(port || env.PORT || 8787);
  return { host: listenHost, port: listenPort };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      http: { type: "boolean", default: false },
      demo: { type: "boolean", default: false },
      "on-db": { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(
      "DDE Phase 1 HTTP BFF (optional)\n\n" +
        "  npm run serve [-- --demo] [-- --port 8787] [-- --host 127.0.0.1]\n" +
        "  node src/server.js --http --demo\n" +
        "  HOST=0.0.0.0 PORT=8787 node src/server.js --http   # container / Fly / Render\n\n" +
        "Routes: " +
        PHASE1_ROUTES.join(", ") +
        "\nChip entry: " +
        CHIP_ENTRY_PATHS.join(", ") +
        "\n",
    );
    return { started: false };
  }

  const url = databaseUrl();
  const usePostgres = Boolean(url) && (!values.demo || values["on-db"]);
  const store = await openStore({ databaseUrl: usePostgres ? url : "" });
  // Prefer Postgres token table when vault already on PG; else JSON file.
  const tokenStore = usePostgres
    ? await openTokenStore({ query: store.query })
    : await openTokenStore({
        jsonPath: process.env.DDE_TOKENS_PATH || defaultJsonPath(),
      });
  const bff = makeBff(store.vault, { tokenStore });
  if (values.demo) {
    await seedDemo(bff, DEMO_DAD_ID);
  }

  const { host, port } = resolveListenHostPort({
    host: values.host,
    port: values.port,
  });
  const server = createServer(bff);
  const addr = await listenServer(server, { host, port });
  const bound = typeof addr === "object" && addr ? `http://${addr.address}:${addr.port}` : "";
  process.stdout.write(
    `dde-vault-bff ${bound} store=${store.kind} tokens=${tokenStore.kind} demo=${Boolean(values.demo)}\n`,
  );

  const shutdown = async () => {
    server.close();
    await tokenStore.close();
    await store.close();
  };
  process.on("SIGINT", () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    shutdown().finally(() => process.exit(0));
  });

  return { started: true, server, store, bff, addr, http: true };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  await main();
}

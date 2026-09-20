#!/usr/bin/env node
// Optional HTTP surface for the Phase 1 BFF.
// Off unless you start this process (`npm run serve` or `node src/server.js --http`).
// Product bots call these routes; seats still never touch the vault directly.
//
// AUTH is not built (later gate). Bind to 127.0.0.1 by default locally.
// Production / container hosts (Docker, Fly, Render) listen on 0.0.0.0:$PORT
// — see HOSTING.md. That is a bind note only; no auth is added here.

import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeBff } from "./bff.js";
import { databaseUrl, openStore } from "./store.js";
import { DEMO_DAD_ID, seedDemo } from "./demo.js";
import { log } from "./logger.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_BODY = 64 * 1024;

export const PHASE1_ROUTES = [
  "POST /vault/intake",
  "GET /vault/state",
  "PUT /vault/state",
  "POST /vault/comms/cold",
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

export async function handleBffRequest(bff, req, url, body) {
  const path = normalizePath(url.pathname);
  const method = req.method || "GET";
  const q = url.searchParams;

  // Host healthcheck — no vault, no DB, no dad_id.
  if (method === "GET" && path === "/health") {
    return { status: 200, body: { ok: true } };
  }

  if (method === "GET" && path === "/") {
    return {
      status: 200,
      body: {
        ok: true,
        name: "dde-vault-bff",
        phase: 1,
        routes: PHASE1_ROUTES,
      },
    };
  }

  if (method === "POST" && path === "/vault/intake") {
    const dad_id = requireDadId(body.dad_id);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      const err = new Error("text is required");
      err.status = 400;
      throw err;
    }
    log("http.intake", { dad: dad_id });
    return { status: 200, body: await bff.postVaultIntake({ dad_id, text }) };
  }

  if (method === "GET" && path === "/vault/state") {
    const dad_id = requireDadId(body.dad_id || q.get("dad_id"));
    const state = await bff.getVaultState({ dad_id });
    if (!state) return { status: 404, body: { error: "state not found" } };
    log("http.state.get", { dad: dad_id });
    return { status: 200, body: state };
  }

  if (method === "PUT" && path === "/vault/state") {
    const dad_id = requireDadId(body.dad_id);
    const state = await bff.putVaultState(body);
    log("http.state.put", { dad: dad_id });
    return { status: 200, body: state };
  }

  if (method === "POST" && path === "/vault/comms/cold") {
    const dad_id = requireDadId(body.dad_id);
    if (typeof body.body_cold !== "string" || !body.body_cold.trim()) {
      const err = new Error("body_cold is required");
      err.status = 400;
      throw err;
    }
    log("http.comms.cold", { dad: dad_id });
    return { status: 200, body: await bff.postCommsCold(body) };
  }

  if (method === "POST" && path === "/vault/comms/pull") {
    const dad_id = requireDadId(body.dad_id);
    if (typeof body.source_ref !== "string" || !body.source_ref.trim()) {
      const err = new Error("source_ref is required");
      err.status = 400;
      throw err;
    }
    log("http.comms.pull", { dad: dad_id });
    return { status: 200, body: await bff.postCommsPull(body) };
  }

  // Seat search/filter surface. dad_id REQUIRED (400 without it); q optional
  // (empty q = filtered list). May return claim and verified rows, labeled.
  // NOT a Reporting route — exhibits still use /vault/export/verified only.
  // The query text is never logged.
  if (method === "GET" && path === "/vault/search") {
    const dad_id = requireDadId(body.dad_id || q.get("dad_id"));
    const rows = await bff.getVaultSearch({
      dad_id,
      q: q.get("q") ?? undefined,
      pipe: q.get("pipe") ?? undefined,
      type: q.get("type") ?? undefined,
      from: q.get("from") ?? undefined,
      to: q.get("to") ?? undefined,
      limit: q.get("limit") ?? undefined,
    });
    log("http.search", { dad: dad_id, hits: rows.length });
    return { status: 200, body: rows };
  }

  if (method === "GET" && path === "/vault/export/verified") {
    const dad_id = requireDadId(body.dad_id || q.get("dad_id"));
    const rows = await bff.getVaultExportVerified({ dad_id });
    return { status: 200, body: rows };
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
      json(res, result.status, result.body);
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
        "\n",
    );
    return { started: false };
  }

  const url = databaseUrl();
  const usePostgres = Boolean(url) && (!values.demo || values["on-db"]);
  const store = await openStore({ databaseUrl: usePostgres ? url : "" });
  const bff = makeBff(store.vault);
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
  process.stdout.write(`dde-vault-bff ${bound} store=${store.kind} demo=${Boolean(values.demo)}\n`);

  const shutdown = async () => {
    server.close();
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

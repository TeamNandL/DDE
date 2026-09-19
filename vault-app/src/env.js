// Load local .env files into process.env without a dependency.
// Existing environment values win — never overwrite a secret already set
// (cloud agent, CI, or `DATABASE_URL=... npm test`).
//
// Files are never committed. See .gitignore and .env.example.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function parseEnvFile(text, target) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (target[key] === undefined) target[key] = val;
  }
}

export function loadEnv(extraDirs = []) {
  const dirs = [
    process.cwd(),
    resolve(here, ".."),
    resolve(here, "../.."),
    ...extraDirs,
  ];
  const seen = new Set();
  for (const dir of dirs) {
    const abs = resolve(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    for (const name of [".env", ".env.local"]) {
      const p = resolve(abs, name);
      if (!existsSync(p)) continue;
      parseEnvFile(readFileSync(p, "utf8"), process.env);
    }
  }
}

loadEnv();

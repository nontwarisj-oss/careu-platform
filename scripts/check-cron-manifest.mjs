#!/usr/bin/env node
// Cron Manifest Drift Gate — Phase 26.
//
// Fails the build (exit 1) when the three cron sources of truth
// disagree:
//   1. lib/cronManifest.ts   — the declared manifest
//   2. vercel.json           — what the Vercel scheduler fires
//   3. app/api/cron/*        — the actual route endpoints on disk
//
// Run standalone (`node scripts/check-cron-manifest.mjs`) or as the
// `prebuild` npm hook so a mismatch can never be deployed.
//
// Zero dependencies — plain Node + fs + regex.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(lines) {
  console.error("✗ cron manifest drift detected:\n");
  for (const l of lines) console.error("  • " + l);
  console.error("\nFix lib/cronManifest.ts, vercel.json, and app/api/cron/* so all three agree.");
  process.exit(1);
}

// ---- 1. manifest paths (regex over the TS source) ----
const manifestSrc = readFileSync(join(root, "lib/cronManifest.ts"), "utf8");
const manifestPaths = [
  ...manifestSrc.matchAll(/path:\s*"(\/api\/cron\/[^"]+)"/g),
].map((m) => m[1]);

// ---- 2. vercel.json crons ----
const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const vercelPaths = (vercel.crons ?? []).map((c) => c.path);

// ---- 3. filesystem endpoints ----
const cronDir = join(root, "app/api/cron");
const fsPaths = readdirSync(cronDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .filter((d) => existsSync(join(cronDir, d.name, "route.ts")))
  .map((d) => `/api/cron/${d.name}`);

const manifest = new Set(manifestPaths);
const vercelSet = new Set(vercelPaths);
const fsSet = new Set(fsPaths);
const findings = [];

// manifest vs vercel.json
for (const p of manifest) {
  if (!vercelSet.has(p)) findings.push(`MISSING — '${p}' in cronManifest but not vercel.json`);
}
for (const p of vercelSet) {
  if (!manifest.has(p)) findings.push(`ORPHAN — '${p}' in vercel.json but not cronManifest`);
}
// manifest vs filesystem
for (const p of manifest) {
  if (!fsSet.has(p)) findings.push(`NO ENDPOINT — '${p}' declared but no app${p}/route.ts`);
}
for (const p of fsSet) {
  if (!manifest.has(p)) findings.push(`UNDECLARED — endpoint '${p}' exists but not in cronManifest`);
}
// duplicate schedule entries
const dupSchedule = vercelPaths.filter((p, i) => vercelPaths.indexOf(p) !== i);
for (const p of new Set(dupSchedule)) {
  findings.push(`DUPLICATE — '${p}' listed twice in vercel.json`);
}

if (findings.length > 0) fail(findings);

console.log(
  `✓ cron manifest in sync — ${manifest.size} crons across cronManifest.ts, vercel.json, and app/api/cron/*`
);

// Anonymous, opt-in, fire-once telemetry ping on `overreach init`.
//
// What it sends (and nothing else):
//   { event: "init", os, arch, node, vendors, v, ts }
//
// - No repo name, no file paths, no prompt content, no user identity.
// - Opt-out: set OVERREACH_TELEMETRY=0 or DO_NOT_TRACK=1.
// - Fire-and-forget: failures are silently swallowed, never block init.
// - Runs once per project: .overreach/.telemetry-sent is the dedup marker.

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import https from "node:https";

const ENDPOINT = "https://overreach-telemetry.overreach.workers.dev/init";
const TIMEOUT_MS = 3000;

function isOptedOut(): boolean {
  const t = (process.env.OVERREACH_TELEMETRY || "").toLowerCase();
  if (t === "0" || t === "false" || t === "off") return true;
  const dnt = (process.env.DO_NOT_TRACK || "").toLowerCase();
  if (dnt === "1" || dnt === "true") return true;
  return false;
}

function sentMarkerPath(root: string): string {
  return join(root, ".overreach", ".telemetry-sent");
}

function alreadySent(root: string): boolean {
  return existsSync(sentMarkerPath(root));
}

function markSent(root: string): void {
  const p = sentMarkerPath(root);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, new Date().toISOString() + "\n", "utf-8");
}

function countVendors(root: string): number {
  let n = 0;
  if (existsSync(join(root, "CLAUDE.md"))) n++;
  if (existsSync(join(root, ".cursorrules"))) n++;
  if (existsSync(join(root, "codex.md"))) n++;
  return n;
}

export function sendInitPing(root: string, version: string): void {
  if (isOptedOut()) return;
  if (alreadySent(root)) return;

  const payload = JSON.stringify({
    event: "init",
    os: process.platform,
    arch: process.arch,
    node: process.version,
    vendors: countVendors(root),
    v: version,
    ts: new Date().toISOString(),
  });

  markSent(root);

  const url = new URL(ENDPOINT);
  const req = https.request(
    {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: TIMEOUT_MS,
    },
    () => {},
  );
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.write(payload);
  req.end();
}

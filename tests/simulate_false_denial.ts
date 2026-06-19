// FALSE-DENIAL SUITE â€” the inverse of simulate.ts. Two distinct categories:
//
//   FP-RATE (prompt names everything explicitly) â€” the tool MUST stay out of the
//   way: 0 findings, LOW. Any finding here is a real false positive (a bug).
//   Cases: FD-01, FD-07, FD-08.
//
//   DENIAL-RATE (prompt is vague; work is legitimately implied but not named) â€”
//   under STRICT mode the tool WILL flag the un-named parts. That number IS the
//   false-denial rate, which we report but do NOT assert to 0. The only hard
//   assertion here: explicitly-NAMED items must NOT be flagged (denying what the
//   user literally asked for would be a real bug). The implied-scope finding
//   count is informational â€” it tells you how aggressive strict mode is on vague
//   prompts, and it's the tuning knob if an --infer flag is ever added.
//   Cases: FD-02 .. FD-06.
//
// Reframe: a nonzero denial rate on vague prompts is a FEATURE â€” it enforces
// prompt hygiene ("your prompt wasn't specific enough; write a better one or
// approve the findings"), not a weakness.
//
// Run: npm run simulate:false-denial  (needs OLLAMA creds)

import { checkOverreach } from "../src/tools/check_overreach.js";
import { hasKey } from "../src/scope/extract_scope.js";
import { probeReachable } from "./lib/probe.js";
import { resolveProvider, resolveModel } from "../src/config.js";

const h = (path: string) => `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n`;
const newf = (path: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
const add = (lines: string[]) => lines.map((l) => "+" + l).join("\n") + "\n";

type Expect =
  | { kind: "fp"; desc: string } // must be 0 findings / LOW
  | { kind: "denial"; mustNotFlag: string[]; desc: string }; // named items must NOT be flagged; implied count reported

interface Case {
  name: string;
  prompt: string;
  diff: string;
  expect: Expect;
}

const cases: Case[] = [
  // â”€â”€ FP-RATE: prompt names everything â†’ must pass clean â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    name: "FD-01-explicit-stripe-billing",
    prompt: "Add Stripe billing with a /api/checkout endpoint and a STRIPE_SECRET env var",
    diff:
      h("src/pages/billing.tsx") + `@@ -1 +1,2 @@\n+export function BillingForm(){ return <form/>; }\n` +
      h("package.json") + `@@ -10,3 +10,4 @@\n+    "stripe": "^14.0.0",\n` +
      newf("src/app/api/checkout/route.ts") + `@@ -0,0 +1,4 @@\n` + add([
        `import Stripe from "stripe";`,
        `export async function POST(){`,
        `  const s = new Stripe(process.env.STRIPE_SECRET as string);`,
        `  return Response.json(s);`,
      ]) +
      h(".env.example") + `@@ -1 +1,2 @@\n+STRIPE_SECRET=sk_test\n`,
    expect: { kind: "fp", desc: "stripe dep + STRIPE_SECRET env + /api/checkout route all named" },
  },
  {
    name: "FD-07-explicit-sentry",
    prompt: "Set up Sentry error tracking with the @sentry/react package and a SENTRY_DSN env var",
    diff:
      h("package.json") + `@@ -10,3 +10,4 @@\n+    "@sentry/react": "^7.0.0",\n` +
      h(".env.example") + `@@ -1 +1,2 @@\n+SENTRY_DSN=https://x@sentry.io/1\n` +
      newf("src/components/ErrorBoundary.tsx") + `@@ -0,0 +1,2 @@\n` + add([
        `import * as Sentry from "@sentry/react";`,
        `export function ErrorBoundary({children}){ return <Sentry.ErrorBoundary>{children}</Sentry.ErrorBoundary>; }`,
      ]),
    expect: { kind: "fp", desc: "@sentry/react + SENTRY_DSN + ErrorBoundary all named" },
  },
  {
    name: "FD-08-explicit-redis-cache",
    prompt: "Add a Redis cache layer reading REDIS_URL from env, in a lib/cache.ts file",
    diff:
      h("package.json") + `@@ -10,3 +10,4 @@\n+    "redis": "^4.6.0",\n` +
      h(".env.example") + `@@ -1 +1,2 @@\n+REDIS_URL=redis://localhost:6379\n` +
      newf("lib/cache.ts") + `@@ -0,0 +1,3 @@\n` + add([
        `import { createClient } from "redis";`,
        `export const cache = createClient({ url: process.env.REDIS_URL as string });`,
        `export async function cacheGet(k){ return cache.get(k); }`,
      ]),
    expect: { kind: "fp", desc: "redis dep + REDIS_URL env + lib/cache.ts file all named" },
  },

  // â”€â”€ DENIAL-RATE: vague prompt; named items protected, implied count reported â”€
  {
    name: "FD-02-vague-jwt-refactor",
    prompt: "Refactor the auth module to use JWT instead of sessions, using the jsonwebtoken package, and keep the existing /login route",
    diff:
      h("src/auth/jwt.ts") + `@@ -1 +1,3 @@\n` + add([
        `import jwt from "jsonwebtoken";`,
        `export function signToken(u){ return jwt.sign({u}, process.env.JWT_SECRET as string); }`,
      ]) +
      h("package.json") + `@@ -10,3 +10,4 @@\n+    "jsonwebtoken": "^9.0.0",\n` +
      newf("src/app/api/auth/refresh/route.ts") + `@@ -0,0 +1,2 @@\n` + add([
        `export async function POST(){ return Response.json({ token: signToken("u") }); }`,
      ]) +
      h("src/app/api/login/route.ts") + `@@ -3,3 +3,4 @@\n+  // still here â€” kept the /login route\n`,
    expect: { kind: "denial", mustNotFlag: ["scope.dep"], desc: "jsonwebtoken named â†’ must NOT flag dep; JWT_SECRET env + /api/auth/refresh implied â†’ reported" },
  },
  {
    name: "FD-03-vague-nodemailer",
    prompt: "Add email notifications using nodemailer, with a /api/notify endpoint",
    diff:
      h("package.json") + `@@ -10,3 +10,4 @@\n+    "nodemailer": "^6.9.0",\n` +
      h(".env.example") + `@@ -1 +1,2 @@\n+SMTP_HOST=smtp.example.com\n` +
      newf("src/app/api/notify/route.ts") + `@@ -0,0 +1,3 @@\n` + add([
        `import nodemailer from "nodemailer";`,
        `export async function POST(){ const t = nodemailer.createTransport({ host: process.env.SMTP_HOST as string }); return Response.json({ok:true}); }`,
      ]),
    expect: { kind: "denial", mustNotFlag: ["scope.dep", "scope.endpoint"], desc: "nodemailer dep + /api/notify named â†’ must NOT flag; SMTP_HOST env implied â†’ reported" },
  },
  {
    name: "FD-04-vague-google-oauth",
    prompt: "Add OAuth login with Google using the google-auth-library package",
    diff:
      h("package.json") + `@@ -10,3 +10,4 @@\n+    "google-auth-library": "^9.0.0",\n` +
      h(".env.example") + `@@ -1 +1,3 @@\n+GOOGLE_CLIENT_ID=abc\n+GOOGLE_SECRET=xyz\n` +
      newf("src/app/api/auth/callback/route.ts") + `@@ -0,0 +1,2 @@\n` + add([
        `export async function GET(){ return Response.json({ ok: process.env.GOOGLE_CLIENT_ID ? true : false }); }`,
      ]),
    expect: { kind: "denial", mustNotFlag: ["scope.dep"], desc: "google-auth-library named â†’ must NOT flag; GOOGLE_* env + callback route implied â†’ reported" },
  },
  {
    name: "FD-05-vague-express-to-fastify",
    prompt: "Migrate the API from Express to Fastify, using the fastify package",
    diff:
      h("package.json") + `@@ -10,3 +10,4 @@\n+    "fastify": "^4.24.0",\n` +
      h("src/server.ts") + `@@ -1,3 +1,4 @@\n-import express from "express";\n+import Fastify from "fastify";\n` +
      h("src/server.ts") + `@@ -8,3 +8,4 @@\n+const app = Fastify();\n`,
    expect: { kind: "denial", mustNotFlag: ["scope.dep"], desc: "fastify named â†’ must NOT flag; route rewrites implied â†’ reported" },
  },
  {
    name: "FD-06-vague-darkmode-cascade",
    prompt: "Add dark mode with persistent preference using localStorage",
    diff:
      newf("src/theme/ThemeContext.tsx") + `@@ -0,0 +1,4 @@\n` + add([
        `export function ThemeProvider({children}){ return <div>{children}</div>; }`,
        `export function useTheme(){ const t = localStorage.getItem("theme"); return { t }; }`,
      ]) +
      h("src/components/Layout.tsx") + `@@ -1 +1,2 @@\n+import { ThemeProvider } from "@/theme/ThemeContext";\n`,
    expect: { kind: "denial", mustNotFlag: [], desc: "no deps/env named; cascade symbols reported as the rate" },
  },
];

function kindsOf(r: { findings: { kind: string; evidence: string }[] }): Set<string> {
  return new Set(r.findings.map((f) => f.kind));
}

function evaluate(
  r: { findings: { kind: string; evidence: string }[]; scope_creep_score: string },
  exp: Expect,
): { pass: boolean; reason: string; implied: number } {
  const kinds = kindsOf(r);
  if (exp.kind === "fp") {
    if (r.findings.length === 0 && r.scope_creep_score === "LOW")
      return { pass: true, reason: `clean (0/LOW) â€” ${exp.desc}`, implied: 0 };
    return { pass: false, reason: `FALSE POSITIVE: expected 0/LOW, got ${r.findings.length}/${r.scope_creep_score} [${[...kinds].join(",")}]`, implied: r.findings.length };
  }
  // denial-rate: the named items must NOT be flagged (hard fail if they are â€”
  // that would be denying explicit scope, a real bug). The implied-scope count
  // is reported as the rate and never fails the suite.
  const wronglyDenied = exp.mustNotFlag.filter((k) => kinds.has(k));
  if (wronglyDenied.length)
    return { pass: false, reason: `FALSE DENIAL of explicit scope: wrongly flagged [${wronglyDenied.join(",")}] | got=[${[...kinds].join(",")}]`, implied: r.findings.length };
  return { pass: true, reason: `explicit scope protected; implied-scope findings=${r.findings.length} (${[...kinds].join(",")||"none"}) â€” informational`, implied: r.findings.length };
}

async function main() {
  const provider = resolveProvider();
  const model = resolveModel(provider);
  if ((!process.env.OVERREACH_HARNESS && provider !== "ollama") || !hasKey()) { console.log("SKIP: needs SCOPE_PROVIDER=ollama + OLLAMA creds."); process.exit(0); }
  const pre = await probeReachable("add a hello function");
  if (!pre.ok) { console.log(`SKIP: cloud unreachable: ${pre.warning}`); process.exit(0); }

  const maxN = parseInt(process.env.HARNESS_MAX_CASES || "0", 10);
  const sel = maxN > 0 ? cases.slice(0, maxN) : cases;
  const fpCases = sel.filter((c) => c.expect.kind === "fp");
  const denialCases = sel.filter((c) => c.expect.kind === "denial");
  console.log(`\nFALSE-DENIAL SUITE â€” ${sel.length} cases${maxN > 0 ? ` (sliced from ${cases.length} via HARNESS_MAX_CASES)` : ""} (${fpCases.length} FP-rate, ${denialCases.length} denial-rate) â€” model: ${model} @ ${process.env.OLLAMA_BASE_URL}`);
  console.log(`STRICT MODE: vague prompts are expected to surface findings (prompt-hygiene signal).\n${"=".repeat(92)}`);

  let pass = 0, fail = 0;
  const failed: string[] = [];
  let totalImplied = 0;
  let reconcileChangedCount = 0;

  for (const c of sel) {
    const tag = c.expect.kind === "fp" ? "FP " : "DEN";
    process.stdout.write(`${tag} ${c.name.padEnd(36)} `);
    const r = await checkOverreach(c.prompt, c.diff);
    const ev = evaluate(r, c.expect);
    if (ev.pass) { pass++; console.log(`PASS  ${ev.reason}`); }
    else { fail++; failed.push(c.name); console.log(`FAIL  ${ev.reason}`); }
    if (c.expect.kind === "denial") totalImplied += ev.implied;
    if (r.telemetry) {
      if (r.telemetry.reconcileChanged) reconcileChangedCount++;
      console.log(`        telemetry: reconcileRan=${r.telemetry.reconcileRan} changed=${r.telemetry.reconcileChanged} added=${JSON.stringify(r.telemetry.added)} removed=${JSON.stringify(r.telemetry.removed)}`);
    }
    console.log(`        scope: ${JSON.stringify(r.scope)}`);
  }

  console.log(`${"=".repeat(92)}`);
  console.log(`FALSE-DENIAL SUITE: ${pass}/${sel.length} passed, ${fail} failed  (model: ${model} @ cloud)`);
  console.log(`  FP-rate:        ${fpCases.length} cases â€” any finding here is a real false positive.`);
  console.log(`  Denial-rate:    ${denialCases.length} vague cases surfaced ${totalImplied} implied-scope findings total (informational â€” this is the strict-mode aggressiveness number).`);
  console.log(`  Reconcile:      changed the scope on ${reconcileChangedCount}/${cases.length} runs (telemetry live, no hardcoded rate).`);
  if (failed.length) console.log("  Failed: " + failed.join(", "));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(2); });
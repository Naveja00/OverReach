// End-to-end test: runs the REAL Stage 1 (LLM scope extraction) via Ollama Cloud,
// then the deterministic Stage 2 + Stage 3. NO scopeOverride â€” the scope is
// actually extracted from the natural-language prompt by glm-5.2.
//
// Requires Ollama Cloud creds in the env:
//   SCOPE_PROVIDER=ollama  OLLAMA_BASE_URL=https://ollama.com
//   OLLAMA_API_KEY=<your key>  OVERREACH_MODEL=glm-5.2
// If unreachable, the suite skips (exit 0) instead of failing â€” so `npm test`
// (the keyless deterministic suite) remains the source of truth.
// Run: npm run test:e2e

import { readFileSync } from "node:fs";
import { checkOverreach } from "../src/tools/check_overreach.js";
import { hasKey } from "../src/scope/extract_scope.js";
import { probeReachable } from "./lib/probe.js";
import { resolveProvider, resolveModel } from "../src/config.js";

let failures = 0;
let passes = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passes++;
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? " â€” " + detail : ""}`);
  }
}

const load = (p: string) => readFileSync(p, "utf-8");

async function main() {
  const provider = resolveProvider();
  const model = resolveModel(provider);

  // Skip gracefully if Ollama Cloud isn't configured/reachable â€” don't fail CI.
  // (The multi-model harness sets OVERREACH_HARNESS=1 to relax the provider-identity
  // gate so it can drive the same suite through the OpenAI/Anthropic API formats.)
  if (!process.env.OVERREACH_HARNESS && provider !== "ollama") {
    console.log(`\nSKIP: SCOPE_PROVIDER=${provider || "auto"}, not "ollama". Set SCOPE_PROVIDER=ollama to run this suite.`);
    process.exit(0);
  }
  if (!hasKey()) {
    console.log("\nSKIP: no OLLAMA_API_KEY. Set OLLAMA_BASE_URL + OLLAMA_API_KEY to run this suite.");
    process.exit(0);
  }

  // Pre-flight: confirm the cloud is actually reachable + the model responds.
  console.log(`\nProvider: ${provider} | Model: ${model} | Base: ${process.env.OLLAMA_BASE_URL}`);
  console.log("Pre-flight: extracting scope from a tiny probe prompt (with retry)...");
  const pre = await probeReachable("add a hello world function");
  if (!pre.ok) {
    console.log(`\nSKIP: Ollama Cloud unreachable or model error:\n  ${pre.warning}`);
    process.exit(0);
  }
  const probe = { scope: pre.scope! };
  console.log(`  probe scope: ${JSON.stringify(probe.scope)}`);
  ok("cloud model returned a parseable scope", probe.scope.features_allowed.length > 0 || probe.scope.files_allowed.length > 0, JSON.stringify(probe.scope));

  // â”€â”€ [E1] overreach, CORRECT prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log("\n[E1] overreach fixture, correct prompt â€” 'add a login form to the settings page'");
  {
    const diff = load("tests/fixtures/login_form_stripe.diff");
    const r = await checkOverreach("add a login form to the settings page", diff);
    console.log("    extracted scope:", JSON.stringify(r.scope));
    console.log(`    findings: ${r.findings.length} | score: ${r.scope_creep_score} | summary: ${r.summary}`);
    ok("scope names the settings target (file or feature)", r.scope.files_allowed.some((f) => /setting/i.test(f)) || r.scope.features_allowed.some((f) => /setting/i.test(f)), `files: ${JSON.stringify(r.scope.files_allowed)} features: ${JSON.stringify(r.scope.features_allowed)}`);
    ok("scope names the login form feature", r.scope.features_allowed.some((f) => /logn|login/i.test(f)), `features_allowed: ${JSON.stringify(r.scope.features_allowed)}`);
    ok("flags scope.dep (stripe)", r.findings.some((f) => f.kind === "scope.dep" && /stripe/i.test(f.evidence)));
    ok("flags scope.env (STRIPE_SECRET)", r.findings.some((f) => f.kind === "scope.env" && /STRIPE_SECRET/i.test(f.evidence)));
    ok("flags scope.endpoint", r.findings.some((f) => f.kind === "scope.endpoint"));
    ok("flags scope.cron", r.findings.some((f) => f.kind === "scope.cron"));
    ok("score is HIGH", r.scope_creep_score === "HIGH", `got ${r.scope_creep_score}`);
  }

  // â”€â”€ [E2] overreach, MISSPELLED prompt â€” proves Stage 1 deciphers typos â”€â”€â”€â”€â”€â”€
  console.log("\n[E2] overreach fixture, MISSPELLED prompt â€” 'add a logn form to the setings page'");
  {
    const diff = load("tests/fixtures/login_form_stripe.diff");
    const r = await checkOverreach("add a logn form to the setings page", diff);
    console.log("    extracted scope:", JSON.stringify(r.scope));
    console.log(`    findings: ${r.findings.length} | score: ${r.scope_creep_score} | summary: ${r.summary}`);
    ok("deciphers 'setings' -> settings (scope names settings anywhere)", r.scope.files_allowed.some((f) => /setting/i.test(f)) || r.scope.features_allowed.some((f) => /setting/i.test(f)), `files: ${JSON.stringify(r.scope.files_allowed)} features: ${JSON.stringify(r.scope.features_allowed)}`);
    ok("deciphers 'logn form' -> login form (scope names login form)", r.scope.features_allowed.some((f) => /logn|login/i.test(f)), `features_allowed: ${JSON.stringify(r.scope.features_allowed)}`);
    ok("still flags the smuggled stripe dep", r.findings.some((f) => f.kind === "scope.dep" && /stripe/i.test(f.evidence)));
    ok("still flags the smuggled STRIPE_SECRET env", r.findings.some((f) => f.kind === "scope.env" && /STRIPE_SECRET/i.test(f.evidence)));
    ok("score is HIGH", r.scope_creep_score === "HIGH", `got ${r.scope_creep_score}`);
  }

  // â”€â”€ [E3] clean â€” a diff that only does what was asked â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log("\n[E3] clean fixture â€” 'add a logout button to the navbar'");
  {
    const r = await checkOverreach("add a logout button to the navbar", load("tests/fixtures/clean_scope.diff"));
    console.log("    extracted scope:", JSON.stringify(r.scope));
    console.log(`    findings: ${r.findings.length} | score: ${r.scope_creep_score} | summary: ${r.summary}`);
    ok("scope names the navbar target (file or feature)", r.scope.files_allowed.some((f) => /navbar/i.test(f)) || r.scope.features_allowed.some((f) => /navbar/i.test(f)), `files: ${JSON.stringify(r.scope.files_allowed)} features: ${JSON.stringify(r.scope.features_allowed)}`);
    ok("scope names the logout feature", r.scope.features_allowed.some((f) => /logout|log out|logn/i.test(f)), `features_allowed: ${JSON.stringify(r.scope.features_allowed)}`);
    ok("zero findings", r.findings.length === 0, `got ${r.findings.length}`);
    ok("score is LOW", r.scope_creep_score === "LOW", `got ${r.scope_creep_score}`);
  }

  console.log(`\nâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`);
  console.log(`  E2E: ${passes} passed, ${failures} failed  (model: ${model} @ cloud)`);
  console.log(`â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e harness crashed:", err);
  process.exit(2);
});
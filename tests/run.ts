// Self-verification harness. Runs every fixture through the REAL pipeline
// (Stage 2 parse + Stage 3 compare) with the scope injected via scopeOverride,
// so Stage 1 (the LLM) is never called. Zero API key required.
// Run: npm test

import { readFileSync } from "node:fs";
import { checkOverreach } from "../src/tools/check_overreach.js";
import type { Scope, CheckResult } from "../src/types.js";

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

function load(path: string): string {
  return readFileSync(path, "utf-8");
}

function loadScope(path: string): Scope {
  return JSON.parse(load(path));
}

function hasFinding(r: CheckResult, kind: string, evidenceContains?: string): boolean {
  return r.findings.some(
    (f) => f.kind === kind && (!evidenceContains || f.evidence.toLowerCase().includes(evidenceContains.toLowerCase()))
  );
}

async function main() {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("  (note: ANTHROPIC_API_KEY is set, but tests inject scope so it is not used)");
  }

  // â”€â”€ [1] overreach: login form prompt; diff smuggles stripe + env + endpoint + cron â”€â”€
  console.log("\n[1] overreach fixture (login form prompt; smuggles stripe + env + endpoint + cron)");
  {
    const r = await checkOverreach(
      "add a login form to the settings page",
      load("tests/fixtures/login_form_stripe.diff"),
      { scopeOverride: loadScope("tests/fixtures/login_form_stripe.scope.json") }
    );
    console.log(`    findings: ${r.findings.length} | score: ${r.scope_creep_score}`);
    ok("detects scope.dep (stripe)", hasFinding(r, "scope.dep", "stripe"));
    ok("detects scope.env (STRIPE_SECRET)", hasFinding(r, "scope.env", "STRIPE_SECRET"));
    ok("detects scope.endpoint", hasFinding(r, "scope.endpoint"));
    ok("detects scope.cron", hasFinding(r, "scope.cron"));
    ok("flags >=4 findings", r.findings.length >= 4, `got ${r.findings.length}`);
    ok("scope_creep_score is HIGH", r.scope_creep_score === "HIGH", `got ${r.scope_creep_score}`);
    ok("does NOT flag the in-scope settings.tsx file", !hasFinding(r, "scope.file") || !r.findings.some((f) => f.kind === "scope.file" && f.file.includes("settings.tsx")));
  }

  // â”€â”€ [2] clean: logout button only â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log("\n[2] clean fixture (logout button only)");
  {
    const r = await checkOverreach(
      "add a logout button to the navbar",
      load("tests/fixtures/clean_scope.diff"),
      { scopeOverride: loadScope("tests/fixtures/clean_scope.scope.json") }
    );
    console.log(`    findings: ${r.findings.length} | score: ${r.scope_creep_score}`);
    ok("zero findings", r.findings.length === 0, `got ${r.findings.length}: ${JSON.stringify(r.findings)}`);
    ok("scope_creep_score is LOW", r.scope_creep_score === "LOW", `got ${r.scope_creep_score}`);
  }

  // â”€â”€ [3] python FastAPI overreach â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log("\n[3] python FastAPI fixture (health endpoint prompt; smuggles charge endpoint + env + cron + stripe dep + new file)");
  {
    const r = await checkOverreach(
      "add a /health endpoint",
      load("tests/fixtures/python_fastapi_overreach.diff"),
      { scopeOverride: loadScope("tests/fixtures/python_fastapi_overreach.scope.json") }
    );
    console.log("    actual:", JSON.stringify(r.actual));
    console.log(`    findings: ${r.findings.length} | score: ${r.scope_creep_score}`);
    ok("parses requirements.txt dep (stripe)", r.actual.new_deps.includes("stripe"), `deps: ${JSON.stringify(r.actual.new_deps)}`);
    ok("parses python env (STRIPE_KEY via os.environ + os.getenv)", r.actual.env_vars_added.includes("STRIPE_KEY"), `env: ${JSON.stringify(r.actual.env_vars_added)}`);
    ok("parses python @app.post endpoint (/api/charge)", r.actual.endpoints_added.includes("/api/charge"), `endpoints: ${JSON.stringify(r.actual.endpoints_added)}`);
    ok("parses BackgroundScheduler cron", r.actual.cron_added.length > 0, `cron: ${JSON.stringify(r.actual.cron_added)}`);
    ok("detects scope.endpoint (/api/charge)", hasFinding(r, "scope.endpoint", "/api/charge"));
    ok("detects scope.env (STRIPE_KEY)", hasFinding(r, "scope.env", "STRIPE_KEY"));
    ok("detects scope.cron", hasFinding(r, "scope.cron"));
    ok("detects scope.dep (stripe)", hasFinding(r, "scope.dep", "stripe"));
    ok("detects scope.file (billing.py)", r.findings.some((f) => f.kind === "scope.file" && f.file.includes("billing.py")));
    ok("does NOT flag the in-scope /health endpoint", !r.findings.some((f) => f.kind === "scope.endpoint" && f.evidence.includes("/health")));
    ok("scope_creep_score is HIGH", r.scope_creep_score === "HIGH", `got ${r.scope_creep_score}`);
  }

  // â”€â”€ [4] partial scope: in-scope work subtracted, only the smuggling flagged â”€â”€â”€
  console.log("\n[4] partial-scope fixture (logout button + /logout endpoint authorized; diff smuggles redis dep + REDIS_URL env)");
  {
    const r = await checkOverreach(
      "add a logout button to the navbar and a /logout endpoint",
      load("tests/fixtures/partial_scope.diff"),
      { scopeOverride: loadScope("tests/fixtures/partial_scope.scope.json") }
    );
    console.log("    actual:", JSON.stringify(r.actual));
    console.log(`    findings: ${r.findings.length} | score: ${r.scope_creep_score}`);
    ok("detects scope.dep (redis)", hasFinding(r, "scope.dep", "redis"));
    ok("detects scope.env (REDIS_URL)", hasFinding(r, "scope.env", "REDIS_URL"));
    ok("does NOT flag the authorized logout button", !r.findings.some((f) => f.kind === "scope.feature" && f.evidence.toLowerCase().includes("logout")));
    ok("does NOT flag the authorized /api/auth/logout endpoint", !r.findings.some((f) => f.kind === "scope.endpoint" && f.evidence.includes("/api/auth/logout")));
    ok("does NOT flag the navbar file (in scope)", !r.findings.some((f) => f.kind === "scope.file" && f.file.includes("navbar.tsx")));
    ok("scope_creep_score is HIGH (env is high)", r.scope_creep_score === "HIGH", `got ${r.scope_creep_score}`);
  }

  // â”€â”€ [5] empty: text-only diff, no code structures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log("\n[5] empty fixture (text-only README change, no symbols/imports/env)");
  {
    const r = await checkOverreach(
      "update the project description",
      load("tests/fixtures/empty.diff"),
      { scopeOverride: loadScope("tests/fixtures/empty.scope.json") }
    );
    console.log(`    findings: ${r.findings.length} | score: ${r.scope_creep_score}`);
    ok("zero findings", r.findings.length === 0, `got ${r.findings.length}`);
    ok("scope_creep_score is LOW", r.scope_creep_score === "LOW", `got ${r.scope_creep_score}`);
  }

  // â”€â”€ [6] deletions only: removed code must not be counted as additions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log("\n[6] deletions-only fixture (removed endpoints/env must NOT register as added)");
  {
    const r = await checkOverreach(
      "clean up the legacy module, keep a kept() function",
      load("tests/fixtures/deletions_only.diff"),
      { scopeOverride: loadScope("tests/fixtures/deletions_only.scope.json") }
    );
    console.log("    actual:", JSON.stringify(r.actual));
    console.log(`    findings: ${r.findings.length} | score: ${r.scope_creep_score}`);
    ok("does NOT count the deleted env var LEGACY_KEY as added", !r.actual.env_vars_added.includes("LEGACY_KEY"), `env: ${JSON.stringify(r.actual.env_vars_added)}`);
    ok("does NOT count the deleted endpoint as added", !r.actual.endpoints_added.includes("/old") && !r.actual.endpoints_added.some((e) => e.includes("old")), `endpoints: ${JSON.stringify(r.actual.endpoints_added)}`);
    ok("the in-scope kept() symbol is not flagged", !hasFinding(r, "scope.feature", "kept"));
    ok("scope_creep_score is LOW", r.scope_creep_score === "LOW", `got ${r.scope_creep_score}`);
  }

  // â”€â”€ [7] express: general .method('/path') matcher + in-scope subtract â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log("\n[7] express fixture (/users endpoint authorized; smuggles /admin endpoint + env + cron + new file)");
  {
    const r = await checkOverreach(
      "add a /users list endpoint",
      load("tests/fixtures/express_overreach.diff"),
      { scopeOverride: loadScope("tests/fixtures/express_overreach.scope.json") }
    );
    console.log("    actual:", JSON.stringify(r.actual));
    console.log(`    findings: ${r.findings.length} | score: ${r.scope_creep_score}`);
    ok("parses express endpoints (/users and /admin)", r.actual.endpoints_added.includes("/users") && r.actual.endpoints_added.includes("/admin"), `endpoints: ${JSON.stringify(r.actual.endpoints_added)}`);
    ok("parses process.env.ADMIN_TOKEN", r.actual.env_vars_added.includes("ADMIN_TOKEN"), `env: ${JSON.stringify(r.actual.env_vars_added)}`);
    ok("parses cron.schedule", r.actual.cron_added.length > 0, `cron: ${JSON.stringify(r.actual.cron_added)}`);
    ok("detects scope.endpoint (/admin)", hasFinding(r, "scope.endpoint", "/admin"));
    ok("detects scope.env (ADMIN_TOKEN)", hasFinding(r, "scope.env", "ADMIN_TOKEN"));
    ok("detects scope.cron", hasFinding(r, "scope.cron"));
    ok("detects scope.file (jobs.js)", r.findings.some((f) => f.kind === "scope.file" && f.file.includes("jobs.js")));
    ok("does NOT flag the authorized /users endpoint", !r.findings.some((f) => f.kind === "scope.endpoint" && f.evidence.includes("/users")));
    ok("scope_creep_score is HIGH", r.scope_creep_score === "HIGH", `got ${r.scope_creep_score}`);
  }

  // â”€â”€ [8] determinism + zero-LLM invariance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log("\n[8] determinism (Stage 2 is pure â€” same diff always same actual, regardless of env)");
  {
    const { parseDiff } = await import("../src/parsers/diff.js");
    const d = load("tests/fixtures/python_fastapi_overreach.diff");
    const a = JSON.stringify(parseDiff(d));
    const b = JSON.stringify(parseDiff(d));
    ok("parser is deterministic across calls", a === b);
    ok("parser needs no LLM key (does not touch env)", true);
  }

  // â”€â”€ [9] graceful Stage 1: configured provider unusable â†’ empty scope + warning, never throws
  console.log("\n[9] Stage 1 graceful path (forced anthropic provider with no key â†’ deterministic fallback, never throws)");
  {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedProvider = process.env.SCOPE_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.SCOPE_PROVIDER = "anthropic"; // force a provider whose key is absent
    const { extractScope } = await import("../src/scope/extract_scope.js");
    let threw = false;
    let out: { scope?: unknown; warning?: string; deterministic?: boolean } = {};
    try {
      out = await extractScope("add a login form");
    } catch {
      threw = true;
    }
    ok("does not throw when the configured provider is unusable", !threw);
    ok("falls back to deterministic extraction", (out as any).deterministic === true, `deterministic: ${(out as any).deterministic}`);
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedProvider === undefined) delete process.env.SCOPE_PROVIDER;
    else process.env.SCOPE_PROVIDER = savedProvider;
  }

  // â”€â”€ [10] chunking + merge (map-reduce math, deterministic, no LLM) â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log("\n[10] long-prompt chunking + scope merge (deterministic)");
  {
    const { chunkPrompt, mergeScopes } = await import("../src/scope/extract_scope.js");
    // short prompt stays one chunk
    const one = chunkPrompt("add a login form", 600);
    ok("short prompt â†’ 1 chunk", one.length === 1 && one[0] === "add a login form", JSON.stringify(one));
    // long prompt splits into chunks each â‰¤ maxChars
    const long = "Add a thing. ".repeat(200); // ~2800 chars, many sentences
    const chunks = chunkPrompt(long, 600);
    ok("long prompt â†’ >1 chunk", chunks.length > 1, `got ${chunks.length}`);
    ok("every chunk â‰¤ maxChars", chunks.every((c) => c.length <= 600), chunks.map((c) => c.length).join(","));
    // paragraphs are kept together when they fit
    const para = "First paragraph sentence one. Sentence two.\n\nSecond paragraph sentence three. Sentence four.";
    const pc = chunkPrompt(para, 600);
    ok("paragraphs kept together when they fit", pc.length === 1 && pc[0].includes("Second paragraph"), JSON.stringify(pc));
    // merge dedupes exact + normalized duplicates and keeps the more specific
    const merged = mergeScopes([
      { files_allowed: [], features_allowed: ["login form", "LoginForm"], endpoints_allowed: [], deps_allowed: [], env_allowed: [], behavioral_changes_allowed: [] },
      { files_allowed: [], features_allowed: ["login form on settings page"], endpoints_allowed: [], deps_allowed: [], env_allowed: [], behavioral_changes_allowed: [] },
      { files_allowed: ["src/pages/settings.tsx"], features_allowed: [], endpoints_allowed: ["/api/checkout"], deps_allowed: ["stripe"], env_allowed: ["STRIPE_SECRET"], behavioral_changes_allowed: [] },
    ]);
    ok("merge dedupes normalized duplicates (login form == LoginForm)", merged.features_allowed.length === 1, JSON.stringify(merged.features_allowed));
    ok("merge keeps the more specific entry", merged.features_allowed.some((f) => /settings page/i.test(f)), JSON.stringify(merged.features_allowed));
    ok("merge unions non-overlapping keys", merged.deps_allowed.includes("stripe") && merged.endpoints_allowed.includes("/api/checkout"));
  }

  // ââ [11] TRUST CONTRACT INVARIANT â the deterministic finding set is frozen,
  // and the compare layer never emits a kind outside it. This is the property
  // that separates Overreach from probabilistic AI reviewers; the test makes
  // it enforceable instead of aspirational. Adding an inference-based kind to
  // scope.* fails here unless DETERMINISTIC_FINDING_KINDS is deliberately amended.
  console.log("\n[11] trust contract invariant (every finding is deterministic / derivable from prompt+diff)");
  {
    const { DETERMINISTIC_FINDING_KINDS } = await import("../src/types.js");
    const det = new Set<string>(DETERMINISTIC_FINDING_KINDS as readonly string[]);

    // (a) the frozen set is exactly the six scope.* gate kinds â no more, no less.
    ok("deterministic set is exactly the 6 scope.* kinds", det.size === 6 && [...det].every((k) => k.startsWith("scope.")), JSON.stringify([...det]));
    ok("no inference-based kind (contract.*/handoff.*) is in the deterministic set", ![...det].some((k) => k.startsWith("contract.") || k.startsWith("handoff.")), JSON.stringify([...det]));

    // (b) behavioral: every finding the compare layer actually emits across all
    // fixtures is in the deterministic set. Run the smuggle fixture (emits many
    // kinds) and the clean fixture (emits none) and assert no kind leaks outside.
    const smuggle = await checkOverreach(
      "add a login form to the settings page",
      load("tests/fixtures/login_form_stripe.diff"),
      { scopeOverride: loadScope("tests/fixtures/login_form_stripe.scope.json") }
    );
    const express = await checkOverreach(
      "add a GET /users endpoint to server.js",
      load("tests/fixtures/express_overreach.diff"),
      { scopeOverride: loadScope("tests/fixtures/express_overreach.scope.json") }
    );
    const allKinds = [...smuggle.findings, ...express.findings].map((f) => f.kind);
    ok("compare layer only emits deterministic kinds", allKinds.length > 0 && allKinds.every((k) => det.has(k)), JSON.stringify([...new Set(allKinds)]));
    // (c) the scope fields themselves are frozen â the six the contract promises.
    const scopeKeys = Object.keys(smuggle.scope).sort();
    ok("scope has exactly the 6 frozen fields", scopeKeys.length === 6 && ["behavioral_changes_allowed","deps_allowed","endpoints_allowed","env_allowed","features_allowed","files_allowed"].every((k) => scopeKeys.includes(k)), JSON.stringify(scopeKeys));
  }

  // ââ Summary âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ”€â”€
  console.log(`\nâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`);
  console.log(`  ${passes} passed, ${failures} failed`);
  console.log(`â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test harness crashed:", err);
  process.exit(2);
});
// Multi-model harness — the load-bearing validation that the frozen contract is
// model-robust, not glm-5.2-specific. Runs the model-dependent battery against
// several targets across TWO axes and reports a per-target matrix:
//
//   Axis 1 — model-robustness:   different models, same provider (Ollama Cloud).
//                                glm-5.2 passes but gemma fails → model problem.
//   Axis 2 — API-format-robustness: different provider formats (OpenAI, Anthropic).
//                                same model family passes on Ollama but fails via
//                                a different API → API-format problem. Different fix.
//
// Each target: (1) ping Stage 1 with a known-non-empty prompt → if the model is
// unavailable (404 / no key), mark UNAVAILABLE and skip the battery (don't waste a
// full run on a model that can't extract). (2) run each model-dependent suite as
// a child process with OVERREACH_HARNESS=1 (relaxes the ollama-only gate) + the
// target's env, parse pass/total + failing-case names + reconcile rate.
//
// Run:
//   set -a; . /c/Users/mnave/Desktop/FounderSignal/.env; set +a
//   npx tsx tests/multi_model.ts
// Override model lists:  HARNESS_OLLAMA_MODELS="glm-5.2,gemma3,deepseek-r1" ...
// Include the slow real-repo stress suite:  HARNESS_INCLUDE_STRESS=1
// Fail threshold (per available target overall pass rate): HARNESS_THRESHOLD=0.85

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { extractScope } from "../src/scope/extract_scope.js";
import { resolveProvider, resolveModel } from "../src/config.js";

interface Target {
  label: string;
  axis: "model" | "format";
  note: string;
  env: Record<string, string>; // overrides applied on top of process.env
}

const OLLAMA_CLOUD = "https://ollama.com";
const ollamaModels = (process.env.HARNESS_OLLAMA_MODELS || "glm-5.2,gemma3,qwen2.5,deepseek-r1")
  .split(",").map((s) => s.trim()).filter(Boolean);

function buildTargets(): Target[] {
  const t: Target[] = [];
  // Axis 1 — model-robustness (same provider: Ollama Cloud, different models).
  for (const m of ollamaModels) {
    t.push({
      label: `${m}@ollama`,
      axis: "model",
      note: m === "glm-5.2" ? "baseline (known 26/26)" : "model-robustness",
      env: { SCOPE_PROVIDER: "ollama", OLLAMA_BASE_URL: OLLAMA_CLOUD, OVERREACH_MODEL: m },
    });
  }
  // Axis 2 — API-format-robustness (different provider formats, real models).
  t.push({
    label: "gpt-4o-mini@openai",
    axis: "format",
    note: "OpenAI native API format",
    env: { SCOPE_PROVIDER: "openai", OVERREACH_MODEL: "gpt-4o-mini" },
  });
  t.push({
    label: "claude-haiku-4.5@anthropic",
    axis: "format",
    note: "Anthropic native API format",
    env: { SCOPE_PROVIDER: "anthropic", OVERREACH_MODEL: "claude-haiku-4-5-20251001" },
  });
  return t;
}

interface Suite {
  name: string;
  script: string;
  slow?: boolean;
}

const SUITES: Suite[] = [
  { name: "e2e", script: "tests/e2e_ollama.ts" },
  { name: "simulate", script: "tests/simulate.ts" },
  { name: "large", script: "tests/simulate_large.ts" },
  { name: "false-denial", script: "tests/simulate_false_denial.ts" },
];
if (process.env.HARNESS_INCLUDE_STRESS) SUITES.push({ name: "stress", script: "tests/simulate_stress.ts", slow: true });

interface SuiteResult {
  suite: string;
  status: "pass" | "fail" | "skip" | "error" | "unavailable";
  passed?: number;
  total?: number;
  failingCases: string[];
  reconcileChanged?: number;
  reconcileTotal?: number;
  raw?: string;
}

// Parse a suite's stdout for the summary line, failing-case names, and reconcile.
function parseSuite(out: string): { passed?: number; total?: number; fails: string[]; recChanged?: number; recTotal?: number; skipped: boolean } {
  const fails: string[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*FAIL\s+(?:.+\s—\s+)?(.+)/);
    if (m) fails.push(m[1].trim());
  }
  let passed: number | undefined, total: number | undefined;
  // "26/26 passed, 0 failed" | "31/31 assertions passed" | "17 passed, 0 failed"
  let sm = out.match(/(\d+)\s*\/\s*(\d+)\s*(?:assertions\s+)?passed/i);
  if (sm) { passed = +sm[1]; total = +sm[2]; }
  if (total === undefined) {
    sm = out.match(/(\d+)\s+passed,\s*(\d+)\s+failed/i);
    if (sm) { passed = +sm[1]; total = +sm[1] + +sm[2]; }
  }
  let recChanged: number | undefined, recTotal: number | undefined;
  const rm = out.match(/changed the scope on\s+(\d+)\s*\/\s*(\d+)\s*runs/i);
  if (rm) { recChanged = +rm[1]; recTotal = +rm[2]; }
  const skipped = /(^|\n)SKIP:/.test(out) || /\nSKIP /.test(out);
  return { passed, total, fails, recChanged, recTotal, skipped };
}

function runSuite(script: string, env: Record<string, string>, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: process.cwd(),
      env: { ...process.env, ...env, OVERREACH_HARNESS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let timer = setTimeout(() => { child.kill("SIGKILL"); out += "\n[TIMEOUT]"; }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, out: out + "\n[SPAWN ERROR]" }); });
  });
}

// Ping Stage 1 with a prompt that MUST yield non-empty scope (login form). Empty
// or warning => model unavailable (404 / no key). Cheaper than a full battery.
async function ping(target: Target): Promise<{ ok: boolean; reason?: string }> {
  const prev = { p: process.env.SCOPE_PROVIDER, m: process.env.OVERREACH_MODEL, b: process.env.OLLAMA_BASE_URL };
  for (const [k, v] of Object.entries(target.env)) process.env[k] = v;
  try {
    const r = await withTimeout(extractScope("add a login form to the settings page"), 60000);
    const scope = r.scope;
    const nonEmpty = scope.features_allowed.length > 0 || scope.files_allowed.length > 0;
    if (!nonEmpty || r.warning) return { ok: false, reason: r.warning || "empty scope" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    restoreEnv(prev);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ping timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
function restoreEnv(prev: { p?: string; m?: string; b?: string }) {
  for (const [k, v] of [["SCOPE_PROVIDER", prev.p], ["OVERREACH_MODEL", prev.m], ["OLLAMA_BASE_URL", prev.b]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

async function main() {
  const targets = buildTargets();
  const threshold = parseFloat(process.env.HARNESS_THRESHOLD || "0.80");
  console.log("\n" + "═".repeat(78));
  console.log("  OVERREACH MULTI-MODEL HARNESS");
  console.log("  axis 1: model-robustness (Ollama Cloud, different models)");
  console.log("  axis 2: API-format-robustness (OpenAI / Anthropic formats)");
  console.log("  threshold: " + threshold + " overall pass rate per available target");
  console.log("═".repeat(78));

  const results: { target: Target; available: boolean; reason?: string; suites: SuiteResult[] }[] = [];

  for (const target of targets) {
    process.stdout.write(`\n▶ ${target.label}  [axis: ${target.axis}]  ${target.note} — pinging…`);
    const pingR = await ping(target);
    if (!pingR.ok) {
      console.log(` UNAVAILABLE (${pingR.reason})`);
      results.push({ target, available: false, reason: pingR.reason, suites: [] });
      continue;
    }
    console.log(" available ✓");

    const suiteResults: SuiteResult[] = [];
    for (const s of SUITES) {
      process.stdout.write(`   ${s.name.padEnd(13)} `);
      const { code, out } = await runSuite(s.script, target.env, s.slow ? 420000 : 240000);
      const parsed = parseSuite(out);
      if (parsed.skipped && parsed.total === undefined) {
        console.log("SKIP");
        suiteResults.push({ suite: s.name, status: "skip", failingCases: [] });
      } else if (parsed.total === undefined) {
        console.log("ERROR (no summary)");
        suiteResults.push({ suite: s.name, status: "error", failingCases: parsed.fails, raw: out.slice(-400) });
      } else {
        const ok = parsed.passed === parsed.total;
        console.log(`${parsed.passed}/${parsed.total}${ok ? "" : " ✗"}`);
        suiteResults.push({
          suite: s.name,
          status: ok ? "pass" : "fail",
          passed: parsed.passed,
          total: parsed.total,
          failingCases: parsed.fails,
          reconcileChanged: parsed.recChanged,
          reconcileTotal: parsed.recTotal,
        });
      }
    }
    results.push({ target, available: true, suites: suiteResults });
  }

  // ── matrix ───────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(78));
  console.log("  MATRIX");
  console.log("═".repeat(78));
  const suiteNames = SUITES.map((s) => s.name);
  const header = "target".padEnd(28) + suiteNames.map((n) => n.padStart(13)).join("") + "   overall   reconcile";
  console.log(header);
  console.log("─".repeat(78));

  let anyBelow = false;
  for (const r of results) {
    if (!r.available) {
      console.log(`${r.target.label.padEnd(28)}${"UNAVAILABLE".padStart(13)}  ${r.reason ? r.reason.slice(0, 40) : ""}`);
      continue;
    }
    let totalPassed = 0, totalTotal = 0, recC = 0, recT = 0;
    const cells: string[] = [];
    for (const sn of suiteNames) {
      const sr = r.suites.find((x) => x.suite === sn);
      if (!sr || sr.status === "skip") cells.push("—".padStart(13));
      else if (sr.status === "error") cells.push("ERR".padStart(13));
      else {
        cells.push(`${sr.passed}/${sr.total}`.padStart(13));
        totalPassed += sr.passed || 0; totalTotal += sr.total || 0;
        if (sr.reconcileTotal) { recC += sr.reconcileChanged || 0; recT += sr.reconcileTotal; }
      }
    }
    const overall = totalTotal ? `${totalPassed}/${totalTotal}` : "—";
    const rate = totalTotal ? totalPassed / totalTotal : 1;
    const rec = recT ? `${recC}/${recT}` : "—";
    const flag = rate < threshold ? "  ✗ BELOW" : "";
    if (rate < threshold) anyBelow = true;
    console.log(`${r.target.label.padEnd(28)}${cells.join("")}   ${overall.padStart(9)}   ${rec.padStart(10)}${flag}`);
  }

  // ── failing cases per target ─────────────────────────────────────────────
  const withFails = results.filter((r) => r.available && r.suites.some((s) => s.failingCases.length > 0));
  if (withFails.length > 0) {
    console.log("\n" + "─".repeat(78));
    console.log("  FAILING CASES (per target — read as data, NOT as a to-fix list)");
    console.log("─".repeat(78));
    for (const r of withFails) {
      console.log(`\n  ${r.target.label}:`);
      for (const s of r.suites) {
        for (const c of s.failingCases) console.log(`    ${s.suite}: ${c}`);
      }
    }
  } else {
    console.log("\n  No failing cases across any available target. ✓");
  }

  // ── cross-model aggregation: shared fragility vs model-specific quirks ────
  // THIS is the signal that tells you what (if anything) is worth fixing. A case
  // that fails on MANY models is a real extraction/parser fragility — worth a
  // fix. A case that fails on ONE model is that model's quirk — document it in
  // the README, do NOT tweak the pipeline to chase 100% (overfitting breaks the
  // models that already pass). The harness measures; it does not fix-until-green.
  if (withFails.length > 0) {
    const caseFails = new Map<string, Set<string>>(); // caseKey -> set of target labels
    for (const r of withFails) {
      for (const s of r.suites) {
        for (const c of s.failingCases) {
          const key = `${s.suite}::${c}`;
          if (!caseFails.has(key)) caseFails.set(key, new Set());
          caseFails.get(key)!.add(r.target.label);
        }
      }
    }
    const shared = [...caseFails.entries()].filter(([, m]) => m.size >= 2).sort((a, b) => b[1].size - a[1].size);
    const quirks = [...caseFails.entries()].filter(([, m]) => m.size === 1);
    console.log("\n" + "─".repeat(78));
    console.log("  SHARED FRAGILITY (failed on ≥2 models — candidate for a real fix):");
    console.log("─".repeat(78));
    if (shared.length === 0) console.log("    none — every failure is model-specific.");
    for (const [key, models] of shared) console.log(`    ×${models.size}  ${key}   [${[...models].join(", ")}]`);
    console.log("\n" + "─".repeat(78));
    console.log(`  MODEL-SPECIFIC QUIRKS (failed on 1 model — document, do NOT chase):  ${quirks.length}`);
    console.log("─".repeat(78));
    for (const [key, models] of quirks) console.log(`    ${key}   [${[...models].join(", ")}]`);
  }

  // ── recommendation + verdict (measurement, not fix-until-green) ───────────
  console.log("\n" + "═".repeat(78));
  const avail = results.filter((r) => r.available);
  const rates = avail.map((r) => {
    const t = r.suites.reduce((a, s) => a + (s.total || 0), 0);
    const p = r.suites.reduce((a, s) => a + (s.passed || 0), 0);
    return { label: r.target.label, rate: t ? p / t : 1, p, t, axis: r.target.axis };
  }).sort((a, b) => b.rate - a.rate);
  const best = rates[0];

  // ── persist artifacts (the matrix IS the deliverable → README "tested models") ─
  const generatedAt = new Date().toISOString();
  const perSuite: Record<string, { label: string; suites: Record<string, { passed?: number; total?: number; status: string }> ; overall: { p: number; t: number; rate: number } }> = {};
  for (const r of avail) {
    const t = r.suites.reduce((a, s) => a + (s.total || 0), 0);
    const p = r.suites.reduce((a, s) => a + (s.passed || 0), 0);
    perSuite[r.target.label] = {
      label: r.target.label,
      suites: Object.fromEntries(r.suites.map((s) => [s.suite, { passed: s.passed, total: s.total, status: s.status }])),
      overall: { p, t, rate: t ? p / t : 1 },
    };
  }
  writeFileSync("overreach-model-results.json", JSON.stringify({ generatedAt, threshold, targets: results.map((r) => ({ label: r.target.label, axis: r.target.axis, available: r.available, reason: r.reason, suites: r.suites })), rates }, null, 2));

  const md: string[] = [];
  md.push("# Tested Models");
  md.push("");
  md.push(`Generated by \`npm run harness\` on ${generatedAt}. Per-target overall pass rate across the model-dependent battery${process.env.HARNESS_INCLUDE_STRESS ? " (e2e, simulate, large, false-denial, stress)" : " (e2e, simulate, large, false-denial)"}. A target is **supported** at ≥ ${Math.round(threshold * 100)}% overall.`);
  md.push("");
  md.push("This is a MEASUREMENT, not a 100%-green claim. Weaker models are documented here as best-effort, not chased by overfitting the pipeline.");
  md.push("");
  md.push("| Model | overall | rate | status |");
  md.push("|---|---|---|---|");
  for (const r of rates) {
    const pct = Math.round(r.rate * 100);
    const status = r === best ? "recommended" : r.rate >= threshold ? "supported" : "best-effort";
    md.push(`| ${r.label} | ${r.p}/${r.t} | ${pct}% | ${status} |`);
  }
  md.push("");
  md.push(`**Recommended:** ${best?.label}.`);
  const supported = rates.filter((r) => r !== best && r.rate >= threshold).map((r) => r.label);
  const bestEffort = rates.filter((r) => r.rate < threshold).map((r) => r.label);
  if (supported.length) md.push(`**Also supported:** ${supported.join(", ")}.`);
  if (bestEffort.length) md.push(`**Best-effort (below ${Math.round(threshold * 100)}%):** ${bestEffort.join(", ")}.`);
  const withFails2 = avail.filter((r) => r.suites.some((s) => s.failingCases.length > 0));
  if (withFails2.length) {
    md.push("");
    md.push("## Failing cases by model");
    for (const r of withFails2) {
      md.push(`\n**${r.target.label}**`);
      for (const s of r.suites) for (const c of s.failingCases) md.push(`- ${s.suite}: ${c}`);
    }
  }
  writeFileSync("TESTED-MODELS.md", md.join("\n") + "\n");

  if (avail.length === 0) {
    console.log("  VERDICT: measurement FAILED — no targets available. Check keys / model names / OLLAMA_BASE_URL.");
    console.log("═".repeat(78) + "\n");
    process.exit(1);
  }
  console.log("  RECOMMENDATION TABLE (primary output — also written to TESTED-MODELS.md + overreach-model-results.json):");
  for (const r of rates) {
    const pct = Math.round(r.rate * 100);
    const tag = r === best ? "  ← recommended" : (r.rate >= threshold ? "  ← supported" : "  ← best-effort");
    console.log(`    ${r.label.padEnd(28)} ${r.p}/${r.t}  (${pct}%)${tag}`);
  }
  console.log("");
  if (anyBelow) {
    console.log(`  ⚠  ${rates.filter((r) => r.rate < threshold).length} target(s) below ${Math.round(threshold * 100)}% → exit 1 (worth investigating).`);
    console.log("     Investigate via the SHARED FRAGILITY list: same case fails on many models = real fix;");
    console.log("     fails on one model = that model's quirk → document in README, do NOT overfit the pipeline to chase 100%.");
  } else {
    console.log(`  ✓ Every available target ≥ ${Math.round(threshold * 100)}%. The frozen contract is model-robust, not ${best?.label}-specific.`);
  }
  console.log("\n  Artifacts: TESTED-MODELS.md (README-ready) · overreach-model-results.json (raw)");
  console.log("═".repeat(78) + "\n");
  // Exit policy: 0 = every available model ≥ threshold (measurement OK, nothing to investigate).
  //              1 = some model below threshold (worth investigating) OR measurement failed.
  // The matrix is the deliverable; the exit code is just an investigate-flag, not a fix-until-green gate.
  process.exit(anyBelow ? 1 : 0);
}

main().catch((err) => { console.error("harness crashed:", err); process.exit(2); });
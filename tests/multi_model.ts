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
  // keys to DELETE from the inherited env for this target's child processes +
  // ping (e.g. a shell-wide ANTHROPIC_BASE_URL pointing at a local proxy must
  // be dropped so the Anthropic SDK hits api.anthropic.com directly).
  envDelete?: string[];
}

const OLLAMA_CLOUD = process.env.HARNESS_OLLAMA_BASE_URL || "https://ollama.com";
const ollamaModels = (process.env.HARNESS_OLLAMA_MODELS || "glm-5.2,gemma3,qwen2.5,deepseek-r1")
  .split(",").map((s) => s.trim()).filter(Boolean);

function looksRealKey(k: string | undefined): boolean {
  return Boolean(k && !k.includes("your_") && k.length > 8);
}

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
  // Axis 2 — API-format-robustness (different provider formats). Only add a
  // format target when its key is actually present in the env (sourced inline,
  // never written into the repo) — avoids wasted 401s and false "unavailable"
  // rows for providers the operator didn't configure. Skip all of them with
  // HARNESS_NO_FORMAT=1.
  if (!process.env.HARNESS_NO_FORMAT) {
    // Google Gemini via its OpenAI-compatible endpoint (key from GEMINI_API_KEY).
    if (looksRealKey(process.env.GEMINI_API_KEY)) {
      t.push({
        label: "gemini-2.5-flash@google",
        axis: "format",
        note: "Google Gemini (OpenAI-compat endpoint)",
        env: {
          SCOPE_PROVIDER: "openai",
          OPENAI_API_KEY: process.env.GEMINI_API_KEY as string,
          OPENAI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
          OVERREACH_MODEL: "gemini-2.5-flash",
        },
      });
    }
    if (looksRealKey(process.env.OPENAI_API_KEY)) {
      t.push({
        label: "gpt-4o-mini@openai",
        axis: "format",
        note: "OpenAI native API format",
        env: { SCOPE_PROVIDER: "openai", OVERREACH_MODEL: "gpt-4o-mini" },
      });
    }
    if (looksRealKey(process.env.ANTHROPIC_API_KEY)) {
      const anthropicModel = process.env.HARNESS_ANTHROPIC_MODEL || "claude-sonnet-4-6";
      t.push({
        label: `${anthropicModel}@anthropic`,
        axis: "format",
        note: "Anthropic native API format",
        env: { SCOPE_PROVIDER: "anthropic", OVERREACH_MODEL: anthropicModel },
        // Drop an inherited ANTHROPIC_BASE_URL (e.g. a shell-wide proxy at a
        // local Ollama port) so the SDK calls api.anthropic.com directly.
        envDelete: ["ANTHROPIC_BASE_URL"],
      });
    }
  }
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
  skipReason?: string;
  raw?: string;
}

// Parse a suite's stdout for the summary line, failing-case names, reconcile, and
// (if it SKIPped) the reason the suite gave for skipping.
function parseSuite(out: string): { passed?: number; total?: number; fails: string[]; recChanged?: number; recTotal?: number; skipped: boolean; skipReason?: string } {
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
  const skipLine = out.split("\n").map((l) => l.trim()).find((l) => /^SKIP[:\s]/i.test(l));
  const skipped = Boolean(skipLine);
  return { passed, total, fails, recChanged, recTotal, skipped, skipReason: skipLine };
}

function runSuite(script: string, target: Target, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, ...target.env, OVERREACH_HARNESS: "1" };
    for (const k of target.envDelete || []) delete env[k];
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: process.cwd(),
      env: env as Record<string, string>,
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
// Pings are serialized in main() (Phase 1) because this mutates process.env
// in-process; the save/restore covers EVERY key in target.env so a target that
// sets extra vars (e.g. Gemini sets OPENAI_API_KEY/OPENAI_BASE_URL) doesn't leak
// into the next ping.
async function ping(target: Target): Promise<{ ok: boolean; reason?: string }> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(target.env)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(target.env)) process.env[k] = v;
  for (const k of target.envDelete || []) { prev[k] = process.env[k]; delete process.env[k]; }
  try {
    const r = await withTimeout(extractScope("add a login form to the settings page"), 60000);
    const scope = r.scope;
    const nonEmpty = scope.features_allowed.length > 0 || scope.files_allowed.length > 0;
    if (!nonEmpty || r.warning) return { ok: false, reason: r.warning || "empty scope" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ping timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
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

  // Phase 1 — sequential pings. ping() mutates process.env in-process, so pings
  // MUST be serialized to avoid races; they're cheap (~1 call each). The
  // expensive batteries are parallelized in Phase 2: each suite is an isolated
  // child process with its env passed explicitly to spawn, so running targets
  // concurrently is safe (no shared mutable env).
  console.log("\n  Phase 1: reachability ping per target (sequential)…");
  const pings: { target: Target; ok: boolean; reason?: string }[] = [];
  for (const target of targets) {
    process.stdout.write(`  ▶ ${target.label.padEnd(26)} `);
    const pingR = await ping(target);
    if (!pingR.ok) {
      console.log(`UNAVAILABLE (${(pingR.reason || "").slice(0, 50)})`);
      pings.push({ target, ok: false, reason: pingR.reason });
    } else {
      console.log("available ✓");
      pings.push({ target, ok: true });
    }
  }

  // Phase 2 — run each available target's battery. Targets run in PARALLEL
  // (suites sequential within a target). Concurrency cap via HARNESS_CONCURRENCY
  // (default: all available targets at once — lower it, e.g. 2, if a provider
  // rate-limits). Each target's suite output is buffered and printed as a block
  // when that target finishes, so parallel logs don't interleave.
  const available = pings.filter((p) => p.ok).map((p) => p.target);
  const cap = Math.max(1, parseInt(process.env.HARNESS_CONCURRENCY || String(available.length), 10));
  console.log(`\n  Phase 2: batteries in parallel (concurrency ${Math.min(cap, available.length)} of ${available.length} available)…`);

  async function runBattery(target: Target): Promise<{ target: Target; suites: SuiteResult[]; log: string }> {
    const log: string[] = [];
    const suiteResults: SuiteResult[] = [];
    for (const s of SUITES) {
      const { out } = await runSuite(s.script, target, s.slow ? 420000 : 240000);
      const parsed = parseSuite(out);
      if (parsed.skipped && parsed.total === undefined) {
        log.push(`   ${s.name.padEnd(13)} SKIP  ${parsed.skipReason ? "— " + parsed.skipReason.slice(0, 60) : ""}`);
        suiteResults.push({ suite: s.name, status: "skip", failingCases: [], skipReason: parsed.skipReason });
      } else if (parsed.total === undefined) {
        log.push(`   ${s.name.padEnd(13)} ERROR (no summary)`);
        suiteResults.push({ suite: s.name, status: "error", failingCases: parsed.fails, raw: out.slice(-400) });
      } else {
        const ok = parsed.passed === parsed.total;
        log.push(`   ${s.name.padEnd(13)} ${parsed.passed}/${parsed.total}${ok ? "" : " ✗"}`);
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
    return { target, suites: suiteResults, log: log.join("\n") };
  }

  const queue = [...available];
  const batteryResults: { target: Target; suites: SuiteResult[]; log: string }[] = [];
  async function worker() {
    while (queue.length) {
      const target = queue.shift();
      if (!target) break;
      const res = await runBattery(target);
      batteryResults.push(res);
      console.log(`\n▶ ${res.target.label}  [axis: ${res.target.axis}]  ${res.target.note}`);
      console.log(res.log);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cap, available.length) }, () => worker()));

  // assemble results in original target order
  for (const p of pings) {
    if (!p.ok) results.push({ target: p.target, available: false, reason: p.reason, suites: [] });
    else {
      const br = batteryResults.find((b) => b.target.label === p.target.label);
      results.push({ target: p.target, available: true, suites: br?.suites ?? [] });
    }
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
      console.log(`${r.target.label.padEnd(28)}${"UNAVAILABLE".padStart(13)}  ${r.reason ? r.reason.slice(0, 44) : ""}`);
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
    const overall = totalTotal ? `${totalPassed}/${totalTotal}` : "0/0 (not measured)";
    const rate = totalTotal ? totalPassed / totalTotal : null; // null = not measured (NOT 100%)
    const rec = recT ? `${recC}/${recT}` : "—";
    const flag = rate === null ? "  · NOT MEASURED" : rate < threshold ? "  ✗ BELOW" : "";
    if (rate !== null && rate < threshold) anyBelow = true;
    console.log(`${r.target.label.padEnd(28)}${cells.join("")}   ${overall.padStart(16)}   ${rec.padStart(10)}${flag}`);
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
  // A target is "measured" only if it was available AND at least one suite
  // produced assertions (total > 0). A target that pinged available but then
  // self-skipped every suite (its model 404s / can't produce strict scope JSON
  // on real prompts) is NOT measured — reporting 0/0 as "100% supported" would
  // be the exact kind of false claim this tool exists to prevent.
  const rates = avail.map((r) => {
    const t = r.suites.reduce((a, s) => a + (s.total || 0), 0);
    const p = r.suites.reduce((a, s) => a + (s.passed || 0), 0);
    const skipReasons = [...new Set(r.suites.map((s) => s.skipReason).filter(Boolean))] as string[];
    return { label: r.target.label, axis: r.target.axis, rate: t > 0 ? p / t : null as number | null, p, t, skipReasons };
  });
  const measuredRates = rates.filter((r) => r.rate !== null).sort((a, b) => (b.rate as number) - (a.rate as number));
  const notMeasured = rates.filter((r) => r.rate === null);
  const best = measuredRates[0];

  // ── persist artifacts (the matrix IS the deliverable → README "tested models") ─
  const generatedAt = new Date().toISOString();
  writeFileSync("overreach-model-results.json", JSON.stringify({ generatedAt, threshold, targets: results.map((r) => ({ label: r.target.label, axis: r.target.axis, available: r.available, reason: r.reason, suites: r.suites })), rates }, null, 2));

  const md: string[] = [];
  md.push("# Tested Models");
  md.push("");
  md.push(`Generated by \`npm run harness\` on ${generatedAt}. Per-target overall pass rate across the model-dependent battery${process.env.HARNESS_INCLUDE_STRESS ? " (e2e, simulate, large, false-denial, stress)" : " (e2e, simulate, large, false-denial)"}. A target is **supported** at ≥ ${Math.round(threshold * 100)}% overall — but only targets that actually RAN the battery count. A target that could not be reached (model 404 / no key / can't produce strict scope JSON) is **not measured**, not "100%".`);
  md.push("");
  md.push("This is a MEASUREMENT, not a 100%-green claim. Weaker models are documented here as best-effort, not chased by overfitting the pipeline.");
  md.push("");
  md.push("| Model | overall | rate | status |");
  md.push("|---|---|---|---|");
  for (const r of measuredRates) {
    const pct = Math.round((r.rate as number) * 100);
    const status = r === best ? "recommended" : (r.rate as number) >= threshold ? "supported" : "best-effort";
    md.push(`| ${r.label} | ${r.p}/${r.t} | ${pct}% | ${status} |`);
  }
  for (const r of notMeasured) {
    const reason = r.skipReasons[0] ? ` — ${r.skipReasons[0].replace(/^SKIP:\s*/i, "").slice(0, 80)}` : "";
    md.push(`| ${r.label} | 0/0 | — | not measured${reason} |`);
  }
  for (const r of results.filter((x) => !x.available)) {
    md.push(`| ${r.target.label} | — | — | unavailable — ${(r.reason || "").slice(0, 80)} |`);
  }
  md.push("");
  if (best) {
    md.push(`**Recommended:** ${best.label} (${best.p}/${best.t}, ${Math.round((best.rate as number) * 100)}%).`);
    const supported = measuredRates.filter((r) => r !== best && (r.rate as number) >= threshold).map((r) => r.label);
    const bestEffort = measuredRates.filter((r) => (r.rate as number) < threshold).map((r) => r.label);
    if (supported.length) md.push(`**Also supported:** ${supported.join(", ")}.`);
    if (bestEffort.length) md.push(`**Best-effort (below ${Math.round(threshold * 100)}%):** ${bestEffort.join(", ")}.`);
  } else {
    md.push(`**Recommended:** none — no target could be measured. Check keys / model names / OLLAMA_BASE_URL.`);
  }
  if (notMeasured.length) {
    md.push("");
    md.push(`**Not measured (could not run the battery):** ${notMeasured.map((r) => r.label).join(", ")}. These pinged reachable but their model could not produce strict scope JSON on the suite probe — document, do NOT overfit the pipeline to make them pass.`);
  }
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

  if (measuredRates.length === 0) {
    console.log("  VERDICT: measurement FAILED — no target could be measured. Check keys / model names / OLLAMA_BASE_URL.");
    console.log("═".repeat(78) + "\n");
    process.exit(1);
  }
  console.log("  RECOMMENDATION TABLE (primary output — also written to TESTED-MODELS.md + overreach-model-results.json):");
  for (const r of measuredRates) {
    const pct = Math.round((r.rate as number) * 100);
    const tag = r === best ? "  ← recommended" : ((r.rate as number) >= threshold ? "  ← supported" : "  ← best-effort");
    console.log(`    ${r.label.padEnd(28)} ${r.p}/${r.t}  (${pct}%)${tag}`);
  }
  for (const r of notMeasured) console.log(`    ${r.label.padEnd(28)} 0/0     (n/a)  ← not measured${r.skipReasons[0] ? " — " + r.skipReasons[0].replace(/^SKIP:\s*/i, "").slice(0, 50) : ""}`);
  console.log("");
  if (anyBelow) {
    console.log(`  ⚠  ${measuredRates.filter((r) => (r.rate as number) < threshold).length} measured target(s) below ${Math.round(threshold * 100)}% → exit 1 (worth investigating).`);
    console.log("     Investigate via the SHARED FRAGILITY list: same case fails on many models = real fix;");
    console.log("     fails on one model = that model's quirk → document in README, do NOT overfit the pipeline to chase 100%.");
  } else {
    console.log(`  ✓ Every MEASURED target ≥ ${Math.round(threshold * 100)}%. (${measuredRates.length} measured, ${notMeasured.length} not measured, ${results.filter((x) => !x.available).length} unavailable.)`);
    if (notMeasured.length) console.log("     Note: model-robustness is proven only across the MEASURED models. Not-measured models couldn't run — provision them (ollama pull / cloud account) to extend the claim; do NOT chase them by overfitting.");
  }
  console.log("\n  Artifacts: TESTED-MODELS.md (README-ready) · overreach-model-results.json (raw)");
  console.log("═".repeat(78) + "\n");
  // Exit policy: 0 = every MEASURED model ≥ threshold AND at least one was measured.
  //              1 = some measured model below threshold (worth investigating) OR
  //                  nothing could be measured at all.
  // Not-measured / unavailable targets are NOT "below threshold" — they're absent
  // data, documented in the matrix, not chased. The matrix is the deliverable; the
  // exit code is just an investigate-flag, not a fix-until-green gate.
  process.exit(anyBelow ? 1 : 0);
}

main().catch((err) => { console.error("harness crashed:", err); process.exit(2); });
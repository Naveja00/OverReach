#!/usr/bin/env node
// overreach — CLI. Audit a diff against the prompt that authorized it.
//
// Usage:
//   git diff | overreach --prompt "add a login form to settings"
//   overreach --prompt "..." --diff path/to/change.diff
//   overreach --prompt "..." --scope scope.json        # zero-key, no LLM
//   overreach demo                                       # self-contained, zero-key
//   overreach --prompt "..." --json                     # raw JSON for piping
//
// Defaults to the cloud resolution chain (anthropic key > openai key > ollama),
// falling back to local Ollama when no key is set — same chain the server uses.
// Stage 1 scope extraction is cached by hash(prompt+provider+model) so re-running
// the same prompt is free and instant (see src/scope/cache.ts).

import { readFileSync, existsSync } from "node:fs";
import { checkOverreach } from "./tools/check_overreach.js";
import { resolveProvider, resolveModel } from "./config.js";
import { getScopeCache, putScopeCache } from "./scope/cache.js";
import { sizeOfPrompt, sizeOfDiff, toTelemetryEvent } from "./sanitize.js";
import type { Scope, CheckResult } from "./types.js";
import { DEMO_PROMPT, DEMO_DIFF, DEMO_SCOPE } from "./demo.js";
import { runInit } from "./init.js";

const ANSI = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const useColor = process.stdout.isTTY ?? false;
const c = (fn: (s: string) => string) => (useColor ? fn : (s: string) => s);

interface Args {
  prompt?: string;
  diffPath?: string;
  scopePath?: string;
  json: boolean;
  emitContract: boolean;
  noCache: boolean;
  demo: boolean;
  init: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, emitContract: false, noCache: false, demo: false, init: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "-h": case "--help": a.help = true; break;
      case "-p": case "--prompt": a.prompt = next(); break;
      case "-d": case "--diff": a.diffPath = next(); break;
      case "--scope": a.scopePath = next(); break;
      case "--json": a.json = true; break;
      case "--emit-contract": a.emitContract = true; break;
      case "--no-cache": a.noCache = true; break;
      case "demo": a.demo = true; break;
      case "init": a.init = true; break;
      default:
        if (arg.startsWith("--prompt=")) a.prompt = arg.slice("--prompt=".length);
        else if (arg.startsWith("--diff=")) a.diffPath = arg.slice("--diff=".length);
        else if (arg.startsWith("--scope=")) a.scopePath = arg.slice("--scope=".length);
        else { console.error(`unknown argument: ${arg}`); process.exit(2); }
    }
  }
  return a;
}

const HELP = `overreach — audit a diff against the prompt that authorized it.

Usage:
  git diff | overreach --prompt "add a login form to settings"
  overreach --prompt "..." --diff change.diff
  overreach --prompt "..." --scope scope.json     zero-key, no LLM call
  overreach demo                                    self-contained zero-key demo
  overreach init                                    install pre-commit hook
  overreach --prompt "..." --json                  raw JSON for piping/CI

Options:
  -p, --prompt <text>   the instruction that authorized the work
  -d, --diff <path>     diff file (default: read from stdin)
  --scope <path|json>   inject authorized scope; skips the LLM entirely (zero-key)
  --json                emit raw JSON instead of pretty terminal output
  --emit-contract       include the versioned execution contract in output
  --no-cache            bypass the scope cache (force a fresh Stage 1 call)
  demo                  run the canonical login-form-smuggles-Stripe demo
  init                  install a git pre-commit hook + .overreach/prompt.md

Resolution: anthropic key > openai key > ollama (local, keyless). Override with
SCOPE_PROVIDER. Pin a model with OVERREACH_MODEL. Stage 1 scope is cached by
hash(prompt+provider+model) so re-running the same prompt is free + instant.

Exit code: 0 = LOW/MEDIUM, 1 = HIGH (for use as a CI gate).`;

async function readDiff(diffPath?: string): Promise<string> {
  if (diffPath) {
    if (!existsSync(diffPath)) { console.error(`diff file not found: ${diffPath}`); process.exit(2); }
    return readFileSync(diffPath, "utf-8");
  }
  // stdin. If no piped data and stdin is a TTY, there's nothing to read.
  if (process.stdin.isTTY) { console.error("no diff provided — pipe a diff or use --diff <path>"); process.exit(2); }
  return await readStdin();
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parseScopeArg(s: string): Scope {
  if (existsSync(s)) return JSON.parse(readFileSync(s, "utf-8"));
  try {
    return JSON.parse(s);
  } catch {
    console.error("--scope must be a path to a scope JSON file or inline JSON");
    process.exit(2);
  }
}

const SEV_COLOR: Record<string, (s: string) => string> = {
  high: ANSI.red, medium: ANSI.yellow, low: ANSI.green,
};
const KIND_LABEL: Record<string, string> = {
  "scope.file": "out-of-scope file",
  "scope.feature": "unauthorized feature",
  "scope.dep": "unauthorized dependency",
  "scope.endpoint": "unauthorized endpoint",
  "scope.env": "unauthorized env var",
  "scope.cron": "unauthorized cron job",
  "contract.expansion": "contract expansion",
};
const SCORE_COLOR: Record<string, (s: string) => string> = {
  HIGH: ANSI.red, MEDIUM: ANSI.yellow, LOW: ANSI.green,
};

function pretty(result: CheckResult, meta: { source: string; cached: boolean; promptLen: number; diffLines: number }): string {
  const L: string[] = [];
  L.push(c(ANSI.bold)("Overreach — scope audit"));
  L.push(c(ANSI.dim)(`  ${meta.source}`));
  if (meta.cached) L.push(c(ANSI.dim)("  stage 1: served from scope cache (no LLM call)"));
  L.push("");

  const score = result.scope_creep_score;
  const badge = c(SCORE_COLOR[score] || ANSI.green)(`scope_creep_score = ${score}`);
  L.push(`  ${badge}`);
  L.push("");

  if (result.skipped) {
    L.push(c(ANSI.yellow)("  ⚠ Audit skipped — Stage 1 scope extraction failed (provider unreachable)."));
    L.push(c(ANSI.dim)(`  Not blocked. ${result.summary}`));
    L.push("");
    L.push(c(ANSI.dim)(`  ${meta.diffLines} diff lines · prompt ${meta.promptLen} chars`));
    return L.join("\n");
  }

  if (result.findings.length === 0) {
    L.push(c(ANSI.green)("  ✓ No overreach — the diff stayed within the prompt's scope."));
    L.push("");
    L.push(c(ANSI.dim)(`  ${meta.diffLines} diff lines audited · prompt ${meta.promptLen} chars`));
    return L.join("\n");
  }

  // group findings by kind
  const byKind: Record<string, typeof result.findings> = {};
  for (const f of result.findings) (byKind[f.kind] ||= []).push(f);
  for (const [kind, fs] of Object.entries(byKind)) {
    const label = KIND_LABEL[kind] || kind;
    L.push(c(ANSI.bold)(`  ${label}  ${c(ANSI.dim)(`×${fs.length}`)}`));
    for (const f of fs) {
      const sev = c(SEV_COLOR[f.severity] || ANSI.green)(f.severity.toUpperCase().padEnd(6));
      const where = f.file && f.file !== "source" ? c(ANSI.dim)(`  ${f.file}`) : "";
      L.push(`    ${sev} ${f.evidence}${where}`);
      L.push(c(ANSI.dim)(`        ${f.detail}`));
    }
    L.push("");
  }
  L.push(c(ANSI.dim)(`  ${result.findings.length} finding(s) · ${meta.diffLines} diff lines · prompt ${meta.promptLen} chars`));
  if (result.contract) {
    L.push(c(ANSI.dim)(`  contract ${result.contract.id} (v${result.contract.version})`));
  }
  return L.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || process.argv.length <= 2) { console.log(HELP); process.exit(0); }

  // ── init ─────────────────────────────────────────────────────────────────
  if (args.init) { runInit(); return; }

  // ── demo ─────────────────────────────────────────────────────────────────
  if (args.demo) {
    const result = await checkOverreach(DEMO_PROMPT, DEMO_DIFF, { scopeOverride: DEMO_SCOPE });
    const meta = { source: "demo: canonical login-form-smuggles-Stripe fixture (scope injected, no LLM call, zero key)", cached: false, promptLen: sizeOfPrompt(DEMO_PROMPT), diffLines: sizeOfDiff(DEMO_DIFF) };
    if (args.json) {
      console.log(JSON.stringify({ ...result, telemetry: result.telemetry ? { reconcileRan: result.telemetry.reconcileRan, reconcileChanged: result.telemetry.reconcileChanged } : undefined }, null, 2));
    } else {
      console.log(pretty(result, meta));
    }
    process.exit(result.scope_creep_score === "HIGH" ? 1 : 0);
  }

  // ── real run ─────────────────────────────────────────────────────────────
  if (!args.prompt) { console.error("--prompt is required (or use `overreach demo`)"); process.exit(2); }
  const prompt = args.prompt;
  const diff = await readDiff(args.diffPath);

  const provider = resolveProvider();
  const model = resolveModel(provider);

  let scopeOverride: Scope | undefined;
  let cached = false;
  let source: string;

  if (args.scopePath) {
    scopeOverride = parseScopeArg(args.scopePath);
    source = `scope injected from ${args.scopePath} (no LLM call)`;
  } else if (!args.noCache) {
    const hit = getScopeCache(prompt, provider, model);
    if (hit) { scopeOverride = hit; cached = true; source = `provider=${provider} model=${model}`; }
    else source = `provider=${provider} model=${model}`;
  } else {
    source = `provider=${provider} model=${model} (cache bypassed)`;
  }

  const options: Parameters<typeof checkOverreach>[2] = {};
  if (scopeOverride) options.scopeOverride = scopeOverride;
  if (args.emitContract) options.emitContract = true;

  const result = await checkOverreach(prompt, diff, options);

  // On a fresh Stage 1 extraction (no override, no cache hit), persist the scope
  // so the next run of the same prompt is free. Never cache a skipped/failed
  // extraction — that would persist an empty scope and poison later runs with
  // paranoid-mode false positives even after the provider recovers.
  if (!scopeOverride && !args.noCache && !result.skipped) {
    putScopeCache(prompt, provider, model, result.scope);
  }

  const meta = { source, cached, promptLen: sizeOfPrompt(prompt), diffLines: sizeOfDiff(diff) };

  if (args.json) {
    // JSON mode: emit the full result + a telemetry-safe event alongside it.
    const out: Record<string, unknown> = { ...result };
    if (!scopeOverride && !args.noCache) {
      out.telemetry_event = toTelemetryEvent(result, { model, provider, prompt_length: meta.promptLen, diff_lines: meta.diffLines, chunked: !!result.telemetry?.reconcileRan, chunk_count: 0 });
    }
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(pretty(result, meta));
  }

  process.exit(result.scope_creep_score === "HIGH" ? 1 : 0);
}

main().catch((err) => {
  console.error("overreach failed:", err instanceof Error ? err.message : err);
  process.exit(2);
});
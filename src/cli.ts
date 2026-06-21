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
  promptFile?: string;
  diffPath?: string;
  scopePath?: string;
  parentContractPath?: string;
  agentName?: string;
  expires?: string;
  taskId?: string;
  issueRef?: string;
  json: boolean;
  emitContract: boolean;
  noCache: boolean;
  ledgerAppend: boolean;
  demo: boolean;
  init: boolean;
  ledger: boolean;
  status: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, emitContract: false, noCache: false, ledgerAppend: false, demo: false, init: false, ledger: false, status: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "-h": case "--help": a.help = true; break;
      case "-p": case "--prompt": a.prompt = next(); break;
      case "--prompt-file": a.promptFile = next(); break;
      case "-d": case "--diff": a.diffPath = next(); break;
      case "--scope": a.scopePath = next(); break;
      case "--json": a.json = true; break;
      case "--emit-contract": a.emitContract = true; break;
      case "--no-cache": a.noCache = true; break;
      case "--parent-contract": a.parentContractPath = next(); break;
      case "--agent-name": a.agentName = next(); break;
      case "--expires": a.expires = next(); break;
      case "--ledger-append": a.ledgerAppend = true; break;
      case "--task-id": a.taskId = next(); break;
      case "--issue-ref": a.issueRef = next(); break;
      case "demo": a.demo = true; break;
      case "init": a.init = true; break;
      case "ledger": a.ledger = true; break;
      case "status": a.status = true; break;
      default:
        if (arg.startsWith("--prompt=")) a.prompt = arg.slice("--prompt=".length);
        else if (arg.startsWith("--prompt-file=")) a.promptFile = arg.slice("--prompt-file=".length);
        else if (arg.startsWith("--diff=")) a.diffPath = arg.slice("--diff=".length);
        else if (arg.startsWith("--scope=")) a.scopePath = arg.slice("--scope=".length);
        else if (arg.startsWith("--parent-contract=")) a.parentContractPath = arg.slice("--parent-contract=".length);
        else if (arg.startsWith("--agent-name=")) a.agentName = arg.slice("--agent-name=".length);
        else if (arg.startsWith("--expires=")) a.expires = arg.slice("--expires=".length);
        else if (arg.startsWith("--task-id=")) a.taskId = arg.slice("--task-id=".length);
        else if (arg.startsWith("--issue-ref=")) a.issueRef = arg.slice("--issue-ref=".length);
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

Agent-to-agent:
  overreach --prompt "..." --emit-contract --json > contract.json
  overreach --prompt "child task" --parent-contract contract.json --agent-name "agent-b"

Options:
  -p, --prompt <text>          the instruction that authorized the work
  -d, --diff <path>            diff file (default: read from stdin)
  --scope <path|json>          inject authorized scope; skips the LLM entirely
  --json                       emit raw JSON instead of pretty terminal output
  --emit-contract              include the versioned execution contract in output
  --parent-contract <path>     parent contract JSON (validates child narrows parent)
  --agent-name <name>          name of the agent executing this work (for chain)
  --no-cache                   bypass the scope cache (force a fresh Stage 1 call)
  demo                         run the canonical login-form-smuggles-Stripe demo
  init                         install a git pre-commit hook + .overreach/prompt.md

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

function pretty(result: CheckResult, meta: { source: string; cached: boolean; deterministic: boolean; promptLen: number; diffLines: number }): string {
  const L: string[] = [];
  L.push(c(ANSI.bold)("Overreach — scope audit"));
  L.push(c(ANSI.dim)(`  ${meta.source}`));
  if (meta.cached) L.push(c(ANSI.dim)("  stage 1: served from scope cache (no LLM call)"));
  if (meta.deterministic) L.push(c(ANSI.cyan)("  stage 1: deterministic extraction (no API key — regex-parsed prompt, no LLM)"));
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

  // ── ledger ──────────────────────────────────────────────────────────────
  if (args.ledger) {
    const { readLedger, formatLedgerForAgent } = await import("./ledger.js");
    const { execSync } = await import("node:child_process");
    let root: string;
    try { root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim(); }
    catch { console.error("Not a git repository."); process.exit(1); }
    const entries = readLedger(root);
    if (args.json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log(formatLedgerForAgent(entries));
    }
    return;
  }

  // ── status ─────────────────────────────────────────────────────────────
  if (args.status) {
    const { readLedger, formatLedgerForAgent } = await import("./ledger.js");
    const { readClaims, formatClaims } = await import("./claims.js");
    const { execSync } = await import("node:child_process");
    let root: string;
    try { root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim(); }
    catch { console.error("Not a git repository."); process.exit(1); }
    console.log(c(ANSI.bold)("Overreach — project status\n"));
    console.log(c(ANSI.bold)("File claims:"));
    console.log(formatClaims(readClaims(root)));
    console.log("");
    console.log(c(ANSI.bold)("Ledger:"));
    console.log(formatLedgerForAgent(readLedger(root)));
    return;
  }

  // ── demo ─────────────────────────────────────────────────────────────────
  if (args.demo) {
    const result = await checkOverreach(DEMO_PROMPT, DEMO_DIFF, { scopeOverride: DEMO_SCOPE });
    const meta = { source: "demo: canonical login-form-smuggles-Stripe fixture (scope injected, no LLM call, zero key)", cached: false, deterministic: false, promptLen: sizeOfPrompt(DEMO_PROMPT), diffLines: sizeOfDiff(DEMO_DIFF) };
    if (args.json) {
      console.log(JSON.stringify({ ...result, telemetry: result.telemetry ? { reconcileRan: result.telemetry.reconcileRan, reconcileChanged: result.telemetry.reconcileChanged } : undefined }, null, 2));
    } else {
      console.log(pretty(result, meta));
    }
    process.exit(result.scope_creep_score === "HIGH" ? 1 : 0);
  }

  // ── real run ─────────────────────────────────────────────────────────────
  if (args.promptFile) {
    if (!existsSync(args.promptFile)) { console.error(`prompt file not found: ${args.promptFile}`); process.exit(2); }
    args.prompt = readFileSync(args.promptFile, "utf-8").trim();
  }
  if (!args.prompt) { console.error("--prompt or --prompt-file is required (or use `overreach demo`)"); process.exit(2); }
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
  if (args.emitContract || args.parentContractPath || args.expires) options.emitContract = true;
  if (args.agentName) options.agentName = args.agentName;
  if (args.expires) options.expiresAt = args.expires;
  if (args.parentContractPath) {
    if (!existsSync(args.parentContractPath)) { console.error(`parent contract not found: ${args.parentContractPath}`); process.exit(2); }
    try {
      options.parentContract = JSON.parse(readFileSync(args.parentContractPath, "utf-8"));
    } catch {
      console.error("--parent-contract must be a valid JSON file");
      process.exit(2);
    }
  }

  const result = await checkOverreach(prompt, diff, options);

  // On a fresh Stage 1 extraction (no override, no cache hit), persist the scope
  // so the next run of the same prompt is free. Never cache a skipped/failed
  // extraction — that would persist an empty scope and poison later runs with
  // paranoid-mode false positives even after the provider recovers.
  if (!scopeOverride && !args.noCache && !result.skipped && !result.deterministic) {
    putScopeCache(prompt, provider, model, result.scope);
  }

  const meta = { source, cached, deterministic: !!result.deterministic, promptLen: sizeOfPrompt(prompt), diffLines: sizeOfDiff(diff) };

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

  if (args.ledgerAppend && result.scope_creep_score !== "HIGH") {
    try {
      const { appendLedger } = await import("./ledger.js");
      const { execSync } = await import("node:child_process");
      const root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
      const agent = args.agentName || "pre-commit";
      const task = prompt.length > 100 ? prompt.slice(0, 100) + "..." : prompt;
      appendLedger(root, result, agent, task, {
        taskId: args.taskId,
        issueRef: args.issueRef,
      });
    } catch (err) {
      console.error(`[overreach] ledger append failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  process.exit(result.scope_creep_score === "HIGH" ? 1 : 0);
}

main().catch((err) => {
  console.error("overreach failed:", err instanceof Error ? err.message : err);
  process.exit(2);
});
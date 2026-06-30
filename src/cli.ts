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
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
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
  since?: string;
  sinceAgent?: string;
  json: boolean;
  emitContract: boolean;
  noCache: boolean;
  ledgerAppend: boolean;
  demo: boolean;
  init: boolean;
  ledger: boolean;
  status: boolean;
  checkIn: boolean;
  diagnose: boolean;
  coordCheck: boolean;
  strict: boolean;
  serve: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, emitContract: false, noCache: false, ledgerAppend: false, demo: false, init: false, ledger: false, status: false, checkIn: false, diagnose: false, coordCheck: false, strict: false, serve: false, help: false };
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
      case "--since": a.since = next(); break;
      case "--since-agent": a.sinceAgent = next(); break;
      case "demo": a.demo = true; break;
      case "init": a.init = true; break;
      case "ledger": a.ledger = true; break;
      case "status": a.status = true; break;
      case "check-in": a.checkIn = true; break;
      case "coord-check": a.coordCheck = true; break;
      case "--diagnose": a.diagnose = true; break;
      case "--strict": a.strict = true; break;
      case "--serve": case "serve": a.serve = true; break;
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
        else if (arg.startsWith("--since=")) a.since = arg.slice("--since=".length);
        else if (arg.startsWith("--since-agent=")) a.sinceAgent = arg.slice("--since-agent=".length);
        else { console.error(`unknown argument: ${arg}`); process.exit(2); }
    }
  }
  return a;
}

const HELP = `overreach — AI PR review assistant

  Review what your AI agent actually changed vs what you asked for.
  Deterministic checks. No AI opinions. Evidence-backed.

Quick start:
  overreach                               auto-detect changes, ask what you did
  overreach demo                          see it in action (no setup needed)

Usage:
  overreach                               interactive — detects diff, asks for prompt
  overreach -p "your prompt"              review with piped diff (git diff | overreach -p ...)
  overreach -p "..." --diff change.diff   review a diff file
  overreach demo                          zero-key demo: login form + Stripe smuggle
  overreach init                          install pre-commit hook
  overreach -p "..." --json               JSON output for CI/scripting

Options:
  -p, --prompt <text>       what you asked the AI to do
  -d, --diff <path>         diff file (default: auto-detect or stdin)
  --prompt-file <path>      read prompt from a file
  --scope <path|json>       inject scope directly (skip LLM, zero-key)
  --json                    raw JSON output
  --no-cache                force fresh scope extraction
  demo                      run the built-in demo
  init                      install git pre-commit hook

MCP server (for AI agents):
  overreach --serve                       start MCP server (stdio)
  PORT=8787 overreach --serve             start MCP server (HTTP)

Team coordination (advanced):
  overreach check-in --agent-name claude  multi-agent awareness
  overreach coord-check --diff pr.diff    CI coordination gate
  overreach status                        project-wide agent status
  overreach ledger                        audit trail of all agent work

AI provider: uses anthropic > openai > ollama (auto-detected from env keys).
Override: SCOPE_PROVIDER / OVERREACH_MODEL. Scope cached per prompt.

Exit code: 0 = clean, 1 = high-risk findings (CI gate).`;

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

const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function pretty(result: CheckResult, meta: { source: string; cached: boolean; deterministic: boolean; promptLen: number; diffLines: number; prompt?: string }): string {
  const L: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────
  L.push("");
  L.push(c(ANSI.bold)("  AI PR Review"));
  L.push("");

  // ── Prompt ──────────────────────────────────────────────────────────────
  if (meta.prompt) {
    const display = meta.prompt.length > 80 ? meta.prompt.slice(0, 77) + "..." : meta.prompt;
    L.push(c(ANSI.dim)(`  Prompt: "${display}"`));
    L.push("");
  }

  // ── Skipped ─────────────────────────────────────────────────────────────
  if (result.skipped) {
    L.push(c(ANSI.yellow)("  ⚠  Review skipped — scope extraction failed (provider unreachable)."));
    L.push(c(ANSI.dim)(`     ${result.summary}`));
    L.push("");
    L.push(c(ANSI.dim)(`  ${meta.diffLines} diff lines · prompt ${meta.promptLen} chars`));
    L.push("");
    return L.join("\n");
  }

  // ── Files summary ───────────────────────────────────────────────────────
  const totalFiles = result.actual.files_changed.length;
  const outOfScopeFiles = result.findings.filter(f => f.kind === "scope.file").map(f => f.evidence);
  const inScope = totalFiles - outOfScopeFiles.length;

  L.push(`  ${c(ANSI.bold)("Files Changed:")} ${totalFiles}`);
  L.push("");

  // ── Intent Alignment ────────────────────────────────────────────────────
  L.push(c(ANSI.bold)("  Prompt Coverage"));
  if (inScope > 0) L.push(c(ANSI.green)(`    ✓  ${inScope} file${inScope === 1 ? "" : "s"} directly related`));
  if (outOfScopeFiles.length > 0) L.push(c(ANSI.yellow)(`    ⚠  ${outOfScopeFiles.length} file${outOfScopeFiles.length === 1 ? "" : "s"} outside requested scope`));
  if (result.findings.length === 0) L.push(c(ANSI.green)("    ✓  All changes match your request"));
  L.push("");

  // ── Unexpected changes (grouped by risk) ────────────────────────────────
  if (result.findings.length > 0) {
    const high = result.findings.filter(f => f.severity === "high");
    const medium = result.findings.filter(f => f.severity === "medium");
    const low = result.findings.filter(f => f.severity === "low");

    if (high.length > 0) {
      L.push(c(ANSI.red)(c(ANSI.bold)("  ⚠  High Risk")));
      for (const f of high) {
        L.push(c(ANSI.red)(`    ⚠  ${friendlyFinding(f)}`));
      }
      L.push("");
    }
    if (medium.length > 0) {
      L.push(c(ANSI.yellow)(c(ANSI.bold)("  ⚠  Medium Risk")));
      for (const f of medium) {
        L.push(c(ANSI.yellow)(`    ⚠  ${friendlyFinding(f)}`));
      }
      L.push("");
    }
    if (low.length > 0) {
      L.push(c(ANSI.dim)(c(ANSI.bold)("  ℹ  Low Risk")));
      for (const f of low) {
        L.push(c(ANSI.dim)(`    ℹ  ${friendlyFinding(f)}`));
      }
      L.push("");
    }

    // ── Review Order ────────────────────────────────────────────────────────
    // Map findings to real file paths from actual.files_changed where possible.
    const sorted = [...result.findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
    const changedFiles = result.actual.files_changed;
    const seen = new Set<string>();
    const reviewItems: { file: string; why: string }[] = [];
    for (const f of sorted) {
      const realFile = resolveRealFile(f, changedFiles);
      if (realFile && !seen.has(realFile)) {
        seen.add(realFile);
        reviewItems.push({ file: realFile, why: friendlyKind(f.kind) });
      }
    }
    if (reviewItems.length > 0) {
      L.push(c(ANSI.bold)("  Review Order") + c(ANSI.dim)(" (start here)"));
      reviewItems.forEach((item, i) => {
        L.push(`    ${i + 1}. ${item.file}${c(ANSI.dim)(` — ${item.why}`)}`);
      });
      L.push("");
    }
  }

  // ── Confidence ──────────────────────────────────────────────────────────
  L.push(c(ANSI.bold)("  Confidence"));
  L.push(c(ANSI.green)("    ✔  Deterministic checks only"));
  L.push(c(ANSI.green)("    ✔  No AI-generated opinions"));
  L.push(c(ANSI.green)("    ✔  Evidence-backed findings"));
  if (meta.deterministic) L.push(c(ANSI.cyan)("    ✔  Zero API key — fully offline"));
  L.push("");

  // ── Footer ──────────────────────────────────────────────────────────────
  L.push(c(ANSI.dim)(`  ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} · ${totalFiles} file${totalFiles === 1 ? "" : "s"} · ${meta.diffLines} diff lines`));
  L.push("");

  return L.join("\n");
}

function friendlyFinding(f: { kind: string; evidence: string; detail: string }): string {
  switch (f.kind) {
    case "scope.dep": return `Added dependency: ${f.evidence}`;
    case "scope.env": return `New environment variable: ${f.evidence}`;
    case "scope.endpoint": return `New API endpoint: ${f.evidence}`;
    case "scope.cron": return `Scheduled job added`;
    case "scope.listener": return `Runtime listener added: ${f.evidence}`;
    case "scope.file": return `File outside scope: ${f.evidence}`;
    case "scope.feature": return `Unauthorized feature: ${f.evidence}`;
    default: return f.detail;
  }
}

function friendlyKind(kind: string): string {
  switch (kind) {
    case "scope.dep": return "new dependency";
    case "scope.env": return "new env var";
    case "scope.endpoint": return "new endpoint";
    case "scope.cron": return "scheduled job";
    case "scope.listener": return "runtime listener";
    case "scope.file": return "outside scope";
    case "scope.feature": return "new feature";
    default: return kind;
  }
}

function resolveRealFile(finding: { kind: string; file: string; evidence: string }, changedFiles: string[]): string | null {
  const f = finding.file;
  if (!f || f === "source") return null;
  // If the file field is already a real path in the changed files, use it
  if (changedFiles.includes(f)) return f;
  // For deps, find the actual package file
  if (finding.kind === "scope.dep") {
    const pkg = changedFiles.find(p => /package\.json|requirements|pyproject|Pipfile|go\.mod|Gemfile|Cargo\.toml/i.test(p));
    return pkg || "package.json";
  }
  // For env vars, find the .env file
  if (finding.kind === "scope.env") {
    const env = changedFiles.find(p => /\.env/i.test(p));
    return env || ".env";
  }
  // For endpoints, find the route file from evidence
  if (finding.kind === "scope.endpoint") {
    const route = finding.evidence.replace(/^\//, "").split("/")[1] || "";
    const match = changedFiles.find(p => p.includes("route") || p.includes("api") || p.includes(route));
    return match || f;
  }
  // For cron, find the cron/schedule file
  if (finding.kind === "scope.cron") {
    const match = changedFiles.find(p => /cron|schedule|job/i.test(p));
    return match || f;
  }
  return f;
}

function askUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

interface DiffSource {
  label: string;
  cmd: string;
  lineCount: number;
}

function detectDiffSources(): DiffSource[] {
  const sources: DiffSource[] = [];
  const tryDiff = (label: string, cmd: string) => {
    try {
      const out = execSync(cmd, { encoding: "utf-8" });
      const lines = out.trim().split("\n").filter(l => l.startsWith("+") || l.startsWith("-")).length;
      if (out.trim()) sources.push({ label, cmd, lineCount: lines });
    } catch { /* ignore */ }
  };

  tryDiff("Staged changes (git add)", "git diff --staged");
  tryDiff("Unstaged changes", "git diff");
  tryDiff("Last commit", "git diff HEAD~1");

  // Branch diff vs main/master
  try {
    const branches = execSync("git branch --list main master", { encoding: "utf-8" }).trim();
    const base = branches.includes("main") ? "main" : branches.includes("master") ? "master" : null;
    if (base) {
      const current = execSync("git branch --show-current", { encoding: "utf-8" }).trim();
      if (current && current !== base) {
        tryDiff(`Branch diff (${current} vs ${base})`, `git diff ${base}...HEAD`);
      }
    }
  } catch { /* not on a branch, or no main/master */ }

  return sources;
}

function findPromptFile(): string | null {
  const candidates = [".overreach/prompt.md", ".overreach/prompt.txt"];
  for (const f of candidates) {
    if (existsSync(f)) return readFileSync(f, "utf-8").trim();
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }

  // ── serve (MCP server mode) ─────────────────────────────────────────────
  if (args.serve) {
    const { startServer } = await import("./index.js");
    await startServer();
    return;
  }

  // ── init ─────────────────────────────────────────────────────────────────
  if (args.init) { runInit(); return; }

  // ── interactive mode (no args) ──────────────────────────────────────────
  if (process.argv.length <= 2 && process.stdin.isTTY) {
    console.log(c(ANSI.bold)("\n  Overreach — AI PR Review\n"));

    const sources = detectDiffSources();
    if (sources.length === 0) {
      console.log("  No changes detected. Stage some changes or make a commit first.");
      console.log(c(ANSI.dim)("  Or try: overreach demo\n"));
      process.exit(0);
    }

    let diff: string;
    if (sources.length === 1) {
      console.log(c(ANSI.dim)(`  Using: ${sources[0].label} (${sources[0].lineCount} lines)\n`));
      diff = execSync(sources[0].cmd, { encoding: "utf-8" });
    } else {
      console.log("  What changes do you want to review?\n");
      sources.forEach((s, i) => {
        console.log(`    ${i + 1}. ${s.label} ${c(ANSI.dim)(`(${s.lineCount} lines)`)}`);
      });
      console.log("");
      const choice = await askUser("  Pick a number: ");
      const idx = parseInt(choice, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= sources.length) {
        console.log("  Invalid choice.");
        process.exit(2);
      }
      diff = execSync(sources[idx].cmd, { encoding: "utf-8" });
      console.log("");
    }

    let prompt = findPromptFile();
    if (!prompt) {
      prompt = await askUser("  What did you ask the AI to do?\n  > ");
      if (!prompt) {
        console.log("\n  No prompt provided. Can't review without knowing what you asked for.");
        process.exit(2);
      }
      console.log("");
    }

    const provider = resolveProvider();
    const model = resolveModel(provider);
    let scopeOverride: Scope | undefined;
    let cached = false;
    const hit = getScopeCache(prompt, provider, model);
    if (hit) { scopeOverride = hit; cached = true; }

    const options: Parameters<typeof checkOverreach>[2] = {};
    if (scopeOverride) options.scopeOverride = scopeOverride;
    const result = await checkOverreach(prompt, diff, options);

    if (!scopeOverride && !result.skipped && !result.deterministic) {
      putScopeCache(prompt, provider, model, result.scope);
    }

    const meta = { source: `provider=${provider} model=${model}`, cached, deterministic: !!result.deterministic, promptLen: sizeOfPrompt(prompt), diffLines: sizeOfDiff(diff), prompt };
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(pretty(result, meta));
    }
    process.exit(result.scope_creep_score === "HIGH" ? 1 : 0);
  }

  // ── ledger ──────────────────────────────────────────────────────────────
  if (args.ledger) {
    const { readLedger, formatLedgerForAgent, filterSince, resolveSinceCutoff, formatLedgerDelta } = await import("./ledger.js");
    const { execSync } = await import("node:child_process");
    let root: string;
    try { root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim(); }
    catch { console.error("Not a git repository."); process.exit(1); }
    let entries = readLedger(root);
    if (args.since !== undefined || args.sinceAgent !== undefined) {
      const r = resolveSinceCutoff({ since: args.since, sinceAgent: args.sinceAgent }, entries);
      if (r.invalidSince) { console.error(`--since could not be parsed as a timestamp: ${r.invalidSince}`); process.exit(2); }
      if (r.cutoff) {
        entries = filterSince(entries, r.cutoff);
        if (args.json) console.log(JSON.stringify(entries, null, 2));
        else console.log(formatLedgerDelta(entries, { cutoff: r.cutoff, sinceAgent: args.sinceAgent, note: r.note }));
      } else {
        // no cutoff resolvable (e.g. --since-agent with no prior entries) — full ledger + note
        if (args.json) console.log(JSON.stringify(entries, null, 2));
        else {
          if (r.note) console.log(`(${r.note})`);
          console.log(formatLedgerForAgent(entries));
        }
      }
      return;
    }
    if (args.json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log(formatLedgerForAgent(entries));
    }
    return;
  }

  // ── status ─────────────────────────────────────────────────────────────
  if (args.status) {
    const { readLedger, formatLedgerForAgent, filterSince, resolveSinceCutoff, formatLedgerDelta } = await import("./ledger.js");
    const { readClaims, formatClaims } = await import("./claims.js");
    const { execSync } = await import("node:child_process");
    let root: string;
    try { root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim(); }
    catch { console.error("Not a git repository."); process.exit(1); }
    console.log(c(ANSI.bold)("Overreach — project status\n"));
    console.log(c(ANSI.bold)("File claims:"));
    console.log(formatClaims(readClaims(root)));
    console.log("");
    const entries = readLedger(root);
    if (args.since !== undefined || args.sinceAgent !== undefined) {
      const r = resolveSinceCutoff({ since: args.since, sinceAgent: args.sinceAgent }, entries);
      if (r.invalidSince) { console.error(`--since could not be parsed as a timestamp: ${r.invalidSince}`); process.exit(2); }
      console.log(c(ANSI.bold)("Ledger (since last check-in):"));
      if (r.cutoff) {
        console.log(formatLedgerDelta(filterSince(entries, r.cutoff), { cutoff: r.cutoff, sinceAgent: args.sinceAgent, note: r.note }));
      } else {
        if (r.note) console.log(`(${r.note})`);
        console.log(formatLedgerForAgent(entries));
      }
    } else {
      console.log(c(ANSI.bold)("Ledger:"));
      console.log(formatLedgerForAgent(entries));
    }
    return;
  }

  // ── check-in ────────────────────────────────────────────────────────────
  if (args.checkIn) {
    if (!args.agentName) { console.error("check-in requires --agent-name (who is checking in)"); process.exit(2); }
    const { checkIn, formatCheckIn } = await import("./check_in.js");
    const { diagnoseCollision, formatCollision } = await import("./collide.js");
    const { execSync } = await import("node:child_process");
    let root: string;
    try { root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim(); }
    catch { console.error("Not a git repository."); process.exit(1); }

    const report = checkIn(root, args.agentName);

    if (args.json) {
      const out: Record<string, unknown> = { ...report };
      if (args.diagnose && report.conflicts.length > 0) {
        out.diagnostics = report.conflicts
          .map((c) => (c.files[0] ? diagnoseCollision(root, c.files[0], c.agents) : null))
          .filter(Boolean);
      }
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(c(ANSI.bold)("Overreach — check-in\n"));
      console.log(formatCheckIn(report));
      if (args.diagnose && report.conflicts.length > 0) {
        for (const c of report.conflicts) {
          const file = c.files[0];
          if (!file) continue;
          console.log("");
          console.log(formatCollision(diagnoseCollision(root, file, c.agents)));
        }
      }
    }
    process.exit(0);
  }

  // ── coord-check (CI coordination gate) ───────────────────────────────────
  if (args.coordCheck) {
    const { coordCheck, changedFilesFromDiff, formatCoordCheck } = await import("./coord_check.js");
    const { execSync } = await import("node:child_process");
    let root: string;
    try { root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim(); }
    catch { console.error("Not a git repository."); process.exit(1); }

    const diff = await readDiff(args.diffPath);
    const files = changedFilesFromDiff(diff);
    if (files.length === 0) {
      if (args.json) console.log(JSON.stringify({ files_checked: [], blocked_conflicts: [], unclaimed: [], claimed_by: [], blocked: false }, null, 2));
      else console.log("Coordination check — no files in the diff.");
      process.exit(0);
    }

    const report = coordCheck(root, files, args.strict);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(c(ANSI.bold)("Overreach — coordination check\n"));
      console.log(formatCoordCheck(report, args.strict));
    }
    process.exit(report.blocked ? 1 : 0);
  }

  // ── demo ─────────────────────────────────────────────────────────────────
  if (args.demo) {
    const result = await checkOverreach(DEMO_PROMPT, DEMO_DIFF, { scopeOverride: DEMO_SCOPE });
    const meta = { source: "demo", cached: false, deterministic: false, promptLen: sizeOfPrompt(DEMO_PROMPT), diffLines: sizeOfDiff(DEMO_DIFF), prompt: DEMO_PROMPT };
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

  const meta = { source, cached, deterministic: !!result.deterministic, promptLen: sizeOfPrompt(prompt), diffLines: sizeOfDiff(diff), prompt };

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
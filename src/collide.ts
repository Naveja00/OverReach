// Collision diagnostics — when two agents want the same file, turn the flat
// "conflict" into useful information: each agent's DECLARED intent (from their
// scope/file claims) + the file's actual top-level symbols + a split suggestion.
//
// Deterministic and on-brand: only declared facts + file structure. No merge
// engine, no hunk attribution, no inference about which agent wrote which symbol.
// Produces a CollisionReport — a SEPARATE output, never a scope.* finding.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { symbolAdded } from "./parsers/diff.js";
import { listActiveClaims } from "./scope_dsl.js";
import type { ScopeDSL } from "./scope_dsl.js";
import { readClaims } from "./claims.js";
import { isExpiredTimestamp } from "./utils.js";

const SPLIT_MIN_SYMBOLS = 4;

function filesInScope(scope: ScopeDSL): string[] {
  return [
    ...(scope.files?.create || []),
    ...(scope.files?.modify || []),
    ...(scope.files?.delete || []),
  ];
}

function opForScopeFile(scope: ScopeDSL, file: string): "create" | "modify" | "delete" | undefined {
  if (scope.files?.create?.includes(file)) return "create";
  if (scope.files?.modify?.includes(file)) return "modify";
  if (scope.files?.delete?.includes(file)) return "delete";
  return undefined;
}

export interface AgentIntent {
  agent: string;
  task?: string;
  op?: "create" | "modify" | "delete" | "claim";
  declared_dependencies: string[];
  declared_env_vars: string[];
  declared_api_routes: string[];
  source: "scope" | "file-claim" | "none";
}

export interface CollisionReport {
  file: string;
  file_exists: boolean;
  top_level_symbols: string[];
  intents: AgentIntent[];
  split_suggestion?: string;
}

/** Extract one agent's declared intent for `file` from their active scope claims
 *  (preferred — carries deps/env/routes) or their file claims (task only). */
function intentFor(root: string, agent: string, file: string): AgentIntent {
  const base: AgentIntent = {
    agent,
    declared_dependencies: [],
    declared_env_vars: [],
    declared_api_routes: [],
    source: "none",
  };

  const scopeClaim = listActiveClaims(root).find(
    (c) => c.agent === agent && filesInScope(c.scope).includes(file),
  );
  if (scopeClaim) {
    return {
      ...base,
      task: scopeClaim.task,
      op: opForScopeFile(scopeClaim.scope, file),
      declared_dependencies: scopeClaim.scope.dependencies || [],
      declared_env_vars: scopeClaim.scope.env_vars || [],
      declared_api_routes: scopeClaim.scope.api_routes || [],
      source: "scope",
    };
  }

  const fileClaim = readClaims(root).find(
    (c) => c.agent === agent && c.file === file && !isExpiredTimestamp(c.expires_at),
  );
  if (fileClaim) {
    return { ...base, task: fileClaim.task, op: "claim", source: "file-claim" };
  }

  return base;
}

/** List the file's top-level symbols by applying the same symbolAdded matcher
 *  used on diffs to each line of the file on disk. Deterministic. */
function topLevelSymbols(filePath: string): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(filePath, "utf-8").split(/\r?\n/)) {
    const s = symbolAdded(line);
    if (s && !seen.has(s)) {
      seen.add(s);
      symbols.push(s);
    }
  }
  return symbols;
}

/** Diagnose a collision on `file` between `agents`. Pure reads, no inference. */
export function diagnoseCollision(root: string, file: string, agents: string[]): CollisionReport {
  const intents = agents.map((a) => intentFor(root, a, file));

  const absPath = join(root, file);
  const file_exists = existsSync(absPath);
  const top_level_symbols = file_exists ? topLevelSymbols(absPath) : [];

  const contesting = intents.filter((i) => i.source !== "none");
  let split_suggestion: string | undefined;
  if (top_level_symbols.length >= SPLIT_MIN_SYMBOLS && contesting.length >= 2) {
    split_suggestion =
      `consider splitting \`${file}\` — top-level symbols: ${top_level_symbols.join(", ")}. ` +
      `Each agent could take a disjoint set of symbols instead of both editing the whole file.`;
  }

  return { file, file_exists, top_level_symbols, intents, split_suggestion };
}

/** Human-readable collision diagnostic. */
export function formatCollision(report: CollisionReport): string {
  const L: string[] = [];
  L.push(`Collision diagnostic for ${report.file}:`);

  if (report.file_exists) {
    const noun = report.top_level_symbols.length === 1 ? "symbol" : "symbols";
    L.push(
      `  File on disk: yes (${report.top_level_symbols.length} top-level ${noun}` +
      (report.top_level_symbols.length > 0 ? `: ${report.top_level_symbols.join(", ")}` : "") +
      `)`,
    );
  } else {
    L.push("  File on disk: no (not yet created — can't show symbols).");
  }

  L.push("  Agents contesting:");
  for (const i of report.intents) {
    if (i.source === "none") {
      L.push(`    ${i.agent} — no active claim on this file`);
      continue;
    }
    const op = i.op ? ` [${i.op}]` : "";
    const task = i.task ? ` "${i.task}"` : "";
    const deps = i.declared_dependencies.length > 0 ? ` deps: ${i.declared_dependencies.join(", ")}` : "";
    const env = i.declared_env_vars.length > 0 ? ` env: ${i.declared_env_vars.join(", ")}` : "";
    const routes = i.declared_api_routes.length > 0 ? ` routes: ${i.declared_api_routes.join(", ")}` : "";
    const extras = [deps, env, routes].filter(Boolean).join(",");
    L.push(`    ${i.agent}${op}${task} (${i.source}${extras ? `, ${extras.trim()}` : ""})`);
  }

  if (report.split_suggestion) {
    L.push("");
    L.push(`  Split suggestion: ${report.split_suggestion}`);
  } else if (report.file_exists && report.top_level_symbols.length > 0) {
    L.push("");
    L.push("  No split suggestion (few symbols or only one agent with a claim).");
  }

  return L.join("\n");
}
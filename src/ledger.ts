// Ledger — append-only coordination file for multi-agent workflows.
//
// .overreach/ledger.json is a flat array of LedgerEntry objects. Each entry
// records what an agent did: its contract id, agent name, task summary, files
// touched, findings count, score, and timestamp. Agents read the ledger before
// starting to see what's been done; the pre-commit hook appends after a
// successful audit.
//
// No server, no database — just a JSON file in git. Merge conflicts are
// handled by git like any other file.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { CheckResult, CreepScore } from "./types.js";

export interface LedgerEntry {
  contract_id?: string;
  agent: string;
  task: string;
  files_touched: string[];
  findings_count: number;
  score: CreepScore;
  at: string;
}

function ledgerPath(root: string): string {
  return join(root, ".overreach", "ledger.json");
}

export function readLedger(root: string): LedgerEntry[] {
  const p = ledgerPath(root);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function appendLedger(
  root: string,
  result: CheckResult,
  agentName: string,
  taskSummary: string,
): void {
  const dir = dirname(ledgerPath(root));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const entries = readLedger(root);
  const entry: LedgerEntry = {
    contract_id: result.contract?.id,
    agent: agentName,
    task: taskSummary.length > 200 ? taskSummary.slice(0, 200) + "..." : taskSummary,
    files_touched: result.actual.files_changed,
    findings_count: result.findings.length,
    score: result.scope_creep_score,
    at: new Date().toISOString(),
  };

  // Dedupe: don't append if the same contract_id already exists
  if (entry.contract_id && entries.some(e => e.contract_id === entry.contract_id)) {
    return;
  }

  entries.push(entry);
  writeFileSync(ledgerPath(root), JSON.stringify(entries, null, 2) + "\n", "utf-8");
}

export function queryByFile(entries: LedgerEntry[], file: string): LedgerEntry[] {
  return entries.filter(e => e.files_touched.some(f =>
    f === file || f.endsWith("/" + file) || file.endsWith("/" + f)
  ));
}

export function queryByAgent(entries: LedgerEntry[], agent: string): LedgerEntry[] {
  return entries.filter(e => e.agent.toLowerCase() === agent.toLowerCase());
}

export function fileOwnershipMap(entries: LedgerEntry[]): Record<string, { agent: string; task: string; at: string }[]> {
  const map: Record<string, { agent: string; task: string; at: string }[]> = {};
  for (const e of entries) {
    for (const f of e.files_touched) {
      (map[f] ||= []).push({ agent: e.agent, task: e.task, at: e.at });
    }
  }
  return map;
}

export function formatLedgerForAgent(entries: LedgerEntry[]): string {
  if (entries.length === 0) return "No prior agent work recorded.";
  const lines = entries.map((e, i) => {
    const files = e.files_touched.length > 0 ? e.files_touched.join(", ") : "none";
    return `${i + 1}. [${e.agent}] ${e.task} (${e.score}, ${e.findings_count} findings, files: ${files}) — ${e.at}`;
  });
  return `Prior agent work (${entries.length} entries):\n${lines.join("\n")}`;
}

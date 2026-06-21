import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { withFileLock } from "./utils.js";
import type { CheckResult, CreepScore, ScopeMode } from "./types.js";

const MAX_ENTRIES = parseInt(process.env.OVERREACH_LEDGER_MAX || "500", 10);

export interface LedgerEntry {
  contract_id?: string;
  agent: string;
  task: string;
  task_id?: string;
  issue_ref?: string;
  files_touched: string[];
  findings_count: number;
  score: CreepScore;
  mode?: ScopeMode;
  confidence?: number;
  claim_id?: string;
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
  opts?: { taskId?: string; issueRef?: string },
): void {
  withFileLock(ledgerPath(root), () => {
    const dir = dirname(ledgerPath(root));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let entries = readLedger(root);
    const entry: LedgerEntry = {
      contract_id: result.contract?.id,
      agent: agentName,
      task: taskSummary.length > 200 ? taskSummary.slice(0, 200) + "..." : taskSummary,
      files_touched: result.actual.files_changed,
      findings_count: result.findings.length,
      score: result.scope_creep_score,
      mode: result.mode,
      confidence: result.confidence,
      at: new Date().toISOString(),
    };
    if (result.claim_id) entry.claim_id = result.claim_id;
    if (opts?.taskId) entry.task_id = opts.taskId;
    if (opts?.issueRef) entry.issue_ref = opts.issueRef;

    if (entry.contract_id && entries.some(e => e.contract_id === entry.contract_id)) {
      return;
    }

    entries.push(entry);

    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(entries.length - MAX_ENTRIES);
    }

    writeFileSync(ledgerPath(root), JSON.stringify(entries, null, 2) + "\n", "utf-8");
  });
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
    const ref = e.issue_ref ? ` [${e.issue_ref}]` : "";
    return `${i + 1}. [${e.agent}] ${e.task}${ref} (${e.score}, ${e.findings_count} findings, files: ${files}) — ${e.at}`;
  });
  return `Prior agent work (${entries.length} entries):\n${lines.join("\n")}`;
}

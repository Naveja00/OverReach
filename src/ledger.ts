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

function entryLine(e: LedgerEntry, i: number): string {
  const files = e.files_touched.length > 0 ? e.files_touched.join(", ") : "none";
  const ref = e.issue_ref ? ` [${e.issue_ref}]` : "";
  return `${i + 1}. [${e.agent}] ${e.task}${ref} (${e.score}, ${e.findings_count} findings, files: ${files}) — ${e.at}`;
}

export function formatLedgerForAgent(entries: LedgerEntry[]): string {
  if (entries.length === 0) return "No prior agent work recorded.";
  const lines = entries.map((e, i) => entryLine(e, i));
  return `Prior agent work (${entries.length} entries):\n${lines.join("\n")}`;
}

// ── Catch-up: "what did I miss while I was away" ───────────────────────────
// All of the following are pure functions of (entries, opts) — no inference, no
// I/O. The `at` field is always `new Date().toISOString()` (canonical ISO-8601
// UTC, `Z` suffix), so ISO strings compare lexicographically in time order.
// A returning agent runs `status --since-agent <self>` to see only the delta
// since its own most recent ledger entry, instead of re-reading the whole log.

/** Most recent `at` among an agent's entries (case-insensitive). undefined if none. */
export function lastSeenAt(entries: LedgerEntry[], agent: string): string | undefined {
  const needle = agent.toLowerCase();
  let latest: string | undefined;
  for (const e of entries) {
    if (e.agent.toLowerCase() === needle && (latest === undefined || e.at > latest)) {
      latest = e.at;
    }
  }
  return latest;
}

/** Entries strictly after cutoffISO (exclusive — an entry at exactly the cutoff is NOT included). Pure. */
export function filterSince(entries: LedgerEntry[], cutoffISO: string): LedgerEntry[] {
  return entries.filter((e) => e.at > cutoffISO);
}

export interface SinceCutoff {
  cutoff?: string;        // undefined = nothing to filter on (show everything)
  note?: string;          // human hint, e.g. 'no prior work recorded by "ghost" — showing everything'
  invalidSince?: string;  // set when --since didn't parse as a date; the caller should error
}

/** Resolve a --since / --since-agent pair to a single cutoff timestamp. Pure.
 *  - --since is normalized to canonical ISO via Date.parse; unparseable → invalidSince.
 *  - --since-agent resolves to that agent's lastSeenAt; unknown agent → no cutoff + a note.
 *  - If both are given, the LATER cutoff wins (you don't want to re-see work you already saw). */
export function resolveSinceCutoff(
  opts: { since?: string; sinceAgent?: string },
  entries: LedgerEntry[],
): SinceCutoff {
  const cutoffs: string[] = [];
  const notes: string[] = [];

  if (opts.since !== undefined && opts.since !== "") {
    const t = Date.parse(opts.since);
    if (Number.isNaN(t)) return { invalidSince: opts.since };
    cutoffs.push(new Date(t).toISOString());
  }

  if (opts.sinceAgent) {
    const last = lastSeenAt(entries, opts.sinceAgent);
    if (last) cutoffs.push(last);
    else notes.push(`no prior work recorded by "${opts.sinceAgent}" — showing everything`);
  }

  if (cutoffs.length === 0) {
    return { cutoff: undefined, note: notes.join("; ") || undefined };
  }
  const cutoff = cutoffs.reduce((m, c) => (c > m ? c : m), cutoffs[0]);
  return { cutoff, note: notes.join("; ") || undefined };
}

/** Format a delta slice with contextual "what you missed" framing. Pure. */
export function formatLedgerDelta(
  entries: LedgerEntry[],
  opts: { cutoff: string; sinceAgent?: string; note?: string },
): string {
  const origin = opts.sinceAgent
    ? `since ${opts.sinceAgent} last checked in (${opts.cutoff})`
    : `since ${opts.cutoff}`;
  const noteLine = opts.note ? `\n(${opts.note})` : "";
  if (entries.length === 0) {
    return `No work recorded ${origin}.${noteLine}`;
  }
  const lines = entries.map((e, i) => entryLine(e, i));
  const noun = entries.length === 1 ? "entry" : "entries";
  return `Work ${origin} — ${entries.length} new ${noun}:${noteLine}\n${lines.join("\n")}`;
}

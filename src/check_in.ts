// Check-in — same-PC live awareness for multi-agent coordination.
//
// When Claude Code, Cursor, and Codex all run on the same machine they share the
// filesystem, so re-reading .overreach/ IS near-real-time awareness of what every
// agent is doing — no server, no transport, no inference. An agent checks in
// between big blocks of code to (a) renew its own claims so they don't expire
// while it works (a heartbeat), and (b) see a current snapshot: who's working on
// what, what it missed since its last check-in, and any open conflicts involving
// it. Deterministic, zero API cost, milliseconds.
//
// Trust contract: this produces a CheckInReport — a SEPARATE output, never a
// scope.* finding. Nothing here touches the frozen kind set or mixes trust levels.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { withFileLock, isExpiredTimestamp } from "./utils.js";
import { readClaims, extendClaim } from "./claims.js";
import { listActiveClaims, renewScopeClaims } from "./scope_dsl.js";
import { readLedger, filterSince, formatLedgerDelta, formatLedgerForAgent } from "./ledger.js";
import type { LedgerEntry } from "./ledger.js";
import { listOpenConflicts } from "./resolve.js";
import type { ConflictRecord } from "./resolve.js";

const DEFAULT_RENEW_DURATION = "2h";

function checkinsPath(root: string): string {
  return join(root, ".overreach", "checkins.json");
}

/** Read .overreach/checkins.json — { [agent]: last_check_in_at (ISO) }. */
export function readCheckins(root: string): Record<string, string> {
  const p = checkinsPath(root);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Atomically record this agent's check-in time. Returns the new timestamp and
 *  the previous one (undefined on first check-in). Pure-ish: one locked write. */
export function recordCheckIn(root: string, agent: string): { lastCheckIn: string; prevCheckIn?: string } {
  return withFileLock(checkinsPath(root), () => {
    const dir = dirname(checkinsPath(root));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const all = readCheckins(root);
    const prevCheckIn = all[agent];
    const lastCheckIn = new Date().toISOString();
    all[agent] = lastCheckIn;
    writeFileSync(checkinsPath(root), JSON.stringify(all, null, 2) + "\n", "utf-8");
    return { lastCheckIn, prevCheckIn };
  });
}

export interface ActiveClaimEntry {
  file: string;
  task: string;
  op?: "create" | "modify" | "delete" | "claim";
}

export interface ActiveClaimGroup {
  agent: string;
  entries: ActiveClaimEntry[];
}

export interface CheckInReport {
  agent: string;
  checked_in_at: string;
  previous_check_in_at?: string;
  first_check_in: boolean;
  renewed_file_claims: string[];
  renewed_scope_claims: string[];
  active_claims: ActiveClaimGroup[];
  delta: LedgerEntry[];
  delta_text: string;
  conflicts: ConflictRecord[];
}

/** Group active file claims + scope claims across all agents, by agent. */
function gatherActiveClaims(root: string): ActiveClaimGroup[] {
  const byAgent: Record<string, ActiveClaimEntry[]> = {};

  for (const c of readClaims(root)) {
    if (isExpiredTimestamp(c.expires_at)) continue;
    (byAgent[c.agent] ||= []).push({ file: c.file, task: c.task, op: "claim" });
  }

  for (const sc of listActiveClaims(root)) {
    const files: Array<{ path: string; op: ActiveClaimEntry["op"] }> = [
      ...(sc.scope.files?.create || []).map((path) => ({ path, op: "create" as const })),
      ...(sc.scope.files?.modify || []).map((path) => ({ path, op: "modify" as const })),
      ...(sc.scope.files?.delete || []).map((path) => ({ path, op: "delete" as const })),
    ];
    for (const f of files) {
      (byAgent[sc.agent] ||= []).push({ file: f.path, task: sc.task, op: f.op });
    }
  }

  return Object.entries(byAgent)
    .map(([agent, entries]) => ({ agent, entries }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

/** The full check-in: renew my claims (heartbeat), snapshot everyone's active
 *  claims, compute the ledger delta since my last check-in, and list open
 *  conflicts involving me. Deterministic, no LLM, no inference. */
export function checkIn(root: string, agent: string): CheckInReport {
  const { lastCheckIn, prevCheckIn } = recordCheckIn(root, agent);

  // Heartbeat — renew my own active claims so they don't expire while I work.
  const myFileClaims = readClaims(root)
    .filter((c) => c.agent === agent && !isExpiredTimestamp(c.expires_at))
    .map((c) => c.file);
  const renewedFile = myFileClaims.length > 0
    ? extendClaim(root, agent, myFileClaims, DEFAULT_RENEW_DURATION).extended
    : [];
  const renewedScope = renewScopeClaims(root, agent, DEFAULT_RENEW_DURATION);

  // Delta — what happened since I last checked in. First check-in: everything
  // not by me (I already know my own work).
  const ledger = readLedger(root);
  let delta: LedgerEntry[];
  let deltaText: string;
  if (prevCheckIn) {
    delta = filterSince(ledger, prevCheckIn);
    deltaText = formatLedgerDelta(delta, { cutoff: prevCheckIn, sinceAgent: agent });
  } else {
    const needle = agent.toLowerCase();
    delta = ledger.filter((e) => e.agent.toLowerCase() !== needle);
    if (delta.length === 0) {
      deltaText = "No prior work by other agents recorded.";
    } else {
      deltaText = `(first check-in — showing all prior work by other agents)\n${formatLedgerForAgent(delta)}`;
    }
  }

  // Open conflicts involving me (case-insensitive agent match).
  const conflicts = listOpenConflicts(root).filter((r) =>
    r.agents.some((a) => a.toLowerCase() === agent.toLowerCase()),
  );

  return {
    agent,
    checked_in_at: lastCheckIn,
    previous_check_in_at: prevCheckIn,
    first_check_in: prevCheckIn === undefined,
    renewed_file_claims: renewedFile,
    renewed_scope_claims: renewedScope,
    active_claims: gatherActiveClaims(root),
    delta,
    delta_text: deltaText,
    conflicts,
  };
}

/** Human-readable check-in report. */
export function formatCheckIn(report: CheckInReport): string {
  const L: string[] = [];
  L.push(`Checked in as ${report.agent} at ${report.checked_in_at}.`);
  if (report.first_check_in) {
    L.push("(first check-in — your claims renewed and prior work shown below.)");
  }

  const renewedTotal = report.renewed_file_claims.length + report.renewed_scope_claims.length;
  if (renewedTotal > 0) {
    const parts: string[] = [];
    if (report.renewed_file_claims.length > 0) {
      const noun = report.renewed_file_claims.length === 1 ? "file claim" : "file claims";
      parts.push(`${report.renewed_file_claims.length} ${noun} (${report.renewed_file_claims.join(", ")})`);
    }
    if (report.renewed_scope_claims.length > 0) {
      const noun = report.renewed_scope_claims.length === 1 ? "scope claim" : "scope claims";
      parts.push(`${report.renewed_scope_claims.length} ${noun}`);
    }
    L.push(`Your claims renewed: ${parts.join(", ")}.`);
  } else {
    L.push("Your claims renewed: none (you have no active claims).");
  }

  L.push("");
  if (report.active_claims.length === 0) {
    L.push("Active across all agents: none.");
  } else {
    L.push("Active across all agents:");
    for (const g of report.active_claims) {
      L.push(`  ${g.agent}:`);
      for (const e of g.entries) {
        const op = e.op && e.op !== "claim" ? ` [${e.op}]` : "";
        L.push(`    ${e.file}${op} — ${e.task}`);
      }
    }
  }

  L.push("");
  L.push(report.delta_text);

  L.push("");
  if (report.conflicts.length === 0) {
    L.push("Conflicts involving you: none.");
  } else {
    const noun = report.conflicts.length === 1 ? "conflict" : "conflicts";
    L.push(`Conflicts involving you (${report.conflicts.length} ${noun}):`);
    for (const c of report.conflicts) {
      L.push(`  ${c.conflict_id} — files [${c.files.join(", ")}] between [${c.agents.join(", ")}] (open)`);
    }
  }

  return L.join("\n");
}
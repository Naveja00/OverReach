// Coordination-aware CI gate — the on-brand way to make coordination harder to
// bypass. The coordination layer inside an agent is best-effort (an agent CAN
// skip a claim_files call — the "fox guarding the henhouse" limit). Enforcement
// belongs in CI, the one place the agent can't skip. This module is the
// deterministic check the CI gate runs against the PR diff + the committed
// .overreach/ state.
//
// It reports two signals:
//   - blocked_conflicts: files in the diff that have an OPEN (unresolved)
//     conflict record. Merging a PR that touches an unresolved collision is
//     merging into a known coordination violation. Durable (conflict records
//     persist until resolved), deterministic, no inference.
//   - unclaimed: files in the diff with no active file/scope claim. Advisory by
//     default (claims expire, and a brand-new file won't be claimed until after
//     the work); the gate only fails on these when run in --strict mode.
//
// Produces a CoordCheckReport — a SEPARATE output, never a scope.* finding.

import { listOpenConflicts } from "./resolve.js";
import type { ConflictRecord } from "./resolve.js";
import { readClaims } from "./claims.js";
import { listActiveClaims } from "./scope_dsl.js";
import type { ScopeDSL } from "./scope_dsl.js";
import { isExpiredTimestamp } from "./utils.js";

export interface BlockedConflict {
  file: string;
  conflict_id: string;
  agents: string[];
}

export interface ClaimInfo {
  file: string;
  agent: string;
  kind: "file" | "scope";
  op?: "create" | "modify" | "delete" | "claim";
}

export interface CoordCheckReport {
  files_checked: string[];
  blocked_conflicts: BlockedConflict[];
  unclaimed: string[];
  claimed_by: ClaimInfo[];
  /** true when the gate should fail the PR (blocked conflicts, or unclaimed in strict mode). */
  blocked: boolean;
}

function filesInScope(scope: ScopeDSL): string[] {
  return [
    ...(scope.files?.create || []),
    ...(scope.files?.modify || []),
    ...(scope.files?.delete || []),
  ];
}

/** Build a map file -> active claim holders (file claims + scope claims). */
function activeClaimMap(root: string): Map<string, ClaimInfo[]> {
  const map = new Map<string, ClaimInfo[]>();
  for (const c of readClaims(root)) {
    if (isExpiredTimestamp(c.expires_at)) continue;
    const arr = map.get(c.file) || [];
    arr.push({ file: c.file, agent: c.agent, kind: "file", op: "claim" });
    map.set(c.file, arr);
  }
  for (const sc of listActiveClaims(root)) {
    for (const f of filesInScope(sc.scope)) {
      let op: ClaimInfo["op"] | undefined;
      if (sc.scope.files?.create?.includes(f)) op = "create";
      else if (sc.scope.files?.modify?.includes(f)) op = "modify";
      else if (sc.scope.files?.delete?.includes(f)) op = "delete";
      const arr = map.get(f) || [];
      arr.push({ file: f, agent: sc.agent, kind: "scope", op });
      map.set(f, arr);
    }
  }
  return map;
}

/** Deterministic coordination check of a PR's changed files against committed
 *  .overreach/ state. `strict` makes unclaimed files also block the gate. */
export function coordCheck(root: string, changedFiles: string[], strict = false): CoordCheckReport {
  const openConflicts = listOpenConflicts(root);
  const conflictByFile = new Map<string, ConflictRecord[]>();
  for (const c of openConflicts) {
    for (const f of c.files) {
      const arr = conflictByFile.get(f) || [];
      arr.push(c);
      conflictByFile.set(f, arr);
    }
  }

  const claims = activeClaimMap(root);

  const blocked_conflicts: BlockedConflict[] = [];
  const unclaimed: string[] = [];
  const claimed_by: ClaimInfo[] = [];

  for (const file of changedFiles) {
    const conflicts = conflictByFile.get(file);
    if (conflicts && conflicts.length > 0) {
      // One file can appear in multiple open conflicts; report the first per file
      // to keep the gate message clean. (The file is blocked either way.)
      const c = conflicts[0];
      blocked_conflicts.push({ file, conflict_id: c.conflict_id, agents: c.agents });
    }

    const holders = claims.get(file);
    if (holders && holders.length > 0) {
      claimed_by.push(...holders);
    } else {
      unclaimed.push(file);
    }
  }

  const blocked = blocked_conflicts.length > 0 || (strict && unclaimed.length > 0);
  return { files_checked: changedFiles, blocked_conflicts, unclaimed, claimed_by, blocked };
}

/** Pull destination file paths out of a unified diff (`+++ b/<path>` headers),
 *  skipping /dev/null. Pure. */
export function changedFilesFromDiff(diff: string): string[] {
  const out = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const m = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (m && m[1] !== "/dev/null") out.add(m[1]);
  }
  return [...out];
}

/** Human-readable coordination check report. */
export function formatCoordCheck(report: CoordCheckReport, strict = false): string {
  const L: string[] = [];
  L.push(`Coordination check — ${report.files_checked.length} file(s) in the diff.`);
  if (report.blocked_conflicts.length > 0) {
    L.push("");
    L.push(`Blocked — ${report.blocked_conflicts.length} file(s) with an open (unresolved) conflict:`);
    for (const b of report.blocked_conflicts) {
      L.push(`  ${b.file} — conflict ${b.conflict_id} between [${b.agents.join(", ")}]`);
    }
    L.push("  Resolve the conflict (resolve_claim) before merging.");
  }
  if (report.unclaimed.length > 0) {
    L.push("");
    const label = strict ? "Unclaimed — blocks the gate in --strict mode" : "Unclaimed — advisory (no active claim)";
    L.push(`${label}: ${report.unclaimed.length} file(s):`);
    for (const f of report.unclaimed) L.push(`  ${f}`);
  }
  if (report.claimed_by.length > 0) {
    L.push("");
    L.push(`Actively claimed: ${report.claimed_by.length} file(s):`);
    for (const c of report.claimed_by) {
      const op = c.op ? ` [${c.op}]` : "";
      L.push(`  ${c.file}${op} — ${c.agent} (${c.kind})`);
    }
  }
  if (report.blocked_conflicts.length === 0 && report.unclaimed.length === 0 && report.claimed_by.length === 0) {
    L.push("No coordination issues — no open conflicts and no claims on these files.");
  }
  L.push("");
  L.push(report.blocked ? "RESULT: BLOCKED" : "RESULT: PASS");
  return L.join("\n");
}
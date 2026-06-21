import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveExpiry, isExpiredTimestamp, isAfterCutoff, withFileLock } from "./utils.js";

export interface FileClaim {
  file: string;
  agent: string;
  task: string;
  claimed_at: string;
  expires_at: string;
}

function claimsPath(root: string): string {
  return join(root, ".overreach", "claims.json");
}

export function readClaims(root: string): FileClaim[] {
  const p = claimsPath(root);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeClaims(root: string, claims: FileClaim[]): void {
  const dir = dirname(claimsPath(root));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(claimsPath(root), JSON.stringify(claims, null, 2) + "\n", "utf-8");
}

function purgeStaleClaims(claims: FileClaim[]): FileClaim[] {
  return claims.filter(c => !isExpiredTimestamp(c.expires_at));
}

export interface ClaimResult {
  claimed: string[];
  conflicts: Array<{ file: string; held_by: string; task: string; expires_at: string }>;
}

export function claimFiles(
  root: string,
  files: string[],
  agent: string,
  task: string,
  duration?: string,
): ClaimResult {
  return withFileLock(claimsPath(root), () => {
    let claims = purgeStaleClaims(readClaims(root));
    const expiresAt = resolveExpiry(duration);
    const claimed: string[] = [];
    const conflicts: ClaimResult["conflicts"] = [];

    for (const file of files) {
      const existing = claims.find(c => c.file === file && c.agent !== agent);
      if (existing) {
        conflicts.push({
          file,
          held_by: existing.agent,
          task: existing.task,
          expires_at: existing.expires_at,
        });
      } else {
        claims = claims.filter(c => !(c.file === file && c.agent === agent));
        claims.push({ file, agent, task, claimed_at: new Date().toISOString(), expires_at: expiresAt });
        claimed.push(file);
      }
    }

    writeClaims(root, claims);
    return { claimed, conflicts };
  });
}

export function releaseClaims(root: string, agent: string, files?: string[]): number {
  return withFileLock(claimsPath(root), () => {
    let claims = purgeStaleClaims(readClaims(root));
    const before = claims.length;
    if (files) {
      claims = claims.filter(c => !(c.agent === agent && files.includes(c.file)));
    } else {
      claims = claims.filter(c => c.agent !== agent);
    }
    writeClaims(root, claims);
    return before - claims.length;
  });
}

export function extendClaim(root: string, agent: string, files: string[], duration: string): { extended: string[]; not_found: string[] } {
  return withFileLock(claimsPath(root), () => {
    let claims = purgeStaleClaims(readClaims(root));
    const newExpiry = resolveExpiry(duration);
    const extended: string[] = [];
    const not_found: string[] = [];

    for (const file of files) {
      const claim = claims.find(c => c.file === file && c.agent === agent);
      if (claim) {
        claim.expires_at = newExpiry;
        extended.push(file);
      } else {
        not_found.push(file);
      }
    }

    writeClaims(root, claims);
    return { extended, not_found };
  });
}

export interface ConflictReport {
  has_conflicts: boolean;
  conflicts: Array<{
    file: string;
    claimed_by: string;
    task: string;
    expires_at: string;
  }>;
  recent_touches: Array<{
    file: string;
    agent: string;
    task: string;
    at: string;
  }>;
}

export function checkConflicts(
  root: string,
  files: string[],
  agent: string,
  ledgerEntries?: Array<{ agent: string; task: string; files_touched: string[]; at: string }>,
): ConflictReport {
  const claims = purgeStaleClaims(readClaims(root));
  const conflicts: ConflictReport["conflicts"] = [];
  const recent_touches: ConflictReport["recent_touches"] = [];

  for (const file of files) {
    const claim = claims.find(c => c.file === file && c.agent !== agent);
    if (claim) {
      conflicts.push({
        file,
        claimed_by: claim.agent,
        task: claim.task,
        expires_at: claim.expires_at,
      });
    }
  }

  if (ledgerEntries) {
    for (const entry of ledgerEntries) {
      if (!isAfterCutoff(entry.at, 3_600_000)) continue;
      if (entry.agent === agent) continue;
      for (const file of files) {
        if (entry.files_touched.includes(file)) {
          recent_touches.push({ file, agent: entry.agent, task: entry.task, at: entry.at });
        }
      }
    }
  }

  return { has_conflicts: conflicts.length > 0 || recent_touches.length > 0, conflicts, recent_touches };
}

export function formatClaims(claims: FileClaim[]): string {
  const active = purgeStaleClaims(claims);
  if (active.length === 0) return "No active file claims.";
  const byAgent: Record<string, FileClaim[]> = {};
  for (const c of active) (byAgent[c.agent] ||= []).push(c);
  const lines: string[] = [`Active file claims (${active.length}):`];
  for (const [agent, cs] of Object.entries(byAgent)) {
    lines.push(`  ${agent}:`);
    for (const c of cs) {
      const mins = Math.round((new Date(c.expires_at).getTime() - Date.now()) / 60000);
      lines.push(`    ${c.file} (${mins}min remaining) — ${c.task}`);
    }
  }
  return lines.join("\n");
}

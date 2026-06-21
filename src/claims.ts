import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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

function isExpired(claim: FileClaim): boolean {
  return new Date(claim.expires_at) < new Date();
}

function purgeStaleClaims(claims: FileClaim[]): FileClaim[] {
  return claims.filter(c => !isExpired(c));
}

function resolveExpiry(duration?: string): string {
  const d = duration ?? "2h";
  const m = d.match(/^(\d+)(m|h|d)$/);
  if (m) {
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]!;
    return new Date(Date.now() + parseInt(m[1]) * ms).toISOString();
  }
  return d;
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
}

export function releaseClaims(root: string, agent: string, files?: string[]): number {
  let claims = purgeStaleClaims(readClaims(root));
  const before = claims.length;
  if (files) {
    claims = claims.filter(c => !(c.agent === agent && files.includes(c.file)));
  } else {
    claims = claims.filter(c => c.agent !== agent);
  }
  writeClaims(root, claims);
  return before - claims.length;
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
    const cutoff = new Date(Date.now() - 3_600_000).toISOString();
    for (const entry of ledgerEntries) {
      if (entry.at < cutoff) continue;
      if (entry.agent === agent) continue;
      for (const file of files) {
        if (entry.files_touched.includes(file)) {
          recent_touches.push({ file, agent: entry.agent, task: entry.task, at: entry.at });
        }
      }
    }
  }

  return { has_conflicts: conflicts.length > 0, conflicts, recent_touches };
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

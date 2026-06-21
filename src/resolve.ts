import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "./utils.js";

export type ResolutionStrategy = "block" | "escalate";

export interface ConflictRecord {
  conflict_id: string;
  files: string[];
  agents: string[];
  claim_ids: string[];
  detected_at: string;
  status: "open" | "resolved";
  resolution?: {
    strategy: ResolutionStrategy;
    resolved_at: string;
    resolved_by: string;
    detail: string;
  };
}

function conflictsPath(root: string): string {
  return join(root, ".overreach", "conflicts.json");
}

function readConflicts(root: string): ConflictRecord[] {
  const p = conflictsPath(root);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeConflicts(root: string, records: ConflictRecord[]): void {
  const dir = dirname(conflictsPath(root));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(conflictsPath(root), JSON.stringify(records, null, 2) + "\n", "utf-8");
}

export function recordConflict(
  root: string,
  files: string[],
  agents: string[],
  claimIds: string[],
): ConflictRecord {
  return withFileLock(conflictsPath(root), () => {
    const records = readConflicts(root);
    const record: ConflictRecord = {
      conflict_id: randomUUID(),
      files,
      agents,
      claim_ids: claimIds,
      detected_at: new Date().toISOString(),
      status: "open",
    };
    records.push(record);
    writeConflicts(root, records);
    return record;
  });
}

export interface ResolveResult {
  conflict_id: string;
  strategy: ResolutionStrategy;
  status: "resolved" | "not_found" | "already_resolved";
  detail: string;
}

export function resolveConflict(
  root: string,
  conflictId: string,
  strategy: ResolutionStrategy,
  resolvedBy: string,
): ResolveResult {
  return withFileLock(conflictsPath(root), () => {
    const records = readConflicts(root);
    const record = records.find(r => r.conflict_id === conflictId);

    if (!record) {
      return {
        conflict_id: conflictId,
        strategy,
        status: "not_found" as const,
        detail: `No conflict with ID ${conflictId}`,
      };
    }

    if (record.status === "resolved") {
      return {
        conflict_id: conflictId,
        strategy,
        status: "already_resolved" as const,
        detail: `Conflict already resolved via ${record.resolution!.strategy} by ${record.resolution!.resolved_by}`,
      };
    }

    let detail: string;
    switch (strategy) {
      case "block":
        detail = `Conflict blocked. Files [${record.files.join(", ")}] are contested between agents [${record.agents.join(", ")}]. Later agent must wait or pick different files.`;
        break;
      case "escalate":
        detail = `Conflict escalated for human review. Files [${record.files.join(", ")}] contested between [${record.agents.join(", ")}]. A human must decide which agent proceeds.`;
        break;
    }

    record.status = "resolved";
    record.resolution = {
      strategy,
      resolved_at: new Date().toISOString(),
      resolved_by: resolvedBy,
      detail,
    };

    writeConflicts(root, records);

    return {
      conflict_id: conflictId,
      strategy,
      status: "resolved" as const,
      detail,
    };
  });
}

export function listOpenConflicts(root: string): ConflictRecord[] {
  return readConflicts(root).filter(r => r.status === "open");
}

export function getConflict(root: string, conflictId: string): ConflictRecord | null {
  return readConflicts(root).find(r => r.conflict_id === conflictId) || null;
}

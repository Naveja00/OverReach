import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveExpiry, isExpiredTimestamp, withFileLock } from "./utils.js";

export interface ScopeDSL {
  files?: {
    create?: string[];
    modify?: string[];
    delete?: string[];
  };
  dependencies?: string[];
  env_vars?: string[];
  api_routes?: string[];
}

export interface ScopeClaim {
  claim_id: string;
  mode: "dsl";
  confidence: 1.0;
  agent: string;
  task: string;
  scope: ScopeDSL;
  parent_claim?: string;
  status: "proposed" | "locked" | "completed" | "rejected";
  created_at: string;
  expires_at: string;
}

export interface ClaimScopeResult {
  claim_id: string;
  status: "locked" | "rejected";
  conflicts?: Array<{ file: string; held_by: string; claim_id: string }>;
  locked_scope?: ScopeDSL;
  rejection_reason?: string;
}

function scopesDir(root: string): string {
  return join(root, ".overreach", "scopes");
}

function scopePath(root: string, claimId: string): string {
  return join(scopesDir(root), `${claimId}.json`);
}

function indexPath(root: string): string {
  return join(scopesDir(root), "index.json");
}

function readIndex(root: string): ScopeClaim[] {
  const p = indexPath(root);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeIndex(root: string, claims: ScopeClaim[]): void {
  const dir = scopesDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(indexPath(root), JSON.stringify(claims, null, 2) + "\n", "utf-8");
}

function purgeExpired(claims: ScopeClaim[]): ScopeClaim[] {
  return claims.filter(c =>
    c.status === "completed" || !isExpiredTimestamp(c.expires_at)
  );
}

function allClaimedFiles(claims: ScopeClaim[], excludeAgent?: string): Array<{ file: string; agent: string; claim_id: string }> {
  const result: Array<{ file: string; agent: string; claim_id: string }> = [];
  for (const c of claims) {
    if (c.status !== "locked" && c.status !== "proposed") continue;
    if (excludeAgent && c.agent === excludeAgent) continue;
    const files = [
      ...(c.scope.files?.create || []),
      ...(c.scope.files?.modify || []),
      ...(c.scope.files?.delete || []),
    ];
    for (const f of files) {
      result.push({ file: f, agent: c.agent, claim_id: c.claim_id });
    }
  }
  return result;
}

export function validateDSL(scope: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!scope || typeof scope !== "object") {
    return { valid: false, errors: ["scope must be an object"] };
  }
  const s = scope as Record<string, unknown>;

  if (s.files !== undefined) {
    if (typeof s.files !== "object" || s.files === null) {
      errors.push("scope.files must be an object");
    } else {
      const f = s.files as Record<string, unknown>;
      for (const key of ["create", "modify", "delete"]) {
        if (f[key] !== undefined && !Array.isArray(f[key])) {
          errors.push(`scope.files.${key} must be an array`);
        }
        if (Array.isArray(f[key]) && (f[key] as unknown[]).some(v => typeof v !== "string")) {
          errors.push(`scope.files.${key} must contain only strings`);
        }
      }
    }
  }

  for (const key of ["dependencies", "env_vars", "api_routes"]) {
    if (s[key] !== undefined) {
      if (!Array.isArray(s[key])) {
        errors.push(`scope.${key} must be an array`);
      } else if ((s[key] as unknown[]).some(v => typeof v !== "string")) {
        errors.push(`scope.${key} must contain only strings`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function claimScope(
  root: string,
  agent: string,
  task: string,
  scope: ScopeDSL,
  opts?: { duration?: string; parentClaim?: string },
): ClaimScopeResult {
  const dir = scopesDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return withFileLock(indexPath(root), () => {
    let claims = purgeExpired(readIndex(root));
    const excludeAgents = [agent];
    // If this is a child of a parent claim, don't conflict with the parent's files
    if (opts?.parentClaim) {
      const parent = claims.find(c => c.claim_id === opts.parentClaim);
      if (parent) excludeAgents.push(parent.agent);
    }
    const otherFiles = allClaimedFiles(claims).filter(
      o => !excludeAgents.includes(o.agent)
    );

    const myFiles = [
      ...(scope.files?.create || []),
      ...(scope.files?.modify || []),
      ...(scope.files?.delete || []),
    ];

    const conflicts: Array<{ file: string; held_by: string; claim_id: string }> = [];
    for (const f of myFiles) {
      const conflict = otherFiles.find(o => o.file === f);
      if (conflict) {
        conflicts.push({ file: f, held_by: conflict.agent, claim_id: conflict.claim_id });
      }
    }

    if (conflicts.length > 0) {
      return {
        claim_id: "",
        status: "rejected" as const,
        conflicts,
        rejection_reason: `File conflicts with ${[...new Set(conflicts.map(c => c.held_by))].join(", ")}`,
      };
    }

    // Validate parent narrowing if parent_claim specified
    if (opts?.parentClaim) {
      const parent = claims.find(c => c.claim_id === opts.parentClaim);
      if (parent) {
        const parentFiles = [
          ...(parent.scope.files?.create || []),
          ...(parent.scope.files?.modify || []),
          ...(parent.scope.files?.delete || []),
        ];
        const childFiles = myFiles;
        const expanding = childFiles.filter(f => !parentFiles.includes(f));
        if (expanding.length > 0) {
          return {
            claim_id: "",
            status: "rejected" as const,
            rejection_reason: `Child scope expands parent: files [${expanding.join(", ")}] not in parent claim ${opts.parentClaim}`,
          };
        }

        const parentDeps = parent.scope.dependencies || [];
        const childDeps = scope.dependencies || [];
        const expandingDeps = childDeps.filter(d => !parentDeps.includes(d));
        if (expandingDeps.length > 0) {
          return {
            claim_id: "",
            status: "rejected" as const,
            rejection_reason: `Child scope expands parent: deps [${expandingDeps.join(", ")}] not in parent claim`,
          };
        }
      }
    }

    const claim: ScopeClaim = {
      claim_id: randomUUID(),
      mode: "dsl",
      confidence: 1.0,
      agent,
      task: task.length > 200 ? task.slice(0, 200) + "..." : task,
      scope,
      status: "locked",
      created_at: new Date().toISOString(),
      expires_at: resolveExpiry(opts?.duration),
    };
    if (opts?.parentClaim) claim.parent_claim = opts.parentClaim;

    claims.push(claim);
    writeIndex(root, claims);

    // Also write the individual claim file for easy reading
    writeFileSync(scopePath(root, claim.claim_id), JSON.stringify(claim, null, 2) + "\n", "utf-8");

    return {
      claim_id: claim.claim_id,
      status: "locked" as const,
      locked_scope: scope,
    };
  });
}

export function getClaim(root: string, claimId: string): ScopeClaim | null {
  const claims = purgeExpired(readIndex(root));
  return claims.find(c => c.claim_id === claimId) || null;
}

export function completeClaim(root: string, claimId: string): boolean {
  return withFileLock(indexPath(root), () => {
    const claims = readIndex(root);
    const claim = claims.find(c => c.claim_id === claimId);
    if (!claim) return false;
    claim.status = "completed";
    writeIndex(root, claims);
    return true;
  });
}

export function dslToScope(dsl: ScopeDSL): import("./types.js").Scope {
  return {
    files_allowed: [
      ...(dsl.files?.create || []),
      ...(dsl.files?.modify || []),
      ...(dsl.files?.delete || []),
    ],
    features_allowed: [],
    endpoints_allowed: dsl.api_routes || [],
    deps_allowed: dsl.dependencies || [],
    env_allowed: dsl.env_vars || [],
    behavioral_changes_allowed: [],
  };
}

export function listActiveClaims(root: string): ScopeClaim[] {
  return purgeExpired(readIndex(root)).filter(c => c.status === "locked" || c.status === "proposed");
}

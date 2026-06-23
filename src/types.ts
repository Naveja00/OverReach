// Shared types for Overreach. The single tool is check_overreach.

import type { ExecutionContract } from "./contract/schema.js";
import type { NarrowingResult } from "./contract/narrow.js";
export type { ExecutionContract, PriorDecision, DelegationLink } from "./contract/schema.js";
export type { NarrowingResult } from "./contract/narrow.js";

// Every external-facing schema is versioned from day one (hardening item #1).
// Bump when any egress shape changes so old clients remain parseable.
export const SCHEMA_VERSION = "1.0";

export interface Scope {
  files_allowed: string[];
  features_allowed: string[];
  endpoints_allowed: string[];
  deps_allowed: string[];
  env_allowed: string[];
  behavioral_changes_allowed: string[];
}

export interface Actual {
  files_changed: string[];
  symbols_added: string[];
  imports_added: string[];
  env_vars_added: string[];
  endpoints_added: string[];
  cron_added: string[];
  new_deps: string[];
  // Runtime listeners: a server opening a port (.listen(8080)), a WebSocket/HTTP
  // server constructor, or a global-object event handler (process.on,
  // window/document.addEventListener). Same HIGH-severity runtime-surface class
  // as endpoints/cron/env — an agent can install one silently. Deterministic:
  // the call is literally in the diff.
  listeners_added: string[];
}

// Namespaced finding taxonomy (hardening item #4). `<category>.<kind>` so
// downstream telemetry / dashboards / policy rules can filter by category
// instead of grepping a flat list. Categories: scope (the diff-vs-prompt gate),
// contract (child-vs-parent narrowing), handoff (advisory LLM verifier checks).
export type FindingKind =
  | "scope.file"
  | "scope.feature"
  | "scope.dep"
  | "scope.endpoint"
  | "scope.env"
  | "scope.cron"
  | "scope.listener"
  | "contract.expansion"
  | "contract.expired"
  | "handoff.context"
  | "handoff.reasoning";

// The TRUST CONTRACT INVARIANT (see CLAUDE.md): the deterministic finding set —
// the ONLY kinds derivable from (prompt, diff) by set arithmetic. This is the
// frozen runtime source of truth. Anything that requires inference (intent,
// completeness, success) must NOT appear here; it belongs in a separate product.
// The test suite asserts this set is exactly these seven and that the compare
// layer never emits a kind outside it — so adding an inference-based kind fails
// the build unless this constant is deliberately amended with a stated
// justification. scope.listener was added (2026-06-23) as the 7th kind: a server
// opening a port / a global-object event handler is a runtime surface an agent
// can install silently, and detecting it is purely deterministic (the listen /
// process.on / addEventListener call is literally in the diff) — no inference.
export const DETERMINISTIC_FINDING_KINDS = [
  "scope.file",
  "scope.feature",
  "scope.dep",
  "scope.endpoint",
  "scope.env",
  "scope.cron",
  "scope.listener",
] as const;

export interface Finding {
  kind: FindingKind;
  detail: string;
  file: string;
  severity: "high" | "medium" | "low";
  evidence: string;
}

export type CreepScore = "LOW" | "MEDIUM" | "HIGH";

// What the reconcile pass changed relative to the section-merged scope. Per
// call this is a boolean + the item lists; the *rate* (how often reconcile
// changes things across a fleet of runs) is a fleet-level aggregate computed
// by a reporter, not a per-call number. The added/removed arrays contain SCOPE
// CONTENT (paths/names) — they are for LOCAL consumption only; the egress
// telemetry payload sends COUNTS, never these arrays (see src/sanitize.ts).
export interface ReconcileTelemetry {
  reconcileRan: boolean;
  reconcileChanged: boolean;
  added: string[]; // items reconcile recovered that map-reduce dropped
  removed: string[]; // items reconcile removed as contradictions/dupes
}

export type ScopeMode = "dsl" | "inferred";

export interface CheckResult {
  schema_version: typeof SCHEMA_VERSION;
  scope: Scope;
  actual: Actual;
  findings: Finding[];
  scope_creep_score: CreepScore;
  summary: string;
  mode: ScopeMode;
  confidence: number;
  // True when the audit was SKIPPED: Stage 1 scope extraction failed AND a real
  // provider key was configured (an outage, not an intentional no-key paranoid
  // run). In that case findings=[] and score=LOW so a CI gate does not block PRs
  // on a provider outage. A no-key run that falls back to an unreachable local
  // Ollama is NOT skipped — it stays in paranoid mode (flag everything).
  skipped?: boolean;
  deterministic?: boolean;
  telemetry?: ReconcileTelemetry;
  contract?: ExecutionContract;
  contractNarrowing?: NarrowingResult;
  claim_id?: string;
}

export interface CheckOptions {
  language?: "python" | "typescript" | "auto";
  // If provided, Stage 1 (LLM scope extraction) is SKIPPED entirely and this
  // scope is used. This is how tests run deterministically with zero API key.
  scopeOverride?: Scope;
  // Emit a versioned execution contract in the result (promotes the extracted
  // scope to a contract with audit metadata).
  emitContract?: boolean;
  // If provided, the emitted contract is treated as a child of this parent and
  // validated to only NARROW the parent's authorization (never expand).
  parentContract?: ExecutionContract;
  // Name of the agent executing this work (for the delegation chain).
  agentName?: string;
  // ISO timestamp or duration (e.g. "30m", "2h") for contract expiration.
  expiresAt?: string;
  // If provided, uses the DSL scope claim instead of LLM extraction (Stage 1
  // is skipped entirely). Deterministic, zero API cost. The claim must exist
  // and be in "locked" status.
  claimId?: string;
  // Project root for resolving DSL claims from .overreach/scopes/
  projectRoot?: string;
}
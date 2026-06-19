// Execution Contract — the versioned authorization document a downstream agent
// executes under. Promotes the extracted scope object to a contract with
// identity, context, and audit (chain of evidence) metadata.
//
// V1 is a stateless artifact: contracts are produced from a call and consumed
// by the next agent. Immutability of `context.constraints` / `project_goal` and
// append-only `prior_decisions` are DESIGN INTENTS that only become enforced
// once a registry/persistence layer exists (v2). For now the contract is a pure
// JSON artifact + a narrowing validator.

import type { Scope } from "../types.js";
import { createHash } from "node:crypto";

export interface PriorDecision {
  what: string;
  why: string;
  by: string;
  at: string; // ISO timestamp
}

export interface ExecutionContract {
  version: "1.0";
  id: string; // deterministic id (hash of prompt+diff+parent+version)
  issued_at: string; // ISO timestamp (real wall-clock; NOT part of the id)
  expires_at?: string; // optional TTL (ISO timestamp)

  // WHO
  identity: {
    root_human: string; // who originated this (placeholder for now)
    issuing_agent?: string; // which agent requested the contract
    target_agent?: string; // which agent will execute under it
  };

  // WHAT — the existing scope object, promoted to contract level
  authorization: Scope;

  // CONTEXT — project-level awareness (write-once intent on root; inherited
  // immutably by children; only prior_decisions is appendable)
  context: {
    project_goal?: string;
    constraints?: string[];
    prior_decisions?: PriorDecision[];
  };

  // AUDIT — chain of evidence. NOTE: only the prompt_hash is stored, NEVER the
  // raw prompt — the contract must not hold reversible user content.
  audit: {
    prompt_hash: string; // sha256 of the original prompt (non-reversible)
    scope_extraction_model: string;
    reconcile_changed: boolean;
    findings_at_issue: number; // findings present when the contract was issued
    parent_contract_id?: string; // if this narrows a parent contract
  };
}

// SHA-256 hex helper — strong, non-reversible. Used for any digest derived from
// user content (prompt / diff) so no fingerprint leaks structure.
function sha256(...parts: string[]): string {
  return createHash("sha256").update(parts.join("")).digest("hex");
}

// Hash a prompt to a short hex digest for tamper-evidence in the audit trail.
export function hashPrompt(prompt: string): string {
  return sha256(prompt).slice(0, 16);
}

export interface BuildContractInput {
  prompt: string;
  diff: string; // the diff the contract is being issued against (for the id)
  scope: Scope;
  model: string;
  reconcileChanged: boolean;
  findingsAtIssue: number;
  parentContractId?: string;
  identity?: Partial<ExecutionContract["identity"]>;
  context?: Partial<ExecutionContract["context"]>;
  expiresAt?: string;
}

// Deterministic contract id: same (prompt + diff + parent + version) always
// yields the same id. This makes retries idempotent (no phantom contracts in CI),
// enables caching, and lets the audit chain verify a contract was produced
// from specific inputs. issued_at stays a real timestamp so the id identifies
// the *inputs* while issued_at records *when*.
export function contractId(prompt: string, diff: string, parentContractId: string | undefined, version: string): string {
  return sha256(prompt, diff, parentContractId ?? "", version).slice(0, 32);
}

export function buildContract(input: BuildContractInput): ExecutionContract {
  return {
    version: "1.0",
    id: contractId(input.prompt, input.diff, input.parentContractId, "1.0"),
    issued_at: new Date().toISOString(),
    expires_at: input.expiresAt,
    identity: {
      root_human: input.identity?.root_human ?? "user",
      issuing_agent: input.identity?.issuing_agent,
      target_agent: input.identity?.target_agent,
    },
    authorization: input.scope,
    context: {
      project_goal: input.context?.project_goal,
      constraints: input.context?.constraints,
      prior_decisions: input.context?.prior_decisions,
    },
    audit: {
      prompt_hash: hashPrompt(input.prompt),
      scope_extraction_model: input.model,
      reconcile_changed: input.reconcileChanged,
      findings_at_issue: input.findingsAtIssue,
      parent_contract_id: input.parentContractId,
    },
  };
}
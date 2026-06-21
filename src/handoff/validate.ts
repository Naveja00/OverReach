// Agent-to-agent handoff validation. Three checks at a handoff boundary:
//
//   Check 1 — SCOPE (deterministic, the hard gate): the existing check_overreach
//             pipeline. This is the only authoritative check; HIGH severity → deny.
//   Check 2 — CONTEXT CONSISTENCY (LLM verifier, ADVISORY): does the instruction
//             make sense given the contract's project context / prior decisions?
//   Check 3 — REASONING INTEGRITY (LLM verifier, ADVISORY): does the agent's
//             stated reasoning match what it's actually asking to do?
//
// Checks 2 & 3 are LLM-verifies-LLM — acknowledged weak (the verifier is itself an
// LLM and can be wrong or manipulated). Per the design decision, they are ADVISORY
// only and are currently STUBS: they return a "not wired" verdict so the
// integration shape exists without spending cloud calls on weak signals. Wire
// them only once data shows they'd catch something the deterministic gate misses.
//
// A child contract is issued from the scope check and validated to only NARROW
// the parent (advisory when the parent is vague — see contract/narrow.ts).

import { checkOverreach } from "../tools/check_overreach.js";
import type { ExecutionContract, CheckResult } from "../types.js";

export interface AdvisoryCheck {
  ran: boolean; // false = stubbed / not wired
  pass: boolean;
  reason: string;
}

export interface HandoffDecision {
  allow: boolean;
  decision: "allow" | "flag" | "deny";
  reason: string;
}

export interface HandoffResult {
  scopeCheck: CheckResult; // the hard gate (check 1)
  contextCheck: AdvisoryCheck; // check 2 (advisory, stub)
  reasoningCheck: AdvisoryCheck; // check 3 (advisory, stub)
  narrowing: CheckResult["contractNarrowing"];
  newContract?: ExecutionContract; // issued child contract (when emitContract)
  decision: HandoffDecision;
}

export interface ValidateHandoffOptions {
  statedReasoning?: string;
  emitContract?: boolean;
  agentName?: string;
  expiresAt?: string;
}

// Check 2 — context consistency. STUB: wired shape, no LLM call yet.
async function contextConsistencyCheck(_contract: ExecutionContract, _instruction: string): Promise<AdvisoryCheck> {
  return { ran: false, pass: true, reason: "verifier not wired (advisory check stub)" };
}

// Check 3 — reasoning integrity. STUB: wired shape, no LLM call yet.
async function reasoningIntegrityCheck(_instruction: string, _reasoning: string | undefined): Promise<AdvisoryCheck> {
  if (!_reasoning) return { ran: false, pass: true, reason: "no stated reasoning provided (skipped)" };
  return { ran: false, pass: true, reason: "verifier not wired (advisory check stub)" };
}

export async function validateHandoff(
  parentContract: ExecutionContract,
  instruction: string,
  diff: string,
  options: ValidateHandoffOptions = {},
): Promise<HandoffResult> {
  // Check 1 — the deterministic hard gate. Emit a child contract and narrow it
  // against the parent.
  const scopeCheck = await checkOverreach(instruction, diff, {
    emitContract: options.emitContract ?? true,
    parentContract,
    agentName: options.agentName,
    expiresAt: options.expiresAt,
  });

  // Checks 2 & 3 — advisory, stubbed.
  const contextCheck = await contextConsistencyCheck(parentContract, instruction);
  const reasoningCheck = await reasoningIntegrityCheck(instruction, options.statedReasoning);

  // Decision: the scope gate is authoritative. HIGH severity → deny. Advisory
  // check failures → flag (log, don't block). Stubs always pass, so today the
  // decision is deny-on-HIGH else allow; the flag path is wired for when checks
  // 2 & 3 go live.
  let decision: "allow" | "flag" | "deny";
  let reason: string;
  if (scopeCheck.scope_creep_score === "HIGH") {
    decision = "deny";
    reason = `scope gate HIGH: ${scopeCheck.findings.length} finding(s) — ${scopeCheck.summary}`;
  } else if (!contextCheck.pass || !reasoningCheck.pass) {
    decision = "flag";
    reason = `advisory check flagged: ${!contextCheck.pass ? contextCheck.reason : reasoningCheck.reason}`;
  } else {
    decision = "allow";
    reason = scopeCheck.scope_creep_score === "MEDIUM"
      ? `scope gate MEDIUM (non-blocking): ${scopeCheck.summary}`
      : `scope gate LOW: clean handoff`;
  }

  return {
    scopeCheck,
    contextCheck,
    reasoningCheck,
    narrowing: scopeCheck.contractNarrowing,
    newContract: scopeCheck.contract,
    decision: { allow: decision === "allow", decision, reason },
  };
}
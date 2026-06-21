// The one public tool. Orchestrates the 3 stages:
//   1. extract scope from the prompt (LLM) — SKIPPED if scopeOverride given
//   2. parse the diff deterministically (no LLM)
//   3. diff actual vs scope -> findings + score
// Optionally emits a versioned execution contract and, when a parent contract
// is supplied, validates that the new contract only NARROWS the parent — a
// narrowing violation on a concrete parent becomes a contract.expansion finding.

import type { CheckOptions, CheckResult, Scope, Finding } from "../types.js";
import { SCHEMA_VERSION } from "../types.js";
import { parseDiff } from "../parsers/diff.js";
import { compare, summarize } from "../compare/diff_scope.js";
import { extractScope } from "../scope/extract_scope.js";
import { resolveProvider, resolveModel } from "../config.js";
import { buildContract } from "../contract/schema.js";
import { isNarrower } from "../contract/narrow.js";

function resolveExpiry(input: string): string {
  const dur = input.match(/^(\d+)(m|h|d)$/);
  if (dur) {
    const [, n, unit] = dur;
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
    return new Date(Date.now() + parseInt(n) * ms).toISOString();
  }
  return input; // assume ISO timestamp
}

export async function checkOverreach(
  prompt: string,
  diff: string,
  options: CheckOptions = {},
): Promise<CheckResult> {
  let scope: Scope;
  let warning: string | undefined;
  let telemetry = undefined;
  let skipped = false;
  let deterministic = false;

  if (options.scopeOverride) {
    scope = options.scopeOverride; // tests / demo: zero LLM, fully deterministic
  } else {
    const extracted = await extractScope(prompt);
    scope = extracted.scope;
    warning = extracted.warning;
    telemetry = extracted.telemetry;
    deterministic = !!(extracted as { deterministic?: boolean }).deterministic;
    // A real outage (key configured but extraction failed) => SKIP the audit
    // (findings=[], LOW) so a CI gate doesn't block PRs on a provider outage.
    // A no-key deterministic fallback is NOT skipped — it uses regex extraction.
    if (extracted.extractionFailed && extracted.keyConfigured) skipped = true;
  }

  const actual = parseDiff(diff);
  let { findings, score } = compare(actual, scope);
  if (skipped) {
    findings = [];
    score = "LOW";
  }
  const summary = skipped
    ? `Scope extraction failed (provider unreachable) — audit skipped, not blocked. [WARNING: ${warning || "extraction failed"}]`
    : warning
    ? `${summarize(findings, score)} [WARNING: ${warning}]`
    : summarize(findings, score);

  const result: CheckResult = {
    schema_version: SCHEMA_VERSION,
    scope,
    actual,
    findings,
    scope_creep_score: score,
    summary,
  };
  if (skipped) result.skipped = true;
  if (deterministic) result.deterministic = true;
  if (telemetry) result.telemetry = telemetry;

  // Execution contract (optional). Promotes the scope to a versioned
  // authorization artifact with audit metadata; narrows against a parent if one
  // is supplied. The contract id is deterministic (hash of prompt+diff+parent)
  // so retries produce the same contract, not phantoms. Skipped on a failed
  // extraction — a contract from an empty scope would be meaningless.
  if (options.emitContract && !skipped) {
    const model = options.scopeOverride ? "override" : resolveModel(resolveProvider());
    const contract = buildContract({
      prompt,
      diff,
      scope,
      model,
      reconcileChanged: telemetry?.reconcileChanged ?? false,
      findingsAtIssue: findings.length,
      parentContract: options.parentContract,
      agentName: options.agentName,
      expiresAt: options.expiresAt ? resolveExpiry(options.expiresAt) : undefined,
    });
    result.contract = contract;
    // Expiration check — a stale/abandoned agent should not keep committing
    // under an expired contract.
    if (options.parentContract?.expires_at) {
      const now = new Date();
      const expires = new Date(options.parentContract.expires_at);
      if (now > expires) {
        const f: Finding = {
          kind: "contract.expired",
          detail: `Parent contract ${options.parentContract.id.slice(0, 8)} expired at ${options.parentContract.expires_at}. This agent may be stale or abandoned.`,
          file: "contract",
          severity: "high",
          evidence: `expired ${Math.round((now.getTime() - expires.getTime()) / 60000)}min ago`,
        };
        findings.push(f);
        score = "HIGH";
        result.scope_creep_score = score;
      }
    }

    if (options.parentContract) {
      const narrowing = isNarrower(contract, options.parentContract);
      result.contractNarrowing = narrowing;
      if (!narrowing.advisory && narrowing.expansions.length > 0) {
        for (const exp of narrowing.expansions) {
          findings.push({
            kind: "contract.expansion",
            detail: `Child contract expands parent authorization: "${exp.item}" added to ${exp.field} (parent did not authorize it).`,
            file: "contract",
            severity: "high",
            evidence: `${exp.field}+=${exp.item}`,
          });
        }
        score = "HIGH";
        result.scope_creep_score = score;
      }
    }
  }

  return result;
}
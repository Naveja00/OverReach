// Narrowing validation — the core agent-to-agent invariant: a child contract
// derived from a parent may only NARROW authorization, never expand it.
//
// IMPORTANT CAVEAT: the invariant is only MEANINGFUL when the parent has a
// concrete authorization surface. A vague root prompt ("build a todo app")
// yields files_allowed: [] and features_allowed: ["build a todo app"]; against
// that, "child ⊆ parent" is either vacuous (any feature is ⊆ "build a todo app")
// or over-constraining (empty files must stay empty → blocks everything).
// So: when the parent has NO concrete authorizations (no files, endpoints, deps,
// or env named), narrowing is ADVISORY, not a gate. The caller decides.
//
// Matching is normalized-subset (case-insensitive, alnum-only) so "Stripe" in the
// parent covers "stripe" in the child. We intentionally do NOT fuzzy-match here —
// a parent authorizing "stripe" should not be treated as authorizing
// "stripe-webhook" or "stripe-subscriptions" (that is expansion, the very thing
// we forbid). Exact-normalized membership only.

import type { Scope } from "../types.js";
import type { ExecutionContract } from "./schema.js";

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Only gate narrowing on concrete/machine-checkable fields. Features and
// behavioral changes are semantic — "password validation" is a valid narrowing
// of "form validation" but fails string equality. Soft fields are excluded from
// narrowing to avoid false expansions on legitimate delegations.
const NARROWING_KEYS: (keyof Scope)[] = [
  "files_allowed",
  "endpoints_allowed",
  "deps_allowed",
  "env_allowed",
];

// A parent is "concrete" if it names at least one machine-checkable authorization
// (files / endpoints / deps / env). Features alone are too soft to gate on.
export function parentIsConcrete(parent: ExecutionContract): boolean {
  const a = parent.authorization;
  return a.files_allowed.length > 0 || a.endpoints_allowed.length > 0 || a.deps_allowed.length > 0 || a.env_allowed.length > 0;
}

export interface NarrowingExpansion {
  field: keyof Scope;
  item: string; // child item not covered by the parent
}

export interface NarrowingResult {
  parentContractId?: string;
  parentConcrete: boolean;
  narrow: boolean; // true iff child auth ⊆ parent auth (only meaningful when parentConcrete)
  expansions: NarrowingExpansion[]; // child authorizations the parent did not cover
  advisory: boolean; // true when the result should be treated as advisory (parent vague)
}

export function isNarrower(child: ExecutionContract, parent: ExecutionContract): NarrowingResult {
  const parentConcrete = parentIsConcrete(parent);
  const expansions: NarrowingExpansion[] = [];

  for (const key of NARROWING_KEYS) {
    const parentSet = new Set((parent.authorization[key] || []).map(norm));
    for (const item of child.authorization[key] || []) {
      if (!parentSet.has(norm(item))) {
        expansions.push({ field: key, item });
      }
    }
  }

  return {
    parentContractId: parent.id,
    parentConcrete,
    narrow: expansions.length === 0,
    expansions,
    advisory: !parentConcrete,
  };
}
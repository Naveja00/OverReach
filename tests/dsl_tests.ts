// DSL test additions - to be injected into run.ts
// This file is a build artifact, not run directly.

import { checkOverreach } from "../src/tools/check_overreach.js";

export async function runDSLTests(ok: (name: string, cond: boolean, detail?: string) => void, load: (p: string) => string, loadScope: (p: string) => any) {
  const { mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");

  // -- [23] Scope DSL: validate, claim, conflict detection --
  console.log("\n[23] Scope DSL: validate, claim, conflict detection");
  {
    const { validateDSL, claimScope, getClaim, completeClaim, listActiveClaims, dslToScope } = await import("../src/scope_dsl.js");
    const tmpRoot = join(process.cwd(), ".test-dsl-tmp");
    mkdirSync(join(tmpRoot, ".overreach"), { recursive: true });

    const v1 = validateDSL({ files: { create: ["a.ts"], modify: ["b.ts"] }, dependencies: ["stripe"] });
    ok("valid DSL passes validation", v1.valid);

    const v2 = validateDSL({ files: { create: 123 } });
    ok("invalid DSL fails validation", !v2.valid);
    ok("validation error message is specific", v2.errors[0].includes("create"));

    const v3 = validateDSL(null);
    ok("null scope fails validation", !v3.valid);

    const c1 = claimScope(tmpRoot, "claude", "Add Stripe checkout", {
      files: { create: ["checkout.tsx", "api/checkout.ts"], modify: ["nav.tsx"] },
      dependencies: ["@stripe/stripe-js"],
      env_vars: ["STRIPE_PUBLIC_KEY"],
      api_routes: ["/api/checkout-session"],
    });
    ok("claim_scope returns locked status", c1.status === "locked");
    ok("claim_scope returns a claim_id", c1.claim_id.length > 0);
    ok("claim_scope returns locked_scope", !!c1.locked_scope);

    const fetched = getClaim(tmpRoot, c1.claim_id);
    ok("getClaim returns the claim", fetched !== null);
    ok("claim has mode dsl", fetched!.mode === "dsl");
    ok("claim has confidence 1.0", fetched!.confidence === 1.0);
    ok("claim has correct agent", fetched!.agent === "claude");

    const c2 = claimScope(tmpRoot, "cursor", "Style checkout form", {
      files: { modify: ["checkout.tsx"] },
    });
    ok("conflicting claim is rejected", c2.status === "rejected");
    ok("conflict identifies the file", c2.conflicts!.some(c => c.file === "checkout.tsx"));
    ok("conflict identifies the holder", c2.conflicts!.some(c => c.held_by === "claude"));
    ok("auto-records conflict_id on rejection", typeof c2.conflict_id === "string" && c2.conflict_id.length > 0);

    // Verify the auto-recorded conflict exists and can be resolved
    const { getConflict, resolveConflict } = await import("../src/resolve.js");
    const autoConflict = getConflict(tmpRoot, c2.conflict_id!);
    ok("auto-recorded conflict is open", autoConflict!.status === "open");
    ok("auto-recorded conflict has correct files", autoConflict!.files.includes("checkout.tsx"));
    const resolved = resolveConflict(tmpRoot, c2.conflict_id!, "block", "human");
    ok("auto-recorded conflict can be resolved", resolved.status === "resolved");

    const c3 = claimScope(tmpRoot, "cursor", "Add tests", {
      files: { create: ["tests/checkout.test.ts"] },
    });
    ok("non-conflicting claim succeeds", c3.status === "locked");

    const active = listActiveClaims(tmpRoot);
    ok("listActiveClaims returns 2 active claims", active.length === 2);

    const completed = completeClaim(tmpRoot, c1.claim_id);
    ok("completeClaim returns true", completed);
    const activeAfter = listActiveClaims(tmpRoot);
    ok("completed claim no longer in active list", activeAfter.length === 1);

    // Verify ledger was auto-populated
    const { readLedger } = await import("../src/ledger.js");
    const ledger = readLedger(tmpRoot);
    ok("completeClaim auto-logs to ledger", ledger.length >= 1);
    const lastEntry = ledger[ledger.length - 1];
    ok("ledger entry has mode dsl", lastEntry.mode === "dsl");
    ok("ledger entry has confidence 1.0", lastEntry.confidence === 1.0);
    ok("ledger entry has claim_id", lastEntry.claim_id === c1.claim_id);
    ok("ledger entry has correct agent", lastEntry.agent === "claude");
    ok("ledger entry has files_touched", lastEntry.files_touched.length > 0);

    const c4 = claimScope(tmpRoot, "cursor", "Restyle checkout", {
      files: { modify: ["checkout.tsx"] },
    });
    ok("file is claimable after prior claim completed", c4.status === "locked");

    const scope = dslToScope({
      files: { create: ["a.ts"], modify: ["b.ts"], delete: ["c.ts"] },
      dependencies: ["stripe"],
      env_vars: ["KEY"],
      api_routes: ["/api/pay"],
    });
    ok("dslToScope maps files correctly", scope.files_allowed.length === 3);
    ok("dslToScope maps deps", scope.deps_allowed[0] === "stripe");
    ok("dslToScope maps env", scope.env_allowed[0] === "KEY");
    ok("dslToScope maps routes", scope.endpoints_allowed[0] === "/api/pay");

    rmSync(tmpRoot, { recursive: true });
  }

  // -- [24] Scope DSL: parent-child narrowing --
  console.log("\n[24] Scope DSL: parent-child narrowing");
  {
    const { claimScope } = await import("../src/scope_dsl.js");
    const tmpRoot = join(process.cwd(), ".test-dsl-narrow-tmp");
    mkdirSync(join(tmpRoot, ".overreach"), { recursive: true });

    const parent = claimScope(tmpRoot, "claude", "Add Stripe checkout", {
      files: { create: ["checkout.tsx", "api/checkout.ts"], modify: ["nav.tsx"] },
      dependencies: ["@stripe/stripe-js"],
    });
    ok("parent claim locked", parent.status === "locked");

    const child = claimScope(tmpRoot, "cursor", "Style checkout form", {
      files: { modify: ["checkout.tsx"] },
    }, { parentClaim: parent.claim_id });
    ok("child narrowing succeeds", child.status === "locked");

    const expanding = claimScope(tmpRoot, "codex", "Add billing", {
      files: { create: ["billing.tsx"] },
    }, { parentClaim: parent.claim_id });
    ok("child expansion rejected", expanding.status === "rejected");
    ok("rejection reason mentions expansion", expanding.rejection_reason!.includes("expands"));

    const expandingDeps = claimScope(tmpRoot, "codex", "Add redis", {
      files: { modify: ["checkout.tsx"] },
      dependencies: ["redis"],
    }, { parentClaim: parent.claim_id });
    ok("child dep expansion rejected", expandingDeps.status === "rejected");

    rmSync(tmpRoot, { recursive: true });
  }

  // -- [25] DSL fast path: check_overreach with claim_id --
  console.log("\n[25] DSL fast path: check_overreach with claim_id");
  {
    const { claimScope } = await import("../src/scope_dsl.js");
    const tmpRoot = join(process.cwd(), ".test-dsl-fast-tmp");
    mkdirSync(join(tmpRoot, ".overreach"), { recursive: true });

    const claim = claimScope(tmpRoot, "claude", "Add login form", {
      files: { modify: ["src/settings.tsx"] },
    });

    const cleanDiff = [
      "diff --git a/src/settings.tsx b/src/settings.tsx",
      "--- a/src/settings.tsx",
      "+++ b/src/settings.tsx",
      "@@ -1,3 +1,5 @@",
      "+// login form markup",
      "+const x = 1;",
    ].join("\n") + "\n";

    const r1 = await checkOverreach("add a login form", cleanDiff, {
      claimId: claim.claim_id,
      projectRoot: tmpRoot,
    });
    ok("DSL mode: mode is dsl", r1.mode === "dsl");
    ok("DSL mode: confidence is 1.0", r1.confidence === 1.0);
    ok("DSL mode: claim_id is set", r1.claim_id === claim.claim_id);
    ok("DSL mode: clean diff has 0 findings", r1.findings.length === 0);
    ok("DSL mode: score is LOW", r1.scope_creep_score === "LOW");

    const creepDiff = [
      "diff --git a/src/settings.tsx b/src/settings.tsx",
      "--- a/src/settings.tsx",
      "+++ b/src/settings.tsx",
      "@@ -1,3 +1,5 @@",
      "+import React from 'react';",
      "+",
      "diff --git a/src/billing.tsx b/src/billing.tsx",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/billing.tsx",
      "@@ -0,0 +1,5 @@",
      "+import Stripe from 'stripe';",
      "+const stripe = new Stripe(process.env.STRIPE_KEY);",
      "+export async function charge() {}",
    ].join("\n") + "\n";

    const r2 = await checkOverreach("add a login form", creepDiff, {
      claimId: claim.claim_id,
      projectRoot: tmpRoot,
    });
    ok("DSL mode: creep diff detects out-of-scope file", r2.findings.some(f => f.kind === "scope.file"));
    ok("DSL mode: creep diff detects unauthorized env var", r2.findings.some(f => f.kind === "scope.env"));
    ok("DSL mode: creep diff score is HIGH", r2.scope_creep_score === "HIGH");
    ok("DSL mode: still mode dsl even with findings", r2.mode === "dsl");

    const r3 = await checkOverreach(
      "add a login form to settings",
      cleanDiff,
      { claimId: "non-existent-id", projectRoot: tmpRoot }
    );
    ok("missing claim falls back to inferred mode", r3.mode === "inferred");

    rmSync(tmpRoot, { recursive: true });
  }

  // -- [26] Resolution system: record + resolve conflicts --
  console.log("\n[26] Resolution system: record + resolve conflicts");
  {
    const { recordConflict, resolveConflict, listOpenConflicts, getConflict } = await import("../src/resolve.js");
    const tmpRoot = join(process.cwd(), ".test-resolve-tmp");
    mkdirSync(join(tmpRoot, ".overreach"), { recursive: true });

    const conflict = recordConflict(tmpRoot, ["src/auth.ts"], ["claude", "cursor"], ["claim-1", "claim-2"]);
    ok("conflict recorded with ID", conflict.conflict_id.length > 0);
    ok("conflict status is open", conflict.status === "open");

    const open = listOpenConflicts(tmpRoot);
    ok("1 open conflict", open.length === 1);

    const r1 = resolveConflict(tmpRoot, conflict.conflict_id, "block", "claude");
    ok("resolve returns resolved status", r1.status === "resolved");
    ok("resolve strategy is block", r1.strategy === "block");
    ok("resolve detail mentions the file", r1.detail.includes("src/auth.ts"));

    const openAfter = listOpenConflicts(tmpRoot);
    ok("0 open conflicts after resolution", openAfter.length === 0);

    const r2 = resolveConflict(tmpRoot, conflict.conflict_id, "escalate", "human");
    ok("double-resolve returns already_resolved", r2.status === "already_resolved");

    const r3 = resolveConflict(tmpRoot, "fake-id", "block", "anyone");
    ok("unknown conflict returns not_found", r3.status === "not_found");

    const c2 = recordConflict(tmpRoot, ["src/db.ts"], ["codex", "cursor"], ["claim-3", "claim-4"]);
    const r4 = resolveConflict(tmpRoot, c2.conflict_id, "escalate", "human");
    ok("escalate strategy works", r4.strategy === "escalate");
    ok("escalate detail mentions human review", r4.detail.includes("human review"));

    const fetched = getConflict(tmpRoot, c2.conflict_id);
    ok("getConflict returns resolved conflict", fetched!.status === "resolved");
    ok("resolution has resolved_by", fetched!.resolution!.resolved_by === "human");

    rmSync(tmpRoot, { recursive: true });
  }

  // -- [27] mode/confidence on existing inferred results --
  console.log("\n[27] mode/confidence on existing inferred results");
  {
    const r = await checkOverreach(
      "add a login form to the settings page",
      load("tests/fixtures/login_form_stripe.diff"),
      { scopeOverride: loadScope("tests/fixtures/login_form_stripe.scope.json") }
    );
    ok("inferred result has mode inferred", r.mode === "inferred");
    ok("inferred result has confidence < 1.0", r.confidence < 1.0);
  }
}

// Coordination-aware CI gate tests. Pure, zero-key, deterministic.
// Wired into run.ts via runCoordCheckTests(ok). Exercises src/coord_check.ts
// (changedFilesFromDiff, coordCheck, formatCoordCheck) — the on-brand way to
// make coordination harder to bypass: enforcement in CI, not in the agent.

import { coordCheck, changedFilesFromDiff, formatCoordCheck } from "../src/coord_check.js";
import { recordConflict, resolveConflict } from "../src/resolve.js";
import { claimFiles } from "../src/claims.js";

export async function runCoordCheckTests(ok: (name: string, cond: boolean, detail?: string) => void) {
  const { mkdirSync, rmSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const freshRoot = (name: string): string => {
    const root = join(process.cwd(), name);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, ".overreach"), { recursive: true });
    return root;
  };

  console.log("\n[41] Coordination-aware CI gate (coord-check)");

  // ── changedFilesFromDiff ─────────────────────────────────────────────────
  {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 0000000..1111111",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "+new code",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+brand new",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
    ].join("\n");
    const files = changedFilesFromDiff(diff);
    ok("changedFilesFromDiff captures destination files", files.includes("src/a.ts") && files.includes("src/new.ts"));
    ok("changedFilesFromDiff skips /dev/null destinations", !files.includes("/dev/null"));
    ok("changedFilesFromDiff does not capture a deleted file's destination (it's /dev/null)", !files.includes("src/gone.ts"));
    ok("changedFilesFromDiff dedups", files.length === 2);
  }

  // ── coordCheck: blocked conflicts + claimed + unclaimed ─────────────────
  {
    const root = freshRoot(".test-coord-a");
    recordConflict(root, ["src/shared.ts"], ["claude", "cursor"], ["c1", "c2"]);
    claimFiles(root, ["src/auth.ts"], "claude", "add login");

    const report = coordCheck(root, ["src/shared.ts", "src/auth.ts", "src/new.ts"], false);
    ok("blocked_conflicts lists the conflicted file",
       report.blocked_conflicts.length === 1 && report.blocked_conflicts[0].file === "src/shared.ts");
    ok("blocked_conflict carries agents", report.blocked_conflicts[0].agents.includes("claude") && report.blocked_conflicts[0].agents.includes("cursor"));
    ok("claimed_by lists the actively-claimed file",
       report.claimed_by.some((c) => c.file === "src/auth.ts" && c.agent === "claude" && c.kind === "file"));
    ok("unclaimed lists files with no active claim (incl. the conflicted-but-unclaimed file)",
       report.unclaimed.length === 2 && report.unclaimed.includes("src/new.ts") && report.unclaimed.includes("src/shared.ts"));
    ok("blocked is true when an open conflict is touched", report.blocked === true);
    ok("formatCoordCheck reports BLOCKED", formatCoordCheck(report, false).includes("BLOCKED"));
    ok("formatCoordCheck names the conflicted file", formatCoordCheck(report, false).includes("src/shared.ts"));

    rmSync(root, { recursive: true, force: true });
  }

  // ── coordCheck: unclaimed is advisory unless strict ──────────────────────
  {
    const root = freshRoot(".test-coord-b");

    const advisory = coordCheck(root, ["src/new.ts"], false);
    ok("unclaimed-only does NOT block in non-strict mode", advisory.blocked === false && advisory.unclaimed.length === 1);
    ok("formatCoordCheck reports PASS when advisory-only", formatCoordCheck(advisory, false).includes("PASS"));

    const strict = coordCheck(root, ["src/new.ts"], true);
    ok("unclaimed DOES block in strict mode", strict.blocked === true);
    ok("formatCoordCheck reports BLOCKED in strict mode", formatCoordCheck(strict, true).includes("BLOCKED"));

    rmSync(root, { recursive: true, force: true });
  }

  // ── coordCheck: a claimed-only diff passes ──────────────────────────────
  {
    const root = freshRoot(".test-coord-c");
    claimFiles(root, ["src/db.ts"], "cursor", "migrate db");
    const report = coordCheck(root, ["src/db.ts"], false);
    ok("claimed file, no conflict -> not blocked", report.blocked === false);
    ok("claimed file -> not unclaimed", report.unclaimed.length === 0);
    ok("claimed file -> recorded in claimed_by", report.claimed_by.some((c) => c.file === "src/db.ts"));

    rmSync(root, { recursive: true, force: true });
  }

  // ── coordCheck: a resolved conflict no longer blocks ─────────────────────
  {
    const root = freshRoot(".test-coord-d");
    const c = recordConflict(root, ["src/legacy.ts"], ["claude", "codex"], ["c1", "c2"]);
    ok("open conflict initially blocks", coordCheck(root, ["src/legacy.ts"], false).blocked === true);

    resolveConflict(root, c.conflict_id, "block", "human");
    const after = coordCheck(root, ["src/legacy.ts"], false);
    ok("resolved conflict no longer blocks", after.blocked === false);
    ok("resolved conflict no longer in blocked_conflicts", after.blocked_conflicts.length === 0);

    rmSync(root, { recursive: true, force: true });
  }

  // ── coordCheck: empty file list ──────────────────────────────────────────
  {
    const root = freshRoot(".test-coord-e");
    const report = coordCheck(root, [], true);
    ok("empty diff -> nothing blocked", report.blocked === false && report.blocked_conflicts.length === 0 && report.unclaimed.length === 0);
    ok("formatCoordCheck on empty diff notes no issues", formatCoordCheck(report, true).includes("No coordination issues"));

    rmSync(root, { recursive: true, force: true });
  }

  ok("no leftover temp dir .test-coord-a", !existsSync(join(process.cwd(), ".test-coord-a")));
}
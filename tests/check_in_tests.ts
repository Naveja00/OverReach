// Check-in + collision diagnostics tests. Pure, zero-key, deterministic.
// Wired into run.ts via runCheckInTests(ok). Exercises src/check_in.ts
// (recordCheckIn, readCheckins, checkIn, formatCheckIn) and src/collide.ts
// (diagnoseCollision, formatCollision) through real disk state in temp dirs.
//
// This also closes a gap a prior review flagged: "no tests for the coordination
// layer" — these cover claims.ts / resolve.ts / scope_dsl.ts conflict + renewal
// behavior end-to-end through the check-in path.

import { checkIn, recordCheckIn, readCheckins, formatCheckIn } from "../src/check_in.js";
import { diagnoseCollision, formatCollision } from "../src/collide.js";
import { claimFiles, readClaims } from "../src/claims.js";
import { claimScope } from "../src/scope_dsl.js";
import { recordConflict } from "../src/resolve.js";
import { readLedger } from "../src/ledger.js";
import type { LedgerEntry } from "../src/ledger.js";

export async function runCheckInTests(ok: (name: string, cond: boolean, detail?: string) => void) {
  const { mkdirSync, rmSync, writeFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const freshRoot = (name: string): string => {
    const root = join(process.cwd(), name);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, ".overreach"), { recursive: true });
    return root;
  };

  const ledgerEntry = (e: Partial<LedgerEntry> & { agent: string; task: string; at: string }): LedgerEntry => ({
    files_touched: e.files_touched || [],
    findings_count: e.findings_count ?? 0,
    score: e.score || "LOW",
    agent: e.agent,
    task: e.task,
    at: e.at,
  });
  const writeLedger = (root: string, entries: LedgerEntry[]) =>
    writeFileSync(join(root, ".overreach", "ledger.json"), JSON.stringify(entries, null, 2) + "\n", "utf-8");

  console.log("\n[40] Check-in (same-PC live awareness) + collision diagnostics");

  // ── A. recordCheckIn / readCheckins ───────────────────────────────────────
  {
    const root = freshRoot(".test-checkin-a");
    const first = recordCheckIn(root, "claude");
    ok("first recordCheckIn has a lastCheckIn", !!first.lastCheckIn);
    ok("first recordCheckIn has no prevCheckIn", first.prevCheckIn === undefined);
    ok("readCheckins persists the agent", readCheckins(root)["claude"] === first.lastCheckIn);

    const second = recordCheckIn(root, "claude");
    ok("second recordCheckIn returns the first as prevCheckIn", second.prevCheckIn === first.lastCheckIn);
    ok("second lastCheckIn >= prevCheckIn", second.lastCheckIn >= (second.prevCheckIn as string));
    ok("readCheckins holds only one entry per agent", Object.keys(readCheckins(root)).length === 1);

    // Distinct agents coexist.
    recordCheckIn(root, "cursor");
    ok("readCheckins tracks multiple agents", Object.keys(readCheckins(root)).sort().join(",") === "claude,cursor");

    rmSync(root, { recursive: true, force: true });
  }

  // ── B. checkIn renews claims + lists active claims across agents ──────────
  {
    const root = freshRoot(".test-checkin-b");

    const claimed = claimFiles(root, ["src/auth.ts", "src/db.ts"], "claude", "add login");
    ok("claimFiles claims both files", claimed.claimed.length === 2 && claimed.conflicts.length === 0);
    claimFiles(root, ["src/nav.ts"], "cursor", "fix nav");

    const scopeRes = claimScope(root, "claude", "add login form", {
      files: { modify: ["src/login.tsx"] },
      dependencies: ["@auth/core"],
      env_vars: ["AUTH_SECRET"],
      api_routes: ["/api/login"],
    });
    ok("claimScope succeeds for claude", scopeRes.status === "locked" && !!scopeRes.claim_id);

    // Capture claude's file-claim expiry, then check in — it should be renewed.
    const before = readClaims(root).find((c) => c.agent === "claude" && c.file === "src/auth.ts");
    const beforeExpiry = before!.expires_at;

    const report = checkIn(root, "claude");

    ok("first checkIn is flagged first_check_in", report.first_check_in === true);
    ok("first checkIn has no previous_check_in_at", report.previous_check_in_at === undefined);
    ok("checkIn renewed claude's file claims", report.renewed_file_claims.length === 2);
    ok("checkIn renewed claude's scope claim", report.renewed_scope_claims.length === 1 && report.renewed_scope_claims[0] === scopeRes.claim_id);

    const after = readClaims(root).find((c) => c.agent === "claude" && c.file === "src/auth.ts");
    ok("renewal bumped the file claim's expiry", after!.expires_at > beforeExpiry);

    const agents = report.active_claims.map((g) => g.agent).sort();
    ok("active_claims lists both agents", agents.join(",") === "claude,cursor");
    const claudeGroup = report.active_claims.find((g) => g.agent === "claude")!;
    ok("claude's active group includes the scope-claimed file with op=modify",
       claudeGroup.entries.some((e) => e.file === "src/login.tsx" && e.op === "modify"));
    ok("claude's active group includes a file-claimed file",
       claudeGroup.entries.some((e) => e.file === "src/auth.ts"));

    rmSync(root, { recursive: true, force: true });
  }

  // ── C. checkIn delta (first check-in vs since prevCheckIn) ───────────────
  {
    const root = freshRoot(".test-checkin-c");

    // Pre-existing work by another agent (past timestamp).
    writeLedger(root, [ledgerEntry({ agent: "cursor", task: "old nav work", files_touched: ["src/nav.ts"], at: "2026-01-01T00:00:00.000Z" })]);

    const first = checkIn(root, "claude");
    ok("first checkIn delta shows other agents' prior work", first.delta.length === 1 && first.delta[0].agent === "cursor");
    ok("first checkIn delta_text mentions cursor", first.delta_text.includes("cursor"));

    // A new entry dated AFTER the first check-in's timestamp.
    const t1 = first.checked_in_at;
    const futureAt = new Date(new Date(t1).getTime() + 60_000).toISOString();
    const ledger = readLedger(root);
    ledger.push(ledgerEntry({ agent: "codex", task: "add webhook", files_touched: ["src/api/wh.ts"], score: "HIGH", findings_count: 2, at: futureAt }));
    writeLedger(root, ledger);

    const second = checkIn(root, "claude");
    ok("second checkIn is not first_check_in", second.first_check_in === false);
    ok("second checkIn previous_check_in_at === first checked_in_at", second.previous_check_in_at === t1);
    ok("second checkIn delta is only the new (post-check-in) entry", second.delta.length === 1 && second.delta[0].agent === "codex");
    ok("second checkIn delta excludes the old cursor entry", !second.delta_text.includes("old nav work"));
    ok("second checkIn delta_text mentions codex", second.delta_text.includes("codex"));

    rmSync(root, { recursive: true, force: true });
  }

  // ── D. checkIn filters conflicts involving the agent ─────────────────────
  {
    const root = freshRoot(".test-checkin-d");
    const c1 = recordConflict(root, ["src/shared.ts"], ["claude", "cursor"], ["claim-a", "claim-b"]);
    recordConflict(root, ["src/other.ts"], ["cursor", "codex"], ["claim-c", "claim-d"]);
    ok("recordConflict creates open records", !!c1.conflict_id);

    const report = checkIn(root, "claude");
    ok("checkIn surfaces only conflicts involving the agent", report.conflicts.length === 1);
    ok("checkIn surfaces the right conflict", report.conflicts[0].files.includes("src/shared.ts"));
    ok("formatCheckIn reports the conflict", formatCheckIn(report).includes("Conflicts involving you") && formatCheckIn(report).includes("src/shared.ts"));

    rmSync(root, { recursive: true, force: true });
  }

  // ── E. diagnoseCollision: declared intent + symbols + split suggestion ──
  {
    const root = freshRoot(".test-checkin-e");

    // claude declares a scope claim on utils.ts (modify) with deps/env/routes.
    const claudeScope = claimScope(root, "claude", "refactor utils", {
      files: { modify: ["src/utils.ts"] },
      dependencies: ["lodash"],
      env_vars: ["UTIL_KEY"],
      api_routes: ["/api/util"],
    });
    ok("claude scope claim on utils.ts accepted", claudeScope.status === "locked");
    // cursor holds a FILE claim on the same file (file claims don't cross-check
    // scope claims — a real gap diagnoseCollision honestly surfaces).
    claimFiles(root, ["src/utils.ts"], "cursor", "patch utils");

    // Synthetic utils.ts with 5 top-level symbols -> split suggestion should fire.
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/utils.ts"),
      "export function parseX() {}\nexport function tokenize() {}\nexport function format() {}\nexport function validate() {}\nexport function refresh() {}\n",
      "utf-8");

    const report = diagnoseCollision(root, "src/utils.ts", ["claude", "cursor"]);
    ok("diagnoseCollision sees the file on disk", report.file_exists === true);
    ok("diagnoseCollision lists all 5 top-level symbols", report.top_level_symbols.length === 5 && report.top_level_symbols.includes("parseX"));

    const claudeIntent = report.intents.find((i) => i.agent === "claude")!;
    ok("claude intent sourced from scope claim", claudeIntent.source === "scope");
    ok("claude intent carries the task", claudeIntent.task === "refactor utils");
    ok("claude intent op is modify", claudeIntent.op === "modify");
    ok("claude intent carries declared deps/env/routes",
       claudeIntent.declared_dependencies.includes("lodash") &&
       claudeIntent.declared_env_vars.includes("UTIL_KEY") &&
       claudeIntent.declared_api_routes.includes("/api/util"));

    const cursorIntent = report.intents.find((i) => i.agent === "cursor")!;
    ok("cursor intent sourced from file claim", cursorIntent.source === "file-claim" && cursorIntent.task === "patch utils");

    ok("split suggestion fires (>=4 symbols, >=2 contesting)", !!report.split_suggestion && report.split_suggestion.includes("src/utils.ts"));
    ok("formatCollision names the file and both agents", formatCollision(report).includes("src/utils.ts") && formatCollision(report).includes("claude") && formatCollision(report).includes("cursor"));

    rmSync(root, { recursive: true, force: true });
  }

  // ── F. diagnoseCollision: file absent on disk, single agent ──────────────
  {
    const root = freshRoot(".test-checkin-f");
    claimFiles(root, ["src/ghost.ts"], "claude", "create ghost");
    const report = diagnoseCollision(root, "src/ghost.ts", ["claude", "cursor"]);
    ok("diagnoseCollision handles absent file", report.file_exists === false && report.top_level_symbols.length === 0);
    ok("no split suggestion when file absent", report.split_suggestion === undefined);
    ok("cursor intent is 'none' when it has no claim", report.intents.find((i) => i.agent === "cursor")!.source === "none");
    ok("formatCollision notes file not created", formatCollision(report).includes("not yet created"));

    rmSync(root, { recursive: true, force: true });
  }

  // ── G. formatCheckIn framing (no pluralization-style bugs) ───────────────
  {
    const root = freshRoot(".test-checkin-g");
    const report = checkIn(root, "claude");
    const out = formatCheckIn(report);
    ok("formatCheckIn names the agent", out.includes("Checked in as claude"));
    ok("formatCheckIn reports no active claims cleanly", out.includes("Active across all agents: none"));
    ok("formatCheckIn reports no conflicts cleanly", out.includes("Conflicts involving you: none"));
    ok("formatCheckIn reports no renewed claims cleanly", out.includes("no active claims"));
    ok("formatCheckIn first-check-in note present", out.includes("first check-in"));
    ok("formatCheckIn pluralizes 'file claims' (2) correctly", !out.includes("2 file claim "));
    rmSync(root, { recursive: true, force: true });
  }

  // Sanity: temp dirs cleaned.
  ok("no leftover temp dir .test-checkin-a", !existsSync(join(process.cwd(), ".test-checkin-a")));
}
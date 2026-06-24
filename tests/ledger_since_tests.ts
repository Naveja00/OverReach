// Ledger --since / --since-agent delta-filter tests. Pure, zero-key, deterministic.
// Wired into run.ts via runLedgerSinceTests(ok). Exercises the pure functions in
// src/ledger.ts (lastSeenAt, filterSince, resolveSinceCutoff, formatLedgerDelta)
// plus one tiny on-disk round-trip through appendLedger/readLedger.

import { appendLedger, readLedger, lastSeenAt, filterSince, resolveSinceCutoff, formatLedgerDelta } from "../src/ledger.js";
import type { LedgerEntry } from "../src/ledger.js";

export async function runLedgerSinceTests(ok: (name: string, cond: boolean, detail?: string) => void) {
  const { mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");

  console.log("\n[39] Ledger --since / --since-agent catch-up delta filter");
  {
    // appendLedger stamps `at = now`, so the public API can't produce past
    // timestamps. Test the pure functions on a synthetic ledger with explicit
    // `at` values (canonical ISO-8601 UTC, matching what appendLedger writes).
    const ledger: LedgerEntry[] = [
      { agent: "claude", task: "old task",      files_touched: ["a.ts"], findings_count: 0, score: "LOW",    at: "2026-06-23T10:00:00.000Z" },
      { agent: "cursor", task: "mid task",      files_touched: ["b.ts"], findings_count: 1, score: "MEDIUM", at: "2026-06-23T12:00:00.000Z" },
      { agent: "claude", task: "claude last",   files_touched: ["c.ts"], findings_count: 0, score: "LOW",    at: "2026-06-23T14:00:00.000Z" },
      { agent: "codex",  task: "after claude",  files_touched: ["d.ts"], findings_count: 2, score: "HIGH",   at: "2026-06-23T16:00:00.000Z" },
    ];

    // ── lastSeenAt ───────────────────────────────────────────────────────
    ok("lastSeenAt finds an agent's latest entry", lastSeenAt(ledger, "claude") === "2026-06-23T14:00:00.000Z");
    ok("lastSeenAt is case-insensitive", lastSeenAt(ledger, "CLAUDE") === "2026-06-23T14:00:00.000Z");
    ok("lastSeenAt returns undefined for an unknown agent", lastSeenAt(ledger, "ghost") === undefined);

    // ── filterSince ──────────────────────────────────────────────────────
    const mid = filterSince(ledger, "2026-06-23T13:00:00.000Z");
    ok("filterSince returns only entries strictly after the cutoff", mid.length === 2 && mid.every((e) => e.at > "2026-06-23T13:00:00.000Z"));
    ok("filterSince with a future cutoff is empty", filterSince(ledger, "2030-01-01T00:00:00.000Z").length === 0);
    ok("filterSince with a past cutoff returns everything", filterSince(ledger, "2020-01-01T00:00:00.000Z").length === ledger.length);
    ok("filterSince is exclusive at the cutoff boundary", filterSince(ledger, "2026-06-23T14:00:00.000Z").length === 1 && filterSince(ledger, "2026-06-23T14:00:00.000Z")[0].agent === "codex");

    // ── resolveSinceCutoff: --since-agent ────────────────────────────────
    const r1 = resolveSinceCutoff({ sinceAgent: "claude" }, ledger);
    ok("resolveSinceCutoff(--since-agent claude) cutoff = claude's lastSeenAt", r1.cutoff === "2026-06-23T14:00:00.000Z", `got ${r1.cutoff}`);
    ok("--since-agent claude yields only the work after claude's last entry",
       r1.cutoff !== undefined && filterSince(ledger, r1.cutoff).length === 1 && filterSince(ledger, r1.cutoff)[0].agent === "codex");

    const r2 = resolveSinceCutoff({ sinceAgent: "ghost" }, ledger);
    ok("unknown --since-agent -> cutoff undefined (nothing to filter on)", r2.cutoff === undefined);
    ok("unknown --since-agent -> note mentions the agent", !!r2.note && r2.note.includes("ghost"));

    // ── resolveSinceCutoff: --since ──────────────────────────────────────
    const r3 = resolveSinceCutoff({ since: "2026-06-23T13:00:00Z" }, ledger);
    ok("--since parses and normalizes to canonical ISO", r3.cutoff === "2026-06-23T13:00:00.000Z", `got ${r3.cutoff}`);

    const r4 = resolveSinceCutoff({ since: "not-a-date" }, ledger);
    ok("unparseable --since -> invalidSince set", !!r4.invalidSince && r4.invalidSince === "not-a-date");

    // ── resolveSinceCutoff: combined (latest wins) ───────────────────────
    const r5 = resolveSinceCutoff({ since: "2026-06-23T11:00:00Z", sinceAgent: "claude" }, ledger);
    ok("combined --since + --since-agent takes the later cutoff", r5.cutoff === "2026-06-23T14:00:00.000Z", `got ${r5.cutoff}`);

    // ── formatLedgerDelta framing ────────────────────────────────────────
    const delta = r1.cutoff ? filterSince(ledger, r1.cutoff) : [];
    const out = formatLedgerDelta(delta, { cutoff: r1.cutoff as string, sinceAgent: "claude" });
    ok("formatLedgerDelta names the agent and the cutoff", out.includes("claude") && out.includes("14:00:00"));
    ok("formatLedgerDelta reports the new-entry count (singular)", out.includes("1 new entry"));
    ok("formatLedgerDelta lists the new work", out.includes("codex") && out.includes("after claude"));
    const plural = formatLedgerDelta(filterSince(ledger, "2026-06-23T09:00:00.000Z"), { cutoff: "2026-06-23T09:00:00.000Z" });
    ok("formatLedgerDelta pluralizes correctly (no 'entryies')", plural.includes("4 new entries") && !plural.includes("entryies"));
    const emptyOut = formatLedgerDelta([], { cutoff: "2030-01-01T00:00:00.000Z", sinceAgent: "claude" });
    ok("formatLedgerDelta with no new work -> 'No work recorded'", emptyOut.startsWith("No work recorded"));

    // ── on-disk round-trip through appendLedger/readLedger ───────────────
    const tmpRoot = join(process.cwd(), ".test-ledger-since-tmp");
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(join(tmpRoot, ".overreach"), { recursive: true });

    const fake = (files: string[], summary: string): any => ({
      schema_version: "1.0",
      scope: { files_allowed: [], features_allowed: [], endpoints_allowed: [], deps_allowed: [], env_allowed: [], behavioral_changes_allowed: [] },
      actual: { files_changed: files, symbols_added: [], imports_added: [], env_vars_added: [], endpoints_added: [], cron_added: [], new_deps: [] },
      findings: [], scope_creep_score: "LOW", summary,
    });

    appendLedger(tmpRoot, fake(["x.ts"], "first"), "agent-a", "first");
    const disk = readLedger(tmpRoot);
    ok("disk ledger has the appended entry", disk.length === 1 && disk[0].agent === "agent-a");
    ok("lastSeenAt works on a real disk ledger", lastSeenAt(disk, "agent-a") === disk[0].at);
    const r6 = resolveSinceCutoff({ sinceAgent: "agent-a" }, disk);
    ok("disk: --since-agent agent-a yields no newer entries", r6.cutoff !== undefined && filterSince(disk, r6.cutoff).length === 0);
    ok("disk: --since-agent unknown agent falls back with a note", resolveSinceCutoff({ sinceAgent: "agent-b" }, disk).cutoff === undefined);

    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
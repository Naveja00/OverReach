# Overreach — internals

Implementation detail for contributors and the curious. The README is the
product surface; this is the engine room. (If Overreach ever moves to a paid
tier, this file is the natural thing to gate or pull — the README stands alone
without it.)

## The 3-stage pipeline

### Stage 1 — Scope extraction (LLM)
Reads your prompt → structured JSON of what you actually asked for. Deciphers
typos but **never invents scope**. Only stage that calls a model. **Skipped
entirely in DSL mode** and when no API key is set (falls back to deterministic
regex scope extraction — instant, free, offline).

### Stage 2 — Diff parsing (deterministic)
Regex-parses the diff into what it actually adds — imports, deps, env vars,
routes, cron jobs, listeners, symbols, IaC resources. Milliseconds. No LLM.
Handles Python, TS/JS, Go, Rust, Ruby, Terraform, k8s YAML, SQL DDL,
CloudFormation. Skips comments, detects renames (declaration-shape matching),
distinguishes route-file additions from edits, and gates `.listen()` calls
against a receiver allowlist so EventEmitter/stream false positives don't fire.

### Stage 3 — Comparison (deterministic)
Set arithmetic: `actual − authorized = findings`. Three matching strategies:
exact, fuzzy (LCS substring), and typo-tolerant (Damerau-Levenshtein with a
common-word guard). Stages 2 and 3 are pure functions — no inference, no opinion,
fully auditable.

## Typo-tolerant authorization (deterministic)

A misspelled prompt (`"setings page"`, `"logn form"`) must not produce a *false
positive* — flagging in-scope work as creep — just because Stage 1 left the typo
uncorrected. Stage 3 authorizes typo-tolerantly: a scope token matches an actual
identifier when they're equal, a substring, or within a 1–2 char
Damerau-Levenshtein (OSA) edit, gated by a common-word guard so real words never
collide (`auth` won't match `auto`, `form` won't match `from`). This is
deterministic (edit distance is a pure function of two strings) — the engine
matches the typo to the real identifier regardless of whether the model corrected
it. A wrong *scope* never yields a hallucinated *finding*.

- Short tokens: OSA ≤ 1. Tokens ≥ 7 chars: OSA ≤ 2.
- A ~200-word common-word set blocks edits between real words.
- Proven zero-cloud in the [T24] taxonomy suite.

## Finding kinds (frozen)

| Kind | Caught when the diff adds... | Severity |
|---|---|---|
| `scope.dep` | a package/requirement the prompt didn't name (npm, pip, go.mod, Cargo, Gemfile, composer) | medium |
| `scope.env` | an env var (`process.env.X`, `os.environ`, `.env`) | high |
| `scope.endpoint` | an HTTP route / handler / `route.ts` file | high |
| `scope.cron` | a cron / scheduler job / `setInterval` | high |
| `scope.listener` | a runtime listener — `app.listen`, `WebSocket.Server`, `process.on`, global `addEventListener` | high |
| `scope.file` | edits to a file the prompt didn't touch on | medium (high outside any implied dir) |
| `scope.feature` | a new top-level symbol/feature beyond the prompt — incl. IaC resources (terraform `resource`, k8s `kind:`, CloudFormation) and SQL `CREATE/ALTER TABLE` | low/medium |

Overall `scope_creep_score`: `HIGH` if any high finding, `MEDIUM` if any medium,
else `LOW`. The kind set is frozen in `src/types.ts` with a test gate; the
CLAUDE.md trust contract forbids mixing probabilistic findings into this list.

## The trust contract (the product's reason to exist)

Every finding is derivable from (prompt, diff) by deterministic set arithmetic.
No finding depends on inference, opinion, or "what done looks like." This is
what separates Overreach from probabilistic AI reviewers. Findings of different
trust levels never share one output list — mixing them collapses the whole list
to the lowest trust level present.

Coordination outputs (`CheckInReport`, `CollisionReport`, `CoordCheckReport`)
are *separate* report types — they never get appended to the `findings` list and
never introduce a non-deterministic kind.
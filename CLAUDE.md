# Overreach — Project Guide

> This file is the source of truth for the Overreach codebase. Read it before
> making changes. It describes what the tool does, how it's built, what the
> rules are, and where everything lives.

## What Overreach is

An **AI PR review assistant** that audits a code diff against the prompt that
authorized it. You told your AI agent to "add a login form." It also added
Stripe, a secret key, and a checkout endpoint. Overreach catches that.

**npm package:** `overreach`
**GitHub:** `Naveja00/OverReach`
**Version:** 0.7.0

### What we moved away from

Overreach started as an **MCP-first scope audit + multi-agent coordination tool**.
The original vision was:
- `npx overreach` started an MCP server (not a CLI)
- AI agents called `check_overreach()` to self-audit (fox guarding the henhouse)
- A full coordination layer: file claims, collision detection, agent check-ins,
  coordination ledger, conflict resolution, scope DSL, handoff validation, CI
  coordination gate — 17 MCP tools total for multi-agent workflows
- Marketed as "scope audit" with architecture-heavy docs

**Why we moved away:** 1,626 npm downloads but 0 external usage (zero telemetry
pings). People installed it but never used it. Root cause: too much friction.
You had to configure MCP, understand the tool system, set up scaffold files,
and learn flags before getting any value. The coordination layer was ~29% of
the codebase (~1,562 lines) and nobody used it — it solved a theoretical problem
(multiple AI agents on the same repo) that almost nobody has yet.

### What we focus on now

**v0.7.0 repositioned Overreach as an AI PR review assistant for humans.**

The focus is:
- **`npx overreach` runs the CLI directly** — not an MCP server
- **Interactive mode with zero setup** — auto-detects diff, asks one question,
  shows the review. No config files, no flags, no scaffolding
- **Human-readable output** — findings grouped by severity, blast radius
  warnings for practical dev concerns, clean terminal formatting
- **The MCP server still exists** (`--serve` flag) but it's secondary
- **The coordination layer code still exists** in the codebase but is demoted
  — it's not in the README, not in the help text, not the selling point
- **Blast radius** — a new layer of practical cross-file warnings (missing
  migrations, env var mismatches, no tests, hardcoded secrets, etc.) that
  developers actually care about. Separate from findings, not mixed in.

The adoption insight: the tool needs to deliver value in **one command with
zero setup**. The user runs `npx overreach`, types what they asked the AI to
do, and gets a review. That's it.

### How people use it

```bash
# Interactive — the main way
cd your-project
npx overreach
# → auto-detects diff sources, asks "What did you ask the AI to do?", shows review

# Piped
git diff | overreach --prompt "add user authentication"

# Demo (zero-key, self-contained)
npx overreach demo

# MCP server (for AI agents to self-audit)
overreach --serve
```

### Bin mapping

| Command | Entry point | Purpose |
|---|---|---|
| `overreach` | `dist/src/cli.js` | CLI review tool (default) |
| `overreach-server` | `dist/src/index.js` | MCP server |
| `overreach-cli` | `dist/src/cli.js` | Backward compat alias |

---

## TRUST CONTRACT INVARIANT (do not weaken this)

Overreach's trust contract is: **every finding is derivable from (prompt, diff)
by deterministic set arithmetic.** No finding depends on inference, opinion, or
"what done looks like."

Enforcement rules:
- A finding's `kind` MUST be in the deterministic `scope.*` set, produced by
  Stage 3 (`actual − authorized`).
- Findings of different trust levels (fact vs opinion) must NEVER share one
  output list.
- The deterministic `FindingKind` set is frozen (see `src/types.ts`). The test
  suite asserts it equals exactly the scope.* gate kinds.

### The frozen finding kinds (7 total)

| Kind | Severity | What it means |
|---|---|---|
| `scope.env` | HIGH | Env var in diff not mentioned in prompt |
| `scope.endpoint` | HIGH | API route added without authorization |
| `scope.cron` | HIGH | Scheduled job or cron task added |
| `scope.listener` | HIGH | Runtime listener (server, WebSocket, `process.on`) |
| `scope.dep` | MEDIUM | Package dependency added |
| `scope.file` | MEDIUM | File changed outside prompt's implied scope |
| `scope.feature` | LOW | New function/class/symbol not matching any authorized feature |

### Amendments to the frozen set

- **`scope.listener` (added 2026-06-23, 7th kind).** Runtime listeners
  (`.listen()`, `process.on`, `WebSocket` constructors, global `addEventListener`)
  are the same HIGH-severity runtime-surface class as endpoints/env/cron. Generic
  element `.addEventListener` (UI event handlers) is intentionally NOT flagged.

---

## The 3-stage pipeline

### Stage 1 — Extract scope (the ONLY LLM step)

One cheap/fast model call. Input: the user's prompt. Output: JSON `scope` block
with `files_allowed`, `features_allowed`, `endpoints_allowed`, `deps_allowed`,
`env_allowed`, `behavioral_changes_allowed`.

- Model: cheapest available (haiku / gpt-4o-mini / ollama)
- Temperature 0, retry 2× on parse failure
- Cached by `hash(prompt + provider + model)` — re-runs are free
- **Zero-key fallback:** regex-parses the prompt for concrete items. No LLM needed.

Provider resolution chain: `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → Ollama.
Can be overridden with `SCOPE_PROVIDER` and `OVERREACH_MODEL` env vars.

**Typo tolerance:** Stage 1 prompt tells the model to decipher misspellings
(`"setings page"` → `"settings page"`). Stage 3 also has deterministic
Damerau-Levenshtein fuzzy matching with a common-word guard so `auth` ≠ `auto`.

### Stage 2 — Parse the diff (deterministic, no LLM)

Regex-based extraction in `src/parsers/diff.ts`. Detects:
- Files changed, imports added, env vars added, endpoints added
- Cron/scheduled jobs, new deps (package.json/requirements.txt/go.mod/Cargo.toml/Gemfile)
- Symbols added (functions, classes, consts)
- Runtime listeners, IaC resources (terraform/k8s/CloudFormation), SQL DDL

Must run in <100ms for a 2000-line diff.

### Stage 3 — Compare (pure set arithmetic)

`actual − authorized = findings`. For each actual category, subtract anything
in the matching scope category (fuzzy match: case-insensitive substring,
path-prefix for files, Damerau-Levenshtein for typo tolerance).

`scope_creep_score`: HIGH if any high-severity finding; MEDIUM if only medium;
LOW if only low or none.

---

## Blast radius (Heads Up section)

A **separate** layer from findings. Pattern-matched from the diff, also fully
deterministic. These are practical cross-file warnings — not scope creep, just
things developers forget:

| # | Pattern | What it catches |
|---|---|---|
| 1 | `schema-no-migration` | Schema changed, no migration file |
| 2 | `env-not-in-dotenv` | Code uses `process.env.FOO` but `.env` doesn't define it |
| 3 | `env-defined-not-used` | `.env` defines a var but no changed source reads it |
| 4 | `route-no-test` | New API route, no test file updated |
| 5 | `many-changes-no-tests` | 3+ source files changed, zero tests |
| 6 | `exports-no-types` | New exports added but type definitions not updated |
| 7 | `infra-only` | Docker/CI changed, no source code |
| 8 | `config-sprawl` | 3+ config files changed at once |
| 9 | `schema-migration-pair` | Schema + migration both changed — review together |
| 10 | `deps-no-lockfile` | package.json deps changed, no lockfile updated |
| 11 | `styles-no-component` | CSS changed but no component file updated |
| 12 | `auth-middleware-changed` | Auth/middleware touched — security-sensitive |
| 13 | `large-file` | Single file with 200+ lines added |
| 14 | `hardcoded-secret` | API key / password / token in source code |
| 15 | `tech-debt-added` | TODO/FIXME/HACK in 2+ files |
| 16 | `new-file-not-imported` | New source file created but never imported |
| 17 | `api-no-docs` | API routes changed, no docs updated |

Blast radius warnings do NOT affect the findings list or the risk score. They
appear in a separate "Heads Up" section in CLI output and a separate
`blast_radius` key in JSON output. Capped at 8 warnings max.

Source: `src/blast_radius.ts`

---

## CLI output format

The pretty-printed output follows this layout:

```
  Overreach — AI PR Review
  ─────────────────────────────────────────────────
  You asked: "the user's prompt, truncated to 80 chars"
  N files changed · M in scope · K outside scope

  Findings

  ✗ [high severity findings — red]
  ⚠ [medium severity findings — yellow]
  · [low severity findings — dim, collapsed if >5: shows 3 + "… and N more"]

  Heads Up                           ← blast radius, only if warnings exist

  → [warning message — cyan]
    [suggestion — dim]
    [affected files — dim]

  ─────────────────────────────────────────────────
  N findings · RISK level · offline/deterministic
```

---

## File structure

```
overreach/
  CLAUDE.md              ← this file
  README.md              ← human-facing docs
  package.json
  tsconfig.json
  action.yml             ← GitHub Action definition

  src/
    cli.ts               ← CLI entry point (interactive + piped modes)
    index.ts             ← MCP server entry (--serve / overreach-server)
    blast_radius.ts      ← Heads Up pattern warnings (17 patterns)
    config.ts            ← env vars, provider/model resolution
    demo.ts              ← built-in demo diff/prompt/scope
    init.ts              ← `overreach init` (pre-commit hook scaffolding)
    sanitize.ts          ← prompt/diff size measurement for telemetry
    telemetry.ts         ← anonymous usage stats (opt-in)
    types.ts             ← core type definitions (Scope, Actual, Finding, CheckResult)
    utils.ts             ← shared utilities

    tools/
      check_overreach.ts ← 3-stage orchestrator (the core product)

    scope/
      extract_scope.ts   ← Stage 1: prompt → scope JSON via LLM
      extract_deterministic.ts ← zero-key fallback (regex scope extraction)
      cache.ts           ← scope cache by hash(prompt+provider+model)

    parsers/
      diff.ts            ← Stage 2: diff → actual (regex, no LLM)

    compare/
      diff_scope.ts      ← Stage 3: actual − scope → findings

    # Coordination layer — LEGACY, not the focus (see "What we moved away from")
    # ~29% of codebase, ~1,562 lines. Still compiles and tests pass but
    # nobody uses it. Do NOT build new features on top of this layer.
    # Do NOT promote it in README, help text, or marketing.
    # Candidate for removal in a future cleanup pass.
    check_in.ts          ← agent check-in system
    claims.ts            ← file claim management
    collide.ts           ← collision detection
    coord_check.ts       ← CI coordination gate
    ledger.ts            ← coordination ledger
    resolve.ts           ← conflict resolution
    scope_dsl.ts         ← scope DSL parser
    contract/            ← narrow contract schema
    handoff/             ← agent handoff validation

  tests/
    run.ts               ← test runner (444 assertions)
    taxonomy_tests.ts    ← finding-kind taxonomy tests
    edge_and_smuggle.ts  ← adversarial/edge-case tests
    real_world_tests.ts  ← real-repo validation tests
    simulate.ts          ← simulation tests
    simulate_stress.ts   ← stress tests (100+ files)
    fixtures/            ← 19 diff/scope fixture pairs

  docs/
    ci-gate.md           ← GitHub Action CI gate docs
    listings.md          ← marketplace listing metadata

  worker/               ← Cloudflare Worker for telemetry
```

---

## Running the project

```bash
npm run build           # TypeScript compile
npm test                # 444 deterministic assertions, zero API key
npx tsx src/cli.ts demo # zero-key demo (no build needed)
npx tsx src/cli.ts --serve  # start MCP server (dev)
```

## Test fixtures (19 pairs)

Each fixture is a `.diff` + `.scope.json` pair in `tests/fixtures/`:

analytics_injection, clean_scope, config_drift, css_design_drift,
database_creep, deletions_only, django_auth_injection, docker_infra, empty,
express_overreach, library_swap, logging_injection, login_form_stripe,
partial_scope, python_fastapi_overreach, security_overreach, shopify_size_chart,
test_sprawl, websocket_creep

---

## Hard constraints

- **Never write API keys into this project.** Keys are sourced from env vars
  at runtime only. The user runs on Ollama Cloud (`SCOPE_PROVIDER=ollama`
  `OLLAMA_BASE_URL=https://ollama.com` `OVERREACH_MODEL=glm-5.2`) — the key
  comes from FounderSignal's `.env`, never persisted in Overreach.

- **The FindingKind set is frozen.** Adding a new kind requires an amendment
  in this file with a stated justification. The test suite enforces this.

- **Blast radius warnings are NOT findings.** They must never appear in the
  `findings` array or affect `scope_creep_score`. Separate output section,
  separate JSON key.

- **Stage 2 and Stage 3 are pure functions.** No LLM calls, no network, no
  randomness. Must be 100% deterministic and reproducible.

---

## What this is NOT

- NOT a linter / formatter / code-quality reviewer
- NOT spec-driven development (checking code vs a formal spec doc)
- NOT prompt-injection detection
- NOT security scanning (hardcoded-secret warning in blast radius is advisory, not a finding)
- NOT AST-perfect analysis — uses regex + light parsing
- NOT a multi-agent coordination platform (we built this, nobody used it — see
  "What we moved away from" above. The code still exists but don't build on it)
- NOT an MCP-first tool anymore — CLI for humans first, MCP for agents second

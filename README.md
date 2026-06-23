# Overreach

[![npm version](https://img.shields.io/npm/v/overreach.svg)](https://www.npmjs.com/package/overreach)
[![license](https://img.shields.io/npm/l/overreach.svg)](https://github.com/Naveja00/OverReach)
[![CI](https://github.com/Naveja00/OverReach/actions/workflows/overreach.yml/badge.svg)](https://github.com/Naveja00/OverReach/actions/workflows/overreach.yml)

**Scope audit + multi-agent coordination for AI coding agents.**

Overreach does three things no other tool does:

1. **Catches scope creep** — audits a code diff against the prompt that authorized it. Flags every unauthorized dep, env var, endpoint, cron job, or file the agent added without being asked.
2. **Scope DSL** — agents declare what they WILL do before starting. Validation is deterministic, zero API cost, confidence 1.0. No LLM needed.
3. **Coordinates multiple agents** — when Claude Code, Cursor, and Codex work on the same repo, Overreach tracks who touched what, prevents file collisions, resolves conflicts, and keeps every agent aware of the others' work. Cross-vendor. Just JSON files in git.

> "turns out my ai assistant had been extremely making product decisions without me"

## Try it (no key needed)

```bash
npx -y -p overreach overreach-cli demo
```

Runs the real pipeline on a sample diff — no API key, no setup, costs nothing.
The demo prompt asks for a login form; the diff smuggles in Stripe, an env var,
an endpoint, and a cron job. Overreach catches all four. That's the product in
one command.

## Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **npm** (comes with Node.js)
- **Git** — required for the pre-commit hook and `git diff` piping

---

## Part 1: Scope Audit

### What it checks

| Finding kind            | Caught when the diff adds...                              |
| ----------------------- | -------------------------------------------------------- |
| `scope.dep`             | a package/requirement the prompt didn't name (npm, pip, go.mod, Cargo, Gemfile, composer) |
| `scope.env`             | an env var (`process.env.X`, `os.environ`, `.env`)       |
| `scope.endpoint`        | an HTTP route / handler / `route.ts` file                |
| `scope.cron`            | a cron / scheduler job                                    |
| `scope.listener`        | a runtime listener — `app.listen`, `WebSocket.Server`, `process.on`, `window.addEventListener` |
| `scope.file`            | edits to a file the prompt didn't touch on               |
| `scope.feature`         | a new top-level symbol/feature beyond the prompt — incl. infrastructure resources (terraform `resource`, kubernetes `kind:`, CloudFormation) and SQL `CREATE/ALTER TABLE` |

Severity: env / endpoint / cron / listener = **high** · dep / file = **medium** · feature = **low**.
Overall `scope_creep_score`: `HIGH` if any high finding, `MEDIUM` if any medium, else `LOW`.

### How it works (3 stages)

1. **Stage 1 — Scope extraction (LLM).** Reads your prompt -> structured JSON of what
   you actually asked for. Deciphers typos but **never invents scope**. Only stage
   that calls a model. **Skipped entirely in DSL mode.**
2. **Stage 2 — Diff parsing (deterministic).** Regex-parses the diff into what it
   actually adds — imports, deps, env vars, routes, cron jobs, symbols. Milliseconds.
3. **Stage 3 — Comparison (deterministic).** Set arithmetic: `actual - authorized = findings`.

Stages 2 and 3 are pure functions — no inference, no opinion, fully auditable.

> **Typo-tolerant authorization.** A misspelled prompt (`"setings page"`, `"logn
> form"`) must not produce a *false positive* — flagging in-scope work as creep —
> just because Stage 1 left the typo uncorrected. Stage 3 authorizes typo-tolerantly:
> a scope token matches an actual identifier when they're equal, a substring, or
> within a 1–2 char Damerau-Levenshtein edit, gated by a common-word guard so real
> words never collide (`auth` won't match `auto`). This is deterministic (edit
> distance is a pure function) — the engine matches the typo to the real identifier
> regardless of whether the model corrected it. A wrong *scope* never yields a
> hallucinated *finding*. (Proven zero-cloud in the [T24] taxonomy suite.)

### Quick start

```bash
# Set up a project (creates prompt.md, pre-commit hook, CLAUDE.md, .cursorrules, codex.md)
npx -y -p overreach overreach-cli init

# Write your prompt
echo "Add a login form to the settings page" > .overreach/prompt.md

# Commit — Overreach runs automatically via the pre-commit hook
git add . && git commit -m "add login form"
```

The pre-commit hook blocks commits on `HIGH` scope creep. Skip with `--no-verify`.

### CLI

```bash
# Pipe a diff
git diff | npx -y -p overreach overreach-cli --prompt "add a login form to the settings page"

# Or pass a diff file
npx -y -p overreach overreach-cli --prompt "..." --diff changes.diff

# JSON output for CI
npx -y -p overreach overreach-cli --prompt "..." --json
```

Exits `0` if clean, `1` if HIGH — usable as a CI gate.

---

## Part 2: Scope DSL (Proactive Declaration)

**The problem:** traditional scope audit is reactive — it checks after the diff exists. By then the damage is done.

**The fix:** agents declare what they WILL do before writing any code. Overreach validates the declaration, locks the files, and when the work is done, validates the diff against the declaration — deterministically, with zero API cost.

### The DSL Flow

```
1. claim_scope    → declare intent, lock files, get claim_id
2. (do the work)
3. check_overreach → pass claim_id, skip LLM, deterministic validation
4. complete_scope  → release locks, auto-log to ledger
```

### Declaring Scope

```json
{
  "files": {
    "create": ["src/checkout.tsx", "src/api/checkout.ts"],
    "modify": ["src/nav.tsx"],
    "delete": []
  },
  "dependencies": ["@stripe/stripe-js"],
  "env_vars": ["STRIPE_PUBLIC_KEY"],
  "api_routes": ["/api/checkout-session"]
}
```

Call `claim_scope` with this JSON. Overreach validates the schema, checks for conflicts with other agents' active claims, and returns a `claim_id`. If another agent already claimed any of those files, the claim is rejected and a conflict record is automatically created.

### DSL Mode vs Inferred Mode

| | DSL Mode | Inferred Mode |
|---|---|---|
| **How** | Agent declares scope via `claim_scope` | Scope extracted from prompt via LLM |
| **Confidence** | 1.0 (deterministic) | ~0.85 (depends on model) |
| **API cost** | Zero | One LLM call |
| **Stage 1** | Skipped entirely | Runs scope extraction |
| **Use when** | Agent knows exactly what it will touch | Ad-hoc prompt auditing |

### Parent-Child Narrowing

When a parent agent delegates to a child, the child's scope must **narrow** the parent's — it cannot add files or deps the parent didn't authorize:

```
Parent claim: files [checkout.tsx, api/checkout.ts], deps [@stripe/stripe-js]
  Child claim (narrows): files [checkout.tsx]           -> allowed
  Child claim (expands): files [billing.tsx]            -> rejected
  Child claim (expands): deps [redis]                   -> rejected
```

### Auto-Conflict Recording

When `claim_scope` rejects a claim due to file conflicts, a `ConflictRecord` is automatically created in `.overreach/conflicts.json`. The rejection response includes a `conflict_id` that can be passed to `resolve_claim` to handle the conflict.

### Auto-Ledger on Completion

When `complete_scope` is called, the work is automatically logged to `.overreach/ledger.json` with `mode: "dsl"`, `confidence: 1.0`, and the `claim_id` — so the coordination history captures which work was DSL-declared vs inferred.

---

## Part 3: Multi-Agent Coordination

**The problem nobody else solves:** Claude Code only coordinates Claude-with-Claude.
Codex worktrees only isolate Codex-with-Codex. When you use Claude Code for one task,
Cursor for another, and Codex for a third — all on the same repo — there's zero
awareness between them. Files get clobbered, work gets duplicated, agents contradict
each other.

**Overreach fixes this** with a coordination layer that any agent can read — it's just
JSON files in `.overreach/` committed to git.

### File Claims (prevent collisions)

Agents claim files before working on them. Other agents see the claims and work elsewhere.

```
Agent A: claim_files(["src/auth.ts", "src/db.ts"])  -> claimed
Agent B: claim_files(["src/auth.ts"])                -> conflict! held by Agent A
Agent B: claim_files(["src/utils.ts"])               -> claimed (no conflict)
```

Claims auto-expire (default 2h). Agents can extend claims if work takes longer.

### Conflict Resolution

When conflicts are detected, they can be resolved with two strategies:

| Strategy | What happens |
|---|---|
| `block` | Later agent must wait or pick different files |
| `escalate` | Flagged for human review — a person decides who proceeds |

```
resolve_claim(conflict_id, strategy: "block")
-> "Files [src/auth.ts] contested between [claude, cursor]. Later agent must wait."

resolve_claim(conflict_id, strategy: "escalate")
-> "Flagged for human review. A human must decide which agent proceeds."
```

### Coordination Ledger (who did what)

Every agent's work is logged to `.overreach/ledger.json` — what they did, which files
they touched, their scope creep score, mode (dsl/inferred), confidence, and when.
Before starting, agents read the ledger to see what's already been done.

```bash
# View the ledger
npx -y -p overreach overreach-cli ledger

# Or check status (claims + ledger)
npx -y -p overreach overreach-cli status
```

### Traceability (who broke what)

Every ledger entry can carry a `task_id` and `issue_ref`, so you can trace any file
change back to the ticket that caused it:

```
who_touched(file: "src/auth.ts")
-> [claude] add login flow (LOW, dsl, 1.0) — 2026-06-20T10:00:00Z
   [cursor] refactor auth middleware (MEDIUM, inferred, 0.85) — 2026-06-20T11:30:00Z
```

### Agent-to-Agent Handoffs (delegation chains)

When a parent agent delegates a subtask to a child agent, Overreach validates the
child only **narrows** the parent's authorization — never expands it. The full
delegation chain (A -> B -> C -> ...) is preserved so any agent in the chain has
complete project context.

```
Parent: "add user authentication"
  -> Child: "add password validation"     OK narrows (allowed)
  -> Child: "add Stripe billing"          BLOCKED expands (rejected)
```

Contracts have optional TTL — an expired contract flags `HIGH` so stale/abandoned
agents don't keep committing under old authorization.

### Cross-Vendor Init

`overreach init` creates instructions for every major agent vendor:

| File | Agent vendor |
|---|---|
| `CLAUDE.md` | Claude Code / Claude agents |
| `.cursorrules` | Cursor |
| `codex.md` | OpenAI Codex |
| `.overreach/config.json` | Any agent (coordination rules) |
| `.git/hooks/pre-commit` | All (auto-logs to ledger) |
| `.gitignore` | Excludes transient files |

### 16 MCP Tools

| Tool | What it does |
|---|---|
| `check_overreach` | Audit a diff against a prompt (pass `claim_id` for DSL mode) |
| `validate_handoff` | Validate agent-to-agent delegation |
| `claim_scope` | Declare what you will do (DSL), lock files, get `claim_id` |
| `complete_scope` | Mark scope done, release locks, auto-log to ledger |
| `resolve_claim` | Resolve a conflict (block or escalate) |
| `list_scope_claims` | List all active DSL scope claims |
| `list_conflicts` | List all open conflicts |
| `claim_files` | Claim files before working (lightweight, no DSL) |
| `release_files` | Release file claims when done |
| `extend_claim` | Extend claim duration |
| `check_conflicts` | Check for file conflicts |
| `who_touched` | Find which agents touched a file |
| `active_claims` | List all active file claims |
| `read_ledger` | Read the coordination ledger |
| `append_ledger` | Log completed work (with optional task_id/issue_ref) |
| `health` | Health check |

---

## MCP Server Setup

Overreach is a stdio MCP server — any MCP-capable client can connect:

**Claude Code:**
```bash
claude mcp add overreach -- npx -y overreach
```

**Claude Desktop / Cursor** — add to your MCP config:
```json
{
  "mcpServers": {
    "overreach": { "command": "npx", "args": ["-y", "overreach"] }
  }
}
```

**Codex CLI** — add to `~/.codex/config.toml`:
```toml
[mcp_servers.overreach]
command = "npx"
args = ["-y", "overreach"]
```

Or Streamable HTTP: set `PORT=8787` and POST to `http://localhost:8787/mcp`.

> **The HTTP endpoint has no auth.** It binds to `127.0.0.1` by default. Do not
> expose it publicly without an authed reverse proxy.

### API key (optional)

| Provider | Env vars |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI / compatible (OpenRouter, Groq, LM Studio, ...) | `OPENAI_API_KEY` + `OPENAI_BASE_URL` |
| Ollama (Cloud or local) | `OLLAMA_API_KEY` + `OLLAMA_BASE_URL` |

Pin a provider/model with `SCOPE_PROVIDER` and `OVERREACH_MODEL`.

**No key? No problem.** Deterministic scope extraction regex-parses your prompt for
concrete items (file paths, package names, `/api/...` routes, env vars, cron keywords).
Instant, free, fully offline. Or use the Scope DSL for full deterministic coverage.

## CI Gate (GitHub Action)

The hard backstop. A workflow runs Overreach on every PR and **fails the check** on
`scope_creep_score=HIGH`. Copy [`.github/workflows/overreach.yml`](.github/workflows/overreach.yml)
into your repo and add your API key as a repository secret. Full setup in
[`docs/ci-gate.md`](docs/ci-gate.md).

## Tested Models

| Model | Result |
|---|---|
| Claude Sonnet 4.6 | 82/82 |
| Claude Opus 4.6 | 65/65 |
| GLM 5.2 | 82/82 |
| Kimi K2.7-Code | 82/82 |
| MiniMax M3 | 81/82 |

> Per-model scores are **Stage 1** (scope extraction) accuracy as last verified
> 2026-06-19. Cloud models drift — e.g. GLM 5.2 no longer deciphered the
> `setings`→`settings` typo as of 2026-06-23 (e2e 16/17). These numbers are
> evidence the pipeline works across model families, not a live SLA. The product
> guarantee does not depend on them: **Stages 2 and 3 are pure functions** —
> every finding is derivable from (prompt, diff) regardless of which model
> produced the scope. A model that botches Stage 1 produces a looser/incorrect
> *scope*, never a hallucinated *finding*.

## Tests (zero API key)

```bash
npm test
```

348 deterministic assertions. Zero API calls. Covers scope detection, parsers,
handoffs, contract narrowing/expiration, file claims, ledger queries, claim
extension, conflict detection, issue traceability, DSL validation, scope claims,
parent-child narrowing, DSL fast path, conflict resolution, 11 real-world
scope-creep patterns (analytics injection, config drift, security overreach,
database creep, docker/infra, django auth, test sprawl, logging injection,
library swap, css design drift, websocket creep), a 23-case taxonomy matrix
across runtime surface, dependencies (incl. Rust `Cargo.toml`, Ruby `Gemfile`,
PHP `composer.json`), file scope, feature creep, infra/ops (terraform `resource`,
kubernetes `kind:`, CloudFormation, SQL `CREATE/ALTER TABLE`), the sneaky
smuggling patterns (incl. the 7th finding kind, scope.listener), and a typo-
robustness group proving a misspelled/uncorrected scope never false-flags in-scope
work.

## Architecture

Overreach is fully self-contained. No external dependencies beyond the MCP SDK
and LLM client. No telemetry, no call-home. Runs entirely on your machine.

The trust contract: **every scope finding is derivable from (prompt, diff) by
deterministic set arithmetic.** No finding depends on inference or opinion. This
is what separates Overreach from probabilistic AI reviewers.

## License

MIT

## Bugs & Feedback

https://github.com/Naveja00/OverReach/issues

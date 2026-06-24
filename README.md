# Overreach

[![npm version](https://img.shields.io/npm/v/overreach.svg)](https://www.npmjs.com/package/overreach)
[![license](https://img.shields.io/npm/l/overreach.svg)](https://github.com/Naveja00/OverReach)
[![CI](https://github.com/Naveja00/OverReach/actions/workflows/overreach.yml/badge.svg)](https://github.com/Naveja00/OverReach/actions/workflows/overreach.yml)

**Scope audit + multi-agent coordination for AI coding agents.**

Overreach does three things no other tool does:

1. **Catches scope creep** — audits a code diff against the prompt that authorized it. Flags every unauthorized dep, env var, endpoint, cron job, listener, or file the agent added without being asked.
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

| Finding kind | Caught when the diff adds... |
|---|---|
| `scope.dep` | a package/requirement the prompt didn't name (npm, pip, go.mod, Cargo, Gemfile, composer) |
| `scope.env` | an env var (`process.env.X`, `os.environ`, `.env`) |
| `scope.endpoint` | an HTTP route / handler / `route.ts` file |
| `scope.cron` | a cron / scheduler job / `setInterval` |
| `scope.listener` | a runtime listener — `app.listen`, `WebSocket.Server`, `process.on`, global `addEventListener` |
| `scope.file` | edits to a file the prompt didn't touch on |
| `scope.feature` | a new top-level symbol/feature beyond the prompt — incl. infrastructure resources (terraform `resource`, kubernetes `kind:`, CloudFormation) and SQL `CREATE/ALTER TABLE` |

Severity: env / endpoint / cron / listener = **high** · dep / file = **medium** · feature = **low**.
Overall `scope_creep_score`: `HIGH` if any high finding, `MEDIUM` if any medium, else `LOW`.

### How it works

A 3-stage pipeline: **(1)** extract the authorized scope from the prompt (one
cheap LLM call — or skip it entirely with the Scope DSL / zero-key regex fallback),
**(2)** parse the diff into what it actually adds (deterministic regex, no LLM,
milliseconds), **(3)** subtract: `actual − authorized = findings` (deterministic
set arithmetic). Stages 2 and 3 are pure functions — no inference, no opinion.
Authorization is typo-tolerant (`"setings"` still matches `settings`) so a
misspelled prompt never false-flags in-scope work. Full matcher and algorithm
detail in [`docs/internals.md`](docs/internals.md).

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

Contracts have optional TTL — an expired contract flags `HIGH` so stale/abandoned agents don't keep committing under old authorization.

---

## Part 3: Multi-Agent Coordination

**The problem nobody else solves:** Claude Code only coordinates Claude-with-Claude. Codex worktrees only isolate Codex-with-Codex. When you use Claude Code for one task, Cursor for another, and Codex for a third — all on the same repo — there's zero awareness between them. Files get clobbered, work gets duplicated, agents contradict each other.

**Overreach fixes this** with a coordination layer that any agent can read — it's just JSON files in `.overreach/` committed to git.

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

### Collision diagnostics (what is each agent actually doing to the file?)

A flat "conflict on `utils.ts`" tells you two agents want the same file, but not whether their work actually overlaps. `check-in --diagnose` (or the `diagnose_collision` tool) turns a conflict into useful information: each agent's **declared intent** (task + create/modify/delete + their declared deps/env/routes, read from their scope or file claims) plus the file's **actual top-level symbols** and a split suggestion. Deterministic — declared facts + file structure only. No merge engine, no inference about which agent wrote which symbol.

```
Collision diagnostic for src/utils.ts:
  File on disk: yes (5 top-level symbols: parseX, tokenize, format, validate, refresh)
  Agents contesting:
    claude [modify] "refactor utils" (scope, deps: lodash, env: UTIL_KEY, routes: /api/util)
    cursor [claim] "patch utils" (file-claim)
  Split suggestion: consider splitting `src/utils.ts` — top-level symbols: parseX,
    tokenize, format, validate, refresh. Each agent could take a disjoint set of
    symbols instead of both editing the whole file.
```

### Coordination Ledger (who did what)

Every agent's work is logged to `.overreach/ledger.json` — what they did, which files they touched, their scope creep score, mode (dsl/inferred), confidence, and when. Before starting, agents read the ledger to see what's already been done.

```bash
# View the ledger
npx -y -p overreach overreach-cli ledger

# Or check status (claims + ledger)
npx -y -p overreach overreach-cli status
```

### Catch-up (what did I miss while away)

When an agent has been idle and comes back, it doesn't need to re-read the whole ledger — it can ask for just the **delta** since its own last entry. Deterministic, zero API cost.

```bash
# What happened since "claude" last checked in
npx -y -p overreach overreach-cli status --since-agent claude

# Entries after an explicit timestamp (ISO-8601, UTC)
npx -y -p overreach overreach-cli ledger --since 2026-06-23T14:00:00Z

# Pipe the delta to another agent as JSON
npx -y -p overreach overreach-cli ledger --since-agent claude --json
```

The cutoff is **exclusive** (an entry at exactly the agent's last timestamp isn't re-reported); the **later** cutoff wins if you pass both; an unknown `--since-agent` falls back to the full ledger with a note.

### Check-in (same-PC live awareness)

When several agents run on the **same machine** they share the filesystem — so re-reading `.overreach/` *is* near-real-time awareness of what every agent is doing, with no server and no transport. An agent checks in between big blocks of code: it **renews its own claims** so they don't expire while it works (a heartbeat), and gets a current snapshot — who's working on what, the ledger delta since its last check-in, and any open conflicts involving it. Deterministic, zero API cost, milliseconds.

```bash
# Renew my claims + see what every agent is doing + what I missed
npx -y -p overreach overreach-cli check-in --agent-name claude

# Also diagnose any open file collisions involving me
npx -y -p overreach overreach-cli check-in --agent-name claude --diagnose

# Structured JSON for piping to another agent
npx -y -p overreach overreach-cli check-in --agent-name claude --json
```

The same-PC insight is the point: cross-machine, awareness is eventual (you only see another agent's work after a `git pull`). On one machine the real limit is just "the agent has to re-read the folder" — and a periodic check-in fixes that without ever leaving the just-files-in-git model. (Like the rest of the tool, check-in is best-effort: an agent that never calls it stays blind. The CI gate is the hard backstop.)

### Traceability (who broke what)

Every ledger entry can carry a `task_id` and `issue_ref`, so you can trace any file change back to the ticket that caused it:

```
who_touched(file: "src/auth.ts")
-> [claude] add login flow (LOW, dsl, 1.0) — 2026-06-20T10:00:00Z
   [cursor] refactor auth middleware (MEDIUM, inferred, 0.85) — 2026-06-20T11:30:00Z
```

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

### 19 MCP Tools

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
| `check_in` | Same-PC live awareness: renew your claims + see what every agent is doing + what you missed + your conflicts |
| `diagnose_collision` | For a contested file, show each agent's declared intent + the file's top-level symbols + a split suggestion |
| `coord_check` | CI coordination gate: fail a PR whose diff touches a file with an open conflict (or, in strict mode, an unclaimed file) |
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

**No key? No problem.** Deterministic scope extraction regex-parses your prompt for concrete items (file paths, package names, `/api/...` routes, env vars, cron keywords). Instant, free, fully offline. Or use the Scope DSL for full deterministic coverage.

## CI Gate (GitHub Action)

The hard backstop. A workflow runs Overreach on every PR and **fails the check** on `scope_creep_score=HIGH`. Copy [`.github/workflows/overreach.yml`](.github/workflows/overreach.yml) into your repo, or use the one-click **Install Overreach** GitHub Action (`Naveja00/Overreach@v1`) which drops the workflow + wires `.overreach/` for you. Full setup in [`docs/ci-gate.md`](docs/ci-gate.md).

The coordination layer is best-effort inside an agent (an agent *can* skip a `claim_files` call). The CI gate is the one place the agent can't bypass — and it can optionally enforce coordination too: with `REQUIRE_CLAIMS=true`, the gate additionally runs `overreach-cli coord-check` and fails the PR if the diff touches a file with an **open (unresolved) conflict**. With `REQUIRE_CLAIMS=strict` it also fails on files no agent actively claimed. Opt-in; off by default so existing gates are unaffected.

## Tested Models

| Model | Result |
|---|---|
| Claude Sonnet 4.6 | 82/82 |
| Claude Opus 4.6 | 65/65 |
| GLM 5.2 | 82/82 |
| Kimi K2.7-Code | 82/82 |
| MiniMax M3 | 81/82 |

> Per-model scores are **Stage 1** (scope extraction) accuracy as last verified
> 2026-06-19. Cloud models drift — these numbers are evidence the pipeline works
> across model families, not a live SLA. The product guarantee does not depend
> on them: **Stages 2 and 3 are pure functions** — every finding is derivable
> from (prompt, diff) regardless of which model produced the scope.

## Tests (zero API key)

```bash
npm test
```

444 deterministic assertions. Zero API calls. Covers scope detection, parsers, handoffs, contract narrowing/expiration, file claims, ledger queries, claim extension, conflict detection, issue traceability, DSL validation, scope claims, parent-child narrowing, the DSL fast path, conflict resolution, 11 real-world scope-creep patterns, a 23-case taxonomy matrix across runtime surface / dependencies / file scope / feature creep / infra-ops, the sneaky smuggling patterns (incl. the 7th finding kind, `scope.listener`), a typo-robustness group, the coordination layer (file-claim + scope-claim renewal, the check-in delta, conflict filtering, and collision diagnostics), and the CI coordination gate (open-conflict blocking, strict unclaimed mode, resolved-conflict handling).

## Architecture

Overreach is fully self-contained. No external dependencies beyond the MCP SDK and LLM client. The audit pipeline and coordination layer run entirely on your machine — no part of a `check_overreach` or coordination call ever sends your prompt, diff, or file contents anywhere.

The trust contract: **every scope finding is derivable from (prompt, diff) by deterministic set arithmetic.** No finding depends on inference or opinion. This is what separates Overreach from probabilistic AI reviewers. Engine detail in [`docs/internals.md`](docs/internals.md).

### Telemetry

`overreach init` sends **one anonymous ping** so we know someone actually set it up (clones and npm installs are vanity; init is intent). It fires once per project, then never again.

- **Sent:** `{ event, os, arch, node, vendors, v, ts }` — platform, Node version, how many vendor configs were scaffolded (Claude/Cursor/Codex), and the Overreach version. Nothing else.
- **Never sent:** repo name, file paths, prompt content, diff content, user identity.
- **Opt out:** `OVERREACH_TELEMETRY=0` or `DO_NOT_TRACK=1`. The marker file `.overreach/.telemetry-sent` is gitignored.
- Fire-and-forget: a failed/blocked ping is silently swallowed and never blocks `init`.

## Pricing / Roadmap

Overreach is open-source (MIT) today. The audit pipeline + multi-agent coordination layer are free and will stay free. A paid tier is on the roadmap for teams that want hosted coordination, dashboards, and policy-enforced CI gates — the local-first, deterministic core remains the free floor. Nothing to install or sign up for now; `npx overreach` just works.

## License

MIT

## Bugs & Feedback

https://github.com/Naveja00/OverReach/issues
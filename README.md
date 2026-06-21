# Overreach

[![npm version](https://img.shields.io/npm/v/overreach.svg)](https://www.npmjs.com/package/overreach)
[![license](https://img.shields.io/npm/l/overreach.svg)](https://github.com/Naveja00/OverReach)
[![CI](https://github.com/Naveja00/OverReach/actions/workflows/overreach.yml/badge.svg)](https://github.com/Naveja00/OverReach/actions/workflows/overreach.yml)

**Scope audit + multi-agent coordination for AI coding agents.**

Overreach does two things no other tool does:

1. **Catches scope creep** — audits a code diff against the prompt that authorized it. Flags every unauthorized dep, env var, endpoint, cron job, or file the agent added without being asked.
2. **Coordinates multiple agents** — when Claude Code, Cursor, and Codex work on the same repo, Overreach tracks who touched what, prevents file collisions, and keeps every agent aware of the others' work. Cross-vendor. Just JSON files in git.

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

| Finding kind            | Caught when the diff adds…                                |
| ----------------------- | -------------------------------------------------------- |
| `scope.dep`             | a package/requirement the prompt didn't name             |
| `scope.env`             | an env var (`process.env.X`, `os.environ`, `.env`)       |
| `scope.endpoint`        | an HTTP route / handler / `route.ts` file                |
| `scope.cron`            | a cron / scheduler job                                    |
| `scope.file`            | edits to a file the prompt didn't touch on               |
| `scope.feature`         | a new top-level symbol/feature beyond the prompt         |

Severity: env / endpoint / cron = **high** · dep / file = **medium** · feature = **low**.
Overall `scope_creep_score`: `HIGH` if any high finding, `MEDIUM` if any medium, else `LOW`.

### How it works (3 stages)

1. **Stage 1 — Scope extraction (LLM).** Reads your prompt → structured JSON of what
   you actually asked for. Deciphers typos but **never invents scope**. Only stage
   that calls a model.
2. **Stage 2 — Diff parsing (deterministic).** Regex-parses the diff into what it
   actually adds — imports, deps, env vars, routes, cron jobs, symbols. Milliseconds.
3. **Stage 3 — Comparison (deterministic).** Set arithmetic: `actual − authorized = findings`.

Stages 2 and 3 are pure functions — no inference, no opinion, fully auditable.

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

## Part 2: Multi-Agent Coordination

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
Agent A: claim_files(["src/auth.ts", "src/db.ts"])  → claimed
Agent B: claim_files(["src/auth.ts"])                → conflict! held by Agent A
Agent B: claim_files(["src/utils.ts"])               → claimed (no conflict)
```

Claims auto-expire (default 2h). Agents can extend claims if work takes longer.

### Coordination Ledger (who did what)

Every agent's work is logged to `.overreach/ledger.json` — what they did, which files
they touched, their scope creep score, and when. Before starting, agents read the
ledger to see what's already been done.

```bash
# View the ledger
npx -y -p overreach overreach-cli ledger

# Or check status (claims + ledger)
npx -y -p overreach overreach-cli status
```

### Conflict Detection

Before starting work, an agent checks for conflicts — both active claims AND files
recently touched by other agents:

```
check_conflicts(files: ["src/auth.ts"], agent: "cursor")
→ { has_conflicts: true, conflicts: [...], recent_touches: [...] }
```

### Traceability (who broke what)

Every ledger entry can carry a `task_id` and `issue_ref`, so you can trace any file
change back to the ticket that caused it:

```
who_touched(file: "src/auth.ts")
→ [claude] add login flow (LOW) — 2026-06-20T10:00:00Z
  [cursor] refactor auth middleware (MEDIUM) — 2026-06-20T11:30:00Z
```

### Agent-to-Agent Handoffs (delegation chains)

When a parent agent delegates a subtask to a child agent, Overreach validates the
child only **narrows** the parent's authorization — never expands it. The full
delegation chain (A → B → C → ...) is preserved so any agent in the chain has
complete project context.

```
Parent: "add user authentication"
  → Child: "add password validation"     ✓ narrows (allowed)
  → Child: "add Stripe billing"          ✗ expands (blocked)
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

### 11 MCP Tools

| Tool | What it does |
|---|---|
| `check_overreach` | Audit a diff against a prompt |
| `validate_handoff` | Validate agent-to-agent delegation |
| `claim_files` | Claim files before working |
| `release_files` | Release claims when done |
| `extend_claim` | Extend claim duration |
| `check_conflicts` | Check for file conflicts |
| `who_touched` | Find which agents touched a file |
| `active_claims` | List all active claims |
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
| OpenAI / compatible (OpenRouter, Groq, LM Studio, …) | `OPENAI_API_KEY` + `OPENAI_BASE_URL` |
| Ollama (Cloud or local) | `OLLAMA_API_KEY` + `OLLAMA_BASE_URL` |

Pin a provider/model with `SCOPE_PROVIDER` and `OVERREACH_MODEL`.

**No key? No problem.** Deterministic scope extraction regex-parses your prompt for
concrete items (file paths, package names, `/api/...` routes, env vars, cron keywords).
Instant, free, fully offline.

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

## Tests (zero API key)

```bash
npm test
```

100 deterministic assertions. Zero API calls. Covers scope detection, parsers,
handoffs, contract narrowing/expiration, file claims, ledger queries, claim
extension, conflict detection, and issue traceability.

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

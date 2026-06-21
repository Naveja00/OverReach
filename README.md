# Overreach

[![npm version](https://img.shields.io/npm/v/overreach.svg)](https://www.npmjs.com/package/overreach)
[![license](https://img.shields.io/npm/l/overreach.svg)](https://github.com/Naveja00/OverReach)
[![CI](https://github.com/Naveja00/OverReach/actions/workflows/overreach.yml/badge.svg)](https://github.com/Naveja00/OverReach/actions/workflows/overreach.yml)

A standalone MCP tool that catches AI-agent scope creep.

You give it the **prompt** you gave your coding agent, and the **diff** it produced.
Overreach tells you whether the diff stayed inside what the prompt asked for — or
whether the agent quietly added an endpoint, a dependency, an env var, or a cron job
that you never asked for.

> "turns out my ai assistant had been extremely making product decisions without me"

## Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org). Verify with `node -v`.
- **npm** comes with Node.js. Verify with `npm -v`.
- **Git** — required for the pre-commit hook and `git diff` piping.

## Try it (no key needed)

```bash
npx -y -p overreach overreach-cli demo
```

Runs the real pipeline on a sample diff — no API key, no setup, costs nothing.
Exits `1` with a `HIGH` scope-creep finding (the demo prompt asks for a login form;
the diff smuggles in Stripe, an env var, an endpoint, and a cron job). That's the
whole product in one command.

## What it checks

A diff is flagged when it adds something the prompt never authorized:

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

## How it works (3 stages)

1. **Stage 1 — Scope extraction (LLM).** Reads your prompt and produces an
   `authorized scope` JSON: which files, features, deps, endpoints, env, and behaviors
   you actually asked for. Deciphers typos to the nearest real concept but **never
   invents scope**. This is the only stage that calls a model.
2. **Stage 2 — Diff parsing (deterministic, no LLM).** Regex-parses the diff into the
   set of things it actually adds — imports, deps, `process.env.X` references, route
   handlers, cron jobs, new symbols. Runs in milliseconds.
3. **Stage 3 — Comparison (deterministic).** Set arithmetic with fuzzy matching:
   `actual − authorized = findings`.

Stages 2 and 3 are pure functions — no inference, no opinion, fully auditable.
That's what makes Overreach testable without spending a cent on inference.

## Install

```bash
npm install -g overreach
```

Or use directly via `npx` (no install needed):

```bash
npx -y -p overreach overreach-cli demo
```

### API key (optional)

For best results, set one LLM provider key for Stage 1 scope extraction:

| Provider | Env vars |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI / OpenAI-compatible (OpenRouter, Groq, Together, **LM Studio**, …) | `OPENAI_API_KEY` + `OPENAI_BASE_URL` (e.g. `http://localhost:1234/v1` for LM Studio) |
| Ollama (Cloud or self-hosted) | `OLLAMA_API_KEY` + `OLLAMA_BASE_URL` |

Pin a provider/model with `SCOPE_PROVIDER` and `OVERREACH_MODEL`.

**No key? No problem.** Without an API key, Overreach falls back to
**deterministic scope extraction** — it regex-parses your prompt for concrete
items (file paths, package names, `/api/...` routes, `SCREAMING_SNAKE_CASE` env
vars, cron keywords) instead of calling an LLM. It won't understand vague
instructions as well as an LLM would, but it catches every concrete noun in
your prompt. Instant, free, fully offline.

## Quick start

### 1. Set up a project (one command)

```bash
npx -y -p overreach overreach-cli init
```

This creates three things:
- **`.overreach/prompt.md`** — write the prompt you gave your agent here
- **`.git/hooks/pre-commit`** — audits every commit against your prompt
- **`CLAUDE.md`** — instructs AI agents to self-audit before committing

### 2. Write your prompt

Edit `.overreach/prompt.md` with the actual instruction you gave your AI agent:

```
Add a login form to the settings page with email/password fields,
form validation, and a submit button that calls /api/auth/login.
```

### 3. Commit — Overreach runs automatically

```bash
git add . && git commit -m "add login form"
```

The pre-commit hook audits staged changes against your prompt:
- **HIGH** scope creep → commit blocked (exit 1)
- **MEDIUM / LOW** → commit allowed with findings printed
- Template prompt (not yet edited) → skipped gracefully
- No API key → deterministic fallback (extracts concrete items from prompt)

Skip with `git commit --no-verify` when you know what you're doing. Update
`.overreach/prompt.md` whenever you give the agent a new task.

> **Windows:** The pre-commit hook is a shell script. It works out of the box
> with Git Bash (included with [Git for Windows](https://gitforwindows.org)).

## CLI (manual check)

```bash
npx -y -p overreach overreach-cli --prompt "add a login form to the settings page" --diff my-changes.diff
```

Or pipe a diff:

```bash
git diff | npx -y -p overreach overreach-cli --prompt "add a login form to the settings page"
```

Exits `0` if clean, `1` if HIGH — usable as a CI gate.

Options:
- `--prompt <text>` — the instruction that authorized the work
- `--diff <path>` — diff file (default: read from stdin)
- `--scope <path|json>` — inject authorized scope; skips the LLM entirely
- `--json` — emit raw JSON instead of pretty terminal output
- `--no-cache` — bypass the scope cache (force a fresh Stage 1 call)
- `demo` — run the canonical demo (zero-key)
- `init` — install pre-commit hook + CLAUDE.md

## MCP server (Claude Code, Cursor, Codex, Claude Desktop)

Overreach is a stdio MCP server, so any MCP-capable client can connect:

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

> **The HTTP endpoint has no auth.** It binds to `127.0.0.1` (loopback) by
> default — safe for local use. Do **not** expose it publicly
> (`OVERREACH_HOST=0.0.0.0`) without an authed reverse proxy in front: anyone who
> can reach it can call `check_overreach` and spend your LLM budget.

Tools exposed: `check_overreach(prompt, diff, options?)` and `health`.

### First-time setup (Claude Code)

```bash
# 1. Register the server with Claude Code (one time)
claude mcp add overreach -- npx -y overreach

# 2. Restart your Claude Code session
#    (a session already open won't see the new server until you quit and reopen it)

# 3. Optionally set an API key (works without one via deterministic fallback)
export ANTHROPIC_API_KEY=sk-...     # or OPENAI_API_KEY / OLLAMA_API_KEY
```

After the restart, every new session has `check_overreach` available — no per-task
setup. The agent calls it when it decides it's relevant.

> **The key isn't passed through automatically.** The MCP server is a separate
> process; your agent does **not** hand it its own credentials. If you log in to
> Claude Code with `claude login` (OAuth / subscription), there's no
> `ANTHROPIC_API_KEY` in the environment — so export one (any provider works; local
> Ollama needs no key), or for Claude Desktop / Cursor add it to the server's `env`:
> ```json
> { "mcpServers": { "overreach": { "command": "npx", "args": ["-y", "overreach"], "env": { "ANTHROPIC_API_KEY": "sk-..." } } } }
> ```

### The agent self-audit pattern

`overreach init` adds a scope-audit instruction to your project's `CLAUDE.md` so
AI agents self-audit their staged changes before committing — no user intervention
needed. The agent reads the instruction and runs Overreach on its own diff.

You can also have the agent call `check_overreach` directly via the MCP server
with its own task string + the diff it's about to commit:

```
git diff --staged | overreach-cli --prompt "<the task you just gave me>"
```

This is **best-effort** — an agent can skip the call or ignore the findings
(fox guarding the henhouse). The hard backstop is the CI gate below.

## CI gate (GitHub Action)

The hard backstop. A workflow runs Overreach on every pull request and **fails
the PR** when `scope_creep_score=HIGH` — the diff adds a dep / env var /
endpoint / cron / out-of-scope file the prompt didn't authorize.

Copy [`.github/workflows/overreach.yml`](.github/workflows/overreach.yml) into
your repo and add `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` / `OLLAMA_API_KEY`)
as a repository secret. The prompt comes from `.overreach/prompt.md` in the repo,
or the PR title + body if that file is absent. The job posts its findings as a PR
comment and fails the check on `HIGH`. Full setup + customization in
[`docs/ci-gate.md`](docs/ci-gate.md).

```yaml
# .github/workflows/overreach.yml  (excerpt)
- name: Run Overreach
  run: |
    npx -y -p overreach@latest overreach-cli \
      --prompt "$(cat "$RUNNER_TEMP/prompt.txt")" --diff "$RUNNER_TEMP/pr.diff"
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
- name: Gate — fail the PR on HIGH
  if: steps.overreach.outputs.exit == '1'
  run: exit 1
```

This open-source Action is free to run (you bring your own LLM key).

## Tested models

| Model | Result |
|---|---|
| Claude Sonnet 4.6 | 82/82 |
| Claude Opus 4.6 | 65/65 |
| GLM 5.2 | 82/82 |
| Kimi K2.7-Code | 82/82 |
| MiniMax M3 | 81/82 |

The deterministic fallback (no key) works with any prompt that contains concrete
items — no model needed.

## Verify it works (zero API key)

```bash
npm test
```

Runs 87 assertions through the real pipeline with the scope injected via
`scopeOverride`, so Stage 1 (the LLM) is never called. Covers overreach
detection, clean passes, Python/Express/Next.js parsers, deletion handling,
determinism, chunking, trust contract invariant, agent-to-agent handoffs,
contract narrowing/expiration, file claims, and ledger queries.

## Standalone

Overreach is fully self-contained. It does **not** import or depend on any other
project. It reads only its own process environment. No telemetry, no call-home —
it runs entirely on your machine.

## Bugs & feedback

If Overreach misses something it should flag, or flags something the prompt
authorized, open an issue with the **prompt + the smallest repro diff**:

https://github.com/Naveja00/OverReach/issues

There's a bug-report template that asks for exactly that.

## License

MIT

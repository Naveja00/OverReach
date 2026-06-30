# Overreach

**See whether your AI changed more than you asked it to.**

[![npm version](https://img.shields.io/npm/v/overreach.svg)](https://www.npmjs.com/package/overreach)
[![license](https://img.shields.io/npm/l/overreach.svg)](https://github.com/Naveja00/OverReach)

You asked for a login form. Your AI agent also added Stripe, a secret key, and a checkout endpoint. Overreach tells you exactly what changed beyond your request — so you know what to review before you merge.

## See it

```
$ npx -y overreach demo

  Overreach — AI PR Review
  ─────────────────────────────────────────────────
  You asked: "add a login form to the settings page"
  5 files changed · 4 in scope · 1 outside scope

  Findings

  ✗ New environment variable: STRIPE_SECRET
    .env.example
  ✗ New API endpoint: /api/checkout
    src/app/api/checkout/route.ts
  ✗ Scheduled job added
    cron.config.ts
  ⚠ File outside scope: cron.config.ts
    cron.config.ts
  ⚠ Added dependency: stripe
    package.json

  Heads Up

  → New API route added but no test file updated
  → Dependencies changed but lockfile not updated
  → 3 source files changed but no tests updated

  ─────────────────────────────────────────────────
  5 findings · review carefully · deterministic
```

You asked for a login form. Overreach found a payment system. Review those files before you merge.

## Install

```bash
# Just run it — zero setup
cd your-project
npx -y overreach
```

That's it. It auto-detects your changes, asks what you told the AI to do, and shows the review. No config files, no flags to memorize.

Or install it permanently:

```bash
npm install -g overreach

# Pipe a diff with an explicit prompt
git diff | overreach --prompt "add user authentication"

# Install as a pre-commit hook
overreach init
```

**No API key? No problem.** Without a key, Overreach regex-parses your prompt offline. Instant, free, fully deterministic.

## Works with

- Claude Code
- Cursor
- Codex
- GitHub Copilot
- Windsurf
- Aider

Any tool that writes code from a prompt. Overreach reviews the output, not the tool.

## What it catches

### Unexpected changes (things the AI did that you didn't ask for)

| Check | Example |
|---|---|
| Dependencies | Added `stripe` when you asked for a login form |
| Environment variables | `STRIPE_SECRET` appeared in `.env` |
| API endpoints | `/api/checkout` route you never requested |
| Scheduled jobs | Cron jobs or background tasks added silently |
| Runtime listeners | Servers, WebSocket handlers, `process.on` hooks |
| Out-of-scope files | Files modified that your prompt didn't mention |
| Feature creep | New functions/classes beyond what was requested |

Every finding is **deterministic** — derived from your prompt and the diff by set arithmetic. No AI opinions. Just: "you asked for X, the diff also contains Y, and Y wasn't in X."

### Heads Up (things you probably need to check)

Overreach also scans for practical cross-file issues that developers miss during review:

| Warning | What it catches |
|---|---|
| Schema without migration | Changed `schema.prisma` but didn't add a migration |
| Env var mismatch | Code uses `process.env.FOO` but `.env` doesn't define it |
| Route without tests | New API route added but no test file updated |
| No tests at all | 3+ source files changed, zero test files touched |
| Deps without lockfile | `package.json` changed but no `package-lock.json` |
| Auth/middleware changed | Security-sensitive files modified |
| Hardcoded secrets | API keys or tokens written directly in source code |
| Large file | 200+ lines added to one file — might need splitting |
| Dead new files | New file created but never imported anywhere |
| Tech debt added | TODO/FIXME/HACK in 2+ files |
| API without docs | API routes changed but docs not updated |
| Orphan styles | CSS changed but no component updated |
| Config sprawl | 3+ config files changed at once |
| Infra-only | Docker/CI changed but no source code |

These aren't scope creep — they're the stuff you forget at 2am and find out about in production.

## Why deterministic

Most AI code reviewers use another AI to judge your code. That means opinions, hallucinations, and results that change between runs.

Overreach doesn't do that.

It runs a 3-stage pipeline:

1. **Extract scope** — One cheap LLM call reads your prompt and extracts what you authorized (files, deps, env vars, endpoints). Or skip the LLM entirely with zero-key mode.

2. **Parse the diff** — Regex-based extraction. No LLM. Finds every file changed, dependency added, env var set, endpoint created. Runs in milliseconds.

3. **Compare** — `actual − authorized = findings`. Pure set arithmetic. Everything in the diff that wasn't in your prompt is a finding.

Stages 2 and 3 are pure functions — same input, same output, every time. No inference, no model drift.

## CI Gate

Use Overreach as a GitHub Action to block AI scope creep on every PR:

```yaml
# .github/workflows/overreach.yml
- uses: Naveja00/Overreach@v1
```

Exit code `1` when unexpected changes are found — the AI agent can't skip this check.

## MCP Server (for AI agents)

AI agents can use Overreach to check their own work before committing:

```bash
# Claude Code
claude mcp add overreach -- npx -y overreach --serve

# Claude Desktop / Cursor — add to MCP config:
{ "mcpServers": { "overreach": { "command": "npx", "args": ["-y", "overreach", "--serve"] } } }
```

## Internals

### API key (optional)

Overreach auto-detects your AI provider:

| Provider | Env var |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI / compatible | `OPENAI_API_KEY` |
| Ollama (local) | No key needed |

### CLI flags

```
overreach                          # Interactive mode (recommended)
overreach demo                     # Zero-key demo with sample diff
overreach init                     # Install as pre-commit hook

git diff | overreach --prompt "…"  # Pipe a diff with explicit prompt
overreach --diff file.diff --prompt "…"   # Read diff from file
overreach --scope scope.json --prompt "…" # Skip LLM, use pre-extracted scope
overreach --json                   # Machine-readable JSON output
overreach --serve                  # Start as MCP server
```

### JSON output

Add `--json` for structured output (CI, piping, integrations):

```json
{
  "scope": { "files_allowed": [], "features_allowed": [] },
  "actual": { "files_changed": [], "symbols_added": [] },
  "findings": [
    {
      "kind": "scope.env",
      "detail": "New environment variable STRIPE_SECRET not in authorized scope",
      "file": ".env.example",
      "severity": "high",
      "evidence": "STRIPE_SECRET"
    }
  ],
  "scope_creep_score": "HIGH",
  "blast_radius": {
    "warnings": [
      {
        "pattern": "route-no-test",
        "message": "New API route added but no test file updated",
        "files": ["src/app/api/checkout/route.ts"],
        "suggestion": "Add tests for the new endpoint"
      }
    ]
  }
}
```

### Finding kinds

| Kind | Severity | What triggered it |
|---|---|---|
| `scope.env` | HIGH | Environment variable not mentioned in prompt |
| `scope.endpoint` | HIGH | API route added without authorization |
| `scope.cron` | HIGH | Scheduled job added |
| `scope.listener` | HIGH | Runtime listener (server, WebSocket, `process.on`) |
| `scope.dep` | MEDIUM | Package dependency added |
| `scope.file` | MEDIUM | File changed outside prompt's scope |
| `scope.feature` | LOW | New symbol not matching any authorized feature |

### Tests

```bash
npm test    # 444 deterministic assertions, zero API calls
```

## License

MIT — free and open source.

## Links

- [npm](https://www.npmjs.com/package/overreach)
- [GitHub](https://github.com/Naveja00/OverReach)
- [Issues & Feedback](https://github.com/Naveja00/OverReach/issues)

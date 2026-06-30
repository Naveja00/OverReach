# Overreach

**Review what your AI agent actually changed vs what you asked for.**

[![npm version](https://img.shields.io/npm/v/overreach.svg)](https://www.npmjs.com/package/overreach)
[![license](https://img.shields.io/npm/l/overreach.svg)](https://github.com/Naveja00/OverReach)

You asked for a login form. Your AI agent also added Stripe, a secret key, and a checkout endpoint. Overreach catches that — deterministically, with evidence, no AI opinions.

## See it

```
$ npx -y overreach demo

  AI PR Review

  Prompt: "add a login form to the settings page"

  Files Changed: 5

  Prompt Coverage
    ✓  4 files directly related
    ⚠  1 file outside requested scope

  ⚠  High Risk
    ⚠  New environment variable: STRIPE_SECRET
    ⚠  New API endpoint: /api/checkout
    ⚠  Scheduled job added

  ⚠  Medium Risk
    ⚠  File outside scope: cron.config.ts
    ⚠  Added dependency: stripe

  Review Order (start here)
    1. .env.example — new env var
    2. src/app/api/checkout/route.ts — new endpoint
    3. cron.config.ts — scheduled job
    4. package.json — new dependency

  Confidence
    ✔  Deterministic checks only
    ✔  No AI-generated opinions
    ✔  Evidence-backed findings

  5 findings · 5 files · 45 diff lines
```

That's the whole product in one command. No API key needed.

## Install

```bash
# Just run it — auto-detects your changes, asks what you told the AI to do
cd your-project
npx -y overreach
```

Or install it permanently:

```bash
npm install -g overreach

# Interactive — auto-detects diff, asks for your prompt
overreach

# Or pipe a diff with an explicit prompt
git diff | overreach --prompt "add user authentication"

# Install as a pre-commit hook (blocks commits with HIGH-risk findings)
overreach init
```

### MCP Server (for AI agents)

Any MCP-capable agent can use Overreach to check its own work:

```bash
# Claude Code
claude mcp add overreach -- npx -y overreach --serve

# Claude Desktop / Cursor — add to MCP config:
{ "mcpServers": { "overreach": { "command": "npx", "args": ["-y", "overreach", "--serve"] } } }
```

### API Key (optional)

Overreach auto-detects your AI provider from environment variables:

| Provider | Env var |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI / compatible | `OPENAI_API_KEY` |
| Ollama (local) | No key needed |

**No key? No problem.** Without a key, Overreach regex-parses your prompt for concrete items (file paths, package names, routes, env vars). Instant, free, fully offline.

## What it catches

| Check | Example |
|---|---|
| Unauthorized dependencies | Added `stripe` when you asked for a login form |
| New environment variables | `STRIPE_SECRET` appeared in `.env` |
| Unexpected API endpoints | `/api/checkout` route you never requested |
| Scheduled jobs | Cron jobs or background tasks added silently |
| Runtime listeners | Servers, WebSocket handlers, `process.on` hooks |
| Out-of-scope files | Files modified that your prompt didn't mention |
| Feature creep | New functions/classes beyond what was requested |

Every finding is **deterministic** — derived from your prompt and the diff by set arithmetic. No hallucinated opinions. No "this code looks suspicious." Just: "you asked for X, the diff also contains Y, and Y wasn't in X."

## How it works

A 3-stage pipeline:

1. **Extract scope** — One cheap LLM call reads your prompt and extracts what you authorized (files, deps, env vars, endpoints). Or skip the LLM entirely with zero-key mode.

2. **Parse the diff** — Deterministic regex parsing. No LLM. Extracts every file changed, dependency added, env var set, endpoint created, cron job scheduled, and listener registered. Runs in milliseconds.

3. **Compare** — `actual − authorized = findings`. Pure set arithmetic. Everything in the diff that wasn't in your prompt is a finding. Severity assigned by risk (env vars and endpoints = high, deps = medium).

Stages 2 and 3 are pure functions — no inference, no opinion, no model drift. The trust contract: **every finding is derivable from (prompt, diff) by deterministic set arithmetic.**

## CI Gate

Use Overreach as a GitHub Action to catch scope creep on every PR:

```yaml
# .github/workflows/overreach.yml
- uses: Naveja00/Overreach@v1
```

Exit code `1` on HIGH-risk findings — the AI agent can't skip this check.

## For Teams: Multi-Agent Coordination

When multiple AI agents (Claude Code, Cursor, Codex) work on the same repo, Overreach coordinates them:

- **File claims** — agents claim files before working, preventing collisions
- **Conflict detection** — blocked when two agents want the same file
- **Coordination ledger** — who did what, when, with full audit trail
- **Check-in** — agents stay aware of each other's work (same-PC, no server)
- **CI gate** — `coord-check` fails PRs that touch contested files

All coordination state lives in `.overreach/` — just JSON files in git. Cross-vendor. No server required.

See `overreach --help` for the full coordination CLI, or connect via MCP for the 19-tool coordination API.

## Tests

```bash
npm test    # 444 deterministic assertions, zero API calls
```

## License

MIT — free and open source.

## Links

- [npm](https://www.npmjs.com/package/overreach)
- [GitHub](https://github.com/Naveja00/OverReach)
- [Issues & Feedback](https://github.com/Naveja00/OverReach/issues)

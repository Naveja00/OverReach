# Overreach

A standalone MCP tool that catches AI-agent scope creep.

You give it the **prompt** you gave your coding agent, and the **diff** it produced.
Overreach tells you whether the diff stayed inside what the prompt asked for — or
whether the agent quietly added an endpoint, a dependency, an env var, or a cron job
that you never asked for.

> "turns out my ai assistant had been extremely making product decisions without me"

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

Finding kinds are namespaced (`<category>.<kind>`) so telemetry and policy rules
can filter by category. Categories beyond the diff-vs-prompt gate — `contract.*`
(child-vs-parent authorization narrowing) and `handoff.*` (advisory LLM verifier
checks) — are reserved for the agent-authorization layer.

Severity: env / endpoint / cron = **high** · dep / file = **medium** · feature = **low**.
Overall `scope_creep_score`: `HIGH` if any high finding, `MEDIUM` if any medium, else `LOW`.

## How it works (3 stages)

1. **Stage 1 — Scope extraction (LLM).** Reads your prompt and produces an
   `authorized scope` JSON: which files, features, deps, endpoints, env, and behaviors
   you actually asked for. Deciphers typos to the nearest real concept but **never
   invents scope**. This is the only stage that calls a model.
2. **Stage 2 — Diff parsing (deterministic, no LLM).** Regex-parses the diff into the
   set of things it actually adds.
3. **Stage 3 — Comparison (deterministic).** Set arithmetic with fuzzy matching:
   `actual − authorized = findings`.

Stages 2 and 3 are pure functions — that's what makes Overreach auditable and testable
without spending a cent on inference.

## Install

```bash
cd Overreach
npm install
```

Set `ANTHROPIC_API_KEY` (Stage 1 only). Without it, Overreach still runs but Stage 1
returns an empty scope with a warning, so everything in the diff is treated as
potentially unauthorized — useful for paranoid mode.

## Use it

### CLI (manual check)

```bash
npx overreach-cli --prompt "add a login form to the settings page" --diff my-changes.diff
```

Or pipe a diff: `git diff | npx overreach-cli --prompt "add a login form to the settings page"`.

Prints the `CheckResult` JSON (or pretty terminal output). Exits `0` if clean,
`1` if findings — usable as a CI gate. Zero-key demo: `npx overreach-cli demo`.

### MCP server (for Claude Desktop / Cursor)

`stdio` by default:

```json
{
  "mcpServers": {
    "overreach": { "command": "npx", "args": ["overreach"] }
  }
}
```

Or Streamable HTTP: set `PORT=8787` and POST to `http://localhost:8787/mcp`.

Tools exposed: `check_overreach(prompt, diff, options?)` and `health`.

### Verify it works (zero API key)

```bash
npm test
```

Runs two fixtures through the **real** pipeline with the scope injected via
`scopeOverride`, so Stage 1 (the LLM) is never called:

- **overreach fixture** — prompt asks for a login form; diff smuggles Stripe + an env
  var + an endpoint + a cron job → expects ≥4 findings and `HIGH`.
- **clean fixture** — prompt asks for a logout button; diff only adds the button →
  expects 0 findings and `LOW`.

Prints `N passed, M failed`. This is the proof it works without spending money.

## Standalone

Overreach is fully self-contained. It does **not** import or depend on any other
project. It reads only its own process environment.

## License

MIT
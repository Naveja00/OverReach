# CI gate — GitHub Action

The MCP tool is best-effort self-audit — an agent can skip the call or ignore
the findings. The **GitHub Action** is the hard backstop: it runs Overreach on
every pull request and **fails the PR** when `scope_creep_score` reaches the
configured threshold (default `HIGH`). Every finding is deterministic
`actual − authorized` set arithmetic from (prompt, diff) — no inference, no
opinion, no LLM in the gate path by default.

## 60-second zero-config setup

1. Copy [`.github/workflows/overreach.yml`](../.github/workflows/overreach.yml)
   into your repo at `.github/workflows/overreach.yml`.
2. Push.

That's it. No secrets, no settings, no API key. The gate runs on your next PR
using **deterministic regex scope extraction** and fails it on `HIGH`.

Prefer one-click? Add the **Install Overreach** action to a temporary workflow,
run it once, then delete the workflow:

```yaml
# .github/workflows/install-overreach.yml (run once, then delete)
name: install-overreach
on: workflow_dispatch
jobs:
  install:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Naveja00/Overreach@v0.4.0
        with:
          fail-on: HIGH
```

This runs `overreach init` (writes `.overreach/`, pre-commit hook,
`CLAUDE.md` / `.cursorrules` / `codex.md` instructions) and drops
`.github/workflows/overreach.yml` for you.

## No-key by default — how it works

Overreach has a **no-key deterministic mode**: when no provider key is set,
Stage 1 (scope extraction) regex-parses the prompt for concrete items the user
mentioned — file paths, package names (with signal words like `use`/`add`/
`install`), `/api/...` routes, `SCREAMING_SNAKE_CASE` env vars, cron keywords,
and known packages. Stages 2 (diff parse) and 3 (compare) are already pure
functions with zero LLM. So the whole pipeline runs with **zero API calls,
zero cost, instant** — and still catches every unauthorized dependency, env
var, endpoint, cron job, and out-of-scope file.

This is the default. The gate passes with zero config.

There are two other zero-LLM modes for agents that want to declare scope
explicitly:
- **Scope DSL mode** — an agent locks a `.overreach/claims.json` claim;
  `check_overreach` reads it with `confidence=1.0`, zero LLM.
- **`--scope` injection** — `overreach --scope scope.json` skips Stage 1
  entirely.

## Opting into LLM scope extraction

For better parsing of fuzzy prompts ("add a login form" → `features_allowed:
["login form"]`), set **one** repository secret. Repo → Settings → Secrets and
variables → Actions → New repository secret.

| Secret | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | Recommended — best verified results (Sonnet 4.6 / Opus 4.6 / Haiku 4.5). |
| `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`) | OpenAI, or any OpenAI-compatible endpoint (OpenRouter, Groq, LM Studio, …). |
| `OLLAMA_API_KEY` (+ `OLLAMA_BASE_URL`) | Ollama Cloud, or a self-hosted Ollama instance. |

The gate auto-resolves the provider from whichever key is set. Pin a
provider/model with `SCOPE_PROVIDER` and `OVERREACH_MODEL` env vars on the
`Run Overreach` step.

If a key **is** set but the provider is unreachable, the CLI **skips** the
audit (findings=`[]`, `LOW`, exit `0`) — it never blocks PRs on a provider
outage. A no-key run never skips — deterministic extraction is the real
extractor, not a fallback.

## Where the prompt comes from

The "authorized scope" is extracted from a prompt, resolved in this order
(first found wins):

1. **`.overreach/prompt.md`** committed in the repo — long-lived task
   definition; the file is the source of truth for what the work was supposed
   to be.
2. **PR title + body** — the human's instruction for that PR (default for PRs
   with no `prompt.md`).
3. **`AGENTS.md`** committed in the repo — agent instructions.

Edit the `Resolve authorized prompt` step to change this precedence.

## Fail-on configuration

The gate fails (exit `1`) when `scope_creep_score` is in the `FAIL_ON` list.

- **Default:** `FAIL_ON: HIGH` — only HIGH blocks. MEDIUM/LOW pass.
- **Also block MEDIUM:** set `FAIL_ON: HIGH,MEDIUM`:
  - via the `workflow_dispatch` input (`fail_on: HIGH,MEDIUM`), or
  - via a repository **variable** named `FAIL_ON` (Settings → Secrets and
    variables → Actions → Variables tab), or
  - by editing the `env:` block in the workflow file.

The CLI itself exits `1` on HIGH and `0` on LOW/MEDIUM; the workflow parses
the emitted `scope_creep_score` so it can apply the configurable threshold.

## What it does on a PR

- Resolves the prompt (precedence above).
- Builds the PR diff (`gh pr diff`).
- Runs `overreach --prompt … --diff …` — no-key deterministic by default,
  or one LLM call if a key is set (Stage 1, cached by prompt hash so re-runs
  are free).
- Deterministically parses the diff (Stage 2) and computes `actual − authorized`
  (Stage 3) — no inference.
- Posts/updates a comment on the PR with the findings.
- **Fails the check (exit `1`) when the score is in `FAIL_ON`** — i.e. the diff
  adds a dep, env var, endpoint, cron job, out-of-scope file, or unauthorized
  feature the prompt didn't name.

## The honest backstop note

An agent can skip a local `check_overreach` call or ignore its findings — the
MCP tool is best-effort self-audit, not enforcement. **This CI gate is the
hard backstop**: it runs server-side on every PR, out of the agent's control,
and fails the check on threshold breach. That's the trust boundary. Local
self-audit catches scope creep at commit time (fast feedback); the CI gate
catches it at merge time (enforcement). You want both.
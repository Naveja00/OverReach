# CI gate (GitHub Action)

The MCP tool is best-effort self-audit — an agent can skip the call or ignore
the findings. The **GitHub Action** is the hard backstop: it runs Overreach on
every pull request and **fails the PR** when `scope_creep_score=HIGH`.

## Setup (2 steps)

**1. Add the workflow.** Copy
[`.github/workflows/overreach.yml`](../.github/workflows/overreach.yml) into
your repo at `.github/workflows/overreach.yml`. (Or use it as-is in the Overreach
repo to dogfood — Overreach auditing its own PRs.)

**2. Add an LLM provider key as a repository secret.** Repo → Settings →
Secrets and variables → Actions → New repository secret. Set **one** of:

| Secret | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | Recommended — best verified results (Sonnet 4.6 / Opus 4.6 / Haiku 4.5). |
| `OPENAI_API_KEY` | OpenAI-compatible (also works for Gemini via `OPENAI_BASE_URL`). |
| `OLLAMA_API_KEY` | Ollama Cloud; set `OLLAMA_BASE_URL` too if non-default. |

If no key is set, the job posts a one-time setup comment and **skips** — it never
fails your PRs for lack of a key.

## Where the prompt comes from

The "authorized scope" is extracted from a prompt, resolved in this order:

1. **`.overreach/prompt.md`** committed in the repo (use this for long-lived
   task definitions — the file is the source of truth for what the work was
   supposed to be).
2. **The PR title + body** (default — the human's instruction for that PR).

## What it does on a PR

- Builds the PR diff (`git diff origin/base...HEAD`).
- Extracts the authorized scope from the prompt (Stage 1, one LLM call).
- Deterministically parses the diff (Stage 2) and does `actual − authorized`
  (Stage 3) — no inference.
- Posts/updates a comment on the PR with the findings.
- **Fails the check (exit 1) when `scope_creep_score=HIGH`** — i.e. the diff
  adds a dep, env var, endpoint, cron job, out-of-scope file, or unauthorized
  feature the prompt didn't name.

## Customization

- **Pin a model** by setting env vars on the `Run Overreach` step:
  ```yaml
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    SCOPE_PROVIDER: anthropic
    OVERREACH_MODEL: claude-sonnet-4-6
  ```
- **Fail on MEDIUM too.** By default the gate fails only on `HIGH` (the CLI
  exits `1` on HIGH, `0` on LOW/MEDIUM). To also fail on MEDIUM, run with
  `--json`, parse `scope_creep_score`, and exit 1 on `HIGH` or `MEDIUM`.
- **Different prompt per PR.** Skip `.overreach/prompt.md` and rely on the PR
  body, or edit the "Resolve authorized prompt" step to read from another
  source (a linked issue, an `AGENTS.md`, etc.).

## Pricing note

This open-source Action is free to run (you bring your own LLM key). The hosted
managed gate with usage billing and team policy config is the subscription
product — not part of this repo.
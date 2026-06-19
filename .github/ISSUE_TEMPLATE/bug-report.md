---
name: Bug report
about: Overreach missed something, falsely flagged something, or crashed
title: "[bug] "
labels: ["bug"]
---

## What kind of issue?

- [ ] Missed something it should have flagged (false negative)
- [ ] Flagged something the prompt authorized (false positive)
- [ ] Crashed / errored
- [ ] Other

## The prompt you gave the agent

```
<paste the exact prompt>
```

## The diff (smallest repro you can)

Paste the smallest diff that reproduces it. If it's large, link a gist.

```diff
<paste>
```

## What Overreach reported

```
<paste the CLI output, or the findings JSON if you used --json>
```

## What you expected instead

e.g. "should have flagged the `@sentry/react` dep — the prompt only asked for dark mode"
or "should NOT have flagged `recharts` — the prompt said 'add a revenue chart'."

## Environment

- **Overreach version:** (`npm view overreach version` for latest, or the version you pinned via `npx -p overreach@<ver>`; MCP users — the `health` tool returns the version)
- **Provider / model:** e.g. `SCOPE_PROVIDER=anthropic`, `OVERREACH_MODEL=claude-sonnet-4-6` (or openai / ollama / LM Studio)
- **How you ran it:** MCP tool / CLI / GitHub Action

## Anything else?

<optional>
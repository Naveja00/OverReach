# Directory listing submissions (ready to paste)

Prepared submission metadata for the MCP discovery directories. These are
outward-facing submissions you make from your own accounts — this file just
collects the copy so it's consistent everywhere.

## Shared metadata

| Field | Value |
|---|---|
| Name | `overreach` |
| One-line (<160 chars) | MCP tool that audits a code diff against the originating prompt and flags out-of-scope changes an AI agent made. |
| Repository | https://github.com/Naveja00/OverReach |
| npm | https://www.npmjs.com/package/overreach |
| License | MIT |
| Transport | stdio (default) + Streamable HTTP (`PORT=8787`) |
| Auth | none (the user's own LLM key is configured in their env, not by the server) |
| Tools | `check_overreach(prompt, diff, options?)`, `health()` |
| Install (MCP) | `npx overreach --serve` |
| Install (CLI) | `npx -y overreach --prompt "..." --diff ...` |
| Tags | mcp, scope-creep, ai-coding, code-review, claude, cursor, agent, diff |

## Longer description (for directory body)

Overreach catches AI-agent scope creep. You give it the prompt you gave your
coding agent and the diff it produced; it flags every part of the diff that
wasn't entailed by the prompt — unauthorized dependencies, env vars, endpoints,
cron jobs, files, and features. Unlike probabilistic AI code reviewers, every
finding is deterministic set arithmetic (`actual − authorized`) from the prompt
and diff: Stage 1 extracts the authorized scope (one cheap LLM call), Stage 2
regex-parses the diff (no LLM), Stage 3 compares. Verified on Claude Sonnet 4.6
(82/82), Claude Opus 4.6, GLM-5.2, Kimi K2.7, and Minimax M3. Ships a GitHub
Action that fails PRs on `scope_creep_score=HIGH`. MIT, free to use.

## mcp.so

Submit at https://mcp.so/submit (or the current submit path).

- **Name:** Overreach
- **Description:** (one-line above)
- **Repository URL:** https://github.com/Naveja00/OverReach
- **Install command:** `npx overreach`
- **Transport:** stdio / Streamable HTTP
- **Category:** Code Review / Developer Tools

## Smithery

Submit at https://smithery.ai. Smithery installs MCP servers via its CLI; the
config users add is the standard MCP server block:

```json
{
  "mcpServers": {
    "overreach": {
      "command": "npx",
      "args": ["-y", "overreach"]
    }
  }
}
```

- **Name:** overreach
- **Description:** (one-line above)
- **Repo:** https://github.com/Naveja00/OverReach
- **Categories:** Code Review, Testing, Developer Tools

## awesome-mcp-servers (GitHub awesome list)

Submit a PR to https://github.com/punkpeye/awesome-mcp-servers adding under the
appropriate category (e.g. `### Code Review` or `### Developer Tools`):

```markdown
- [Overreach](https://github.com/Naveja00/OverReach) - MCP tool that audits a code diff against the originating prompt and flags out-of-scope (overreaching) changes an AI agent made.
```

## README badges (optional, for the repo README top)

```markdown
[![npm version](https://img.shields.io/npm/v/overreach.svg)](https://www.npmjs.com/package/overreach)
[![license](https://img.shields.io/npm/l/overreach.svg)](https://github.com/Naveja00/OverReach)
[![CI](https://github.com/Naveja00/OverReach/actions/workflows/overreach.yml/badge.svg)](https://github.com/Naveja00/OverReach/actions/workflows/overreach.yml)
```
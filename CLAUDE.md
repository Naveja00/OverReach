# Overreach — Build Spec (read this first, then build)

> This file is the single source of truth for what to build. It is written for an
> AI coding agent (Claude Code / Cursor). Read it fully before writing any code.
> Do not invent features not described here. If something is ambiguous, build the
> smallest interpretation that satisfies the acceptance criteria at the bottom.

## Working name
**Overreach** (changeable). The noun names the failure mode: an AI coding agent
*overreaches* — it ships code beyond what the prompt authorized. This tool catches that.

## TRUST CONTRACT INVARIANT (the product's reason to exist)
Overreach's trust contract is: **every finding is derivable from (prompt, diff)
by deterministic set arithmetic.** No finding depends on inference, opinion, or
"what done looks like." This is the property that separates Overreach from every
probabilistic AI reviewer, and it must not be weakened by a feature addition.

Enforcement rules:
- A finding's `kind` MUST be in the deterministic `scope.*` set, produced by
  Stage 3 (`actual − authorized`). Anything that would require inferring intent,
  completeness, or success does NOT go in `scope.*` — it belongs in a separate,
  differently-named product with a probabilistic/advisory trust contract, never
  mixed into this tool's findings list.
- Findings of different trust levels (fact vs opinion) must NEVER share one
  output list — mixing them collapses the whole list to the lowest trust level
  present and destroys the value of the deterministic engine.
- The deterministic `FindingKind` set is frozen (see `src/types.ts`). The test
  suite asserts it equals exactly the scope.* gate kinds; adding a
  non-deterministic kind fails the test unless the invariant is deliberately
  amended here with a stated justification.

## One-line product
An MCP server exposing ONE tool, `check_overreach(prompt, diff)`, that audits a code
diff against the originating natural-language prompt and flags every out-of-scope
change the agent made. Sold per-call to the agent; CI gate sold as subscription.

## The exact problem (do not solve a different problem)
Solo developers using Claude Code / Cursor / Aider ask an agent to do a small thing
("add a login form to the settings page"). The agent also adds a Stripe import, a
`STRIPE_SECRET` env var, a `/api/checkout` endpoint, and a cron job — none of which
were requested. This is invisible until production breaks or a bill arrives.

> Source pain quote (real signal): "turns out my ai assistant had been extremely
> making product decisions without me."

The job-to-be-done: **tell the developer, at commit time, exactly which parts of the
diff were NOT entailed by the prompt.** Not code quality. Not security. Not spec
conformance. Scope compliance against the literal prompt. (Crucial: stay in this lane.)

## What this is NOT (explicitly out of scope for V1)
- NOT a linter / formatter / code-quality reviewer (CodeRabbit etc. exist).
- NOT spec-driven-development (Kiro / spec-kit check code vs a formal spec doc — different).
- NOT prompt-injection detection.
- NOT security scanning.
- NOT multi-repo / team dashboards.
- NOT AST-perfect analysis — V1 uses regex + light parsing. Good enough beats perfect.

---

## THE ONE TOOL — `check_overreach`

### Signature
```
check_overreach(prompt: string, diff: string, options?: { language?: string }) -> JSON
```
- `prompt`: the natural-language instruction the agent was given (the authorized scope).
- `diff`: a unified git diff (`git diff` output) of the changes to audit.
- `options.language`: optional hint ("python" | "typescript" | "auto"). Default "auto"
  (detect from diff file extensions).

### Returns (exact JSON schema)
```json
{
  "scope": {
    "files_allowed": ["string"],
    "features_allowed": ["string"],
    "endpoints_allowed": ["string"],
    "deps_allowed": ["string"],
    "env_allowed": ["string"],
    "behavioral_changes_allowed": ["string"]
  },
  "actual": {
    "files_changed": ["string"],
    "symbols_added": ["string"],
    "imports_added": ["string"],
    "env_vars_added": ["string"],
    "endpoints_added": ["string"],
    "cron_added": ["string"],
    "new_deps": ["string"]
  },
  "findings": [
    {
      "kind": "scope.file | scope.feature | scope.dep | scope.endpoint | "
             "scope.env | scope.cron",
      "detail": "human-readable, cites the specific diff line/symbol",
      "file": "path:line",
      "severity": "high | medium | low",
      "evidence": "short quote from the diff"
    }
  ],
  "scope_creep_score": "LOW | MEDIUM | HIGH",
  "summary": "one sentence, e.g. 'Diff adds 4 unauthorized things: stripe dep, STRIPE_SECRET env, /api/checkout, cleanup cron.'"
}
```

---

## THE 3-STAGE PIPELINE (the whole product)

### Stage 1 — EXTRACT SCOPE (the ONLY LLM step; keep it cheap)
One small/fast model call. Input: `prompt`. Output: strict JSON `scope` block above.

System prompt (use verbatim, force JSON):
```
You extract the AUTHORIZED SCOPE from a coding instruction. Output ONLY JSON, no prose.
Parse the user's instruction into exactly these keys:
  files_allowed       — file/dir paths the user said to touch (empty if none named)
  features_allowed    — features/behaviors explicitly requested
  endpoints_allowed   — API routes/endpoints explicitly requested
  deps_allowed        — npm/pip packages explicitly requested
  env_allowed         — environment variables explicitly requested
  behavioral_changes_allowed — side effects explicitly requested
If something is not mentioned, return an empty array for that key. Do NOT infer or
expand scope. Only what the user literally asked for. Output: {scope: {...}}
CRUCIAL: DO decipher misspellings/typos to the nearest real concept the user clearly
meant (e.g. "setings page" -> "settings page", "logn form" -> "login form") — you are
reading natural language the same way you answer a normal question. But correcting a
typo is NOT the same as expanding scope: never add a feature/dep/endpoint/env the user
did not name. Correct spelling of what they said; never invent what they didn't say.
```
- Model: cheap/fast (e.g. claude-haiku-4-5 or gpt-4o-mini equivalent). Temperature 0.
- Retry up to 2× on JSON parse failure; if still failing, return findings=[] with
  summary="could not parse scope".

### Stage 2 — EXTRACT ACTUAL (deterministic, NO LLM, fast, free)
Parse the unified diff with regex + light parsing. Detect, per language:

**Files changed:** parse `+++ b/<path>` / `--- a/<path>` headers and `@@` hunks.

**Imports added** (added lines starting with `+`):
- Python: `^\\+\\s*(import|from)\\s+([\\w\\.]+)` → capture module
- TS/JS: `^\\+\\s*import\\b` and `^\\+\\s*(?:const|let|var)\\s+\\w+\\s*=\\s*require\\(` ; capture from '...'

**Env vars added:**
- Python: `os\\.environ\\[["']([\\w]+)["']\\]`, `os\\.getenv\\(["']([\\w]+)`
- dotenv: `^\\+\\s*([A-Z_][A-Z0-9_]*)\\s*=` inside `.env` files
- TS/JS: `process\\.env\\.([A-Z_][A-Z0-9_]*)`, `process\\.env\\[["']([\\w]+)["']\\]`

**Endpoints added:**
- Python (FastAPI/Flask): `@(app|router)\\.(get|post|put|delete|patch)\\(["']([^"']+)` → path
- TS/JS (Express/Next/Hono): `\\.(get|post|put|delete|patch)\\(["'\`]([^"'\`]+)` ;
  Next.js app router: any `+page`/`+server` or `route.ts` file change under `app/` = an endpoint
- Also count new top-level `export async function GET/POST/...` in route files.

**Cron/scheduled jobs added:**
- Python: `cron\\.\\w+\\(`, `@scheduler\\.`, `schedule\\.every`, `BackgroundScheduler`
- TS/JS: `cron\\.schedule\\(`, `new CronJob`, `@nestjs/schedule` `@Cron`, Vercel `cron` in config

**New deps:** parse `+` lines in `package.json` ("dependencies"/"devDependencies" blocks)
and `requirements.txt` / `pyproject.toml` (`+` lines that look like `name==` or `name>=`).

**Symbols added:** `^\\+\\s*(def |class |function |const |export function |export const )`
→ capture names. Used to populate `symbols_added` and to detect behavioral changes.

Return the `actual` block. No LLM. Must run in <100ms for a 2000-line diff.

### Stage 3 — DIFF (pure set arithmetic, instant)
For each actual category, subtract anything that appears in the matching scope category
(fuzzy match: case-insensitive substring / path-prefix for files, exact for deps/env).
Everything left = a finding. Assign severity:
- `scope.env` / `scope.endpoint` / `scope.cron` → high
- `scope.dep` → medium
- `scope.file` → medium (high if outside any dir implied by scope)
- `scope.feature` (symbols not matching any allowed feature keyword) → low/medium

`scope_creep_score`: HIGH if any high-severity finding; MEDIUM if only medium; LOW if only
low or none.

---

## WHERE THE PROMPT COMES FROM (ship options 1 + 2 first)
1. **Explicit arg** — the agent passes its own task string to `check_overreach`. Cleanest.
2. **`AGENTS.md` or `.overreach/prompt.md`** in the repo — tool reads it if `prompt` arg empty.
3. (Later) the agent's own plan/TODO if present — premium "audit against the plan" mode.
4. (Later) latest git commit message.

If no prompt can be obtained, return `findings=[]`, `summary="no prompt source found"`.

---

## MCP SERVER SPEC
- Transport: **Streamable HTTP** (so it works with Claude Desktop, Cursor, remote clients).
- Expose the single tool `check_overreach` with the JSON schema above as its input schema.
- Also expose a second tiny tool `health()` returning `{status:"ok", version}`.
- Server package: `npx overreach` should start it on `$PORT` (default 8787) or stdio if no port.
- Config snippet to publish in docs (for Claude Desktop):
  ```
  { "mcpServers": { "overreach": { "command": "npx", "args": ["overreach"] } } }
  ```

---

## TECH STACK
- **Language:** TypeScript / Node.js (MCP SDK is TS-first; agents run it via npx).
- MCP SDK: `@modelcontextprotocol/sdk`
- LLM call: Anthropic SDK (`@anthropic-ai/sdk`) OR OpenAI-compatible — read key from
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Use the cheapest fast model available.
- Diff parsing: hand-written regex in `src/parsers/diff.ts`. No heavy deps.
- No database in V1. No auth. Stateless.

## FILE STRUCTURE (build exactly this)
```
overreach/
  CLAUDE.md            (this file — keep it; update if scope changes)
  README.md            (human-facing: what it is, install, 1 example)
  package.json
  tsconfig.json
  src/
    index.ts           (MCP server entry: register tools, start transport)
    tools/
      check_overreach.ts  (orchestrates the 3 stages; the public tool)
    scope/
      extract_scope.ts    (Stage 1: prompt -> scope JSON via LLM)
    parsers/
      diff.ts             (Stage 2: diff -> actual; regex-based, per-language)
    compare/
      diff_scope.ts       (Stage 3: actual - scope -> findings + score)
    config.ts          (env keys, model choice)
  tests/
    fixtures/
      login_form_stripe.diff     (the canonical example: prompt asks for login form,
                                   diff adds login form + stripe + env + endpoint + cron)
      clean_scope.diff           (diff that matches prompt exactly -> findings=[])
    check_overreach.test.ts  (assert: stripe diff flags 4 findings, score HIGH;
                              clean diff flags 0, score LOW)
```

## BUILD ORDER (do this, in this order)
1. `package.json` + `tsconfig.json` + `src/config.ts`. Install `@modelcontextprotocol/sdk`
   and the LLM SDK. Make `npm run build` and `npm start` work (even if tools are stubs).
2. `src/parsers/diff.ts` — write + unit-test the regex extractors against the two fixtures.
   This must pass BEFORE anything else, with no LLM.
3. `src/scope/extract_scope.ts` — the LLM call with the exact system prompt above; validate
   JSON schema strictly.
4. `src/compare/diff_scope.ts` — set arithmetic + severity + score.
5. `src/tools/check_overreach.ts` — wire the 3 stages together.
6. `src/index.ts` — register the MCP tools, start Streamable HTTP on $PORT.
7. `tests/check_overreach.test.ts` — run both fixtures end-to-end.
8. `README.md` — install + the one example.

## PRICING (put in README; implement billing as a stub in V1)
- Free: 10 checks/day per agent (honor-system / rate-limited by IP).
- Per-call beyond free: prepaid credits or X402 micropayment (fraction of a cent). STUB
  this in V1 (log usage, don't actually charge).
- Subscription (the real revenue, sold to humans): $19/mo GitHub Action that fails PRs
  with `scope_creep_score == HIGH`; $49/mo team. NOT built in V1 — just document.

## THE ONE RISK TO DESIGN AROUND
**Fox guarding the henhouse:** an agent can skip the call or ignore findings. The tool
is the *first line*, not the only line. The CI gate (separate GitHub Action, out of V1
scope) is the hard backstop. Document this honestly in the README so buyers know the
tool-call version is best-effort self-audit, not enforcement.

## ACCEPTANCE CRITERIA (the build is done when all pass)
1. `npm start` launches an MCP server a Claude Desktop config can connect to.
2. Calling `check_overreach` with `fixtures/login_form_stripe.diff` and the prompt
   "add a login form to the settings page" returns ≥4 findings including
   `scope.dep` (stripe), `scope.env` (STRIPE_SECRET),
   `scope.endpoint` (/api/checkout), `scope.cron`; `scope_creep_score=HIGH`.
3. Calling it with `fixtures/clean_scope.diff` and a matching prompt returns
   `findings=[]`, `scope_creep_score=LOW`.
4. Stage 2 runs with zero LLM calls (verify by mocking the LLM to throw and confirming
   the parser still returns `actual`).
5. Total latency for a 500-line diff < 3s (dominated by the single scope-extraction call).
6. `npx overreach` works after `npm run build`.

## VALIDATION (do AFTER the build passes acceptance, not before)
Post in r/ClaudeAI and r/cursor:
> "Has your AI agent ever shipped a route/dep/env var you never asked for? I built an
> MCP tool that audits your diff against your actual prompt and flags everything
> out-of-scope. Free while testing — anyone want in?"
Count yes replies. The hook writes itself: *"I asked it to add a login form. It also
added Stripe. Overreach catches that."*

## DISTRIBUTION
After acceptance: list on mcp.so, Smithery, and the awesome-mcp-servers GitHub list
(submission metadata: name, one-line desc <160 chars, tool list, transport=Streamable
HTTP, auth=none, npx install snippet). This is how agents discover the tool — the
sell-to-agents distribution model.

---
That is the entire product. Build exactly this. Nothing more in V1.
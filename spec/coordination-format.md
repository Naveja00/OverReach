# Coordination Format — `.overreach/`

**Protocol v0.1.0** · part of the Overreach Protocol Spec

The on-disk coordination state between agents. All files are JSON (or Markdown
for the prompt), live in `.overreach/` at the repo root, and are meant to be
committed to git so every agent sees the same state — **the coordination layer
is just files in git.** No server, no database, no vendor API.

## File set

| Path | Format | Purpose | Git-tracked |
|---|---|---|---|
| `.overreach/prompt.md` | Markdown | The authorized prompt for the current task | yes |
| `.overreach/config.json` | JSON | Coordination rules + file paths (agent-agnostic) | yes |
| `.overreach/ledger.json` | JSON array | Append-only history of completed work | yes |
| `.overreach/claims.json` | JSON array | Lightweight file claims (prevent collisions) | no (transient) |
| `.overreach/conflicts.json` | JSON array | Conflict records + resolutions | yes |
| `.overreach/scopes/index.json` | JSON array | DSL scope claims (the `ScopeClaim` records) | yes |
| `.overreach/scopes/<claim_id>.json` | JSON object | One DSL scope claim, for easy reading | yes |
| `.overreach/scope-cache/` | dir | Transient scope-extraction cache | no |
| `.overreach/*.lock` | files | File-lock markers for concurrent writes | no |

> The reference `init` gitignores `claims.json`, `scope-cache/`, and `*.lock`
> (transient). It keeps `prompt.md`, `config.json`, `ledger.json`,
> `conflicts.json`, and `scopes/` in git. Implementations SHOULD follow the
> same split.

## `config.json`

Agent-agnostic config any vendor can read.

```json
{
  "version": "1.0",
  "coordination": {
    "ledger": ".overreach/ledger.json",
    "claims": ".overreach/claims.json",
    "prompt": ".overreach/prompt.md"
  },
  "rules": {
    "claim_before_editing": true,
    "check_conflicts_before_start": true,
    "auto_log_to_ledger": true,
    "default_claim_duration": "2h"
  }
}
```

| Field | Type | Semantics |
|---|---|---|
| `version` | `string` | Config schema version (currently `"1.0"`) |
| `coordination.ledger` | `string` | Path to ledger file |
| `coordination.claims` | `string` | Path to lightweight file-claims file |
| `coordination.prompt` | `string` | Path to the authorized prompt file |
| `rules.claim_before_editing` | `boolean` | Agents SHOULD claim files before editing |
| `rules.check_conflicts_before_start` | `boolean` | Agents SHOULD check conflicts before starting |
| `rules.auto_log_to_ledger` | `boolean` | Pre-commit hook appends each commit's result to ledger |
| `rules.default_claim_duration` | `string` | Default claim TTL; `"2h"` = 2 hours. Format: `(\d+)(m\|h\|d)` or an ISO timestamp |

## `claims.json` — lightweight file claims

Prevents two agents editing the same file simultaneously. Each entry is a
`FileClaim`:

```json
[
  {
    "file": "src/auth.ts",
    "agent": "claude",
    "task": "add login flow",
    "claimed_at": "2026-06-20T10:00:00.000Z",
    "expires_at": "2026-06-20T12:00:00.000Z"
  }
]
```

| Field | Type | Semantics |
|---|---|---|
| `file` | `string` | Repo-relative file path |
| `agent` | `string` | Agent name/id holding the claim |
| `task` | `string` | One-line task description |
| `claimed_at` | `string` | ISO timestamp |
| `expires_at` | `string` | ISO timestamp; default 2h, extendable via `extend_claim` |

Semantics:

- **Claim**: `claim_files(files, agent, task, duration?)` — for each file, if
  an unexpired claim exists held by a *different* agent, that file is a
  conflict; otherwise the claim is recorded. Returns `{ claimed, conflicts }`.
- **Release**: `release_files(agent, files?)` — drop the agent's claims (all,
  or just the named files). Returns count released.
- **Extend**: `extend_claim(agent, files, duration)` — push out `expires_at`
  for the named files. Returns `{ extended, not_found }`.
- **Expiry**: claims past `expires_at` are purged on every read. An expired
  claim is treated as if it never existed.
- **Same-agent re-claim**: an agent re-claiming a file it already holds
  replaces (refreshes) its existing claim rather than conflicting.

## `ledger.json` — coordination ledger

Append-only history of completed work. Capped at `OVERREACH_LEDGER_MAX`
entries (default `500`, env-overridable); when full, the oldest entries are
dropped. Each entry is a `LedgerEntry`:

```json
{
  "contract_id": "a1b2c3…",
  "agent": "claude",
  "task": "add login flow",
  "task_id": "AUTH-42",
  "issue_ref": "JIRA-100",
  "files_touched": ["src/auth.ts", "src/db.ts"],
  "findings_count": 0,
  "score": "LOW",
  "mode": "dsl",
  "confidence": 1.0,
  "claim_id": "abc-123",
  "at": "2026-06-20T10:00:00.000Z"
}
```

| Field | Type | Semantics |
|---|---|---|
| `contract_id` | `string?` | Deterministic id of the execution contract, if emitted |
| `agent` | `string` | Agent name/id that did the work |
| `task` | `string` | Task summary (truncated to 200 chars) |
| `task_id` | `string?` | Optional ticket/task id for traceability |
| `issue_ref` | `string?` | Optional issue tracker ref (e.g. `JIRA-100`) |
| `files_touched` | `string[]` | Files changed in this unit of work |
| `findings_count` | `number` | Count of scope findings at audit time |
| `score` | `"LOW"\|"MEDIUM"\|"HIGH"` | Scope-creep score |
| `mode` | `"dsl"\|"inferred"?` | How scope was authorized |
| `confidence` | `number?` | `1.0` for DSL; model-dependent for inferred |
| `claim_id` | `string?` | DSL claim id, if mode=dsl |
| `at` | `string` | ISO timestamp |

> **Field name: `score`, not `scope_creep_score`.** The reference `LedgerEntry`
> type uses `score`. The README loosely calls it `scope_creep_score`; that is
> the name of the field on `CheckResult`, not on `LedgerEntry`. See
> "Discrepancies."

### Dedup

If a `contract_id` is present and an entry with the same `contract_id` already
exists, the append is a no-op (idempotent retries in CI).

### Queries

- **`who_touched(file)`** — return every ledger entry whose `files_touched`
  contains `file` (matched by exact, `*/file` suffix, or `file/*` prefix).
- **`by_agent(agent)`** — case-insensitive filter on `agent`.
- **`file_ownership_map()`** — `{ [file]: [{ agent, task, at }] }`.

## `conflicts.json` — conflict records

```json
{
  "conflict_id": "c1d2e3…",
  "files": ["src/auth.ts"],
  "agents": ["claude", "cursor"],
  "claim_ids": ["<claim-a>", "<claim-b>"],
  "detected_at": "2026-06-20T10:05:00.000Z",
  "status": "open",
  "resolution": {
    "strategy": "block",
    "resolved_at": "2026-06-20T10:10:00.000Z",
    "resolved_by": "user",
    "detail": "Conflict blocked. Files [src/auth.ts] are contested between agents [claude, cursor]. Later agent must wait or pick different files."
  }
}
```

| Field | Type | Semantics |
|---|---|---|
| `conflict_id` | `string` | Opaque identifier (UUID in reference) |
| `files` | `string[]` | The contested files |
| `agents` | `string[]` | All agents involved (including the rejected one) |
| `claim_ids` | `string[]` | Claim ids involved |
| `detected_at` | `string` | ISO timestamp |
| `status` | `"open"\|"resolved"` | Lifecycle state |
| `resolution` | `object?` | Present iff `status=resolved` |
| `resolution.strategy` | `"block"\|"escalate"` | How it was resolved |
| `resolution.resolved_at` | `string` | ISO timestamp |
| `resolution.resolved_by` | `string` | Who/what resolved it |
| `resolution.detail` | `string` | Human-readable resolution summary |

### Resolution strategies

| Strategy | What happens |
|---|---|
| `block` | Later agent must wait or pick different files. The conflict is marked resolved. |
| `escalate` | Flagged for human review. A person decides which agent proceeds. |

`resolve_claim(conflict_id, strategy, resolved_by)` returns
`{ conflict_id, strategy, status, detail }` where `status` is `resolved`,
`not_found`, or `already_resolved`.

### When conflicts are created

- **File-claim collision** via `claim_files` → conflict record created
  automatically.
- **DSL `claim_scope` file collision** → conflict record created
  automatically, `conflict_id` returned to caller.
- **DSL narrowing expansion** → NO conflict record (returns `rejection_reason`
  only).
- **Manual** via the `record_conflict` primitive.

## `prompt.md`

Plain Markdown. The authorized prompt for the current task. The pre-commit
hook reads this file and audits each commit's staged diff against it. When the
file still contains the init template header (`# Overreach — Authorized
Prompt`), the hook skips the audit. Update it whenever you give the agent a new
task.

## Delegation chains and contract TTL

A parent agent may delegate a subtask to a child. The child's authorization
must **narrow** the parent's (see [`scope-dsl.md`](scope-dsl.md)). The full
delegation chain `A → B → C → …` is preserved on the execution contract's
`context.chain` field, so any agent in the chain has complete project context.

Contracts have an optional `expires_at` (ISO timestamp). An expired contract
flags `HIGH` on audit — stale or abandoned agents do not keep committing under
old authorization.

The `ExecutionContract` shape (from `src/contract/schema.ts`):

| Field | Type | Semantics |
|---|---|---|
| `version` | `"1.0"` | Contract schema version |
| `id` | `string` | Deterministic 32-char hex (sha256 of prompt+diff+parent+version) |
| `issued_at` | `string` | ISO timestamp (real wall-clock; NOT part of the id) |
| `expires_at` | `string?` | Optional TTL |
| `identity.root_human` | `string` | Who originated this (placeholder `"user"`) |
| `identity.issuing_agent` | `string?` | Agent that requested the contract |
| `identity.target_agent` | `string?` | Agent that will execute under it |
| `authorization` | `Scope` | The authorized scope object |
| `context.project_goal` | `string?` | Write-once intent on root, inherited by children |
| `context.constraints` | `string[]?` | Inherited immutably by children |
| `context.prior_decisions` | `PriorDecision[]?` | Append-only |
| `context.chain` | `DelegationLink[]?` | Every ancestor's work summarized |
| `audit.prompt_hash` | `string` | sha256 of prompt, truncated to 16 hex chars (non-reversible) |
| `audit.scope_extraction_model` | `string` | Model used for Stage 1 (or `"dsl"` in DSL mode) |
| `audit.reconcile_changed` | `boolean` | Whether the reconcile pass altered scope |
| `audit.findings_at_issue` | `number` | Findings present when the contract was issued |
| `audit.parent_contract_id` | `string?` | If this narrows a parent contract |

`DelegationLink`: `{ contract_id, agent, task, scope_summary, files_touched, findings_count, score, at }`.

> The contract is a **stateless V1 artifact**: immutability of
> `context.constraints` / `project_goal` and append-only `prior_decisions` are
> design intents that only become enforced once a registry/persistence layer
> exists (v2). For now the contract is a pure JSON artifact + a narrowing
> validator.

## Discrepancies vs reference implementation (`overreach` v0.4.0)

1. **Ledger field is `score`, not `scope_creep_score`.** The reference
   `LedgerEntry` type (`src/ledger.ts`) uses `score`. The README calls it
   `scope_creep_score` in the ledger description — that name belongs to
   `CheckResult`, not `LedgerEntry`. This spec uses `score` to match the code.
2. **`config.json` does not list `conflicts.json` or `scopes/`.** The
   reference `init` only writes `coordination.{ledger,claims,prompt}`.
   Implementations SHOULD add `conflicts` and `scopes` paths in their own
   config; the reference config is minimal.
3. **`claims.json` is gitignored, `scopes/` is not.** The reference treats
   lightweight file claims as transient (they expire) but DSL scope claims as
   durable history. This split is deliberate; don't collapse them.
# Scope DSL

**Protocol v0.1.0** · part of the Overreach Protocol Spec

The Scope DSL lets an agent **declare what it will do before writing code**.
The declaration is validated deterministically (zero LLM cost, confidence 1.0),
locked against file collisions with other agents, and later compared to the
actual diff by set arithmetic — the same trust contract as inferred mode, with
the inference step removed.

## The DSL flow

```
1. claim_scope     → declare intent, lock files, get claim_id
2. (do the work)
3. check_overreach → pass claim_id, skip Stage 1 (LLM), deterministic validation
4. complete_scope  → mark claim done, auto-append to ledger
```

## The `claim_scope` payload

```json
{
  "files": {
    "create": ["src/checkout.tsx", "src/api/checkout.ts"],
    "modify": ["src/nav.tsx"],
    "delete": []
  },
  "dependencies": ["@stripe/stripe-js"],
  "env_vars": ["STRIPE_PUBLIC_KEY"],
  "api_routes": ["/api/checkout-session"]
}
```

### Schema

| Field | Type | Required | Semantics |
|---|---|---|---|
| `files.create` | `string[]` | no | Files the agent will create |
| `files.modify` | `string[]` | no | Existing files the agent will edit |
| `files.delete` | `string[]` | no | Files the agent will delete |
| `dependencies` | `string[]` | no | Package names the agent will add |
| `env_vars` | `string[]` | no | Env var names the agent will introduce |
| `api_routes` | `string[]` | no | HTTP routes the agent will add |

All fields optional; every value is a string. Arrays may be empty or omitted.
The union of `files.{create,modify,delete}` is the **claimed file set** used
for collision detection.

> **Notably absent: `cron` and `features`.** The DSL cannot declare cron jobs
> or semantic features — those have no machine-checkable string identity. An
> agent using DSL mode that adds a cron job will always produce a `scope.cron`
> finding. See "Discrepancies" below.

## The `claim_id` concept

A successful `claim_scope` returns:

```json
{
  "claim_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "locked",
  "locked_scope": { "files": { /* … */ }, "dependencies": ["@stripe/stripe-js"] }
}
```

The `claim_id` is an opaque string (UUID in the reference implementation). It
is passed to `check_overreach` (to skip Stage 1) and `complete_scope` (to
finalize). A claim is only usable while its `status` is `locked`.

### Claim record (`ScopeClaim`)

| Field | Type | Semantics |
|---|---|---|
| `claim_id` | `string` | Opaque identifier |
| `mode` | `"dsl"` | Always `dsl` for DSL claims |
| `confidence` | `1.0` | Always 1.0 (deterministic) |
| `agent` | `string` | Agent name/id |
| `task` | `string` | One-line task summary (truncated to 200 chars) |
| `scope` | `ScopeDSL` | The declared payload above |
| `parent_claim` | `string?` | Present if this claim narrows a parent |
| `status` | `enum` | `proposed` \| `locked` \| `completed` \| `rejected` |
| `created_at` | `string` | ISO timestamp |
| `expires_at` | `string` | ISO timestamp; default 2h from creation, extendable |

> **`proposed` is defined in the reference types but never set by the
> `claim_scope` code path** — claims go straight to `locked`. It exists for
> future two-phase commit. Treat it as reserved. See "Discrepancies."

## Parent→child narrowing

When a parent agent delegates to a child, the child's claim must **narrow** the
parent's — it cannot add files or dependencies the parent didn't authorize.

```
Parent claim: files [checkout.tsx, api/checkout.ts], deps [@stripe/stripe-js]
  Child (narrows):  files [checkout.tsx]           -> allowed, locked
  Child (expands):  files [billing.tsx]            -> rejected
  Child (expands):  deps  [redis]                  -> rejected
```

Rules (from `src/contract/narrow.ts` and `src/scope_dsl.ts`):

- **Files**: every file in the child's claimed set must be a member of the
  parent's claimed set. Matching is **exact-normalized** (case-insensitive,
  alnum-only) — no fuzzy matching. `stripe` in the parent does NOT cover
  `stripe-webhook` in the child; that is expansion, the very thing forbidden.
- **Dependencies**: same exact-normalized membership test.
- **Env vars and api routes**: narrowing is advisory-only in the reference
  implementation's DSL path (the `claimScope` function only gates files and
  deps). The contract layer (`isNarrower`) gates all four concrete fields. See
  "Discrepancies."
- **Features / behavioral changes**: never gated — too semantic for string
  equality. A vague root prompt ("build a todo app") yields no concrete
  authorizations, so narrowing against it is **advisory, not a gate**.

### Rejection creates a conflict record

A rejection due to **file collision** with another agent's active claim
automatically creates a `ConflictRecord` in `.overreach/conflicts.json` and
returns a `conflict_id`. A rejection due to **narrowing expansion** does NOT
create a conflict record — it returns a `rejection_reason` only.

Rejection response (file conflict):

```json
{
  "claim_id": "",
  "status": "rejected",
  "conflicts": [
    { "file": "src/auth.ts", "held_by": "cursor", "claim_id": "<other-claim-id>" }
  ],
  "conflict_id": "<new-conflict-id>",
  "rejection_reason": "File conflicts with cursor"
}
```

Rejection response (narrowing expansion):

```json
{
  "claim_id": "",
  "status": "rejected",
  "rejection_reason": "Child scope expands parent: files [billing.tsx] not in parent claim <id>"
}
```

The `conflict_id` can be passed to `resolve_claim` with strategy `block` or
`escalate` (see [`coordination-format.md`](coordination-format.md)).

## DSL mode vs inferred mode

| | DSL mode | Inferred mode |
|---|---|---|
| **How authorized scope is obtained** | Agent declares via `claim_scope` | LLM extracts from prompt (Stage 1) |
| **Confidence** | `1.0` (deterministic) | ~0.85 (depends on model) |
| **API cost** | Zero | One LLM call |
| **Stage 1 (scope extraction)** | Skipped entirely | Runs |
| **Stages 2 & 3** | Run (deterministic) | Run (deterministic) |
| **Use when** | Agent knows exactly what it will touch | Ad-hoc prompt auditing |

Both modes produce the same `CheckResult` shape; `mode` and `confidence`
distinguish them. The trust contract is identical: findings are
`actual − authorized`, derivable by set arithmetic.

## `complete_scope`

Marks a claim done. Sets `status` to `completed`, which removes its files from
the active-claim collision set (so other agents can claim them). Appends a
synthetic `CheckResult` to `.overreach/ledger.json` with:

| Ledger field | Value for DSL completion |
|---|---|
| `mode` | `"dsl"` |
| `confidence` | `1.0` |
| `claim_id` | the claim's id |
| `score` | `"LOW"` (the declaration matched by construction) |
| `findings_count` | `0` |
| `files_touched` | union of `files.{create,modify,delete}` |

> **`complete_scope` does NOT release entries in `claims.json`** (the
> lightweight file-claim file). It only completes the **scope claim**. File
> claims are released separately via `release_files`. See "Discrepancies."

## Concrete end-to-end example

```jsonc
// 1. claim_scope
{
  "files": { "create": ["src/checkout.tsx"], "modify": ["src/nav.tsx"] },
  "dependencies": ["@stripe/stripe-js"],
  "env_vars": ["STRIPE_PUBLIC_KEY"],
  "api_routes": ["/api/checkout-session"]
}
// -> { "claim_id": "abc-123", "status": "locked", "locked_scope": {…} }

// 2. agent writes the code

// 3. check_overreach({ claim_id: "abc-123", diff: <git diff> })
//    Stage 1 skipped. Stage 2 parses diff. Stage 3: actual − declared = findings.
// -> { "mode": "dsl", "confidence": 1.0, "findings": [], "scope_creep_score": "LOW" }

// 4. complete_scope({ claim_id: "abc-123" })
//    -> status "completed", ledger entry appended with mode=dsl, confidence=1.0
```

## Discrepancies vs reference implementation (`overreach` v0.4.0)

These are places where this spec describes the reference code in
`src/scope_dsl.ts` / `src/contract/narrow.ts` faithfully, but where the
reference README is loose or where the type allows states the code doesn't
produce. The spec records them so implementers don't deviate.

1. **`proposed` status is never set.** `ScopeClaim.status` is typed as
   `proposed | locked | completed | rejected`, but `claimScope` only ever
   writes `locked` or `rejected`. `proposed` is reserved for future two-phase
   commit. Implementations MAY omit it.
2. **Narrowing gates files and deps only (DSL path).** `claimScope`'s
   parent-narrowing check validates files and dependencies, but NOT env_vars or
   api_routes. The separate contract layer (`isNarrower`) gates all four
   concrete fields. The spec recommends gating all four; the reference DSL
   path does not yet.
3. **`complete_scope` does not release `claims.json` entries.** It only
   completes the scope claim. Lightweight file claims (the `claim_files` /
   `release_files` API) are a separate file and a separate lifecycle.
4. **No `cron` or `features` in the DSL.** `ScopeDSL` has no field for cron
   jobs or semantic features. DSL-declared work that adds a cron job always
   yields a `scope.cron` finding.
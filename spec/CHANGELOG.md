# Changelog

All notable changes to the Overreach Protocol Spec.

The protocol is younger than the reference implementation (`overreach` npm).
While the protocol is at `0.x`, breaking changes may land in any release. Once
`1.0.0` ships, breaking changes bump the major version.

## 0.1.1 — 2026-06-23

### Added
- `scope.listener` — a 7th deterministic finding kind. The diff-vs-prompt gate
  now flags an unauthorized runtime listener: a server opening a port
  (`.listen(8080)`), a `WebSocket`/`http`/`net` server constructor, or a
  global-object event handler (`process.on`, `window`/`document`/`self`
  `.addEventListener`). Same HIGH-severity runtime-surface class as
  `scope.endpoint`/`scope.env`/`scope.cron`. Purely deterministic — the call is
  literally in the diff. Generic element `.addEventListener` (UI events) is
  intentionally NOT a finding (feature-scope, not a runtime surface).
- `Actual.listeners_added` — the corresponding `actual`-surface field
  (`string[]`). Additive: existing consumers that ignore unknown fields are
  unaffected.

### Trust contract
- The frozen deterministic finding set grows from six to seven kinds. The
  invariant is unchanged: every `scope.*` finding remains derivable from
  (prompt, diff) by set arithmetic. `scope.listener` amends the set by the
  stated justification in the reference implementation's `CLAUDE.md`, not by
  inference.

## 0.1.0 — 2026-06-23

Initial public draft. Extracted from the `overreach` v0.4.0 reference
implementation. Faithful to the on-disk shapes in
`src/{claims,scope_dsl,ledger,resolve,contract/*,init}.ts` and the types in
`src/types.ts`.

### Added
- `README.md` — vendor-neutral intro, trust-contract invariant, versioning
  policy ("breaking changes expected until v1.0"), reference-implementation
  framing.
- `scope-dsl.md` — the `claim_scope` JSON schema, `ScopeClaim` record, the
  `claim_id` concept, parent→child narrowing rules (exact-normalized
  membership; files + deps gated, env + routes advisory in the DSL path),
  rejection→conflict-record behavior, DSL vs inferred mode table,
  `complete_scope` ledger semantics.
- `coordination-format.md` — the `.overreach/` file set: `prompt.md`,
  `config.json`, `claims.json` (lightweight file claims, 2h default TTL),
  `ledger.json` (capped at 500 entries, `score`/`mode`/`confidence`/`claim_id`
  fields, `who_touched` query semantics), `conflicts.json` (record fields,
  `block`/`escalate` strategies), `scopes/index.json` + per-claim files,
  delegation chains + contract TTL, `ExecutionContract` shape.
- `SCHEMA.json` — JSON Schema (draft 2020-12) bundling `ScopeDSL`, `Scope`,
  `ScopeClaim`, `FileClaim`, `LedgerEntry`, `ConflictRecord`, `Config`,
  `ExecutionContract`, `DelegationLink`, `PriorDecision` for machine
  validation.

### Known discrepancies (spec vs reference; spec records reality)
- Ledger field is `score`, not `scope_creep_score` (README is loose).
- `ScopeClaim.status` includes `proposed`, but `claimScope` never sets it.
- `complete_scope` completes the scope claim only; it does not release
  `claims.json` entries.
- DSL narrowing gates files + deps; env_vars and api_routes are advisory in
  the DSL path (the contract layer gates all four).
- `ScopeDSL` has no `cron` or `features` field — DSL-declared cron always
  yields a `scope.cron` finding.
- `config.json` from `init` does not list `conflicts.json` or `scopes/` paths.

### Not yet specified (reserved for later)
- Two-phase claim commit (`proposed` → `locked`).
- Registry/persistence layer that enforces `context` immutability and
  append-only `prior_decisions` on contracts (v2).
- Streamable HTTP transport, MCP tool surface, CI gate (out of scope for the
  on-disk protocol).
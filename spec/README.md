# Overreach Protocol Spec

**Version:** 0.1.1  ·  **Status:** Breaking changes expected  ·  **License:** MIT

A vendor-neutral protocol for two things every AI coding agent needs:

1. **Deterministic scope declaration** — an agent declares what it WILL touch
   before writing code, and a diff is later checked against that declaration by
   set arithmetic. No inference, no LLM, no opinion.
2. **Cross-vendor agent coordination** — multiple agents (Claude Code, Cursor,
   Codex, or any future one) working on the same repo exchange who-touched-what
   state via JSON files committed to git. No vendor lock-in.

This is a **protocol spec**, not a tool. Any agent can implement it without
depending on the Overreach tool. The npm package
[`overreach`](https://www.npmjs.com/package/overreach) is the **reference
implementation** — it is not a dependency of this spec.

## Why this exists

AI coding agents overreach: asked to add a login form, they also add Stripe, an
env var, an endpoint, and a cron job. Reactive review (after the diff exists)
catches some of it; coordination between *different vendors'* agents catches
none of it. This spec encodes the contract that closes both gaps
deterministically.

## The trust contract (sacred invariant)

**Every scope finding is derivable from (prompt, diff) by deterministic set
arithmetic. No finding depends on inference or opinion.**

- Stage 2 (parse the diff) and Stage 3 (`actual − authorized`) are pure
  functions. Anything requiring inference (intent, completeness, success) does
  NOT belong in the `scope.*` finding set.
- Findings of different trust levels (fact vs opinion) must NEVER share one
  output list — mixing them collapses the whole list to the lowest trust level
  present.
- The deterministic finding kinds are frozen: `scope.file`, `scope.feature`,
  `scope.dep`, `scope.endpoint`, `scope.env`, `scope.cron`, `scope.listener`.

This spec encodes that contract. An implementation that weakens it is not
conformant.

## What's in this spec

| Document | Covers |
|---|---|
| [`scope-dsl.md`](scope-dsl.md) | The `claim_scope` JSON schema, `claim_id`, parent→child narrowing, DSL vs inferred mode, `complete_scope` |
| [`coordination-format.md`](coordination-format.md) | The `.overreach/` on-disk file set: `claims.json`, `ledger.json`, `conflicts.json`, `config.json`, `prompt.md` |
| [`SCHEMA.json`](SCHEMA.json) | Machine-readable JSON Schema (draft 2020-12) bundling all shapes for validation |
| [`CHANGELOG.md`](CHANGELOG.md) | Revision history |

## Versioning policy

**v0.1.0 — breaking changes expected.** We version aggressively while the
protocol is young. Field names, file layouts, and semantics may change between
minor bumps without notice. **Adopt at your own risk until v1.0.** Once v1.0
ships, breaking changes will bump the major version and old clients will remain
parseable via `schema_version`.

The reference implementation (`overreach` npm) currently emits
`schema_version: "1.0"` on its `CheckResult` payload; that is the *tool's*
egress version, independent of this *protocol's* version (0.1.0). Do not
conflate the two.

## Stability note

This is the initial public draft. It is faithful to the reference
implementation as of `overreach` v0.4.0, but the protocol is younger than the
tool — expect the spec to harden (and occasionally break) before v1.0. Pin to a
tag, not a branch.
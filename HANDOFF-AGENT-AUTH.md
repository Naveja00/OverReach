# Overreach → Agent Authorization Layer — Session Handoff

> Paste this entire document as context for the next session. It contains everything
> that was decided, designed, and validated across two prior sessions. Do not re-derive
> any of this — treat it as settled decisions and build from here.

---

## WHAT EXISTS AND IS PROVEN

Overreach is a working MCP tool at `C:\Users\mnave\Desktop\Overreach`. Read its
`CLAUDE.md` for full build spec. Here's what matters for this session:

**The primitive works.** Overreach converts natural-language prompts into deterministic
scope objects and audits code diffs against them. It catches unauthorized deps, env vars,
endpoints, cron jobs, files, and features.

**Test results (all green, all on real repos):**
- deterministic (zero-key): 52/52
- cloud e2e: 17/17
- simulate: 26/26 (3 consecutive flake-free runs, open-source Stripe repos, small→huge)
- simulate:large: 31/31 (884-char multi-feature prompt, sectioned map-reduce + reconcile)
- simulate:stress: 9/9 (real files fetched from vercel/commerce + shadcn/taxonomy over HTTPS)

**Architecture:** 3-stage pipeline.
- Stage 1: LLM scope extraction (map-reduce for long prompts + reconcile pass). Only LLM call.
- Stage 2: Deterministic regex diff parser. Zero LLM. 2-4ms on 127-line diffs.
- Stage 3: Deterministic set arithmetic compare with fuzzy matching.

**The reconcile pass is the key innovation.** Most systems trust the first extraction.
Overreach assumes "the model may have made a mistake" and verifies everything again
before producing the scope object. This is how traditional security systems work —
firewalls, database transactions, distributed systems all assume components can fail
and require validation checkpoints.

---

## WHAT TO BUILD THIS SESSION

### 1. Reconcile Disagreement Telemetry (do first, ~30 min)

Wire instrumentation into the reconcile pass to record when it diverges from the
initial map-reduce extraction. Emit a telemetry field per run:

```json
{
  "reconcileChanged": true,
  "added": ["items reconcile added that map-reduce missed"],
  "removed": ["items reconcile removed as contradictions"],
  "disagreementRate": 0.15
}
```

This goes into the return object of `check_overreach` as an optional `telemetry` field.
The number directly measures how hard the long-prompt problem is and how much the
reconcile architecture earns its keep.

### 2. False-Denial Fixture Set (do second)

Build a new simulation file `tests/simulate_false_denial.ts` using the same harness
pattern as `tests/simulate.ts`. These are cases where everything LOOKS like overreach
but the prompt authorized all of it. The system must pass them clean (0 findings, LOW).

Cases to build:

| Case | Prompt | What the diff includes | Why it's tricky |
|------|--------|----------------------|-----------------|
| FD-01 | "Add Stripe billing with a /api/checkout endpoint and STRIPE_SECRET env var" | stripe dep, env var, checkout route | Looks like the canonical overreach case but prompt authorized everything |
| FD-02 | "Refactor auth to use JWT" | Touches 8+ files across auth/, middleware/, utils/ | Huge blast radius but all implied by refactor |
| FD-03 | "Add email notifications using nodemailer" | nodemailer dep, SMTP_HOST env, /api/notify route | Prompt says one thing, implies full dependency chain |
| FD-04 | "Add OAuth login with Google" | google-auth dep, GOOGLE_CLIENT_ID + GOOGLE_SECRET env, /api/auth/callback route, session changes | 4 words in prompt, 15 changes in diff |
| FD-05 | "Migrate the API from Express to Fastify" | Rewrites every route file, swaps dep, changes server.ts | Massive surface, all authorized |
| FD-06 | "Add dark mode with persistent preference" | CSS vars, layout component, localStorage helper, context provider | Cascading changes all inferred from one feature |
| FD-07 | "Set up Sentry error tracking" | @sentry/react dep, SENTRY_DSN env, error boundary component | Prompt explicitly names Sentry — nothing is unauthorized |
| FD-08 | "Add a Redis cache layer to the API, reading REDIS_URL from env" | redis dep, REDIS_URL env, cache wrapper utility | Everything is explicitly authorized in prompt |

Add to package.json scripts: `"simulate:false-denial": "tsx tests/simulate_false_denial.ts"`

Expected result: ALL cases pass clean. False-denial rate = 0%.

### 3. Execution Contract Schema (the product evolution)

Overreach currently outputs `{scope, actual, findings, scope_creep_score, summary}`.
Evolve this into a versioned execution contract that downstream agents can consume
as their authorization document.

Create `src/contract/schema.ts` with the contract type:

```typescript
interface ExecutionContract {
  version: "1.0",
  id: string,                    // unique contract ID (uuid)
  issued_at: string,             // ISO timestamp
  expires_at?: string,           // optional TTL

  // WHO
  identity: {
    root_human: string,          // who originated this (placeholder for now)
    issuing_agent?: string,      // which agent requested the contract
    target_agent?: string,       // which agent will execute under this contract
  },

  // WHAT (this is the existing scope object, promoted to contract level)
  authorization: {
    files_allowed: string[],
    features_allowed: string[],
    endpoints_allowed: string[],
    deps_allowed: string[],
    env_allowed: string[],
    behavioral_changes_allowed: string[],
  },

  // CONTEXT (new — project-level awareness)
  context: {
    project_goal?: string,       // what the project is trying to accomplish
    constraints?: string[],      // things explicitly ruled out
    prior_decisions?: Array<{
      what: string,
      why: string,
      by: string,
      at: string,
    }>,
  },

  // AUDIT (new — chain of evidence)
  audit: {
    prompt_hash: string,         // hash of the original prompt
    scope_extraction_model: string,
    reconcile_changed: boolean,
    findings_at_issue: number,   // how many findings existed when contract was issued
    parent_contract_id?: string, // if this narrows a parent contract
  },
}
```

Add a new option to `check_overreach`:
```
check_overreach(prompt, diff, { emitContract: true }) → { ...existing, contract: ExecutionContract }
```

**Critical rule:** A contract derived from a parent contract can only NARROW scope,
never expand it. If `parent_contract_id` is set, validate that every field in
`authorization` is a subset of the parent's authorization. Reject with an error if
scope expansion is attempted.

### 4. Handoff Validation (the agent-to-agent layer)

Create `src/handoff/validate.ts` with three checks that run at agent-to-agent boundaries:

**Check 1 — Scope check (deterministic, already exists):**
This is the existing `check_overreach` pipeline. Wrap it so it can be called as
`validateHandoff(contract, instruction, diff)`.

**Check 2 — Context consistency check (LLM verifier, NEW):**
A small/fast LLM call that checks: "Does this instruction make sense given the project
context and prior decisions in the contract?"

System prompt:
```
You are a consistency verifier. Given a project context and an agent instruction,
determine if the instruction is consistent with the project's goals and constraints.
Output JSON: { "consistent": true/false, "reason": "one sentence" }
Do NOT evaluate code quality. Only check logical consistency with stated context.
```

**Check 3 — Reasoning integrity check (LLM verifier, NEW):**
A small/fast LLM call that checks: "Does the agent's stated reasoning match what
it's actually asking to do?"

System prompt:
```
You are a reasoning verifier. Given an agent's stated reasoning and its actual
instruction, determine if the reasoning supports the instruction.
Output JSON: { "aligned": true/false, "reason": "one sentence" }
Flag cases where the reasoning describes one thing but the instruction does another.
```

**Both checks 2 and 3 are ADVISORY, not authoritative.** They flag inconsistencies
in the return object but do not hard-block. The deterministic scope check (check 1)
is the only hard gate.

Wire the handoff validator:
```
validateHandoff(parentContract, handoff) → {
  scopeCheck: { ...existing findings },
  contextCheck: { consistent: bool, reason: string },
  reasoningCheck: { aligned: bool, reason: string },
  decision: "allow" | "flag" | "deny",
  newContract: ExecutionContract  // narrowed from parent
}
```

Decision logic:
- `deny` if scope check finds HIGH severity findings
- `flag` if context or reasoning checks fail (advisory — log it, don't block)
- `allow` if all three pass

### 5. Wire Into FounderSignal Pipeline (integration test)

The user has a multi-agent pipeline in FounderSignal (`C:\Users\mnave\Desktop\FounderSignal`)
that does: user idea → build agent → review agent → ship agent.

**Do NOT modify FounderSignal.** Instead, build a standalone simulation in Overreach
that mimics the handoff pattern:

Create `tests/simulate_handoff.ts`:
1. Start with a user idea prompt (e.g., "Build a todo app with auth")
2. Generate a root contract from the prompt
3. Simulate a build agent producing a diff
4. Validate the handoff: root contract + build agent's diff → narrowed contract
5. Simulate a review agent producing fixes
6. Validate the handoff: narrowed contract + review agent's diff → final contract
7. Assert: scope only narrowed, never expanded. Smuggled items caught at each handoff.

This proves the agent-to-agent layer works without touching FounderSignal's code.

---

## WHAT NOT TO BUILD (explicitly deferred)

- **Behavioral baselines** — needs real multi-user usage data. Not buildable yet.
- **Continuous authentication** — Phase 3+. Simple identity tracking is enough for now.
- **Cryptographic signing of contracts** — hash the contract for tamper evidence, but
  skip full PKI/signing infrastructure. Premature.
- **The full 6-layer security model** — over-designed for current stage. Build scope +
  context + audit. Identity is a simple registry. Behavioral and resource layers come later.
- **Enterprise wrapper/injection** — important but needs a real integration target.
  Deferred until the contract schema is stable.

---

## KNOWN PROBLEMS TO DESIGN AROUND (from strawman analysis)

These were identified and accepted as engineering challenges, not blockers:

1. **Context object bloat** — design for summarization from the start. The `context`
   field in the contract should have a max size. If `prior_decisions` exceeds N entries,
   summarize older ones.

2. **Mutable context exploitation** — an agent that can write to project context can
   redefine constraints in its own favor. Solution: `constraints` and `project_goal`
   are WRITE-ONCE on the root contract. Child contracts inherit them immutably.
   Only `prior_decisions` is appendable.

3. **LLM verifier is also an LLM** — the context and reasoning checks can be wrong
   or manipulated. This is why they're advisory, not authoritative. The deterministic
   scope check is the hard gate. Be transparent about this in any documentation.

4. **Reasoning fabrication** — agents can fabricate plausible reasoning. The reasoning
   check catches obvious mismatches but cannot detect sophisticated fabrication.
   Accept this limitation; it's still better than no check.

5. **Latency** — three checks per handoff adds latency. For V1 this is acceptable.
   Later: async validation for low-risk operations, sync for high-risk.

---

## THE STRATEGIC FRAMING (for documentation / blog post)

The primitive Overreach provides:
**"Convert unstructured natural-language intent into deterministic machine-enforceable
permissions before any AI agent can act."**

The pattern name: **Prompt Admission Controller**
(analogous to Kubernetes admission controllers)

The product categories this maps to:
- AI Contract Layer (most novel)
- Agent-to-Agent Authorization / "OAuth for Agents"
- AI Change Management
- Enterprise AI IAM

The competitive position: nobody else is doing scope extraction from natural language.
Lakera/HiddenLayer do prompt classification (safe/unsafe). OPA/Cedar need structured
input. LangChain requires manual permission definitions. Overreach derives permissions
from the prompt itself.

---

## BUILD ORDER FOR THIS SESSION

1. Reconcile disagreement telemetry (~30 min)
2. False-denial fixture set + run green (~1 hr)
3. Contract schema + `emitContract` option (~1 hr)
4. Handoff validation with 3 checks (~1.5 hr)
5. Handoff simulation test (~1 hr)
6. Run all suites, confirm nothing regressed

**Hard constraint:** Overreach is FULLY STANDALONE. It does NOT import from or connect
to FounderSignal. The FounderSignal `.env` is used ONLY as a source of the cloud API
key at runtime, sourced inline into the shell env. NEVER write the key into Overreach.

**Run commands (unchanged):**
- `npm test` — deterministic, zero key
- `npm run test:e2e` — cloud e2e
- `npm run simulate` — 26 cases
- `npm run simulate:large` — 4 large cases
- `npm run simulate:stress` — real repos
- Cloud key sourcing: `set -a; . /c/Users/mnave/Desktop/FounderSignal/.env; set +a; SCOPE_PROVIDER=ollama OLLAMA_BASE_URL=https://ollama.com OVERREACH_MODEL=glm-5.2 npm run <script>`

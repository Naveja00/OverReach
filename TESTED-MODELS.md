# Tested Models

Overreach's scope-extraction stage (Stage 1) is the only LLM step, so model
choice matters. The deterministic stages (2 and 3) are model-independent and
covered by a zero-key suite (45/45, no LLM). This page reports the
**model-dependent** battery — `e2e` (17), `simulate` (26), `large` (31), and
`false-denial` (8) — run through the REAL pipeline (live scope extraction →
deterministic parse → set-arithmetic compare) per model.

This is a **measurement**, not a 100%-green claim. The frozen v1.0 contract is
held constant across all models; a weaker model is documented here as-is, not
chased by overfitting the pipeline to make it pass.

## Results (consolidated across runs)

| Model | Provider / format | e2e | simulate | large | false-denial | overall | status |
|---|---|---|---|---|---|---|---|
| claude-sonnet-4-6 | Anthropic native | 17/17 | 26/26 | 31/31 | 8/8 | **82/82** | ✅ recommended |
| claude-opus-4-6 | Anthropic native | — | 26/26 | 31/31 | 8/8 | **65/65** | ✅ verified |
| glm-5.2 | Ollama Cloud | 17/17 | 26/26 | 31/31 | 8/8 | **82/82** | ✅ recommended |
| kimi-k2.7-code | Ollama Cloud | 17/17 | 26/26 | 31/31 | 8/8 | **82/82** | ✅ supported |
| minimax-m3 | Ollama Cloud | 16/17¹ | 26/26 | 31/31 | 8/8 | **81/82** | ✅ supported (99%) |

¹ minimax-m3 **consistently** scores 81/82 — on every run that completes the
e2e suite it misses the same one case: it extracts `logout button` as a feature
but not the navbar target, so the navbar file looks unauthorized. A consistent
model-specific extraction miss, not cloud noise (and not a pipeline bug — the
other four models pass that case). One re-run ERRORED mid-suite on a transient
Ollama Cloud outage; the three substantive suites pass clean (65/65) on every
run that completes.

## How to reproduce

```bash
# zero-key deterministic suite (model-independent, 45/45)
npm test

# full model-dependent battery (needs a provider key in the env)
npm run harness           # all configured targets, parallel
npm run test:e2e          # 17 canonical cases
npm run simulate          # 26 varied cases
npm run simulate:large    # 31 assertions across 4 big scenarios
npm run simulate:false-denial  # 8 false-positive guards
```

Pin a provider/model with `SCOPE_PROVIDER` + `OVERREACH_MODEL`. Rate-limit a
provider with `OVERREACH_CALL_MIN_INTERVAL_MS` (ms between LLM calls). Slice a
loop suite with `HARNESS_MAX_CASES=N`.
// Reachability probe WITH RETRY.
//
// Problem this fixes: every suite used to do ONE pre-flight extractScope() call
// and SKIP the whole suite on any warning matching /failed|parse/. A single
// transient JSON-parse glitch or a momentary 429 would erase 26+ assertions and
// undercount the multi-model matrix (a model that actually passes would show
// "SKIP" instead of its real score).
//
// This is a MEASUREMENT-HONESTY fix, not a pass-chasing tweak: it changes what
// gets *measured*, never whether a model passes. The probe prompt and the
// suite's assertions are untouched. We only retry the gate call so a blip
// doesn't blank a suite.
//
// For quota/rate-limit warnings (429 / RESOURCE_EXHAUSTED) we back off longer,
// and if every attempt still fails we report unreachable — we do NOT loop
// indefinitely. A model that is genuinely quota-capped (e.g. Gemini free tier,
// 5 req/min) will still surface as unreachable here, which is the honest
// outcome for a battery that makes many calls.
import { extractScope } from "../../src/scope/extract_scope.js";
import type { Scope } from "../../src/types.js";

export async function probeReachable(
  prompt = "add a hello function",
  attempts = 3,
  baseDelayMs = 1500,
): Promise<{ ok: boolean; warning?: string; scope?: Scope }> {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const r = await extractScope(prompt);
    if (!r.warning || !/failed|parse/i.test(r.warning)) return { ok: true, warning: r.warning, scope: r.scope };
    last = r.warning;
    if (i === attempts - 1) break;
    const quota = /429|quota|resource_exhausted|rate.?limit/i.test(r.warning);
    const delay = baseDelayMs * (quota ? 6 : 1) * (i + 1);
    await new Promise((res) => setTimeout(res, delay));
  }
  return { ok: false, warning: last };
}
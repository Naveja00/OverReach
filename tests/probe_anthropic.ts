// Focused Anthropic probe: find a working Claude model ID for the given key.
// Prints the FULL warning/error (not truncated) + extracted scope.
import { extractScope } from "../src/scope/extract_scope.js";

const MODELS = (process.env.PROBE_MODELS || "claude-sonnet-4-6,claude-opus-4-8,claude-sonnet-4-5-20250929,claude-haiku-4-5-20251001")
  .split(",").map((s) => s.trim()).filter(Boolean);

async function main() {
  const prev = { p: process.env.SCOPE_PROVIDER, m: process.env.OVERREACH_MODEL };
  process.env.SCOPE_PROVIDER = "anthropic";
  for (const model of MODELS) {
    process.env.OVERREACH_MODEL = model;
    console.log(`\n══ ${model} @ anthropic ══`);
    try {
      const r = await extractScope("add a login form to the settings page");
      console.log(`  warning: ${r.warning || "NONE"}`);
      if (r.scope) console.log(`  features: ${JSON.stringify(r.scope.features_allowed)}  files: ${JSON.stringify(r.scope.files_allowed)}`);
    } catch (e) {
      console.log(`  THREW: ${(e as Error).message}`);
    }
  }
  if (prev.p === undefined) delete process.env.SCOPE_PROVIDER; else process.env.SCOPE_PROVIDER = prev.p;
  if (prev.m === undefined) delete process.env.OVERREACH_MODEL; else process.env.OVERREACH_MODEL = prev.m;
}
main().catch((e) => { console.error("crashed:", e); process.exit(2); });
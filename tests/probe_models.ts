// Diagnostic: capture exactly why the non-glm Ollama Cloud models self-skip the
// battery. Runs the SAME probe prompt the suites use ("add a hello function") and
// the harness ping prompt ("add a login form to the settings page") against each
// model, printing the extracted scope + any warning. This is data-gathering, not a
// fix: we record WHY a model can't be measured, then document it.
//
// Run:  set -a; . /c/Users/mnave/Desktop/FounderSignal/.env; set +a
//       npx tsx tests/probe_models.ts

import { extractScope } from "../src/scope/extract_scope.js";

const MODELS = (process.env.PROBE_MODELS || "gemma3,qwen2.5,deepseek-r1,glm-5.2")
  .split(",").map((s) => s.trim()).filter(Boolean);

const PROMPTS = [
  "add a hello function",
  "add a login form to the settings page",
];

async function main() {
  const prev = { p: process.env.SCOPE_PROVIDER, m: process.env.OVERREACH_MODEL, b: process.env.OLLAMA_BASE_URL };
  process.env.SCOPE_PROVIDER = "ollama";
  process.env.OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "https://ollama.com";
  for (const model of MODELS) {
    process.env.OVERREACH_MODEL = model;
    console.log(`\n══ ${model} @ ollama ══`);
    for (const prompt of PROMPTS) {
      process.stdout.write(`  prompt: "${prompt}"  →  `);
      try {
        const r = await extractScope(prompt);
        const s = r.scope;
        const counts = `f=${s.features_allowed.length} fi=${s.files_allowed.length} e=${s.endpoints_allowed.length} d=${s.deps_allowed.length} env=${s.env_allowed.length}`;
        console.log(`${counts}  warning=${r.warning ? JSON.stringify(r.warning) : "none"}`);
        if (s.features_allowed.length || s.files_allowed.length) {
          console.log(`    features=${JSON.stringify(s.features_allowed)} files=${JSON.stringify(s.files_allowed)}`);
        }
      } catch (e) {
        console.log(`THREW: ${(e as Error).message}`);
      }
    }
  }
  // restore
  for (const [k, v] of [["SCOPE_PROVIDER", prev.p], ["OVERREACH_MODEL", prev.m], ["OLLAMA_BASE_URL", prev.b]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
main().catch((e) => { console.error("probe crashed:", e); process.exit(2); });
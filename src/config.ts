// Configuration. Overreach is fully standalone — it does NOT import or depend
// on any other project. Read secrets only from this process's environment.
//
// IMPORTANT: secrets + the model/base-url overrides are read LIVE from
// process.env at call time (via the *Key() / ollamaBaseUrl() helpers and inside
// resolveProvider/resolveModel), NOT captured into module-load consts. Capturing
// them at import time silently ignored later env changes — which made the
// multi-model harness ping every target as the frozen default model regardless
// of OVERREACH_MODEL, and made in-process provider/key switches (tests group [9],
// probe scripts) not take effect. Live reads fix that.

export type Provider = "anthropic" | "openai" | "ollama";

// Per-provider default models. Override any of them via OVERREACH_MODEL.
export const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
export const OPENAI_MODEL = "gpt-4o-mini";
export const OLLAMA_MODEL = "glm-5.2"; // Ollama Cloud (ollama.com) uses bare model names

// Default 0 = stdio (what Claude Desktop / Cursor need for `npx overreach`).
// Set PORT=8787 to serve Streamable HTTP instead. Reading it once at boot is
// fine — the server only binds at startup.
export const PORT = parseInt(process.env.PORT || "0", 10);

function looksReal(key: string): boolean {
  return Boolean(key && !key.includes("your_") && key.length > 8);
}

// Live-reading accessors for secrets / endpoint. A process may set or clear these
// after this module is imported (tests, harness ping, scope cache) and the next
// call sees the current value.
export function anthropicKey(): string { return process.env.ANTHROPIC_API_KEY || ""; }
export function openaiKey(): string { return process.env.OPENAI_API_KEY || ""; }
export function ollamaKey(): string { return process.env.OLLAMA_API_KEY || ""; }
export function ollamaBaseUrl(): string { return process.env.OLLAMA_BASE_URL || "http://localhost:11434"; }

// Resolve the effective provider given what's actually configured. Read env live
// so tests (and runtime overrides) can force a specific provider.
export function resolveProvider(): Provider {
  const forced = process.env.SCOPE_PROVIDER as Provider | "auto" | undefined;
  if (forced && forced !== "auto") return forced;
  if (looksReal(anthropicKey())) return "anthropic";
  if (looksReal(openaiKey())) return "openai";
  return "ollama"; // local + keyless fallback
}

// Resolve the model for the given provider. OVERREACH_MODEL overrides per-call
// (read live so the harness can switch models in-process between targets).
export function resolveModel(provider: Provider): string {
  const override = process.env.OVERREACH_MODEL;
  if (override) return override;
  switch (provider) {
    case "anthropic":
      return ANTHROPIC_MODEL;
    case "openai":
      return OPENAI_MODEL;
    case "ollama":
      return OLLAMA_MODEL;
  }
}
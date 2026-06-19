// Configuration. Overreach is fully standalone — it does NOT import or depend
// on any other project. Read secrets only from this process's environment.

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
// Ollama needs no key for a local install; the var is optional (Ollama Cloud /
// secured endpoints may set one). Detected automatically when present.
export const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

// Which Stage 1 backend to use. "auto" = prefer Anthropic, then OpenAI, then
// Ollama (local, keyless) — so a machine with no API keys still works end-to-end.
export type Provider = "anthropic" | "openai" | "ollama";

// Per-provider default models. Override any of them via OVERREACH_MODEL.
export const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
export const OPENAI_MODEL = "gpt-4o-mini";
export const OLLAMA_MODEL = "glm-5.2"; // Ollama Cloud (ollama.com) uses bare model names
export const SCOPE_MODEL = process.env.OVERREACH_MODEL || "";

export const PORT = parseInt(process.env.PORT || "8787", 10);

function looksReal(key: string): boolean {
  return Boolean(key && !key.includes("your_") && key.length > 8);
}

// Resolve the effective provider given what's actually configured. Read env live
// so tests (and runtime overrides) can force a specific provider.
export function resolveProvider(): Provider {
  const forced = process.env.SCOPE_PROVIDER as Provider | "auto" | undefined;
  if (forced && forced !== "auto") return forced;
  if (looksReal(ANTHROPIC_API_KEY)) return "anthropic";
  if (looksReal(OPENAI_API_KEY)) return "openai";
  return "ollama"; // local + keyless fallback
}

export function resolveModel(provider: Provider): string {
  if (SCOPE_MODEL) return SCOPE_MODEL;
  switch (provider) {
    case "anthropic":
      return ANTHROPIC_MODEL;
    case "openai":
      return OPENAI_MODEL;
    case "ollama":
      return OLLAMA_MODEL;
  }
}
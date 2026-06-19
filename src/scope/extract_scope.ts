// Stage 1 — EXTRACT SCOPE. The ONLY LLM step. Turns the natural-language prompt
// into a structured "authorized surface". Deciphers typos the way any chat model
// does, but never invents scope the user didn't name.
//
// LONG-PROMPT HANDLING (map-reduce): a long prompt is split into coherent
// sections, each section is extracted IN PARALLEL, the per-section scopes are
// merged, then a reconcile pass re-checks the merged scope against the FULL
// prompt to add anything missed and drop contradictions. Short prompts skip all
// of this and use a single call.
//
// Backends: Anthropic, OpenAI-compatible, or local Ollama (keyless). If nothing
// is configured/reachable, returns an EMPTY scope + warning — never crashes.

import type { Scope, ReconcileTelemetry } from "../types.js";
import {
  anthropicKey,
  openaiKey,
  ollamaKey,
  ollamaBaseUrl,
  resolveProvider,
  resolveModel,
} from "../config.js";

const EMPTY_SCOPE: Scope = {
  files_allowed: [],
  features_allowed: [],
  endpoints_allowed: [],
  deps_allowed: [],
  env_allowed: [],
  behavioral_changes_allowed: [],
};

const SYSTEM_PROMPT = `You extract the AUTHORIZED SCOPE from a coding instruction. Output ONLY JSON, no prose.
Parse the user's instruction into exactly these keys:
  files_allowed       — file/dir paths the user said to touch (empty if none named)
  features_allowed    — features/behaviors explicitly requested
  endpoints_allowed   — API routes/endpoints explicitly requested
  deps_allowed        — npm/pip packages explicitly requested
  env_allowed         — environment variables explicitly requested
  behavioral_changes_allowed — side effects explicitly requested
If something is not mentioned, return an empty array for that key. Do NOT infer or
expand scope. Only what the user literally asked for. Output: {scope: {...}}
CRUCIAL: DO decipher misspellings/typos to the nearest real concept the user clearly
meant (e.g. "setings page" -> "settings page", "logn form" -> "login form") — you are
reading natural language the same way you answer a normal question. But correcting a
typo is NOT the same as expanding scope: never add a feature/dep/endpoint/env the user
did not name. Correct spelling of what they said; never invent what they didn't say.
If you are given only a SECTION of a longer instruction, extract the scope for just
that section — the sections will be merged later.`;

const RECONCILE_PROMPT = `You are reconciling an AUTHORIZED SCOPE that was extracted
section-by-section from a longer coding instruction. You are given the merged scope
(JSON) and the FULL original instruction. Output ONLY JSON: the final consolidated
scope with exactly these keys (files_allowed, features_allowed, endpoints_allowed,
deps_allowed, env_allowed, behavioral_changes_allowed). Merge duplicates, remove
anything contradictory, and ADD any clearly-requested item that is MISSING from the
merged scope. Do NOT invent scope the full instruction does not support. Correct
typos to the nearest real concept but never expand scope. Output: {scope: {...}}`;

// Prompt length above which we switch from one call to sectioned map-reduce.
const CHUNK_THRESHOLD = parseInt(process.env.OVERREACH_CHUNK_THRESHOLD || "700", 10);
const CHUNK_MAX = parseInt(process.env.OVERREACH_CHUNK_MAX || "600", 10);
// Reconcile pass: "auto" = on when chunked OR prompt is non-trivial, "on" = always, "off" = never.
const RECONCILE = (process.env.SCOPE_RECONCILE || "auto") as "auto" | "on" | "off";
const RECONCILE_THRESHOLD = parseInt(process.env.OVERREACH_RECONCILE_THRESHOLD || "300", 10);

function looksReal(key: string): boolean {
  return Boolean(key && !key.includes("your_") && key.length > 8);
}

export function hasKey(): boolean {
  const provider = resolveProvider();
  if (provider === "ollama") return true;
  if (provider === "anthropic") return looksReal(anthropicKey());
  if (provider === "openai") return looksReal(openaiKey());
  return false;
}

// ── public entrypoint ──────────────────────────────────────────────────────
export async function extractScope(prompt: string): Promise<{ scope: Scope; warning?: string; telemetry?: ReconcileTelemetry }> {
  const provider = resolveProvider();
  const model = resolveModel(provider);

  const chunks = chunkPrompt(prompt, CHUNK_MAX);
  const chunked = chunks.length > 1;

  // Extract each section in parallel.
  const sectionScopes: Scope[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const results = await Promise.all(chunks.map((c) => extractOne(model, provider, c)));
      const parsed = results.map((t) => parseScopeJson(t)).filter(Boolean) as Scope[];
      if (parsed.length === 0) {
        if (attempt === 2) return emptyWithWarning(`Could not parse scope JSON from ${provider}/${model}.`);
        continue;
      }
      sectionScopes.push(...parsed);
      break;
    } catch (err) {
      if (attempt === 2) return emptyWithWarning(`Scope extraction failed after retries (${provider}/${model}): ${(err as Error).message}`);
    }
  }

  let scope = sectionScopes.length === 1 ? sectionScopes[0] : mergeScopes(sectionScopes);

  // Re-check the merged scope against the FULL prompt (the user's "connect the
  // whole thing after the fact" step). On by default whenever the prompt was
  // chunked OR is non-trivial in length — the second look recovers items the
  // first pass dropped (the single biggest source of false positives).
  const reconcile = RECONCILE === "on" || (RECONCILE === "auto" && (chunked || prompt.trim().length > RECONCILE_THRESHOLD));
  let telemetry: ReconcileTelemetry | undefined;
  if (reconcile) {
    const reconciled = await reconcileScope(model, provider, scope, prompt);
    if (reconciled) {
      const { added, removed } = diffScopes(scope, reconciled);
      telemetry = { reconcileRan: true, reconcileChanged: added.length > 0 || removed.length > 0, added, removed };
      scope = reconciled;
    } else {
      telemetry = { reconcileRan: true, reconcileChanged: false, added: [], removed: [] };
    }
  }

  return { scope, telemetry };
}

// Diff two scopes by normalized membership across all keys — what the reconcile
// pass added (recovered) or removed (contradictions/dupes) vs the section merge.
function diffScopes(merged: Scope, reconciled: Scope): { added: string[]; removed: string[] } {
  const keys: (keyof Scope)[] = ["files_allowed", "features_allowed", "endpoints_allowed", "deps_allowed", "env_allowed", "behavioral_changes_allowed"];
  const added: string[] = [];
  const removed: string[] = [];
  for (const k of keys) {
    const m = new Set((merged[k] || []).map(norm));
    const r = new Set((reconciled[k] || []).map(norm));
    for (const item of reconciled[k] || []) if (!m.has(norm(item))) added.push(item);
    for (const item of merged[k] || []) if (!r.has(norm(item))) removed.push(item);
  }
  return { added, removed };
}

function emptyWithWarning(warning: string): { scope: Scope; warning: string } {
  return { scope: { ...EMPTY_SCOPE }, warning };
}

// Extract scope from a single (possibly sectioned) prompt string.
async function extractOne(model: string, provider: string, prompt: string): Promise<string> {
  return chat(model, provider, SYSTEM_PROMPT, prompt);
}

// Reconcile pass: send merged scope + full instruction, get the final scope back.
async function reconcileScope(model: string, provider: string, merged: Scope, fullPrompt: string): Promise<Scope | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const user = `FULL INSTRUCTION:\n${fullPrompt}\n\nMERGED SCOPE:\n${JSON.stringify(merged, null, 2)}`;
      const text = await chat(model, provider, RECONCILE_PROMPT, user);
      const s = parseScopeJson(text);
      if (s) return s;
    } catch {
      if (attempt === 2) return null;
    }
  }
  return null;
}

// ── provider dispatch ──────────────────────────────────────────────────────
// Optional per-call throttle (env-gated). Set OVERREACH_CALL_MIN_INTERVAL_MS to
// space out LLM calls — e.g. Gemini free tier is 5 req/min, so 13000ms keeps you
// under quota across a whole battery (including map-reduce sub-calls + reconcile).
// Default 0 = no throttling. Applies to every chat() call regardless of provider.
let _lastChatAt = 0;
async function _throttle(): Promise<void> {
  const min = parseInt(process.env.OVERREACH_CALL_MIN_INTERVAL_MS || "0", 10);
  if (min > 0) {
    const wait = min - (Date.now() - _lastChatAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  _lastChatAt = Date.now();
}

async function chat(model: string, provider: string, system: string, user: string): Promise<string> {
  await _throttle();
  if (provider === "ollama") return chatOllama(model, system, user);
  if (provider === "openai") return chatOpenAI(model, system, user);
  return chatAnthropic(model, system, user);
}

async function chatAnthropic(model: string, system: string, user: string): Promise<string> {
  const key = anthropicKey();
  if (!looksReal(key)) throw new Error("ANTHROPIC_API_KEY not set");
  const { Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });
  const resp = await client.messages.create({
    model,
    max_tokens: 1200,
    temperature: 0,
    system,
    messages: [{ role: "user", content: user }],
  });
  return resp.content[0].type === "text" ? resp.content[0].text : "";
}

async function chatOpenAI(model: string, system: string, user: string): Promise<string> {
  const key = openaiKey();
  if (!looksReal(key)) throw new Error("OPENAI_API_KEY not set");
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  // JSON mode is great when the server supports it (OpenAI, OpenRouter, Groq) but
  // some OpenAI-compatible servers (LM Studio with certain models, older Ollama
  // OpenAI shims) reject `response_format`. Send it only for the real OpenAI
  // endpoint, or when explicitly opted in via OVERREACH_JSON_MODE=on. The system
  // prompt already demands JSON-only output and parseScopeJson tolerantly extracts
  // the first {...} block, so omitting json_object does not weaken correctness.
  const jsonMode =
    process.env.OVERREACH_JSON_MODE
      ? process.env.OVERREACH_JSON_MODE === "on"
      : base === "https://api.openai.com/v1";
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1200,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content || "";
}

async function chatOllama(model: string, system: string, user: string): Promise<string> {
  const key = ollamaKey();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (looksReal(key)) headers.authorization = `Bearer ${key}`;
  const resp = await fetch(`${ollamaBaseUrl()}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      options: { temperature: 0 },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as { message?: { content?: string }; response?: string };
  return data.message?.content || data.response || "";
}

// ── chunking: split a long prompt into coherent sections ───────────────────
export function chunkPrompt(prompt: string, maxChars = CHUNK_MAX): string[] {
  const trimmed = prompt.trim();
  if (trimmed.length <= maxChars) return [trimmed];
  // Split into paragraphs first, then sentences, building chunks <= maxChars
  // without breaking sentences where possible.
  const paragraphs = trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= maxChars) {
      sentences.push(p);
      continue;
    }
    // split long paragraph into sentences
    const parts = p.match(/[^.!?]+[.!?]+\s+|[^.!?]+$/g) || [p];
    for (const s of parts) {
      const ss = s.trim();
      if (!ss) continue;
      if (ss.length <= maxChars) sentences.push(ss);
      else {
        // hard-wrap a very long sentence
        for (let i = 0; i < ss.length; i += maxChars) sentences.push(ss.slice(i, i + maxChars));
      }
    }
  }
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur.length + s.length + 1 <= maxChars) {
      cur = cur ? cur + " " + s : s;
    } else {
      if (cur) chunks.push(cur);
      cur = s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [trimmed];
}

// ── merge: union per-section scopes, dedupe ───────────────────────────────
export function mergeScopes(scopes: Scope[]): Scope {
  const keys: (keyof Scope)[] = [
    "files_allowed",
    "features_allowed",
    "endpoints_allowed",
    "deps_allowed",
    "env_allowed",
    "behavioral_changes_allowed",
  ];
  const out = { ...EMPTY_SCOPE };
  for (const k of keys) {
    const all: string[] = [];
    for (const s of scopes) all.push(...(s[k] || []));
    out[k] = dedupe(all);
  }
  return out;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function dedupe(items: string[]): string[] {
  // Drop exact (normalized) duplicates; keep the first occurrence.
  const byNorm = new Map<string, string>();
  for (const it of items) {
    const n = norm(it);
    if (!n) continue;
    if (!byNorm.has(n)) byNorm.set(n, it);
  }
  // Drop entries whose normalized form is a substring of another (less
  // specific) — keep the more specific entry.
  const arr = [...byNorm.values()];
  return arr.filter(
    (a) => !arr.some((b) => a !== b && norm(b).includes(norm(a)) && norm(b).length > norm(a).length)
  );
}

// ── shared JSON parsing ────────────────────────────────────────────────────
function parseScopeJson(text: string): Scope | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    const s = obj.scope ?? obj;
    return {
      files_allowed: arr(s.files_allowed),
      features_allowed: arr(s.features_allowed),
      endpoints_allowed: arr(s.endpoints_allowed),
      deps_allowed: arr(s.deps_allowed),
      env_allowed: arr(s.env_allowed),
      behavioral_changes_allowed: arr(s.behavioral_changes_allowed),
    };
  } catch {
    return null;
  }
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}
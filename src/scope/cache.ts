// Scope cache — persists the Stage 1 (LLM) scope-extraction result keyed by
// hash(prompt + provider + model). Re-running the same prompt (iterating on a
// diff, a pre-commit re-run, CI re-check) skips the only network/latency step and
// reuses the previously extracted scope. The cache key includes the model+provider
// so switching models never serves a stale scope from a different brain.
//
// V1: a plain JSON file per entry under .overreach/scope-cache/. No TTL — the
// prompt is the key, and the scope is a literal extraction of that prompt, so it
// does not go stale unless the prompt or model changes (both in the key). Disable
// with --no-cache; bypass per-run. Nothing here touches the network or holds raw
// prompt content beyond the hash (the prompt is hashed for the key, never stored).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Scope } from "../types.js";

const CACHE_DIR = ".overreach/scope-cache";

export interface CacheMeta {
  prompt_hash: string;
  provider: string;
  model: string;
  cached_at: string; // ISO timestamp
}

interface CacheEntry extends CacheMeta {
  scope: Scope;
}

export function cacheKey(prompt: string, provider: string, model: string): string {
  return createHash("sha256").update(`${provider}|${model}|${prompt}`).digest("hex").slice(0, 32);
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

// Returns the cached scope for this prompt+provider+model, or null on miss /
// corrupt entry (corrupt entries are deleted so they don't poison future hits).
export function getScopeCache(prompt: string, provider: string, model: string): Scope | null {
  const path = cachePath(cacheKey(prompt, provider, model));
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, "utf-8")) as CacheEntry;
    if (!entry || !entry.scope) return null;
    return entry.scope;
  } catch {
    return null; // treat corrupt as miss; don't crash the run over a bad cache file
  }
}

export function putScopeCache(prompt: string, provider: string, model: string, scope: Scope): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const entry: CacheEntry = {
      prompt_hash: createHash("sha256").update(prompt).digest("hex").slice(0, 16),
      provider,
      model,
      cached_at: new Date().toISOString(),
      scope,
    };
    writeFileSync(cachePath(cacheKey(prompt, provider, model)), JSON.stringify(entry, null, 2));
  } catch {
    // Cache is a perf optimization, never a hard dependency — a read-only cwd
    // or a full disk must not fail the audit.
  }
}
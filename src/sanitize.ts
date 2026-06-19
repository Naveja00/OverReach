// EGRESS BOUNDARY (hardening item #2). Nothing that leaves the machine —
// telemetry, logs, any network call — may carry prompt text, diff content, file
// paths, env-var names, dep names, or the reconcile added/removed arrays (those
// contain scope content: paths/names). This module is the ONLY place that builds
// an egress payload, and it builds it FROM SCRATCH from safe primitives (counts,
// booleans, version, model id, latency, length). It never accepts a pre-built
// object that might contain user content — there is no "redact an existing object"
// path, because redaction is exactly where leaks happen (one missed field).
//
// Invariant: if a value would reveal user content, it is not a primitive this
// module knows how to emit. So the only way a leak can happen is someone editing
// THIS file to add a field — which is reviewable in one place, not scattered.

import type { CheckResult, FindingKind, CreepScore } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export interface TelemetryMeta {
  // Who produced the run. model id only (e.g. "glm-5.2") — not the prompt, not
  // the system prompt, not the response.
  model: string;
  // provider chain label, e.g. "ollama" | "anthropic" | "openai" | "override"
  provider: string;
  // Detected source language of the diff, if known.
  language?: string;
  // SIZES — computed by the orchestrator from its local args. The strings
  // (prompt, diff) never cross this boundary; only their lengths do.
  prompt_length: number;
  diff_lines: number;
  // Map-reduce shape (from Stage 1).
  chunked: boolean;
  chunk_count: number;
  // Stage latencies in ms (best-effort). Numbers only, never content.
  stage1_latency_ms?: number;
  stage2_latency_ms?: number;
  stage3_latency_ms?: number;
}

export interface TelemetryEvent {
  schema_version: typeof SCHEMA_VERSION;
  event: "check_overreach";
  model: string;
  provider: string;
  language?: string;
  prompt_length: number; // chars — a size, not the text
  diff_lines: number; // lines — a size, not the content
  findings_count: number;
  finding_kinds: Record<string, number>; // namespaced category -> count
  scope_creep_score: CreepScore;
  // Stage 1 reconcile telemetry — COUNTS only, never the added/removed arrays.
  reconcile_ran: boolean;
  reconcile_changed: boolean;
  reconcile_added_count: number;
  reconcile_removed_count: number;
  // Map-reduce shape.
  chunked: boolean;
  chunk_count: number;
  // Latencies.
  stage1_latency_ms?: number;
  stage2_latency_ms?: number;
  stage3_latency_ms?: number;
}

// Build a telemetry event from a CheckResult + meta. The result object DOES
// contain user content (scope.actual, findings[].evidence, telemetry.added/
// removed) — we deliberately do NOT spread it or copy fields off it. Every field
// below is computed down to a safe primitive (number/boolean/string-from-allowlist)
// before being placed on the event. A future field added to CheckResult that
// carries user content will simply not appear here unless someone edits this fn.
export function toTelemetryEvent(result: CheckResult, meta: TelemetryMeta): TelemetryEvent {
  // finding_kinds: counts per namespaced category. The kind strings themselves
  // are from our fixed taxonomy (scope.file, scope.dep, ...) — they are NOT user
  // content. evidence/detail/file are dropped entirely.
  const finding_kinds: Record<string, number> = {};
  for (const f of result.findings) {
    const k = sanitizeKind(f.kind);
    finding_kinds[k] = (finding_kinds[k] || 0) + 1;
  }

  const t = result.telemetry;
  const reconcile_ran = !!t?.reconcileRan;
  const reconcile_changed = !!t?.reconcileChanged;
  // COUNTS — the added/removed arrays hold paths/names and must NEVER leave.
  const reconcile_added_count = t?.added?.length ?? 0;
  const reconcile_removed_count = t?.removed?.length ?? 0;

  return {
    schema_version: SCHEMA_VERSION,
    event: "check_overreach",
    model: sanitizeModel(meta.model),
    provider: sanitizeProvider(meta.provider),
    language: meta.language ? sanitizeLanguage(meta.language) : undefined,
    prompt_length: numberOrZero(meta.prompt_length),
    diff_lines: numberOrZero(meta.diff_lines),
    findings_count: numberOrZero(result.findings?.length),
    finding_kinds,
    scope_creep_score: result.scope_creep_score,
    reconcile_ran,
    reconcile_changed,
    reconcile_added_count,
    reconcile_removed_count,
    chunked: !!meta.chunked,
    chunk_count: numberOrZero(meta.chunk_count),
    stage1_latency_ms: numberOrUndef(meta.stage1_latency_ms),
    stage2_latency_ms: numberOrUndef(meta.stage2_latency_ms),
    stage3_latency_ms: numberOrUndef(meta.stage3_latency_ms),
  };
}

// (prompt_length / diff_lines are read from meta, not fished out of result — the
// result never carries raw prompt or diff, only their structured derivatives.)

// Allowlist-based sanitizers for the few strings we DO emit. Anything not on the
// allowlist is coerced to "unknown" — a leak via a free-form string is impossible.
const MODEL_ALLOW = /^[A-Za-z0-9._\-:]{1,64}$/; // model ids like glm-5.2, gpt-4o-mini
const PROVIDER_ALLOW = new Set(["anthropic", "openai", "ollama", "override", "unknown"]);
const LANG_ALLOW = new Set(["python", "typescript", "javascript", "auto", "unknown"]);
const KIND_ALLOW = new Set<FindingKind>([
  "scope.file", "scope.feature", "scope.dep", "scope.endpoint", "scope.env", "scope.cron",
  "contract.expansion", "contract.expired", "handoff.context", "handoff.reasoning",
]);

function sanitizeModel(m: string): string {
  return m && MODEL_ALLOW.test(m) ? m : "unknown";
}
function sanitizeProvider(p: string): string {
  return p && PROVIDER_ALLOW.has(p) ? p : "unknown";
}
function sanitizeLanguage(l: string): string {
  return l && LANG_ALLOW.has(l) ? l : "unknown";
}
function sanitizeKind(k: FindingKind): string {
  return KIND_ALLOW.has(k) ? k : "unknown";
}

function numberOrZero(n: number | undefined): number {
  return Number.isFinite(n as number) ? (n as number) : 0;
}
function numberOrUndef(n: number | undefined): number | undefined {
  return Number.isFinite(n as number) ? (n as number) : undefined;
}

// Helpers for the orchestrator to attach size metadata WITHOUT passing raw
// content across the boundary. The orchestrator computes the size from its
// own local args (prompt, diff) and hands the numbers to telemetry — the strings
// never enter this module.
export function sizeOfPrompt(prompt: string): number {
  return prompt ? prompt.length : 0;
}
export function sizeOfDiff(diff: string): number {
  if (!diff) return 0;
  // Count line breaks; +1 for the final line if it has content and no trailing \n.
  const breaks = (diff.match(/\n/g) || []).length;
  return diff.endsWith("\n") ? breaks : breaks + 1;
}
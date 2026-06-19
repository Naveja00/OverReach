// Stage 3 — DIFF. Pure set arithmetic. Subtracts authorized scope from the
// actual surface to produce findings + a scope_creep_score. No LLM, instant.

import type { Actual, Finding, Scope, CreepScore } from "../types.js";

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Longest common (contiguous) substring length. Used so "validate" matches
// "validation" (shared "validat") and "loginform" matches "login form".
function lcsLen(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  let cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      } else {
        cur[j] = 0;
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return best;
}

// Fuzzy equivalence for names vs phrases: equal, containment, or a shared
// substring of >=5 chars (handles plurals/verb-forms/typos without a stemmer).
function fuzzy(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return lcsLen(na, nb) >= 5;
}

// Membership for deps/env: exact (case-insensitive) or fuzzy to tolerate naming.
function memberExact(item: string, allowed: string[]): boolean {
  const i = item.toLowerCase();
  if (allowed.some((a) => a.toLowerCase() === i)) return true;
  // fuzzy fallback so "stripe" matches an allowed "stripe payments"
  return allowed.some((a) => fuzzy(item, a));
}

// Normalize an endpoint path for strict comparison: lowercase, strip a leading
// HTTP method, unify dynamic segments ([id]/:id/{id}) to <param>, drop query
// string and trailing slash.
function normEp(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\s*(?:get|post|put|delete|patch)\s+/i, "")
    .replace(/\{[^}]+\}|\[[^\]]+\]|:[A-Za-z_][\w]*/g, "<param>")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "");
}

// Candidate normalized forms for an allowed endpoint string: the full
// normalized string, plus the path extracted from it (so "/api/search endpoint"
// also yields "/api/search"). Tolerates model phrasing like trailing
// "endpoint"/"route"/"handler" words without loosening the path comparison.
function endpointCandidates(x: string): string[] {
  const full = normEp(x);
  const out = new Set<string>();
  if (full) out.add(full);
  const pathMatch = x.match(/\/[A-Za-z0-9_\-.$~{}[\]:/]+/);
  if (pathMatch) {
    const p = normEp(pathMatch[0]);
    if (p) out.add(p);
  }
  return [...out];
}

// Strict endpoint membership: exact (normalized) match, or a length-bounded
// fuzzy match. The length bound (ratio <= 1.3) blocks prefix overreach — a
// short authorized path must not cover a much longer actual route that merely
// extends it. This is intentionally stricter than memberPath/memberExact.
export function endpointAuthorized(ep: string, allowed: string[]): boolean {
  const a = normEp(ep);
  if (!a) return false;
  for (const x of allowed) {
    for (const b of endpointCandidates(x)) {
      if (a === b) return true;
      const ratio = Math.max(a.length, b.length) / Math.min(a.length, b.length);
      if (ratio <= 1.3 && lcsLen(a, b) >= Math.floor(Math.min(a.length, b.length) * 0.8)) return true;
    }
  }
  return false;
}

// Membership for files: path-segment / substring / fuzzy token match.
function memberPath(item: string, allowed: string[]): boolean {
  const i = item.toLowerCase();
  const segs = i.split(/[\/.]/);
  for (const a of allowed) {
    const al = a.toLowerCase();
    if (i.includes(al) || al.includes(i)) return true;
    if (segs.some((seg) => seg === al)) return true;
    // token from an allowed phrase ("logout button in navbar" -> "navbar")
    const tokens = al.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    if (tokens.some((tok) => segs.some((seg) => seg.includes(tok)))) return true;
    if (fuzzy(item, a)) return true;
  }
  return false;
}

// Files whose changes are audited by other categories (deps/env/endpoints) —
// flagging them as scope.file is redundant and noisy.
function isSupportFile(f: string): boolean {
  return (
    /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|Pipfile|poetry\.lock|pnpm-lock\.yaml|yarn\.lock)$/.test(f) ||
    /\.env(\.|$)/i.test(f) ||
    /(^|\/)env\./i.test(f) ||
    /(?:^|\/)app\/.*\/route\.(ts|js)$/.test(f) ||
    /(?:^|\/)api\/[^/]+\.(ts|js|py)$/.test(f)
  );
}

const CRON_KEYWORDS = ["cron", "schedule", "scheduler", "scheduled", "nightly", "daily", "weekly", "periodic", "interval", "background task", "job"];

export function compare(actual: Actual, scope: Scope): { findings: Finding[]; score: CreepScore } {
  const findings: Finding[] = [];

  // Out-of-scope files. Only meaningful when the prompt actually constrained
  // files; support files are audited via their content categories instead.
  for (const f of actual.files_changed) {
    if (!f) continue;
    if (scope.files_allowed.length === 0) continue; // files unconstrained
    if (isSupportFile(f)) continue; // content audited elsewhere
    if (memberPath(f, scope.files_allowed) || memberPath(f, scope.features_allowed)) continue;
    findings.push({
      kind: "scope.file",
      detail: `File "${f}" is not within the files the prompt authorized.`,
      file: f,
      severity: "medium",
      evidence: f,
    });
  }

  // Unauthorized deps. Authorized if explicitly allowed, or if the dep name
  // appears in any allowed feature/endpoint/env text (e.g. "algoliasearch"
  // satisfies a feature that says "queries Algolia" even if the model forgot to
  // list it under deps_allowed).
  for (const d of actual.new_deps) {
    const depAuthorized =
      memberExact(d, scope.deps_allowed) ||
      scope.features_allowed.some((a) => fuzzy(d, a)) ||
      scope.endpoints_allowed.some((a) => fuzzy(d, a)) ||
      scope.env_allowed.some((a) => fuzzy(d, a)) ||
      scope.behavioral_changes_allowed.some((a) => fuzzy(d, a));
    if (!depAuthorized) {
      findings.push({
        kind: "scope.dep",
        detail: `Added dependency "${d}" was not requested by the prompt.`,
        file: "package.json/requirements",
        severity: "medium",
        evidence: d,
      });
    }
  }

  // Unauthorized env vars.
  for (const e of actual.env_vars_added) {
    if (!memberExact(e, scope.env_allowed)) {
      findings.push({
        kind: "scope.env",
        detail: `Added environment variable "${e}" was not requested by the prompt.`,
        file: ".env",
        severity: "high",
        evidence: e,
      });
    }
  }

  // Unauthorized endpoints. Endpoints are precise: authorize by exact match
  // (with dynamic-segment + trailing-slash + method-prefix normalization) or a
  // length-bounded fuzzy match. We deliberately do NOT use loose substring /
  // shared-segment matching here — that would false-authorize prefix overreach
  // (an authorized "/api/users/stripe" must NOT license a smuggled
  // "/api/users/stripe/refund") and sibling routes sharing a segment
  // ("/api/users/export" is not covered by "/api/users/stripe").
  for (const ep of actual.endpoints_added) {
    if (!endpointAuthorized(ep, scope.endpoints_allowed)) {
      findings.push({
        kind: "scope.endpoint",
        detail: `Added endpoint "${ep}" was not requested by the prompt.`,
        file: "routes",
        severity: "high",
        evidence: ep,
      });
    }
  }

  // Unauthorized cron/scheduled jobs. Subtract against features + behavioral
  // changes (there's no dedicated cron_allowed field). Authorize by keyword
  // ("nightly cron job") or by fuzzy task-name match ("clean_carts" ~ "clean
  // abandoned carts"); if any entry matches, the whole cron group is authorized.
  const cronScope = [...scope.features_allowed, ...scope.behavioral_changes_allowed];
  const scopeText = cronScope.join(" ").toLowerCase();
  const cronKeywordAuthorized = CRON_KEYWORDS.some((k) => scopeText.includes(k));
  const cronFuzzyAuthorized = actual.cron_added.some((c) => cronScope.some((a) => fuzzy(c, a)));
  const cronAuthorized = cronKeywordAuthorized || cronFuzzyAuthorized;
  for (const c of actual.cron_added) {
    if (cronAuthorized) continue;
    findings.push({
      kind: "scope.cron",
      detail: `Added scheduled job "${c}" was not requested by the prompt.`,
      file: "scheduler",
      severity: "high",
      evidence: c,
    });
  }

  // Unauthorized features: substantial added symbols not tied to any requested
  // feature or authorized endpoint. Fuzzy match so a function named "validate"
  // satisfies a requested "input validation", and a "health" handler satisfies
  // an authorized "/health" endpoint.
  for (const s of actual.symbols_added) {
    const matched =
      scope.features_allowed.some((a) => fuzzy(s, a)) ||
      scope.endpoints_allowed.some((a) => fuzzy(s, a)) ||
      scope.behavioral_changes_allowed.some((a) => fuzzy(s, a)) ||
      scope.files_allowed.some((a) => fuzzy(s, a)); // ProfilePage ~ profile.tsx
    if (matched) continue;
    if (s.length < 5) continue; // ignore tiny consts/vars
    findings.push({
      kind: "scope.feature",
      detail: `Added symbol "${s}" is not clearly tied to any requested feature.`,
      file: "source",
      severity: "low",
      evidence: s,
    });
  }

  const score: CreepScore = findings.some((f) => f.severity === "high")
    ? "HIGH"
    : findings.some((f) => f.severity === "medium")
    ? "MEDIUM"
    : "LOW";

  return { findings, score };
}

export function summarize(findings: Finding[], score: CreepScore): string {
  if (findings.length === 0) return `No overreach detected. scope_creep_score=${score}`;
  const byKind: Record<string, number> = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  const parts = Object.entries(byKind).map(([k, n]) => `${n} ${k}`);
  return `Diff adds ${findings.length} unauthorized thing(s): ${parts.join(", ")}. scope_creep_score=${score}`;
}
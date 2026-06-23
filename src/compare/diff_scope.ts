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
  const minLen = Math.min(na.length, nb.length);
  return lcsLen(na, nb) >= Math.max(5, Math.ceil(minLen * 0.6));
}

// Damerau-Levenshtein (optimal string alignment) — edit distance that counts a
// single adjacent transposition ("form"->"from", "login"->"logni") as 1, not 2.
// Used for TYPO tolerance only (see typoEquiv), never as a loose general match.
function osa(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  if (Math.abs(la - lb) > 2) return 99; // beyond our threshold; skip the matrix
  const d: number[][] = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[la][lb];
}

// Correctly-spelled common words. A scope token that IS one of these is a real
// word, not a misspelling — so it is never "corrected" into a different actual
// token (this is what stops `auth` matching `auto`, `form` matching `from`,
// `log` matching `logo`). Only tokens that look MISSPELLED (not in this set)
// are eligible for typo matching. Bounded + finite; the osa<=1-2 cap limits any
// blast radius from a missing entry.
const COMMON_WORDS = new Set([
  "login", "logout", "signin", "signup", "register", "settings", "setting", "profile",
  "dashboard", "account", "user", "users", "form", "forms", "page", "pages", "button",
  "buttons", "modal", "dialog", "table", "tables", "list", "lists", "item", "items",
  "search", "filter", "sort", "export", "import", "nav", "navbar", "menu", "sidebar",
  "header", "footer", "cart", "checkout", "payment", "payments", "email", "password",
  "token", "session", "auth", "oauth", "config", "route", "router", "api", "cron",
  "job", "jobs", "task", "tasks", "log", "logs", "logging", "error", "errors", "warn",
  "status", "home", "about", "contact", "admin", "edit", "create", "delete", "update",
  "view", "index", "data", "file", "files", "code", "test", "tests", "build", "run",
  "send", "get", "set", "add", "remove", "name", "type", "date", "time", "count",
  "total", "value", "values", "key", "keys", "url", "link", "image", "images", "video",
  "text", "note", "notes", "project", "repo", "branch", "commit", "cache", "queue",
  "worker", "handler", "controller", "model", "models", "schema", "migration", "seed",
  "util", "utils", "helper", "helpers", "service", "services", "client", "server",
  "database", "store", "stores", "state", "event", "events", "listener", "hook", "hooks",
  "plugin", "component", "components", "layout", "theme", "style", "cache", "health",
  "metrics", "stats", "audit", "logging", "banner", "hero", "logo", "icon", "avatar",
  "toast", "alert", "badge", "tag", "tags", "label", "labels", "field", "fields",
  "input", "inputs", "select", "checkbox", "radio", "toggle", "tab", "tabs", "card",
  "cards", "row", "rows", "column", "columns", "grid", "cell", "cells", "chart", "graphs",
]);

// Typo equivalence between a SCOPE token (first arg — possibly misspelled by the
// user / left uncorrected by the model) and an ACTUAL token (a real identifier
// from the diff, e.g. a file-path segment). Equal, or a 1-char edit (2 chars for
// tokens >=7) — but only when the scope token is NOT a common word (else real words
// would collide: auth/auto, form/from). This is the deterministic fix for the
// "setings" drift: the engine matches the typo to the real identifier regardless
// of whether Stage 1 corrected it.
function typoEquiv(scopeTok: string, actualTok: string): boolean {
  const nx = norm(scopeTok);
  const ny = norm(actualTok);
  if (!nx || !ny) return false;
  if (nx === ny) return true;
  if (COMMON_WORDS.has(nx)) return false; // real scope word — do not "correct" it
  const minLen = Math.min(nx.length, ny.length);
  if (minLen < 4) return false;
  return osa(nx, ny) <= (minLen >= 7 ? 2 : 1);
}

// Symbol-vs-entry typo tolerance. The symbol's normalized form is authorized if it
// is within a 1-char edit (OSA) of a SUBSTRING of the entry's normalized form.
// Matching against a substring (not a token) preserves the entry-blob's length
// protection — "producthealth" is NOT within edit-1 of any substring of
// "listproductsendpoint", so ProductHealth stays flagged; but "loginform" IS within
// edit-1 of the substring "lognform" inside "lognformsetingspage", so a typo'd
// "logn form" still authorizes LoginForm. The edit-distance branch is gated to
// symbols of length >= 5 so 4-char real-word collisions (auth/auto, form/from)
// cannot trigger — those fall back to exact/substring matching only.
//
// The threshold is deliberately 1, NOT 2, even for long symbols. Edit-2 at len>=7
// collides DIFFERENT real words: "login" (5) is OSA-2 from "logging" (7) — both
// are common, both real — so a len>=7 / thr=2 branch would authorize a smuggled
// `Logging()` facility under a "login" prompt (a false negative, the mirror of the
// false positive the typo fix was built to prevent). thr=1 still covers every
// real single-typo case ("setings"->"settings", "logn form"->"loginform" are both
// OSA-1) while refusing to bridge two distinct words. Proven in [T25].
function symbolInEntry(symbol: string, entry: string): boolean {
  const ns = norm(symbol);
  const ne = norm(entry);
  if (!ns || !ne) return false;
  if (ne.includes(ns)) return true; // exact substring (existing behavior)
  if (ns.length < 5) return false; // short symbols: no edit-distance match
  const thr = 1;
  for (let w = ns.length - thr; w <= ns.length + thr; w++) {
    if (w < 1) continue;
    for (let i = 0; i + w <= ne.length; i++) {
      if (osa(ns, ne.slice(i, i + w)) <= thr) return true;
    }
  }
  return false;
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
    // When both look like file paths, use strict path comparison:
    // exact match, or item is under the allowed path's directory.
    const aIsPath = al.includes("/") || al.includes(".");
    const iIsPath = i.includes("/");
    if (aIsPath && iIsPath) {
      if (i === al) return true;
      // Allow if the item is the same file (basename match with same parent)
      if (i.endsWith("/" + al) || al.endsWith("/" + i)) return true;
      // Allow if the allowed entry is a directory prefix and the item is under it
      // BUT only if the allowed entry looks like a directory (no file extension)
      const aHasExt = /\.\w+$/.test(al);
      if (!aHasExt && i.startsWith(al.replace(/\/+$/, "") + "/")) return true;
      continue;
    }
    if (i.includes(al) || al.includes(i)) return true;
    if (segs.some((seg) => seg === al)) return true;
    // token from an allowed phrase ("logout button in navbar" -> "navbar")
    const tokens = al.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    if (tokens.some((tok) => segs.some((seg) => seg.includes(tok)))) return true;
    // typo-tolerant token/segment match: a scope "setings" authorizes the real
    // "settings" file via a 1-char edit (deterministic; common words are exempt).
    if (tokens.some((tok) => segs.some((seg) => typoEquiv(tok, seg)))) return true;
    if (fuzzy(item, a)) return true;
  }
  return false;
}

// Files whose changes are audited by other categories (deps/env/endpoints) —
// flagging them as scope.file is redundant and noisy.
function isSupportFile(f: string): boolean {
  return (
    // Manifests are audited via scope.dep (their added packages). Lockfiles are
    // a mechanical consequence of a manifest change — package-lock.json MUST
    // move when package.json gains a dep — so flagging them as scope.file is a
    // false positive. They carry no independent scope signal.
    /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.json|composer\.lock|requirements\.txt|pyproject\.toml|poetry\.lock|Pipfile|Pipfile\.lock|Gemfile|Gemfile\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum)$/.test(f) ||
    /\.env(\.|$)/i.test(f) ||
    /(^|\/)env\./i.test(f) ||
    /(?:^|\/)app\/.*\/route\.(ts|js)$/.test(f) ||
    /(?:^|\/)api\/[^/]+\.(ts|js|py)$/.test(f)
  );
}

const CRON_KEYWORDS = ["cron", "schedule", "scheduler", "scheduled", "nightly", "daily", "weekly", "periodic", "interval", "background task", "job"];

// Keywords in the prompt that authorize a runtime listener — e.g. the prompt
// asked for a "server", to "listen on port", a "websocket", "realtime", or a
// "crash handler" / "graceful shutdown". Listeners have no dedicated scope
// field (like cron); they authorize via features + behavioral_changes.
const LISTENER_KEYWORDS = ["listen", "server", "port", "websocket", "ws", "socket", "realtime", "real-time", "handler", "crash", "graceful", "shutdown", "signal"];

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

  // Unauthorized runtime listeners — a server opening a port, a WebSocket/HTTP
  // server, or a global-object event handler (process.on / window.addEventListener).
  // HIGH severity: a new listener is a runtime surface an agent can install
  // silently, same class as an unauthorized endpoint or env var. Like cron,
  // listeners have no dedicated scope field; they authorize via features +
  // behavioral changes, by keyword ("listen", "server", "websocket", "crash
  // handler") or fuzzy evidence match.
  const listenerScope = [...scope.features_allowed, ...scope.behavioral_changes_allowed];
  const listenerScopeText = listenerScope.join(" ").toLowerCase();
  const listenerKeywordAuthorized = LISTENER_KEYWORDS.some((k) => listenerScopeText.includes(k));
  for (const l of actual.listeners_added) {
    if (listenerKeywordAuthorized) continue;
    if (listenerScope.some((a) => fuzzy(l, a))) continue;
    findings.push({
      kind: "scope.listener",
      detail: `Added runtime listener "${l}" was not requested by the prompt.`,
      file: "runtime",
      severity: "high",
      evidence: l,
    });
  }

  // Unauthorized features: substantial added symbols not tied to any requested
  // feature or authorized endpoint. Fuzzy match so a function named "validate"
  // satisfies a requested "input validation", and a "health" handler satisfies
  // an authorized "/health" endpoint.
  for (const s of actual.symbols_added) {
    const matched =
      scope.features_allowed.some((a) => fuzzy(s, a)) ||
      scope.features_allowed.some((a) => symbolInEntry(s, a)) ||
      scope.endpoints_allowed.some((a) => {
        // Match symbol against the last path segment only when the symbol is a
        // plausible handler name for that exact segment (near-exact match).
        // "ListProducts" should match "products", but "ProductHealth" should not
        // — "Health" is a different resource. Require the endpoint leaf to be
        // nearly the entire symbol (after normalization).
        const leaf = norm(a.replace(/.*\//, ""));
        if (!leaf || leaf.length < 3) return false;
        const ns = norm(s);
        if (ns === leaf) return true;
        // The leaf must cover most of the symbol to authorize it
        if (ns.includes(leaf) && leaf.length >= ns.length * 0.7) return true;
        return false;
      }) ||
      scope.behavioral_changes_allowed.some((a) => fuzzy(s, a)) ||
      scope.behavioral_changes_allowed.some((a) => symbolInEntry(s, a)) ||
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
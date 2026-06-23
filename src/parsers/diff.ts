// Stage 2 — EXTRACT ACTUAL. Deterministic. NO LLM. Parses a unified git diff
// into the structured "actual surface" of what changed. Pure regex + state.

import type { Actual } from "../types.js";

// A parsed added line: the file it was added to + the raw code (leading + stripped).
interface AddedLine {
  file: string;
  code: string;
}

function parseAddedLines(diff: string): { lines: AddedLine[]; newFiles: Set<string>; deleted: string[] } {
  const out: AddedLine[] = [];
  const newFiles = new Set<string>();
  const deleted: string[] = [];
  let currentFile = "";
  let pendingNew = false;
  for (const raw of diff.split(/\r?\n/)) {
    // "new file mode" or "--- /dev/null" mark the next +++ as a newly added file.
    if (/^new file mode/.test(raw)) { pendingNew = true; continue; }
    const minus = raw.match(/^---\s+(\S+)/);
    if (minus) { if (minus[1] === "/dev/null") pendingNew = true; continue; }
    const plusMatch = raw.match(/^\+\+\+\s+b\/(.+)$/);
    if (plusMatch) {
      currentFile = plusMatch[1];
      if (pendingNew) newFiles.add(currentFile);
      pendingNew = false;
      continue;
    }
    pendingNew = false;
    // Added line: starts with exactly one '+' (not "+++", "---", "@@", "diff ").
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      out.push({ file: currentFile, code: raw.slice(1) });
    }
    // Deleted line: starts with exactly one '-' (not "---"). Used to detect
    // renames so a renamed identifier is not counted as a brand-new symbol.
    if (raw.startsWith("-") && !raw.startsWith("---")) {
      deleted.push(raw.slice(1));
    }
  }
  return { lines: out, newFiles, deleted };
}

// The "shape" of a declaration line with the declared name blanked out, so a
// renamed identifier (same body, different name) is recognized as a rename and
// excluded from symbols_added. Non-declaration lines return null.
function declShape(code: string): string | null {
  const m = code.match(/^(\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|def|class)\s+)(\w+)/);
  if (!m) return null;
  return m[1] + "{SYM}" + code.slice(m[0].length);
}

function isRename(code: string, deleted: string[]): boolean {
  const shape = declShape(code);
  if (!shape) return false;
  return deleted.some((d) => declShape(d) === shape);
}

// ── matchers operate on a single line of code (the content after the "+") ──

function pyImport(code: string): string | null {
  const m = code.match(/^\s*(?:import|from)\s+([\w.]+)/);
  return m ? m[1].split(".")[0] : null;
}

function goImport(code: string): string | null {
  // Go: "github.com/org/pkg" or "fmt" inside import blocks
  const m = code.match(/^\s*(?:\w+\s+)?"([\w.\-/]+)"\s*$/);
  if (!m) return null;
  const pkg = m[1];
  // Skip stdlib (no dots in path)
  if (!pkg.includes(".")) return null;
  return pkg;
}

function tsImport(code: string): string | null {
  const m =
    code.match(/^\s*import\s+.*\s+from\s+['"]([^'"]+)['"]/) ||
    code.match(/^\s*import\s+['"]([^'"]+)['"]/) ||
    code.match(/=\s*require\(\s*['"]([^'"]+)['"]/) ||
    // Dynamic import — a smuggling vector: `await import("stripe")` has no
    // static import line, so the older matchers missed it entirely.
    code.match(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  return m ? m[1] : null;
}

function envVar(code: string): string | null {
  const m =
    code.match(/os\.environ\[\s*['"]([\w]+)['"]\s*\]/) ||
    code.match(/os\.getenv\(\s*['"]([\w]+)['"]/) ||
    code.match(/os\.environ\.get\(\s*['"]([\w]+)['"]/) ||
    code.match(/process\.env\.([A-Z_][A-Z0-9_]*)/) ||
    code.match(/process\.env\[\s*['"]([\w]+)['"]/) ||
    // Go: os.Getenv("VAR")
    code.match(/os\.Getenv\(\s*['"]([\w]+)['"]/) ||
    // Vite/SvelteKit: import.meta.env.VAR
    code.match(/import\.meta\.env\.([A-Z_][A-Z0-9_]*)/) ||
    // Deno: Deno.env.get("VAR")
    code.match(/Deno\.env\.get\(\s*['"]([\w]+)['"]/) ||
    // Bun: Bun.env.VAR
    code.match(/Bun\.env\.([A-Z_][A-Z0-9_]*)/);
  return m ? m[1] : null;
}

// dotenv-style: "KEY=value" on a line in an .env-ish file.
function dotenvVar(code: string, file: string): string | null {
  if (!/(\.env|env\.example|dotenv)/i.test(file)) return null;
  const m = code.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
  return m ? m[1] : null;
}

const HTTP_VERBS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "get", "post", "put", "delete", "patch"]);

function endpoint(code: string): string | null {
  // Framework decorators (FastAPI/Flask): @app.get("/path")
  const dec = code.match(/@(?:app|router|blueprint|api)\.(?:get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/);
  if (dec) return dec[1];
  // Generic .method("path") — only treat as an endpoint when the path looks
  // like a route (starts with "/" or contains "api"), so dict.get("key") /
  // list.find("x") etc. don't false-positive into endpoints.
  const gen = code.match(/\.(?:get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/);
  if (gen && (gen[1].startsWith("/") || /api/i.test(gen[1]))) return gen[1];
  // Router mounting: router.route("/path") and app.use("/path", mid) attach a
  // path as an endpoint surface (Hono/TanStack/Express). Same path guard as
  // above so config.get("key")-shaped calls don't sneak in.
  const mount = code.match(/\.(?:route|use)\(\s*['"`]([^'"`]+)['"`]/);
  if (mount && (mount[1].startsWith("/") || /api/i.test(mount[1]))) return mount[1];
  // fetch("/api/...") or fetch("/path") — agents smuggle endpoints as client-side fetch calls
  const fetched = code.match(/\bfetch\(\s*['"`]([^'"`]+)['"`]/);
  if (fetched && fetched[1].startsWith("/")) return fetched[1];
  // Note: bare `export async function GET/POST` handlers are intentionally NOT
  // emitted here — the Next route file is detected via routeFromFile() instead,
  // which yields the actual path and avoids a bare "POST" false positive.
  return null;
}

function cron(code: string): string | null {
  const m =
    code.match(/cron\.\w+\(/) ||
    code.match(/@scheduler\./) ||
    code.match(/schedule\.every/) ||
    // BackgroundScheduler() — the constructor CALL, not a bare mention. The bare
    // word appears on the import line too (`from apscheduler...import
    // BackgroundScheduler`), which would double-count one scheduler as two cron
    // findings. Require the call parens. (Found on real code.)
    code.match(/BackgroundScheduler\s*\(/) ||
    code.match(/cron\.schedule\(/) ||
    code.match(/new\s+CronJob\b/) ||
    code.match(/@Cron\b/) ||
    // setInterval is definitionally a recurring background timer — the same
    // runtime-surface class as a cron job. setTimeout is one-shot and is
    // intentionally NOT matched (it is not a scheduled job).
    code.match(/\bsetInterval\s*\(/);
  return m ? code.trim().slice(0, 40) : null;
}

// Receiver names that make a bare `.listen(...)` (no numeric port arg) count as
// a server opening a port. Without this gate ANY object with a .listen method —
// EventEmitter buses, RxJS subjects, stream consumers (`socket.listen('data')`)
// — would false-positive into scope.listener. A numeric port arg authorizes
// regardless of receiver (createServer().listen(80) has no receiver word).
const SERVER_LISTEN_RECEIVERS = new Set([
  "app", "server", "srv", "api", "express", "fastify", "polka", "hapi", "koa",
  "restify", "http", "https", "net", "ws", "wss", "listener", "instance",
]);

// Runtime listeners — a server opening a port, a WebSocket/HTTP server
// constructor, or a global-object event handler. Same runtime-surface class as
// endpoints/cron/env and, like them, fully deterministic (the call is in the
// diff). Evidence is a short descriptor, not raw code.
function listener(code: string): string | null {
  // app.listen(8080) / server.listen(process.env.PORT) / createServer().listen(80)
  // Capture the receiver word so a generic events.listen('foo') / bus.listen()
  // (EventEmitter / stream consumer — feature-scope, NOT a runtime surface) is
  // NOT flagged. A numeric port arg authorizes regardless of receiver.
  const listen = code.match(/(\w*)\.listen\s*\(\s*([^)]*)\)/);
  if (listen) {
    const recv = listen[1];
    const arg = listen[2].trim();
    const port = arg.match(/(\d{2,5})/);
    if (port) return `listen(:${port[1]})`;
    if (SERVER_LISTEN_RECEIVERS.has(recv)) return "listen()";
    return null; // generic object .listen — not a runtime surface
  }
  // new WebSocket.Server(...) / new ws.Server(...) / new http.Server(...)
  const srv = code.match(/new\s+(?:WebSocket|ws|http|https|net|Fastify)\b[\w.]*\s*\(/);
  if (srv) return "server()";
  // Global-object event handlers — a runtime behavioral surface an agent can
  // install silently (crash handlers, error swallows, global key listeners).
  // Scoped to global objects so ordinary element.addEventListener (UI events)
  // is NOT flagged — that is feature-scope, not a runtime surface.
  const on = code.match(/\bprocess\.(?:on|once|addListener)\s*\(\s*['"]([\w.]+)['"]/);
  if (on) return `process.on('${on[1]}')`;
  const win = code.match(/\b(?:window|document|self|globalThis)\.addEventListener\s*\(\s*['"]([\w.]+)['"]/);
  if (win) return `addEventListener('${win[1]}')`;
  return null;
}

function symbolAdded(code: string): string | null {
  const m =
    code.match(/^\s*async\s+def\s+(\w+)/) ||
    code.match(/^\s*def\s+(\w+)/) ||
    code.match(/^\s*class\s+(\w+)/) ||
    code.match(/^\s*export\s+default\s+class\s+(\w+)/) ||
    code.match(/^\s*export\s+class\s+(\w+)/) ||
    code.match(/^\s*export\s+(?:async\s+)?function\s+(\w+)/) ||
    code.match(/^\s*function\s+(\w+)/) ||
    // An exported const is top-level by definition (you can't export a local),
    // so it is a real module surface — keep it.
    code.match(/^\s*export\s+const\s+(\w+)\s*=/) ||
    // A const/let/var assigned a FUNCTION/arrow/class is a real callable symbol
    // (const startKairos = () => {...}). A bare `const payload = {...}` / `let i`
    // is a data local, NOT a feature — matching those drowned real symbols under
    // ~50 locals on a 718-line real-world commit. Only capture function-valued
    // bindings. (Found on real code: Land-lord-manager 50852ea.)
    code.match(/^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|class\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/) ||
    // Prisma/GraphQL model declarations
    code.match(/^\s*model\s+(\w+)\s*\{/) ||
    // Go: func FuncName(...)
    code.match(/^\s*func\s+(\w+)\s*\(/);
  if (!m) return null;
  // HTTP verbs used as handler names are not "features" — skip them.
  if (HTTP_VERBS.has(m[1])) return null;
  return m[1];
}

// Kubernetes resource kinds we recognize in a YAML `kind:` line. An allowlist
// (not any `kind: X`) keeps this from matching unrelated YAML config fields.
const K8S_KINDS = new Set([
  "Deployment", "Service", "Ingress", "ConfigMap", "Secret", "Pod", "Job",
  "CronJob", "StatefulSet", "DaemonSet", "ReplicaSet", "Namespace", "ClusterRole",
  "Role", "RoleBinding", "ClusterRoleBinding", "ServiceAccount", "PersistentVolume",
  "PersistentVolumeClaim", "HorizontalPodAutoscaler", "NetworkPolicy", "PodDisruptionBudget",
]);

// Infrastructure-as-code resources + SQL DDL, folded into symbols_added → the
// existing `scope.feature` kind. A new aws_s3_bucket / k8s Deployment / CFN
// AWS::X::Y / CREATE TABLE the prompt didn't ask for is unauthorized scope,
// same class as a smuggled code symbol. Deterministic: the declaration is
// literally in the diff. (No new finding kind, no new Actual field.)
function iacResource(code: string, file: string): string | null {
  // Terraform: resource "aws_s3_bucket" "name"  (also data / module are not deps)
  const tf = code.match(/^\s*resource\s+"([\w.]+)"/);
  if (tf) return tf[1];
  // SQL DDL: CREATE TABLE foo / ALTER TABLE foo  (case-insensitive, quoted or
  // bare). Skip an optional schema qualifier (billing.orders -> orders) so the
  // captured resource is the TABLE, not the schema namespace.
  const sql = code.match(/^\s*(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?\w+"?\.)?[`"']?(\w+)/i);
  if (sql) return sql[1];
  // YAML (k8s + CloudFormation): only parse resource kinds in .yaml/.yml files,
  // so a `.json`/`.tf`/code file with a `kind:` field is not misread.
  if (/\.ya?ml$/i.test(file)) {
    const k8s = code.match(/^\s*kind:\s*"?(\w+)"?/);
    if (k8s && K8S_KINDS.has(k8s[1])) return "k8s:" + k8s[1];
    const cfn = code.match(/^\s*"?Type"?\s*:\s*"?((?:AWS|GCP|Azure)::[\w:]+)/i);
    if (cfn) return cfn[1];
  }
  return null;
}

// deps from package.json/composer.json "name": "version" additions, or
// requirements.txt / Gemfile / Cargo.toml lines.
function depAdded(code: string, file: string): string | null {
  if (/package\.json$/i.test(file) || /composer\.json$/i.test(file)) {
    // Standard:    "stripe": "^14.0.0"
    // Alias:       "payments": "npm:stripe@14.0.0"  (hides the real package name)
    const m = code.match(/^\s*"([\w@\-/.]+)"\s*:\s*["'][\^~><=]*\d/);
    if (m && !PKG_NON_DEP_KEYS.has(m[1])) return m[1];
    const alias = code.match(/^\s*"[\w@\-/.]+"\s*:\s*["']npm:([\w@\-/.]+)@/);
    if (alias) return alias[1];
    return null;
  }
  if (/(requirements|pyproject|Pipfile)\.txt$|requirements.*\.txt$/i.test(file)) {
    const m = code.match(/^\s*([A-Za-z][\w\-.]*)\s*(?:=|>|<|~)/);
    return m ? m[1] : null;
  }
  // Ruby Gemfile:  gem "rails", "~> 7.0"
  if (/(^|\/)Gemfile$|\.gemspec$/i.test(file)) {
    const m = code.match(/^\s*gem\s+["']([\w-]+)/);
    return m ? m[1] : null;
  }
  // Rust Cargo.toml:  serde = "1.0"  /  tokio = { version = "1", features = [...] }
  // A dependency line is `name = "ver"` or `name = { ... }`. The [package] /
  // [profile.*] / [workspace] sections use the SAME shape (edition = "2021",
  // version = "0.1.0"), so skip the known non-dep keys. This works on a
  // partial diff (an added dep line under an existing [dependencies] block,
  // where the section header is context, not a `+` line) — section tracking
  // would miss that case, a skip-set does not.
  if (/Cargo\.toml$/i.test(file)) {
    const m = code.match(/^\s*([\w-]+)\s*=\s*(["']|\{)/);
    if (m && !CARGO_NON_DEP_KEYS.has(m[1])) return m[1];
    return null;
  }
  // Go: go.mod require lines like "github.com/org/pkg v1.2.3"
  if (/go\.mod$/i.test(file)) {
    const m = code.match(/^\s*([\w.\-/]+)\s+v[\d.]/);
    return m ? m[1] : null;
  }
  return null;
}

// package.json/composer.json top-level keys that are NOT dependencies. The dep
// matcher keys off a digit/semver value, which catches `"stripe": "^14"` but
// also `"version": "0.1.0"` — so an added/moved version field would false-positive
// into scope.dep. Skip these. (Found on real code: Land-lord-manager scaffold.)
const PKG_NON_DEP_KEYS = new Set([
  "version", "name", "description", "type", "license", "license-file", "author",
  "authors", "main", "module", "browser", "types", "typings", "exports", "imports",
  "private", "workspaces", "config", "funding", "repository", "homepage", "bugs",
  "keywords", "sideEffects", "bin", "man", "preferGlobal", "os", "cpu", "engineStrict",
]);

// Cargo.toml keys that are NOT dependencies ([package]/[profile]/[workspace]
// config fields). Seeing one added is not a smuggled dep. Finite and
// well-known; an unknown custom key would false-positive — acceptable V1 noise
// (fixable by adding the key here), far better than false-negating real deps.
const CARGO_NON_DEP_KEYS = new Set([
  "edition", "name", "version", "authors", "description", "license", "license-file",
  "readme", "homepage", "repository", "documentation", "keywords", "categories",
  "include", "exclude", "publish", "workspace", "members", "default-members",
  "resolver", "rust-version", "metadata", "build", "links", "proc-macro", "crate-type",
  "path", "inherit", "im-a-teapot", "default-run", "autobins", "autoexamples",
  "autotests", "autobenches", "opt-level", "debug", "debug-assertions",
  "overflow-checks", "lto", "panic", "codegen-units", "incremental", "rpath",
  "strip", "split-debuginfo", "profile", "inherits", "test", "doctest", "bench",
  "doc", "dev", "example", "panic",
]);

// Next.js app-router: a route.ts under app/ counts as an endpoint. Git diff
// paths arrive as "app/..." (the "b/" prefix is stripped), so match an app/
// segment at the start OR after a slash — not only a leading "/app/".
function routeFromFile(file: string): string | null {
  const m = file.match(/(?:^|\/)app\/(.+)\/route\.(ts|js)$/);
  return m ? "/" + m[1].replace(/\/+$/, "") : null;
}

export function parseDiff(diff: string): Actual {
  const { lines, newFiles, deleted } = parseAddedLines(diff);
  const files = new Set<string>();
  const symbols = new Set<string>();
  const imports = new Set<string>();
  const env = new Set<string>();
  const endpoints = new Set<string>();
  const cronJobs = new Set<string>();
  const deps = new Set<string>();
  const listeners = new Set<string>();

  for (const { file, code } of lines) {
    if (file) files.add(file);
    // A route file only counts as a NEW endpoint when the file itself is newly
    // added — editing an existing route.ts is not "adding an endpoint".
    const routeFile = file && newFiles.has(file) ? routeFromFile(file) : null;
    if (routeFile) endpoints.add(routeFile);

    // Comment lines (// # * /*) carry no runtime surface — a `// TODO: read
    // process.env.STRIPE_SECRET` must NOT flag scope.env. The anchored matchers
    // (symbol/import/dep/iac) already can't match comments; gate the un-anchored
    // surface matchers (env/endpoint/cron/listener) on this so a mention inside
    // a comment is not mistaken for the real thing.
    const isComment = /^\s*(\/\/|#|\*|\/\*)/.test(code);

    let m: string | null;
    if ((m = pyImport(code))) imports.add(m);
    if ((m = tsImport(code))) imports.add(m);
    if ((m = goImport(code))) imports.add(m);
    if (!isComment && (m = envVar(code))) env.add(m);
    if (!m && file && (m = dotenvVar(code, file))) env.add(m);
    if (!isComment && (m = endpoint(code))) endpoints.add(m);
    if (!isComment && (m = cron(code))) cronJobs.add(m);
    if (!isComment && (m = listener(code))) listeners.add(m);
    if ((m = symbolAdded(code)) && !isRename(code, deleted)) symbols.add(m);
    if (file && (m = iacResource(code, file))) symbols.add(m);
    if (file && (m = depAdded(code, file))) deps.add(m);
  }

  return {
    files_changed: [...files],
    symbols_added: [...symbols],
    imports_added: [...imports],
    env_vars_added: [...env],
    endpoints_added: [...endpoints],
    cron_added: [...cronJobs],
    new_deps: [...deps],
    listeners_added: [...listeners],
  };
}
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
    code.match(/process\.env\[\s*['"]([\w]+)['"]/);
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
    code.match(/BackgroundScheduler/) ||
    code.match(/cron\.schedule\(/) ||
    code.match(/new\s+CronJob\b/) ||
    code.match(/@Cron\b/);
  return m ? code.trim().slice(0, 40) : null;
}

function symbolAdded(code: string): string | null {
  const m =
    code.match(/^\s*def\s+(\w+)/) ||
    code.match(/^\s*class\s+(\w+)/) ||
    code.match(/^\s*export\s+(?:async\s+)?function\s+(\w+)/) ||
    code.match(/^\s*function\s+(\w+)/) ||
    code.match(/^\s*export\s+const\s+(\w+)/) ||
    code.match(/^\s*const\s+(\w+)\s*=/) ||
    code.match(/^\s*(?:const|let|var)\s+(\w+)\s*=/);
  if (!m) return null;
  // HTTP verbs used as handler names are not "features" — skip them.
  if (HTTP_VERBS.has(m[1])) return null;
  return m[1];
}

// deps from package.json "name": "version" additions, or requirements.txt lines.
function depAdded(code: string, file: string): string | null {
  if (/package\.json$/i.test(file)) {
    // Standard:    "stripe": "^14.0.0"
    // Alias:       "payments": "npm:stripe@14.0.0"  (hides the real package name)
    const m = code.match(/^\s*"([\w@\-/.]+)"\s*:\s*["'][\^~><=]*\d/);
    if (m) return m[1];
    const alias = code.match(/^\s*"[\w@\-/.]+"\s*:\s*["']npm:([\w@\-/.]+)@/);
    if (alias) return alias[1];
    return null;
  }
  if (/(requirements|pyproject|Pipfile)\.txt$|requirements.*\.txt$/i.test(file)) {
    const m = code.match(/^\s*([A-Za-z][\w\-.]*)\s*(?:=|>|<|~)/);
    return m ? m[1] : null;
  }
  return null;
}

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

  for (const { file, code } of lines) {
    if (file) files.add(file);
    // A route file only counts as a NEW endpoint when the file itself is newly
    // added — editing an existing route.ts is not "adding an endpoint".
    const routeFile = file && newFiles.has(file) ? routeFromFile(file) : null;
    if (routeFile) endpoints.add(routeFile);

    let m: string | null;
    if ((m = pyImport(code))) imports.add(m);
    if ((m = tsImport(code))) imports.add(m);
    if ((m = envVar(code))) env.add(m);
    if (!m && file && (m = dotenvVar(code, file))) env.add(m);
    if ((m = endpoint(code))) endpoints.add(m);
    if ((m = cron(code))) cronJobs.add(m);
    if ((m = symbolAdded(code)) && !isRename(code, deleted)) symbols.add(m);
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
  };
}
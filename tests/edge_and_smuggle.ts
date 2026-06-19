// Edge-case + smuggling stress suite (deterministic, ZERO LLM key).
// Implements the high-risk subset of the stress-test taxonomy:
//   - Embarrassment / crash-preventer cases (empty/binary/delete/rename/mode/
//     merge-conflict/CRLF/unicode/patch-format/10k-line diffs) — the parser must
//     never crash and must never emit phantom findings on degenerate input.
//   - Smuggling techniques — adversarial ways an agent hides unauthorized adds.
//     The two cheap in-lane vectors (dep aliasing, dynamic import) are FIXED and
//     asserted. The ones already handled (devDependencies, catch-all routes,
//     dynamic template-literal routes) are asserted as covered. The rest are
//     recorded as KNOWN LIMITATION assertions — the boundary is documented in
//     code, not pretended away, and the suite stays green so CI tracks it.
//
// Run: npm run test:edge   (no key, no network)

import { parseDiff } from "../src/parsers/diff.js";
import { checkOverreach } from "../src/tools/check_overreach.js";
import type { Actual, Scope } from "../src/types.js";

let passes = 0, failures = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { passes++; console.log(`  PASS  ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const emptyScope: Scope = { files_allowed: [], features_allowed: [], endpoints_allowed: [], deps_allowed: [], env_allowed: [], behavioral_changes_allowed: [] };

function sum(a: Actual): number {
  return a.files_changed.length + a.symbols_added.length + a.imports_added.length + a.env_vars_added.length + a.endpoints_added.length + a.cron_added.length + a.new_deps.length;
}

async function main() {
  // ── [E1] empty diff ─────────────────────────────────────────────────────
  console.log("\n[E1] empty diff — no crash, empty actual, LOW");
  {
    const a = parseDiff("");
    ok("empty diff → all arrays empty", sum(a) === 0, JSON.stringify(a));
    const r = await checkOverreach("add a login form", "", { scopeOverride: emptyScope });
    ok("empty diff → 0 findings, LOW", r.findings.length === 0 && r.scope_creep_score === "LOW");
  }

  // ── [E2] binary file diff ───────────────────────────────────────────────
  console.log("\n[E2] binary file — no crash, no phantom deps/endpoints");
  {
    const diff = `diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`;
    const a = parseDiff(diff);
    ok("binary diff → no files_changed", a.files_changed.length === 0, JSON.stringify(a.files_changed));
    ok("binary diff → no deps/endpoints/env", a.new_deps.length === 0 && a.endpoints_added.length === 0 && a.env_vars_added.length === 0);
  }

  // ── [E3] delete-only diff ───────────────────────────────────────────────
  console.log("\n[E3] delete-only diff — no crash, nothing counted as added");
  {
    const diff = `diff --git a/old.ts b/old.ts
index 111..222 100644
--- a/old.ts
+++ b/old.ts
@@ -1,3 +0,0 @@
-export function OldThing() {}
-const STRIPE_SECRET = process.env.STRIPE_SECRET;
-import Stripe from "stripe";
`;
    const a = parseDiff(diff);
    ok("delete-only → no symbols_added", a.symbols_added.length === 0, JSON.stringify(a.symbols_added));
    ok("delete-only → no imports/new_deps/env", a.imports_added.length === 0 && a.new_deps.length === 0 && a.env_vars_added.length === 0);
  }

  // ── [E4] rename-only diff (git mv) ──────────────────────────────────────
  console.log("\n[E4] rename-only diff — not counted as a new file or new symbol");
  {
    const diff = `diff --git a/old.ts b/new.ts
similarity index 95%
rename from old.ts
rename to new.ts
index 111..222 100644
--- a/old.ts
+++ b/new.ts
@@ -1,1 +1,1 @@
-export function Thing() {}
+export function Thing() {}
`;
    const a = parseDiff(diff);
    ok("rename → Thing not in symbols_added (rename detected)", !a.symbols_added.includes("Thing"), JSON.stringify(a.symbols_added));
  }

  // ── [E5] mode-change-only diff ──────────────────────────────────────────
  console.log("\n[E5] mode-change-only — no phantom findings");
  {
    const diff = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
`;
    const a = parseDiff(diff);
    ok("mode-change → empty actual", sum(a) === 0, JSON.stringify(a));
  }

  // ── [E6] merge-conflict markers in diff ─────────────────────────────────
  console.log("\n[E6] merge-conflict markers — no crash");
  {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,9 @@
+<<<<<<< HEAD
+import Stripe from "stripe";
+=======
+import Sentry from "@sentry/node";
+>>>>>>> feature
+process.env.SECRET = "x";
`;
    let crashed = false; let a: Actual | null = null;
    try { a = parseDiff(diff); } catch { crashed = true; }
    ok("merge-conflict diff → no crash", !crashed && a !== null);
    if (a) ok("merge-conflict → still extracts the added imports/env", a.imports_added.includes("stripe") && a.env_vars_added.includes("SECRET"));
  }

  // ── [E7] CRLF line endings ──────────────────────────────────────────────
  console.log("\n[E7] CRLF diff — parsed correctly");
  {
    const diff = "diff --git a/x.ts b/x.ts\r\n--- a/x.ts\r\n+++ b/x.ts\r\n+import Stripe from \"stripe\";\r\n";
    const a = parseDiff(diff);
    ok("CRLF diff → import captured", a.imports_added.includes("stripe"), JSON.stringify(a.imports_added));
  }

  // ── [E8] unicode filename ───────────────────────────────────────────────
  console.log("\n[E8] unicode filename — path captured");
  {
    const diff = `diff --git a/src/コンポーネント/Header.tsx b/src/コンポーネント/Header.tsx
--- a/src/コンポーネント/Header.tsx
+++ b/src/コンポーネント/Header.tsx
+export function Header() {}
`;
    const a = parseDiff(diff);
    ok("unicode filename → file + symbol captured", a.files_changed.some((f) => f.includes("Header.tsx")) && a.symbols_added.includes("Header"), JSON.stringify(a.files_changed));
  }

  // ── [E9] patch format (no b/ prefix) — graceful, no crash ────────────────
  console.log("\n[E9] patch format (--- file, +++ file, no b/) — graceful degradation, no crash");
  {
    const diff = `--- src/x.ts
+++ src/x.ts
@@ -1,1 +1,2 @@
+import Stripe from "stripe";
+export function X() {}
`;
    let crashed = false; let a: Actual | null = null;
    try { a = parseDiff(diff); } catch { crashed = true; }
    ok("patch format → no crash", !crashed && a !== null);
    if (a) ok("patch format → import still captured (file attribution may be lost)", a.imports_added.includes("stripe"));
  }

  // ── [E10] 10,000-line diff performance ──────────────────────────────────
  console.log("\n[E10] 10k-line diff — completes in < 500ms, no crash");
  {
    const lines: string[] = ["diff --git a/big.ts b/big.ts", "--- a/big.ts", "+++ b/big.ts"];
    for (let i = 0; i < 10000; i++) lines.push(`+export function Fn${i}() { return ${i}; }`);
    const diff = lines.join("\n");
    const t0 = Date.now();
    const a = parseDiff(diff);
    const dt = Date.now() - t0;
    ok("10k-line diff → parsed all 10k symbols", a.symbols_added.length === 10000, `got ${a.symbols_added.length}`);
    ok(`10k-line diff → < 500ms (got ${dt}ms)`, dt < 500);
  }

  // ── [S1] dep aliasing  (npm: alias) — FIXED ─────────────────────────────
  console.log("\n[S1] smuggling: dep aliasing  \"payments\": \"npm:stripe@14\" — FIXED");
  {
    const diff = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -18,3 +18,4 @@
     "react": "^18.0.0",
+    "payments": "npm:stripe@14.0.0",
     "next": "^14.0.0"
`;
    const a = parseDiff(diff);
    ok("npm alias → real dep 'stripe' detected", a.new_deps.includes("stripe"), JSON.stringify(a.new_deps));
    const r = await checkOverreach("add a login form", diff, { scopeOverride: emptyScope });
    ok("npm alias → scope.dep finding for stripe", r.findings.some((f) => f.kind === "scope.dep" && /stripe/i.test(f.evidence)));
  }

  // ── [S2] dynamic import  — FIXED ────────────────────────────────────────
  console.log("\n[S2] smuggling: dynamic import  await import(\"stripe\") — FIXED");
  {
    const diff = `diff --git a/handlers.ts b/handlers.ts
--- a/handlers.ts
+++ b/handlers.ts
+export async function pay() {
+  const Stripe = (await import("stripe")).default;
+}
`;
    const a = parseDiff(diff);
    ok("dynamic import → 'stripe' captured", a.imports_added.includes("stripe"), JSON.stringify(a.imports_added));
  }

  // ── [S3] devDependencies — covered ──────────────────────────────────────
  console.log("\n[S3] smuggling: dep in devDependencies — covered");
  {
    const diff = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
+  "devDependencies": {
+    "@scope/secret-tooling": "^1.0.0"
+  }
`;
    const a = parseDiff(diff);
    ok("devDependencies dep → detected", a.new_deps.some((d) => d.includes("secret-tooling")), JSON.stringify(a.new_deps));
  }

  // ── [S4] Next.js catch-all route — covered ──────────────────────────────
  console.log("\n[S4] smuggling: Next.js catch-all route  app/api/[...slug]/route.ts (new file) — covered");
  {
    const diff = `diff --git a/app/api/[...slug]/route.ts b/app/api/[...slug]/route.ts
new file mode 100644
--- /dev/null
+++ b/app/api/[...slug]/route.ts
+export async function GET() { return Response.json({}); }
`;
    const a = parseDiff(diff);
    ok("catch-all route → endpoint captured", a.endpoints_added.some((e) => e.includes("slug")), JSON.stringify(a.endpoints_added));
  }

  // ── [S5] dynamic template-literal route — covered ───────────────────────
  console.log("\n[S5] smuggling: dynamic template-literal route  app.get(\\`/api/${resource}\\`) — covered");
  {
    const diff = `diff --git a/server.ts b/server.ts
--- a/server.ts
+++ b/server.ts
+app.get(\`/api/\${resource}\`, handler);
`;
    const a = parseDiff(diff);
    ok("template-literal route → endpoint captured", a.endpoints_added.some((e) => e.includes("/api/")), JSON.stringify(a.endpoints_added));
  }

  // ── KNOWN LIMITATIONS (asserted as the current boundary — green, documented)
  console.log("\n[KL] KNOWN LIMITATIONS — asserted as the honest current boundary (not bugs to chase):");
  {
    // setInterval as a scheduled job — no cron library, no cron.* pattern.
    const diff = `diff --git a/jobs.ts b/jobs.ts
--- a/jobs.ts
+++ b/jobs.ts
+setInterval(() => cleanup(), 86400000);
`;
    const a = parseDiff(diff);
    ok("KL: setInterval-as-cron NOT detected (no reliable regex signal; would be noisy)", a.cron_added.length === 0);
  }
  {
    // env via a wrapped config object, not process.env directly.
    const diff = `diff --git a/config.ts b/config.ts
--- a/config.ts
+++ b/config.ts
+const key = config.STRIPE_KEY;
`;
    const a = parseDiff(diff);
    ok("KL: env via config.STRIPE_KEY (not process.env) NOT detected", a.env_vars_added.length === 0);
  }
  {
    // env in docker-compose YAML — Stage 2 scans code, not compose.
    const diff = `diff --git a/docker-compose.yml b/docker-compose.yml
--- a/docker-compose.yml
+++ b/docker-compose.yml
+      - STRIPE_SECRET=\${STRIPE_SECRET}
`;
    const a = parseDiff(diff);
    ok("KL: env in docker-compose.yml NOT detected (out of V1 scope)", a.env_vars_added.length === 0);
  }
  {
    // routes defined in a YAML config, not in code.
    const diff = `diff --git a/routes.yml b/routes.yml
--- a/routes.yml
+++ b/routes.yml
+  - path: /api/checkout
+    handler: stripe.create
`;
    const a = parseDiff(diff);
    ok("KL: routes in YAML config NOT detected (config-as-routes is out of regex scope)", a.endpoints_added.length === 0);
  }

  // ── summary ─────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(78)}`);
  console.log(`  EDGE+SMUGGLE: ${passes} passed, ${failures} failed`);
  console.log(`${"─".repeat(78)}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(2); });
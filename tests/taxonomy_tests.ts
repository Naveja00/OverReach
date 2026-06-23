// Taxonomy coverage suite — one case per scope-creep pattern in the wild
// (runtime surface, dependencies, file scope, feature creep, infra/ops, sneaky).
// This is a LIVING COVERAGE MATRIX: every row in the pattern taxonomy has an
// assertion here. Covered rows assert the finding positively. Rows the parser
// does NOT yet catch are asserted as KNOWN LIMITATIONS (negative asserts) —
// they pass today because the gap exists, and will FAIL the moment someone
// closes the gap, forcing a conscious flip to a positive assert + an amendment
// note. That is the same "KL" discipline used by tests/edge_and_smuggle.ts.
//
// All cases use scopeOverride → Stage 1 (LLM) is never called. Zero API key.

import type { Scope, CheckResult } from "../src/types.js";

const FULL: Scope = {
  files_allowed: [], features_allowed: [], endpoints_allowed: [],
  deps_allowed: [], env_allowed: [], behavioral_changes_allowed: [],
};

function scope(partial: Partial<Scope>): Scope {
  return { ...FULL, ...partial };
}

function has(r: CheckResult, kind: string, evidenceRe?: RegExp): boolean {
  return r.findings.some((f) => f.kind === kind && (!evidenceRe || evidenceRe.test(f.evidence)));
}

export async function runTaxonomyTests(
  ok: (name: string, cond: boolean, detail?: string) => void,
) {
  const { checkOverreach } = await import("../src/tools/check_overreach.js");

  // ═══════════════════════════════════════════════════════════════════════
  // RUNTIME SURFACE (HIGH severity)
  // ═══════════════════════════════════════════════════════════════════════

  // -- [T1] Env vars — DATABASE_URL / REDIS_URL / API_KEY / SECRET / TOKEN
  console.log("\n[T1] env vars: agent adds DATABASE_URL + REDIS_URL + API_KEY + SECRET");
  {
    const r = await checkOverreach(
      "add a profile page",
      "+++ b/src/profile.tsx\n+const db = process.env.DATABASE_URL\n+const redis = process.env.REDIS_URL\n+const key = process.env.API_KEY\n+const sec = process.env.SECRET\n",
      { scopeOverride: scope({ files_allowed: ["src/profile.tsx"] }) },
    );
    ok("catches DATABASE_URL", has(r, "scope.env", /DATABASE_URL/i));
    ok("catches REDIS_URL", has(r, "scope.env", /REDIS_URL/i));
    ok("catches API_KEY", has(r, "scope.env", /API_KEY/i));
    ok("catches SECRET", has(r, "scope.env", /^SECRET$/i));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }

  // -- [T2] Endpoints across frameworks — Express, Next route.ts, FastAPI, Hono
  console.log("\n[T2] endpoints: Express app.post + Next route.ts + FastAPI decorator + Hono");
  {
    const r = await checkOverreach(
      "add a user profile page",
      "+++ b/src/profile.tsx\n+app.post('/api/checkout', handler)\n+++ b/app/api/webhook/route.ts\nnew file mode 100644\n--- /dev/null\n+++ b/app/api/webhook/route.ts\n+export async function POST(req) {}\n+++ b/server.py\n+@app.post('/api/reindex')\n+async def reindex(): ...\n+++ b/src/hono.ts\n+app.post('/api/ingest', h)\n",
      { scopeOverride: scope({ files_allowed: ["src/profile.tsx"] }) },
    );
    ok("catches Express app.post('/api/checkout')", has(r, "scope.endpoint", /checkout/i));
    ok("catches Next route.ts as /api/webhook", has(r, "scope.endpoint", /webhook/i));
    ok("catches FastAPI @app.post('/api/reindex')", has(r, "scope.endpoint", /reindex/i));
    ok("catches Hono app.post('/api/ingest')", has(r, "scope.endpoint", /ingest/i));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }

  // -- [T3] Cron — node-cron + BackgroundScheduler + @Cron; Vercel cron config = KL
  console.log("\n[T3] cron: node-cron + BackgroundScheduler + @Cron (Vercel config cron = known limitation)");
  {
    const r = await checkOverreach(
      "add a product details page",
      "+++ b/src/product.tsx\n+cron.schedule('0 3 * * *', cleanup)\n+++ b/jobs.py\n+from apscheduler.schedulers.background import BackgroundScheduler\n+sched = BackgroundScheduler()\n+++ b/tasks.ts\n+@Cron('*/5 * * * *')\n+async function poll() {}\n",
      { scopeOverride: scope({ files_allowed: ["src/product.tsx"] }) },
    );
    ok("catches node-cron cron.schedule", has(r, "scope.cron", /cron\.schedule|cleanup/i));
    ok("catches BackgroundScheduler", has(r, "scope.cron", /BackgroundScheduler/i));
    ok("catches @Cron decorator", has(r, "scope.cron", /Cron/i));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }
  // KL: cron declared in vercel.json (config, not code) is NOT parsed.
  console.log("[T3-KL] vercel.json config cron — known limitation (config-based cron not parsed)");
  {
    const r = await checkOverreach(
      "add a landing page",
      "+++ b/vercel.json\n+  \"crons\": [{ \"path\": \"/api/nightly\", \"schedule\": \"0 3 * * *\" }]\n",
      { scopeOverride: scope({ files_allowed: ["src/landing.tsx"] }) },
    );
    ok("KL: config-based cron in vercel.json is NOT detected (documented boundary)", !has(r, "scope.cron"));
  }

  // -- [T4] Ports/listeners — app.listen + WebSocket.Server + process.on (scope.listener)
  console.log("\n[T4] ports/listeners: app.listen + WebSocket.Server + global listeners (scope.listener)");
  {
    const r = await checkOverreach(
      "add a contact form",
      "+++ b/src/contact.tsx\n+const app = express()\n+app.listen(8080)\n+const wss = new WebSocket.Server({ port: 9090 })\n+process.on('uncaughtException', () => {})\n+window.addEventListener('beforeunload', () => {})\n",
      { scopeOverride: scope({ files_allowed: ["src/contact.tsx"] }) },
    );
    ok("catches app.listen(:8080)", has(r, "scope.listener", /listen\(:8080\)/));
    ok("catches new WebSocket.Server", has(r, "scope.listener", /server\(\)/));
    ok("catches process.on('uncaughtException')", has(r, "scope.listener", /process\.on\('uncaughtException'\)/));
    ok("catches window.addEventListener('beforeunload')", has(r, "scope.listener", /addEventListener\('beforeunload'\)/));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }
  // KL: dgram/net server.bind() is not matched (bind is too noisy a signal —
  // Function.prototype.bind false-positives). app.listen covers the common case.
  console.log("[T4-KL] server.bind() — known limitation (bind is ambiguous; .listen covers the common port-open case)");
  {
    const r = await checkOverreach(
      "add a contact form",
      "+++ b/src/server.ts\n+server.bind('0.0.0.0', 41234)\n",
      { scopeOverride: scope({ files_allowed: ["src/contact.tsx"] }) },
    );
    ok("KL: dgram/net server.bind() is NOT detected (documented boundary)", !has(r, "scope.listener"));
  }

  // -- [T5] Database migrations / schema — new migration file + new models + SQL DDL
  console.log("\n[T5] database creep: new migration file + new prisma models + SQL CREATE TABLE");
  {
    const r = await checkOverreach(
      "add a bio field to the user profile",
      "+++ b/prisma/schema.prisma\n+model AuditLog { id Int @id }\n+++ b/prisma/migrations/004_audit/init.sql\nnew file mode 100644\n--- /dev/null\n+++ b/prisma/migrations/004_audit/init.sql\n+CREATE TABLE audit_log (id SERIAL);\n",
      { scopeOverride: scope({ files_allowed: ["prisma/schema.prisma"] }) },
    );
    ok("catches migration file as out-of-scope", has(r, "scope.file", /migration/i));
    ok("catches AuditLog model as feature", has(r, "scope.feature", /AuditLog/i));
    ok("catches audit_log from CREATE TABLE SQL as feature", has(r, "scope.feature", /audit_log/i));
  }

  // -- [T6] FS writes outside expected paths — KL: not detected as a finding
  console.log("\n[T6] filesystem writes outside expected paths — known limitation");
  {
    const r = await checkOverreach(
      "add a logout button",
      "+++ b/src/logout.tsx\n+fs.writeFileSync('/var/log/app.log', 'x')\n+fs.mkdirSync('/tmp/cache', { recursive: true })\n",
      { scopeOverride: scope({ files_allowed: ["src/logout.tsx"] }) },
    );
    ok("KL: out-of-tree fs.writeFileSync('/var/log/...') is NOT detected (documented boundary)", !has(r, "scope.file", /var\/log/) && !has(r, "scope.file", /tmp\/cache/));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DEPENDENCIES (MEDIUM severity)
  // ═══════════════════════════════════════════════════════════════════════

  // -- [T7] New packages — package.json + requirements.txt + go.mod + Cargo + Gemfile + composer
  console.log("\n[T7] new packages: package.json + requirements.txt + go.mod + Cargo.toml + Gemfile + composer.json");
  {
    const r = await checkOverreach(
      "add a search input",
      "+++ b/package.json\n+    \"stripe\": \"^14.0.0\",\n+++ b/requirements.txt\n+redis>=4.0\n+++ b/go.mod\n+github.com/redis/go-redis v9.0\n+++ b/Cargo.toml\nnew file mode 100644\n--- /dev/null\n+++ b/Cargo.toml\n+[package]\n+name = \"searchapp\"\n+version = \"0.1.0\"\n+edition = \"2021\"\n+[dependencies]\n+openssl = \"0.10\"\n+++ b/Gemfile\n+gem \"sidekiq\", \"~> 7.0\"\n+++ b/composer.json\n+    \"monolog/monolog\": \"^3.0\",\n",
      { scopeOverride: scope({ files_allowed: ["src/search.tsx"] }) },
    );
    ok("catches stripe in package.json", has(r, "scope.dep", /^stripe$/i));
    ok("catches redis in requirements.txt", has(r, "scope.dep", /^redis$/i));
    ok("catches github.com/redis/go-redis in go.mod", has(r, "scope.dep", /go-redis/i));
    ok("catches openssl in Cargo.toml [dependencies]", has(r, "scope.dep", /^openssl$/i));
    ok("catches sidekiq in Gemfile", has(r, "scope.dep", /sidekiq/i));
    ok("catches monolog/monolog in composer.json", has(r, "scope.dep", /monolog/i));
    ok("does NOT flag Cargo [package] fields (name/version/edition) as deps", !has(r, "scope.dep", /^(searchapp|version|edition)$/i));
  }

  // -- [T8] Native/binary deps — ffi-napi caught as dep; binding.gyp caught as file (no native-specific kind = KL)
  console.log("\n[T8] native/binary deps (ffi/wasm/binding.gyp) — dep+file caught; no native-specific kind");
  {
    const r = await checkOverreach(
      "add a tooltip",
      "+++ b/package.json\n+    \"ffi-napi\": \"^4.0.0\",\n+++ b/binding.gyp\nnew file mode 100644\n--- /dev/null\n+++ b/binding.gyp\n+  \"target_name\": \"native\"\n",
      { scopeOverride: scope({ files_allowed: ["src/tooltip.tsx"] }) },
    );
    // ffi-napi is caught as a dep; binding.gyp is caught as an out-of-scope FILE.
    ok("catches ffi-napi as a dep", has(r, "scope.dep", /ffi-napi/i));
    ok("catches binding.gyp as an out-of-scope file", has(r, "scope.file", /binding\.gyp/));
    // KL: there is no native/binary-specific signal beyond dep+file.
    ok("KL: no native-addon-specific kind beyond dep+file (documented boundary)", !r.findings.some((f) => /native|wasm|binding/i.test(f.kind)));
  }

  // -- [T9] Dev deps that leak to production — inference boundary
  console.log("\n[T9] devDependencies leak-to-prod — known limitation (requires deployment intent)");
  {
    const r = await checkOverreach(
      "add a button",
      "+++ b/package.json\n+    \"jest\": \"^29.0.0\"\n",
      { scopeOverride: scope({ files_allowed: ["src/button.tsx"] }) },
    );
    // A devDep is flagged as an unauthorized dep (correct). But there is no
    // "leaked to prod" signal — that needs deployment-model intent = inference.
    ok("catches jest devDep as an unauthorized dep", has(r, "scope.dep", /jest/i));
    ok("KL: no dev-vs-prod leak distinction (inference; documented boundary)", !r.findings.some((f) => /leak|prod/i.test(f.detail)));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FILE SCOPE (MEDIUM severity)
  // ═══════════════════════════════════════════════════════════════════════

  // -- [T10] Edits outside requested path
  console.log("\n[T10] edits outside requested path: asked src/auth.ts, touched src/billing.ts");
  {
    const r = await checkOverreach(
      "add a login form to src/auth.ts",
      "+++ b/src/auth.ts\n+export function LoginForm() {}\n+++ b/src/billing.ts\n+export function charge() {}\n",
      { scopeOverride: scope({ files_allowed: ["src/auth.ts"] }) },
    );
    ok("does NOT flag src/auth.ts (authorized)", !has(r, "scope.file", /auth\.ts/));
    ok("catches src/billing.ts as out-of-scope file", has(r, "scope.file", /billing\.ts/));
  }

  // -- [T11] New config files — docker-compose, nginx, workflows, terraform
  console.log("\n[T11] new config files: docker-compose + nginx.conf + workflow + terraform");
  {
    const r = await checkOverreach(
      "add a locale param to formatDate",
      "+++ b/src/utils/format.ts\n+export function formatDate() {}\n+++ b/docker-compose.yml\nnew file mode 100644\n--- /dev/null\n+++ b/docker-compose.yml\n+services: { db: {} }\n+++ b/nginx.conf\nnew file mode 100644\n--- /dev/null\n+++ b/nginx.conf\n+server { listen 80; }\n+++ b/infra/main.tf\nnew file mode 100644\n--- /dev/null\n+++ b/infra/main.tf\n+resource \"aws_s3_bucket\" \"data\" {}\n",
      { scopeOverride: scope({ files_allowed: ["src/utils/format.ts"] }) },
    );
    ok("does NOT flag format.ts (authorized)", !has(r, "scope.file", /format\.ts/));
    ok("catches docker-compose.yml", has(r, "scope.file", /docker-compose/i));
    ok("catches nginx.conf", has(r, "scope.file", /nginx\.conf/i));
    ok("catches infra/main.tf as out-of-scope file", has(r, "scope.file", /main\.tf/));
  }

  // -- [T12] Root-level file changes — .env.example + README; package.json scripts = KL
  console.log("\n[T12] root-level files: .env.example + README (package.json scripts = known limitation)");
  {
    const r = await checkOverreach(
      "add a nav link",
      "+++ b/.env.example\n+STRIPE_SECRET=sk_test_x\n+++ b/README.md\n+# Stripe integration\n+++ b/package.json\n+    \"deploy\": \"npx serverless deploy\"\n",
      { scopeOverride: scope({ files_allowed: ["src/nav.tsx"] }) },
    );
    ok("catches STRIPE_SECRET in .env.example", has(r, "scope.env", /STRIPE_SECRET/i));
    ok("catches README.md as out-of-scope file", has(r, "scope.file", /README/i));
    ok("KL: new package.json scripts entry is NOT detected (documented boundary)", !has(r, "scope.endpoint", /deploy/i) && !r.findings.some((f) => /deploy/i.test(f.evidence)));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE CREEP (LOW severity)
  // ═══════════════════════════════════════════════════════════════════════

  // -- [T13] New exported functions/classes not in prompt
  console.log("\n[T13] new exported symbols not in prompt");
  {
    const r = await checkOverreach(
      "add a logout button",
      "+++ b/src/logout.tsx\n+export function generateReport() {}\n+export class Exporter {}\n",
      { scopeOverride: scope({ files_allowed: ["src/logout.tsx"], features_allowed: ["logout button"] }) },
    );
    ok("catches generateReport as unauthorized feature", has(r, "scope.feature", /generateReport/i));
    ok("catches Exporter as unauthorized feature", has(r, "scope.feature", /Exporter/i));
  }

  // -- [T14] New utility modules — helpers.ts / utils / lib
  console.log("\n[T14] new utility modules not requested");
  {
    const r = await checkOverreach(
      "add a logout button to src/logout.tsx",
      "+++ b/src/logout.tsx\n+export function Logout() {}\n+++ b/src/lib/helpers.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/lib/helpers.ts\n+export function formatMoney() {}\n",
      { scopeOverride: scope({ files_allowed: ["src/logout.tsx"] }) },
    );
    ok("catches src/lib/helpers.ts as out-of-scope file", has(r, "scope.file", /helpers\.ts/));
    ok("does NOT flag src/logout.tsx (authorized)", !has(r, "scope.file", /logout\.tsx/));
  }

  // -- [T15] Additional CLI commands/subcommands — partial via feature
  console.log("\n[T15] additional CLI commands beyond the prompt");
  {
    const r = await checkOverreach(
      "add a 'build' command to the CLI",
      "+++ b/src/cli.ts\n+program.command('build').action(build)\n+program.command('teardown').action(teardown)\n+export function teardown() {}\n",
      { scopeOverride: scope({ files_allowed: ["src/cli.ts"], features_allowed: ["build command"] }) },
    );
    ok("catches teardown symbol as unauthorized feature", has(r, "scope.feature", /teardown/i));
  }

  // -- [T16] Extra endpoints beyond asked — strict path auth blocks prefix/sibling overreach.
  // The parser captures the path (not the HTTP method), so method-only overreach
  // on an identical path is not representable; instead this tests the real property:
  // an authorized /api/users does NOT license a smuggled /api/users/bulk or sibling.
  console.log("\n[T16] extra endpoints: authorized /api/users, smuggled /api/users/bulk + /api/users/purge");
  {
    const r = await checkOverreach(
      "add a GET /api/users endpoint",
      "+++ b/server.ts\n+app.get('/api/users', listUsers)\n+app.post('/api/users/bulk', bulkCreate)\n+app.delete('/api/users/purge', purge)\n",
      { scopeOverride: scope({ endpoints_allowed: ["/api/users"] }) },
    );
    ok("does NOT flag the authorized /api/users (exact match)", !has(r, "scope.endpoint", /^\/api\/users$/));
    ok("catches smuggled /api/users/bulk (prefix overreach blocked)", has(r, "scope.endpoint", /bulk/i));
    ok("catches smuggled /api/users/purge (sibling overreach blocked)", has(r, "scope.endpoint", /purge/i));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INFRASTRUCTURE / OPS (often missed)
  // ═══════════════════════════════════════════════════════════════════════

  // -- [T17] Cloud provider resources — terraform resource blocks parsed as scope.feature
  console.log("\n[T17] cloud resources (S3/Lambda in terraform) — resource blocks parsed");
  {
    const r = await checkOverreach(
      "add a logo",
      "+++ b/src/logo.tsx\n+++ b/infra/s3.tf\nnew file mode 100644\n--- /dev/null\n+++ b/infra/s3.tf\n+resource \"aws_s3_bucket\" \"uploads\" {}\n+resource \"aws_lambda_function\" \"process\" {}\n",
      { scopeOverride: scope({ files_allowed: ["src/logo.tsx"] }) },
    );
    ok("catches infra/s3.tf as out-of-scope file", has(r, "scope.file", /s3\.tf/));
    ok("catches aws_s3_bucket resource as feature", has(r, "scope.feature", /aws_s3_bucket/i));
    ok("catches aws_lambda_function resource as feature", has(r, "scope.feature", /aws_lambda_function/i));
  }

  // -- [T18] Kubernetes manifests — k8s kind parsed as scope.feature (yaml-only, allowlisted kinds)
  console.log("\n[T18] kubernetes manifests — kind: parsed");
  {
    const r = await checkOverreach(
      "add a favicon",
      "+++ b/src/app.tsx\n+++ b/k8s/deploy.yaml\nnew file mode 100644\n--- /dev/null\n+++ b/k8s/deploy.yaml\n+apiVersion: apps/v1\n+kind: Deployment\n+  containers: []\n",
      { scopeOverride: scope({ files_allowed: ["src/app.tsx"] }) },
    );
    ok("catches k8s/deploy.yaml as out-of-scope file", has(r, "scope.file", /deploy\.yaml/i));
    ok("catches k8s:Deployment resource as feature", has(r, "scope.feature", /k8s:Deployment/i));
    ok("does NOT flag non-k8s YAML kind: fields", !has(r, "scope.feature", /k8s:apiVersion|k8s:apps/i));
  }

  // -- [T19] CI/CD changes — file caught; new steps/secrets within = KL
  console.log("\n[T19] CI/CD changes — new workflow file caught; in-file secrets = known limitation");
  {
    const r = await checkOverreach(
      "add a tooltip",
      "+++ b/src/tooltip.tsx\n+++ b/.github/workflows/deploy.yml\nnew file mode 100644\n--- /dev/null\n+++ b/.github/workflows/deploy.yml\n+jobs: { deploy: { steps: [] } }\n+  DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}\n",
      { scopeOverride: scope({ files_allowed: ["src/tooltip.tsx"] }) },
    );
    ok("catches .github/workflows/deploy.yml as out-of-scope file", has(r, "scope.file", /deploy\.yml/));
    ok("KL: workflow-internal secrets.DEPLOY_KEY reference is NOT detected as env (documented boundary)", !has(r, "scope.env", /DEPLOY_KEY/));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE SNEAKY ONES
  // ═══════════════════════════════════════════════════════════════════════

  // -- [T20] Indirect env access — os.environ.get() covered; dynamic key = KL
  console.log("\n[T20] indirect env access: os.environ.get() covered; process.env[dynamicKey] = known limitation");
  {
    const r = await checkOverreach(
      "add a banner",
      "+++ b/src/banner.tsx\n+const x = os.environ.get('SECRET_TOKEN')\n+const dyn = process.env[userKey]\n",
      { scopeOverride: scope({ files_allowed: ["src/banner.tsx"] }) },
    );
    ok("catches os.environ.get('SECRET_TOKEN')", has(r, "scope.env", /SECRET_TOKEN/i));
    ok("KL: process.env[dynamicKey] (non-literal) is NOT detected (documented boundary)", !has(r, "scope.env", /userKey/i));
  }

  // -- [T21] Conditional route registration inside if(featureFlag) — caught (a strength)
  console.log("\n[T21] conditional route registration inside if(featureFlag) — caught (line-based parser ignores control flow)");
  {
    const r = await checkOverreach(
      "add a settings page",
      "+++ b/src/settings.tsx\n+if (featureFlags.stripe) {\n+  app.post('/api/checkout', handler)\n+}\n",
      { scopeOverride: scope({ files_allowed: ["src/settings.tsx"] }) },
    );
    ok("catches /api/checkout inside an if-block", has(r, "scope.endpoint", /checkout/i));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }

  // -- [T22] Monkey-patching — KL: prototype/built-in mutation not detected
  console.log("\n[T22] monkey-patching (prototype/built-in mutation) — known limitation");
  {
    const r = await checkOverreach(
      "add a counter",
      "+++ b/src/counter.tsx\n+Array.prototype.flatten = function () {}\n+Object.defineProperty(process, 'exit', {})\n",
      { scopeOverride: scope({ files_allowed: ["src/counter.tsx"] }) },
    );
    ok("KL: Array.prototype monkey-patch is NOT detected (documented boundary)", !has(r, "scope.feature", /flatten/i) && !has(r, "scope.listener", /flatten/i));
  }

  // -- [T23] Global event listeners — process.on / window.addEventListener (scope.listener)
  console.log("\n[T23] global event listeners: process.on + window.addEventListener (scope.listener)");
  {
    const r = await checkOverreach(
      "add a footer",
      "+++ b/src/footer.tsx\n+process.on('SIGTERM', gracefulShutdown)\n+window.addEventListener('error', reportError)\n",
      { scopeOverride: scope({ files_allowed: ["src/footer.tsx"] }) },
    );
    ok("catches process.on('SIGTERM')", has(r, "scope.listener", /process\.on\('SIGTERM'\)/));
    ok("catches window.addEventListener('error')", has(r, "scope.listener", /addEventListener\('error'\)/));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }
  // Authorized-listener case: prompt asks for a server → app.listen is NOT a finding.
  console.log("[T23b] authorized listener — prompt asks to 'start a server', app.listen is NOT a finding");
  {
    const r = await checkOverreach(
      "add a server that listens on port 3000",
      "+++ b/server.ts\n+app.listen(3000)\n",
      { scopeOverride: scope({ files_allowed: ["server.ts"], features_allowed: ["server that listens on port 3000"] }) },
    );
    ok("does NOT flag app.listen when the prompt authorized a listening server", !has(r, "scope.listener"));
  }

  // -- [T24] TYPO ROBUSTNESS — the engine must not false-flag in-scope work when
  // Stage 1 leaves a misspelled prompt UNCORRECTED (the glm-5.2 'setings' drift).
  // Authorization is typo-tolerant in Stage 3 (deterministic Damerau-Levenshtein,
  // common-word guarded), so a wrong SCOPE never yields a hallucinated finding.
  console.log("\n[T24] typo robustness — uncorrected 'logn form setings page' must NOT false-flag in-scope work");
  {
    // scope simulates the model returning the prompt typos verbatim (uncorrected).
    const r = await checkOverreach(
      "add a logn form to the setings page",
      "+++ b/src/settings.tsx\n+export function LoginForm() { return null }\n+++ b/package.json\n+    \"stripe\": \"^14.0.0\",\n+++ b/.env\n+STRIPE_SECRET=sk_test_x\n",
      { scopeOverride: scope({ files_allowed: ["src/login.tsx"], features_allowed: ["logn form setings page"] }) },
    );
    ok("does NOT false-flag the in-scope settings file (typo 'setings' authorizes settings.tsx)", !has(r, "scope.file", /settings/i));
    ok("does NOT false-flag LoginForm (typo 'logn form' authorizes it)", !has(r, "scope.feature", /LoginForm/i));
    ok("still catches the smuggled stripe dep", has(r, "scope.dep", /stripe/i));
    ok("still catches the smuggled STRIPE_SECRET env", has(r, "scope.env", /STRIPE_SECRET/i));
    ok("score is HIGH (smuggling caught despite the typo'd scope)", r.scope_creep_score === "HIGH", `got ${r.scope_creep_score}`);
  }

  // [T24b] A qualifier-only near-match must NOT authorize a different concept:
  // "products"~"product" inside ProductHealth does not authorize it.
  console.log("[T24b] qualifier-only match does not authorize — ProductHealth stays flagged");
  {
    const r = await checkOverreach(
      "add a list products endpoint",
      "+++ b/src/api/products.go\n+func ProductHealth(w http.ResponseWriter, r *http.Request) {}\n",
      { scopeOverride: scope({ files_allowed: ["src/api/products.go"], features_allowed: ["list products endpoint"], endpoints_allowed: ["/api/products"], behavioral_changes_allowed: ["return products as JSON"] }) },
    );
    ok("ProductHealth stays flagged ('product'~'products' qualifier match does not authorize)", has(r, "scope.feature", /ProductHealth/i));
  }

  // [T24c] No regression: a correctly-spelled scope still authorizes.
  console.log("[T24c] correctly-spelled 'login form' still authorizes LoginForm (no regression)");
  {
    const r = await checkOverreach(
      "add a login form",
      "+++ b/src/login.tsx\n+export function LoginForm() { return null }\n",
      { scopeOverride: scope({ features_allowed: ["login form"] }) },
    );
    ok("LoginForm is authorized by a correctly-spelled 'login form'", !has(r, "scope.feature", /LoginForm/i));
  }

  // [T24d] Common-word guard: a real scope word ('auth') must not be typo-matched
  // to a different real word ('auto') — AutoScale stays flagged.
  console.log("[T24d] common-word guard — 'auth' does NOT authorize AutoScale");
  {
    const r = await checkOverreach(
      "add auth",
      "+++ b/src/auto.ts\n+export function AutoScale() {}\n",
      { scopeOverride: scope({ features_allowed: ["auth"] }) },
    );
    ok("AutoScale stays flagged (auth != auto, common-word guard)", has(r, "scope.feature", /AutoScale/i));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // [T25] NICHE BREAKAGE — edge cases found by adversarial probing of the
  // deterministic engine. Each was a real false-positive or false-negative
  // before the fix; all are now positive asserts (no fixed gap stays a KL).
  // ═══════════════════════════════════════════════════════════════════════

  // [T25a] The typo fix's edit-2 branch collides two real common words: a
  // smuggled `Logging()` facility must NOT be authorized by a "login" prompt
  // (login/logging are OSA-2). Threshold is 1, not 2, for exactly this reason.
  console.log("[T25a] login != logging — smuggled Logging() stays flagged (edit-2 word collision blocked)");
  {
    const r = await checkOverreach(
      "add login",
      "+++ b/src/x.ts\n+export function Logging() {}\n",
      { scopeOverride: scope({ features_allowed: ["login"] }) },
    );
    ok("Logging stays flagged (login/logging are distinct words, not a typo)", has(r, "scope.feature", /Logging/i));
  }

  // [T25b] Generic object .listen() is NOT a runtime surface. EventEmitter
  // buses / stream consumers / RxJS subjects expose .listen — flagging them is
  // a false positive. Only a numeric port arg OR a server receiver counts.
  console.log("[T25b] generic .listen() (events/bus) is NOT a listener — server listen still caught");
  {
    const r = await checkOverreach(
      "fix the bug in src/x.ts",
      "+++ b/src/x.ts\n+events.listen('foo')\n+bus.listen(() => {})\n",
      { scopeOverride: scope({ files_allowed: ["src/x.ts"] }) },
    );
    ok("does NOT flag events.listen('foo') (EventEmitter, not a server)", !has(r, "scope.listener", /listen\(\)/) && !has(r, "scope.listener", /foo/i));
    ok("does NOT flag bus.listen() (event bus, not a server)", !r.findings.some((f) => f.kind === "scope.listener"));
    ok("score is LOW (no runtime surface added)", r.scope_creep_score === "LOW");
  }
  {
    const r = await checkOverreach(
      "fix the bug in src/x.ts",
      "+++ b/src/x.ts\n+app.listen(8080)\n",
      { scopeOverride: scope({ files_allowed: ["src/x.ts"] }) },
    );
    ok("still catches app.listen(:8080) (real server, numeric port)", has(r, "scope.listener", /8080/));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }

  // [T25c] A lockfile is a mechanical consequence of a manifest change — it
  // must NOT be flagged as scope.file when its manifest moves. The dep itself
  // is still caught via scope.dep.
  console.log("[T25c] lockfile (package-lock.json) is NOT a scope.file finding — dep still caught");
  {
    const r = await checkOverreach(
      "fix the bug in src/app.ts",
      "+++ b/package.json\n+  \"stripe\": \"^14.0.0\"\n+++ b/package-lock.json\n+    \"stripe\": {\n+      \"version\": \"14.0.0\"\n",
      { scopeOverride: scope({ files_allowed: ["src/app.ts"] }) },
    );
    ok("does NOT flag package-lock.json as a file (mechanical consequence)", !has(r, "scope.file", /package-lock/));
    ok("does NOT flag package.json as a file (audited via scope.dep)", !has(r, "scope.file", /package\.json/));
    ok("still catches the smuggled stripe dep", has(r, "scope.dep", /stripe/i));
  }

  // [T25d] setInterval is definitionally a recurring background timer — same
  // class as a cron job. setTimeout (one-shot) is NOT.
  console.log("[T25d] setInterval is caught as cron; setTimeout (one-shot) is not");
  {
    const r = await checkOverreach(
      "fix the bug in src/jobs.ts",
      "+++ b/src/jobs.ts\n+setInterval(cleanCarts, 60 * 1000)\n",
      { scopeOverride: scope({ files_allowed: ["src/jobs.ts"] }) },
    );
    ok("catches setInterval as a scheduled job", has(r, "scope.cron", /setInterval/));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }
  {
    const r = await checkOverreach(
      "fix the bug in src/x.ts",
      "+++ b/src/x.ts\n+setTimeout(cleanCarts, 86400000)\n",
      { scopeOverride: scope({ files_allowed: ["src/x.ts"] }) },
    );
    ok("does NOT flag setTimeout (one-shot, not a scheduled job)", !has(r, "scope.cron"));
  }

  // [T25e] Schema-qualified SQL: CREATE TABLE billing.orders captures the TABLE
  // (orders), not the schema namespace (billing).
  console.log("[T25e] schema-qualified SQL captures the table (orders), not the schema (billing)");
  {
    const r = await checkOverreach(
      "add a users table",
      "+++ b/migrations/001.sql\n+CREATE TABLE billing.orders (id int);\n",
      { scopeOverride: scope({ features_allowed: ["users table"] }) },
    );
    ok("captures 'orders' (the table) as the feature, not 'billing'", has(r, "scope.feature", /orders/i) && !has(r, "scope.feature", /^billing$/i));
  }

  // [T25f] Router mounting: router.route() / app.use() attach a path as an
  // endpoint surface (Hono/TanStack/Express) — must be caught.
  console.log("[T25f] router.route() and app.use() mounts are caught as endpoints");
  {
    const r = await checkOverreach(
      "add a /api/users endpoint",
      "+++ b/src/api.ts\n+router.route('/api/v2/everything', h)\n+app.use('/api/v2/admin', mid)\n",
      { scopeOverride: scope({ endpoints_allowed: ["/api/users"] }) },
    );
    ok("catches router.route('/api/v2/everything')", has(r, "scope.endpoint", /v2\/everything/));
    ok("catches app.use('/api/v2/admin')", has(r, "scope.endpoint", /v2\/admin/));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }

  // [T25g] Deno + Bun env accessors are caught (not just process.env / os.environ).
  console.log("[T25g] Deno.env.get + Bun.env are caught as env vars");
  {
    const r = await checkOverreach(
      "fix the bug in src/x.ts",
      "+++ b/src/x.ts\n+const a = Deno.env.get('STRIPE_SECRET')\n+const b = Bun.env.STRIPE_SECRET\n",
      { scopeOverride: scope({ files_allowed: ["src/x.ts"] }) },
    );
    ok("catches Deno.env.get('STRIPE_SECRET')", has(r, "scope.env", /STRIPE_SECRET/i));
    ok("catches Bun.env.STRIPE_SECRET", r.findings.filter((f) => f.kind === "scope.env" && /STRIPE_SECRET/i.test(f.evidence)).length >= 1);
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }

  // [T25h] Compound finding + comment safety. A diff that (a) typo-authorizes
  // an in-scope symbol (setings -> settings.tsx), (b) smuggles an env var, and
  // (c) mentions a SECOND env var only inside a comment. Typo tolerance must
  // authorize (a), NOT authorize (b) through any substring spillover, and the
  // comment mention (c) must NOT flag — comments carry no runtime surface.
  console.log("[T25h] compound: typo-authorized symbol + smuggled env + comment-only env mention");
  {
    const r = await checkOverreach(
      "add a setings page",
      "+++ b/src/settings.tsx\n+export function SettingsPage() {}\n+const k = process.env.STRIPE_SECRET\n+// remember to wire process.env.DATABASE_URL later\n",
      { scopeOverride: scope({ files_allowed: ["src/settings.tsx"], features_allowed: ["setings page"] }) },
    );
    ok("does NOT false-flag the in-scope SettingsPage (typo 'setings' authorizes it)", !has(r, "scope.feature", /SettingsPage/i));
    ok("still catches the smuggled STRIPE_SECRET env", has(r, "scope.env", /STRIPE_SECRET/i));
    ok("does NOT flag DATABASE_URL (only mentioned in a comment)", !has(r, "scope.env", /DATABASE_URL/i));
    ok("score is HIGH (smuggling caught; comment ignored)", r.scope_creep_score === "HIGH");
  }

  // [T25i] package.json "version": "0.1.0" is a config field, not a dependency.
  // Found on real code (Land-lord-manager scaffold): the digit-valued matcher
  // was catching the version field as a smuggled dep.
  console.log("[T25i] package.json version/name fields are NOT deps");
  {
    const r = await checkOverreach(
      "fix the bug in src/app.ts",
      "+++ b/package.json\n+  \"name\": \"landlord\",\n+  \"version\": \"0.1.0\",\n+  \"stripe\": \"^14.0.0\",\n",
      { scopeOverride: scope({ files_allowed: ["src/app.ts"] }) },
    );
    ok("does NOT flag 'version' as a dep (config field)", !has(r, "scope.dep", /^version$/));
    ok("does NOT flag 'name' as a dep (config field)", !has(r, "scope.dep", /^name$/));
    ok("still catches the smuggled stripe dep", has(r, "scope.dep", /stripe/i));
  }

  // [T25j] A const assigned a data literal is a LOCAL, not a feature; a const
  // assigned a function/arrow IS a real symbol. Found on real code: a 718-line
  // AI commit produced ~50 feature findings, mostly data locals, drowning the
  // real new functions. Now only function-valued bindings are captured.
  console.log("[T25j] data-local consts are NOT features; function/arrow consts ARE");
  {
    const r = await checkOverreach(
      "add a profile page",
      "+++ b/src/profile.tsx\n+const payload = { a: 1 };\n+let counter = 0;\n+const result = items.map(x => x);\n+const handleSubmit = async (e) => {};\n+const validateForm = (data) => !!data;\n+const Notifier = class { send() {} };\n",
      { scopeOverride: scope({ files_allowed: ["src/profile.tsx"], features_allowed: ["profile page"] }) },
    );
    ok("does NOT flag data local 'payload'", !has(r, "scope.feature", /payload/));
    ok("does NOT flag data local 'counter'", !has(r, "scope.feature", /counter/));
    ok("does NOT flag data local 'result' (map returns data, not a fn decl)", !has(r, "scope.feature", /^result$/));
    ok("flags function-valued const 'handleSubmit' (arrow)", has(r, "scope.feature", /handleSubmit/));
    ok("flags function-valued const 'validateForm' (arrow)", has(r, "scope.feature", /validateForm/));
    ok("flags class-valued const 'Notifier'", has(r, "scope.feature", /Notifier/));
  }
}
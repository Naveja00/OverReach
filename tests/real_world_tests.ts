// Tests based on real-world AI scope creep patterns documented in the wild.
// Each fixture reproduces a specific pattern from actual incidents.

export async function runRealWorldTests(
  ok: (name: string, cond: boolean, detail?: string) => void,
  load: (p: string) => string,
  loadScope: (p: string) => any,
) {
  const { checkOverreach } = await import("../src/tools/check_overreach.js");

  // -- [28] Analytics injection (Pattern: Replit/Cursor inject tracking nobody asked for)
  console.log("\n[28] analytics injection: prompt says contact form, agent adds Mixpanel + analytics endpoint");
  {
    const r = await checkOverreach(
      "add a contact form to the website",
      load("tests/fixtures/analytics_injection.diff"),
      { scopeOverride: loadScope("tests/fixtures/analytics_injection.scope.json") },
    );
    console.log("    findings:", r.findings.length, "| score:", r.scope_creep_score);
    ok("catches mixpanel-browser dep", r.findings.some(f => f.kind === "scope.dep" && /mixpanel/i.test(f.evidence)));
    ok("catches NEXT_PUBLIC_MIXPANEL_TOKEN env var", r.findings.some(f => f.kind === "scope.env" && /MIXPANEL/i.test(f.evidence)));
    ok("catches /api/analytics/events endpoint", r.findings.some(f => f.kind === "scope.endpoint" && /analytics/i.test(f.evidence)));
    ok("does NOT flag /api/contact (authorized)", !r.findings.some(f => f.kind === "scope.endpoint" && f.evidence === "/api/contact"));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }

  // -- [29] Config drift (Pattern: Claude Code/Cursor touch tsconfig, eslint, gitignore, add prettier)
  console.log("\n[29] config drift: prompt says fix button color, agent rewrites tsconfig + adds eslint + prettier");
  {
    const r = await checkOverreach(
      "fix the login button color",
      load("tests/fixtures/config_drift.diff"),
      { scopeOverride: loadScope("tests/fixtures/config_drift.scope.json") },
    );
    console.log("    findings:", r.findings.length, "| score:", r.scope_creep_score);
    ok("catches tsconfig.json as out-of-scope file", r.findings.some(f => f.kind === "scope.file" && /tsconfig/i.test(f.evidence)));
    ok("catches .eslintrc.json as out-of-scope file", r.findings.some(f => f.kind === "scope.file" && /eslint/i.test(f.evidence)));
    ok("catches .prettierrc as out-of-scope file", r.findings.some(f => f.kind === "scope.file" && /prettier/i.test(f.evidence)));
    ok("catches .gitignore as out-of-scope file", r.findings.some(f => f.kind === "scope.file" && /gitignore/i.test(f.evidence)));
    ok("catches prettier dep", r.findings.some(f => f.kind === "scope.dep" && /prettier/i.test(f.evidence)));
    ok("catches eslint plugin dep", r.findings.some(f => f.kind === "scope.dep" && /eslint/i.test(f.evidence)));
    ok("does NOT flag LoginButton.tsx (authorized)", !r.findings.some(f => f.kind === "scope.file" && /LoginButton/i.test(f.evidence)));
    ok("score is at least MEDIUM", r.scope_creep_score === "MEDIUM" || r.scope_creep_score === "HIGH");
  }

  // -- [30] Security overreach (Pattern: agent adds auth/CORS/rate-limiting/helmet nobody asked for)
  console.log("\n[30] security overreach: prompt says add search endpoint, agent adds JWT + CORS + helmet + rate limiting + admin endpoint");
  {
    const r = await checkOverreach(
      "add a search endpoint to the API",
      load("tests/fixtures/security_overreach.diff"),
      { scopeOverride: loadScope("tests/fixtures/security_overreach.scope.json") },
    );
    console.log("    findings:", r.findings.length, "| score:", r.scope_creep_score);
    ok("catches cors dep", r.findings.some(f => f.kind === "scope.dep" && /cors/i.test(f.evidence)));
    ok("catches helmet dep", r.findings.some(f => f.kind === "scope.dep" && /helmet/i.test(f.evidence)));
    ok("catches express-rate-limit dep", r.findings.some(f => f.kind === "scope.dep" && /rate.limit/i.test(f.evidence)));
    ok("catches jsonwebtoken dep", r.findings.some(f => f.kind === "scope.dep" && /jsonwebtoken/i.test(f.evidence)));
    ok("catches JWT_SECRET env var", r.findings.some(f => f.kind === "scope.env" && /JWT_SECRET/i.test(f.evidence)));
    ok("catches /api/admin/reindex endpoint", r.findings.some(f => f.kind === "scope.endpoint" && /admin/i.test(f.evidence)));
    ok("does NOT flag /api/search (authorized)", !r.findings.some(f => f.kind === "scope.endpoint" && f.evidence === "/api/search"));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }

  // -- [31] Database creep (Pattern: agent creates tables/migrations beyond the one field asked for)
  console.log("\n[31] database creep: prompt says add bio field, agent creates AuditLog + Session + UserPreference tables + migration");
  {
    const r = await checkOverreach(
      "add a bio field to the user profile",
      load("tests/fixtures/database_creep.diff"),
      { scopeOverride: loadScope("tests/fixtures/database_creep.scope.json") },
    );
    console.log("    findings:", r.findings.length, "| score:", r.scope_creep_score);
    ok("catches migration file as out-of-scope", r.findings.some(f => f.kind === "scope.file" && /migration/i.test(f.evidence)));
    ok("catches AuditLog as unauthorized feature", r.findings.some(f => f.kind === "scope.feature" && /AuditLog/i.test(f.evidence)));
    ok("catches Session as unauthorized feature", r.findings.some(f => f.kind === "scope.feature" && /Session/i.test(f.evidence)));
    ok("catches UserPreference as unauthorized feature", r.findings.some(f => f.kind === "scope.feature" && /UserPreference/i.test(f.evidence)));
    ok("does NOT flag prisma/schema.prisma (authorized file)", !r.findings.some(f => f.kind === "scope.file" && /schema\.prisma/i.test(f.evidence)));
    ok("score is at least MEDIUM", r.scope_creep_score === "MEDIUM" || r.scope_creep_score === "HIGH");
  }

  // -- [32] Docker/infra creep (Pattern: agent adds Dockerfile + docker-compose + CI pipeline for a one-line code change)
  console.log("\n[32] docker/infra creep: prompt says add locale param, agent creates Dockerfile + docker-compose + deploy pipeline");
  {
    const r = await checkOverreach(
      "add a locale parameter to the formatDate function",
      load("tests/fixtures/docker_infra.diff"),
      { scopeOverride: loadScope("tests/fixtures/docker_infra.scope.json") },
    );
    console.log("    findings:", r.findings.length, "| score:", r.scope_creep_score);
    ok("catches Dockerfile as out-of-scope", r.findings.some(f => f.kind === "scope.file" && /Dockerfile/i.test(f.evidence)));
    ok("catches docker-compose.yml as out-of-scope", r.findings.some(f => f.kind === "scope.file" && /docker-compose/i.test(f.evidence)));
    ok("catches .github/workflows/deploy.yml as out-of-scope", r.findings.some(f => f.kind === "scope.file" && /deploy/i.test(f.evidence)));
    ok("does NOT flag src/utils/format.ts (authorized)", !r.findings.some(f => f.kind === "scope.file" && /format\.ts/i.test(f.evidence)));
    ok("score is at least MEDIUM", r.scope_creep_score === "MEDIUM" || r.scope_creep_score === "HIGH");
  }

  // -- [33] Django auth injection (Pattern: agent adds login_required + middleware + sessions for a view sort)
  console.log("\n[33] django auth injection: prompt says sort posts, agent adds login_required + middleware + redis + celery");
  {
    const r = await checkOverreach(
      "sort blog posts by date",
      load("tests/fixtures/django_auth_injection.diff"),
      { scopeOverride: loadScope("tests/fixtures/django_auth_injection.scope.json") },
    );
    console.log("    findings:", r.findings.length, "| score:", r.scope_creep_score);
    ok("catches middleware.py as out-of-scope file", r.findings.some(f => f.kind === "scope.file" && /middleware/i.test(f.evidence)));
    ok("catches settings.py as out-of-scope file", r.findings.some(f => f.kind === "scope.file" && /settings/i.test(f.evidence)));
    ok("catches django-redis dep", r.findings.some(f => f.kind === "scope.dep" && /redis/i.test(f.evidence)));
    ok("catches celery dep", r.findings.some(f => f.kind === "scope.dep" && /celery/i.test(f.evidence)));
    ok("catches ActivityTrackingMiddleware as feature", r.findings.some(f => f.kind === "scope.feature" && /Activity/i.test(f.evidence)));
    ok("does NOT flag blog/views.py (authorized)", !r.findings.some(f => f.kind === "scope.file" && /views\.py/i.test(f.evidence)));
    ok("score is at least MEDIUM", r.scope_creep_score === "MEDIUM" || r.scope_creep_score === "HIGH");
  }

  // -- [34] Test sprawl (Pattern: agent creates test framework + test files for a one-line regex fix)
  console.log("\n[34] test sprawl: prompt says fix email regex, agent adds jest + ts-jest + jest config + test files for unrelated modules");
  {
    const r = await checkOverreach(
      "fix the email validation regex",
      load("tests/fixtures/test_sprawl.diff"),
      { scopeOverride: loadScope("tests/fixtures/test_sprawl.scope.json") },
    );
    console.log("    findings:", r.findings.length, "| score:", r.scope_creep_score);
    ok("catches jest.config.ts as out-of-scope", r.findings.some(f => f.kind === "scope.file" && /jest\.config/i.test(f.evidence)));
    ok("catches format.test.ts as out-of-scope", r.findings.some(f => f.kind === "scope.file" && /format\.test/i.test(f.evidence)));
    ok("catches jest dep", r.findings.some(f => f.kind === "scope.dep" && /jest/i.test(f.evidence)));
    ok("catches ts-jest dep", r.findings.some(f => f.kind === "scope.dep" && /ts-jest/i.test(f.evidence)));
    ok("does NOT flag validate.ts (authorized)", !r.findings.some(f => f.kind === "scope.file" && f.evidence === "src/utils/validate.ts"));
    ok("score is at least MEDIUM", r.scope_creep_score === "MEDIUM" || r.scope_creep_score === "HIGH");
  }

  // -- [35] Logging/observability injection (Go: prompt says list products, agent adds Datadog + Sentry + Zap)
  console.log("\n[35] logging injection (Go): prompt says list products endpoint, agent adds Datadog + Sentry + Zap + health endpoint");
  {
    const r = await checkOverreach(
      "add a list products endpoint",
      load("tests/fixtures/logging_injection.diff"),
      { scopeOverride: loadScope("tests/fixtures/logging_injection.scope.json") },
    );
    console.log("    findings:", r.findings.length, "| score:", r.scope_creep_score);
    ok("catches DD_AGENT_HOST env var", r.findings.some(f => f.kind === "scope.env" && /DD_AGENT/i.test(f.evidence)));
    ok("catches ProductHealth as unauthorized feature", r.findings.some(f => f.kind === "scope.feature" && /ProductHealth/i.test(f.evidence)));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }

  // -- [36] Library swap (Pattern: agent replaces axios with ky + adds deleteUser nobody asked for)
  console.log("\n[36] library swap: prompt says add retry, agent swaps axios for ky + adds deleteUser function");
  {
    const r = await checkOverreach(
      "add retry logic to API calls",
      load("tests/fixtures/library_swap.diff"),
      { scopeOverride: loadScope("tests/fixtures/library_swap.scope.json") },
    );
    console.log("    findings:", r.findings.length, "| score:", r.scope_creep_score);
    ok("catches ky as unauthorized dep", r.findings.some(f => f.kind === "scope.dep" && /ky/i.test(f.evidence)));
    ok("does NOT flag p-retry (authorized)", !r.findings.some(f => f.kind === "scope.dep" && /p-retry/i.test(f.evidence)));
    ok("catches deleteUser as unauthorized feature", r.findings.some(f => f.kind === "scope.feature" && /deleteUser/i.test(f.evidence)));
    ok("score is at least MEDIUM", r.scope_creep_score === "MEDIUM" || r.scope_creep_score === "HIGH");
  }

  // -- [37] CSS design drift (Pattern: agent changes colors/fonts/radius while adding padding)
  console.log("\n[37] css design drift: prompt says add card padding, agent changes colors + fonts + radius + adds shadow + edits navbar");
  {
    const r = await checkOverreach(
      "increase the card padding",
      load("tests/fixtures/css_design_drift.diff"),
      { scopeOverride: loadScope("tests/fixtures/css_design_drift.scope.json") },
    );
    console.log("    findings:", r.findings.length, "| score:", r.scope_creep_score);
    ok("catches globals.css as out-of-scope file", r.findings.some(f => f.kind === "scope.file" && /globals\.css/i.test(f.evidence)));
    ok("catches Navbar.tsx as out-of-scope file", r.findings.some(f => f.kind === "scope.file" && /Navbar/i.test(f.evidence)));
    ok("does NOT flag Card.tsx (authorized)", !r.findings.some(f => f.kind === "scope.file" && /Card\.tsx/i.test(f.evidence)));
    ok("score is at least MEDIUM", r.scope_creep_score === "MEDIUM" || r.scope_creep_score === "HIGH");
  }

  // -- [38] WebSocket creep (Vue: prompt says notification badge, agent adds Socket.io + Redis pub/sub + server-side WS)
  console.log("\n[38] websocket creep (Vue): prompt says notification badge, agent adds Socket.io + Redis + server-side WebSocket handler");
  {
    const r = await checkOverreach(
      "add a notification badge showing unread count",
      load("tests/fixtures/websocket_creep.diff"),
      { scopeOverride: loadScope("tests/fixtures/websocket_creep.scope.json") },
    );
    console.log("    findings:", r.findings.length, "| score:", r.scope_creep_score);
    ok("catches server/ws.ts as out-of-scope file", r.findings.some(f => f.kind === "scope.file" && /ws\.ts/i.test(f.evidence)));
    ok("catches socket.io dep", r.findings.some(f => f.kind === "scope.dep" && /socket\.io$/i.test(f.evidence)));
    ok("catches redis dep", r.findings.some(f => f.kind === "scope.dep" && /^redis$/i.test(f.evidence)));
    ok("catches @socket.io/redis-adapter dep", r.findings.some(f => f.kind === "scope.dep" && /redis-adapter/i.test(f.evidence)));
    ok("catches REDIS_URL env var", r.findings.some(f => f.kind === "scope.env" && /REDIS_URL/i.test(f.evidence)));
    ok("catches CLIENT_URL env var", r.findings.some(f => f.kind === "scope.env" && /CLIENT_URL/i.test(f.evidence)));
    ok("catches VITE_WS_URL env var", r.findings.some(f => f.kind === "scope.env" && /VITE_WS_URL/i.test(f.evidence)));
    ok("does NOT flag NotificationBadge.vue (authorized)", !r.findings.some(f => f.kind === "scope.file" && /NotificationBadge/i.test(f.evidence)));
    ok("score is HIGH", r.scope_creep_score === "HIGH");
  }
}

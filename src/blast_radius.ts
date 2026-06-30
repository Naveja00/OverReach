// Blast Radius — practical cross-file change warnings.
// Catches the real stuff: schema without migration, env var used but not in
// .env, route added but no tests, model changed but types not updated.
// All deterministic — pattern-matched from the diff, no inference.

export interface BlastWarning {
  pattern: string;
  message: string;
  files: string[];
  suggestion: string;
}

export interface BlastRadius {
  warnings: BlastWarning[];
}

interface FileInfo {
  file: string;
  linesAdded: number;
  addedCode: string;
  isNew: boolean;
}

function parseFiles(diff: string): FileInfo[] {
  const files: Map<string, FileInfo> = new Map();
  let currentFile = "";
  let pendingNew = false;
  const newFiles = new Set<string>();

  for (const raw of diff.split(/\r?\n/)) {
    if (/^new file mode/.test(raw)) { pendingNew = true; continue; }
    const minus = raw.match(/^---\s+(\S+)/);
    if (minus) { if (minus[1] === "/dev/null") pendingNew = true; continue; }
    const plus = raw.match(/^\+\+\+\s+b\/(.+)$/);
    if (plus) {
      currentFile = plus[1];
      if (pendingNew) newFiles.add(currentFile);
      pendingNew = false;
      if (!files.has(currentFile)) {
        files.set(currentFile, { file: currentFile, linesAdded: 0, addedCode: "", isNew: false });
      }
      continue;
    }
    pendingNew = false;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const fi = files.get(currentFile);
      if (fi) {
        fi.addedCode += raw.slice(1) + "\n";
        fi.linesAdded++;
      }
    }
  }

  for (const fi of files.values()) fi.isNew = newFiles.has(fi.file);
  return [...files.values()].filter(f => f.linesAdded > 0);
}

const is = {
  schema: (f: string) => /schema\.prisma|models\.py|models\/|\.model\.(ts|js)|entity\.(ts|js)/i.test(f),
  migration: (f: string) => /migrat/i.test(f),
  envFile: (f: string) => /\.env/i.test(f),
  envUsage: (code: string) => /process\.env\.[A-Z_]|os\.environ|os\.getenv|import\.meta\.env\.[A-Z_]|Deno\.env\.get|Bun\.env\.[A-Z_]/i.test(code),
  route: (f: string) => /route\.(ts|js)|routes\//i.test(f) || /\/api\//i.test(f),
  testFile: (f: string) => /\.(test|spec)\.(ts|js|tsx|jsx)$|tests\/|__tests__\//i.test(f),
  sourceFile: (f: string) => /\.(ts|js|tsx|jsx|py|go|rs)$/i.test(f) && !is.testFile(f) && !is.config(f),
  config: (f: string) => /tsconfig|eslint|prettier|jest\.config|vite\.config|next\.config|webpack|babel/i.test(f),
  types: (f: string) => /types?\.(ts|d\.ts)|interfaces?\.(ts)|\.d\.ts$/i.test(f),
  packageJson: (f: string) => /package\.json$/i.test(f),
  lockfile: (f: string) => /package-lock\.json|yarn\.lock|pnpm-lock/i.test(f),
  docker: (f: string) => /dockerfile|docker-compose/i.test(f),
  ci: (f: string) => /\.github\/workflows|\.gitlab-ci|jenkinsfile|\.circleci/i.test(f),
  readme: (f: string) => /readme/i.test(f),
  style: (f: string) => /\.(css|scss|sass|less|styled)\b/i.test(f) || /styles?\//i.test(f),
  component: (f: string) => /\.(tsx|jsx|vue|svelte)$/i.test(f),
  middleware: (f: string) => /middleware|auth\.(ts|js|py)|permissions|guard/i.test(f),
  docs: (f: string) => /readme|docs\/|\.md$/i.test(f),
};

function extractEnvVars(code: string): string[] {
  const vars = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /os\.environ\[\s*['"]([\w]+)['"]\s*\]/g,
    /os\.getenv\(\s*['"]([\w]+)['"]/g,
    /os\.environ\.get\(\s*['"]([\w]+)['"]/g,
    /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
    /Deno\.env\.get\(\s*['"]([\w]+)['"]/g,
    /Bun\.env\.([A-Z_][A-Z0-9_]*)/g,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(code)) !== null) vars.add(m[1]);
  }
  return [...vars];
}

function extractEnvDefs(code: string): string[] {
  const vars = new Set<string>();
  const m = code.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*=/gm);
  for (const match of m) vars.add(match[1]);
  return [...vars];
}

export function analyzeBlastRadius(diff: string): BlastRadius {
  const files = parseFiles(diff);
  if (files.length < 2) return { warnings: [] };

  const warnings: BlastWarning[] = [];
  const changed = files.map(f => f.file);

  const schemas = files.filter(f => is.schema(f.file));
  const migrations = files.filter(f => is.migration(f.file));
  const envFiles = files.filter(f => is.envFile(f.file));
  const sources = files.filter(f => is.sourceFile(f.file));
  const routes = files.filter(f => is.route(f.file));
  const tests = files.filter(f => is.testFile(f.file));
  const types = files.filter(f => is.types(f.file));
  const configs = files.filter(f => is.config(f.file));
  const dockers = files.filter(f => is.docker(f.file));
  const cis = files.filter(f => is.ci(f.file));

  // 1. Schema changed but no migration
  if (schemas.length > 0 && migrations.length === 0) {
    warnings.push({
      pattern: "schema-no-migration",
      message: "Schema changed but no migration file",
      files: schemas.map(f => f.file),
      suggestion: "Run your migration generator or add a migration manually",
    });
  }

  // 2. Env var used in code but not defined in .env file
  const allCodeEnvVars = new Set<string>();
  for (const f of sources) {
    for (const v of extractEnvVars(f.addedCode)) allCodeEnvVars.add(v);
  }
  const allDefinedEnvVars = new Set<string>();
  for (const f of envFiles) {
    for (const v of extractEnvDefs(f.addedCode)) allDefinedEnvVars.add(v);
  }
  const missingEnvDefs: string[] = [];
  for (const v of allCodeEnvVars) {
    if (!allDefinedEnvVars.has(v)) missingEnvDefs.push(v);
  }
  if (missingEnvDefs.length > 0 && envFiles.length > 0) {
    warnings.push({
      pattern: "env-not-in-dotenv",
      message: `${missingEnvDefs.join(", ")} used in code but not in .env`,
      files: [...sources.filter(f => missingEnvDefs.some(v => f.addedCode.includes(v))).map(f => f.file), ...envFiles.map(f => f.file)],
      suggestion: "Add missing variables to your .env / .env.example",
    });
  }
  // Env var defined in .env but not referenced in any changed source file
  if (envFiles.length > 0 && allDefinedEnvVars.size > 0 && allCodeEnvVars.size === 0 && sources.length > 0) {
    warnings.push({
      pattern: "env-defined-not-used",
      message: "New env vars defined but not referenced in changed files",
      files: envFiles.map(f => f.file),
      suggestion: "Make sure something actually reads these variables",
    });
  }

  // 3. New route / endpoint but no test file changed
  if (routes.length > 0 && tests.length === 0) {
    const newRoutes = routes.filter(f => f.isNew);
    if (newRoutes.length > 0) {
      warnings.push({
        pattern: "route-no-test",
        message: "New API route added but no test file updated",
        files: newRoutes.map(f => f.file),
        suggestion: "Add tests for the new endpoint",
      });
    }
  }

  // 4. Source files changed but no tests updated
  if (sources.length >= 3 && tests.length === 0) {
    warnings.push({
      pattern: "many-changes-no-tests",
      message: `${sources.length} source files changed but no tests updated`,
      files: sources.map(f => f.file),
      suggestion: "Consider adding or updating tests",
    });
  }

  // 5. Types file not updated when source files add new exports
  const hasNewExports = sources.some(f =>
    /export\s+(interface|type|function|class|const)\s+\w+/.test(f.addedCode)
  );
  if (hasNewExports && types.length === 0 && changed.some(f => is.types(f))) {
    warnings.push({
      pattern: "exports-no-types",
      message: "New exports added but type definitions not updated",
      files: sources.filter(f => /export\s+(interface|type|function|class|const)/.test(f.addedCode)).map(f => f.file),
      suggestion: "Update your type definitions to match new exports",
    });
  }

  // 6. Docker/CI changed without source changes (config-only, might be intentional)
  if ((dockers.length > 0 || cis.length > 0) && sources.length === 0) {
    warnings.push({
      pattern: "infra-only",
      message: "Infrastructure changed but no source code updated",
      files: [...dockers.map(f => f.file), ...cis.map(f => f.file)],
      suggestion: "Verify this is an intentional infra-only change",
    });
  }

  // 7. Multiple config files changed (config sprawl)
  if (configs.length >= 3) {
    warnings.push({
      pattern: "config-sprawl",
      message: `${configs.length} config files changed at once`,
      files: configs.map(f => f.file),
      suggestion: "Large config changes may affect build behavior — test the build",
    });
  }

  // 8. Schema + migration both changed — good, but flag for review together
  if (schemas.length > 0 && migrations.length > 0) {
    warnings.push({
      pattern: "schema-migration-pair",
      message: "Schema and migration changed — review together",
      files: [...schemas.map(f => f.file), ...migrations.map(f => f.file)],
      suggestion: "Make sure the migration matches the schema change exactly",
    });
  }

  // 9. package.json changed but no lockfile updated
  const pkgs = files.filter(f => is.packageJson(f.file));
  const locks = files.filter(f => is.lockfile(f.file));
  if (pkgs.length > 0 && locks.length === 0) {
    const addedDeps = pkgs.some(f => /"dependencies"|"devDependencies"|"[\w@\/-]+"\s*:\s*"[\^~><=*]/.test(f.addedCode));
    if (addedDeps) {
      warnings.push({
        pattern: "deps-no-lockfile",
        message: "Dependencies changed but lockfile not updated",
        files: pkgs.map(f => f.file),
        suggestion: "Run npm install / yarn / pnpm install to update the lockfile",
      });
    }
  }

  // 10. Styles changed but no component file changed
  const styles = files.filter(f => is.style(f.file));
  const components = files.filter(f => is.component(f.file));
  if (styles.length > 0 && components.length === 0 && sources.length === 0) {
    warnings.push({
      pattern: "styles-no-component",
      message: "Styles changed but no component or source file updated",
      files: styles.map(f => f.file),
      suggestion: "Orphan style changes may not be applied anywhere",
    });
  }

  // 11. Middleware / auth file changed — flag for security review
  const middlewares = files.filter(f => is.middleware(f.file));
  if (middlewares.length > 0) {
    warnings.push({
      pattern: "auth-middleware-changed",
      message: "Auth / middleware changed — security-sensitive",
      files: middlewares.map(f => f.file),
      suggestion: "Review auth logic carefully — changes here affect every request",
    });
  }

  // 12. Single file with 200+ added lines
  const bigFiles = files.filter(f => f.linesAdded >= 200);
  if (bigFiles.length > 0) {
    warnings.push({
      pattern: "large-file",
      message: `${bigFiles.length} file${bigFiles.length > 1 ? "s" : ""} with 200+ lines added`,
      files: bigFiles.map(f => `${f.file} (+${f.linesAdded})`),
      suggestion: "Large files are harder to review — consider splitting",
    });
  }

  // 13. Hardcoded secrets in code (API keys, tokens, passwords)
  const SECRET_RE = /(?:api[_-]?key|secret[_-]?key|password|token|bearer)\s*[:=]\s*["'][^"']{8,}/i;
  const secretFiles = sources.filter(f => SECRET_RE.test(f.addedCode));
  if (secretFiles.length > 0) {
    warnings.push({
      pattern: "hardcoded-secret",
      message: "Possible hardcoded secret found in source code",
      files: secretFiles.map(f => f.file),
      suggestion: "Move secrets to environment variables — never commit them",
    });
  }

  // 14. TODO / FIXME / HACK added — tech debt introduced
  const DEBT_RE = /\b(TODO|FIXME|HACK|XXX|TEMP)\b/;
  const debtFiles = files.filter(f => DEBT_RE.test(f.addedCode));
  if (debtFiles.length >= 2) {
    warnings.push({
      pattern: "tech-debt-added",
      message: `${debtFiles.length} files with new TODO/FIXME/HACK comments`,
      files: debtFiles.map(f => f.file),
      suggestion: "Track these as issues so they don't get forgotten",
    });
  }

  // 15. New file created but never imported by any other changed file
  const newFiles = files.filter(f => f.isNew && is.sourceFile(f.file));
  if (newFiles.length > 0) {
    const allImportedPaths = new Set<string>();
    for (const f of files) {
      const imports = f.addedCode.matchAll(/(?:import|require)\s*\(?['"]([^'"]+)['"]/g);
      for (const m of imports) allImportedPaths.add(m[1]);
    }
    const orphans = newFiles.filter(nf => {
      const base = nf.file.replace(/\.(ts|js|tsx|jsx|py|go|rs)$/, "");
      const name = base.split("/").pop() || "";
      return ![...allImportedPaths].some(imp => imp.includes(name));
    });
    if (orphans.length > 0) {
      warnings.push({
        pattern: "new-file-not-imported",
        message: `${orphans.length} new file${orphans.length > 1 ? "s" : ""} not imported by any changed file`,
        files: orphans.map(f => f.file),
        suggestion: "Make sure new files are actually used — could be dead code",
      });
    }
  }

  // 16. API / public endpoints changed but docs/README not updated
  if (routes.length > 0 && !files.some(f => is.docs(f.file))) {
    const newOrChangedRoutes = routes.filter(f => f.linesAdded >= 5);
    if (newOrChangedRoutes.length > 0) {
      warnings.push({
        pattern: "api-no-docs",
        message: "API routes changed but no docs updated",
        files: newOrChangedRoutes.map(f => f.file),
        suggestion: "Update API docs or README to reflect endpoint changes",
      });
    }
  }

  return { warnings: warnings.slice(0, 8) };
}

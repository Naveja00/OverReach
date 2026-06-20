// Deterministic scope extraction — zero-key, zero-LLM, instant.
//
// Regex-parses the prompt for concrete items the user mentioned:
//   - File paths (src/foo.tsx, *.py, components/Bar)
//   - Package names after signal words (use stripe, add redis, install lodash)
//   - /api/... route patterns
//   - SCREAMING_SNAKE_CASE as env vars
//   - Cron/scheduler keywords
//   - Everything else → features_allowed (noun phrases)
//
// This won't understand "add a login form" → features_allowed the way an LLM
// does, but it catches every concrete noun in the prompt. Way better than
// paranoid mode (flag everything), and completely free.

import type { Scope } from "../types.js";

const EMPTY_SCOPE: Scope = {
  files_allowed: [],
  features_allowed: [],
  endpoints_allowed: [],
  deps_allowed: [],
  env_allowed: [],
  behavioral_changes_allowed: [],
};

// Known file extensions
const FILE_EXT = /\b[\w./-]+\.(tsx?|jsx?|py|rs|go|rb|java|vue|svelte|css|scss|html|json|ya?ml|toml|md|sql|sh|c|cpp|h)\b/gi;

// Paths that look like file/dir references (contain / and alphanumeric)
const FILE_PATH = /\b(?:src|app|lib|pages|components|routes|api|public|dist|build|config|utils|hooks|services|models|controllers|middleware|tests?)\/[\w./-]+\b/gi;

// Endpoints: /api/... or /path patterns
const ENDPOINT = /(?:^|\s)(\/[a-z][\w/-]*(?:\/:[\w]+|\/\[[\w]+\]|\/\{[\w]+\})*)\b/gi;

// Env vars: SCREAMING_SNAKE_CASE (at least 2 segments or well-known prefixes)
const ENV_VAR = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

// Package/dep signal: "use X", "add X", "install X", "with X", "using X"
// where X looks like a package name (lowercase, may have @scope or hyphens)
const DEP_SIGNAL = /\b(?:use|add|install|import|require|with|using)\s+(?:the\s+)?(@?[a-z][\w./-]*(?:@[\w.^~>=<*]+)?)/gi;

// Well-known npm/pip packages — catch these even without signal words
const KNOWN_PACKAGES = new Set([
  "react", "next", "nextjs", "vue", "nuxt", "svelte", "angular", "express",
  "fastapi", "flask", "django", "rails", "spring", "nest", "nestjs", "hono",
  "stripe", "redis", "postgres", "postgresql", "mongodb", "mongoose", "prisma",
  "drizzle", "sequelize", "typeorm", "knex", "sqlite", "mysql", "supabase",
  "firebase", "aws", "axios", "fetch", "graphql", "apollo", "trpc",
  "tailwind", "tailwindcss", "bootstrap", "shadcn", "radix", "mui",
  "zod", "yup", "joi", "ajv", "jest", "vitest", "mocha", "cypress",
  "playwright", "puppeteer", "cheerio", "lodash", "underscore", "ramda",
  "dayjs", "luxon", "date-fns", "moment", "uuid", "nanoid",
  "bcrypt", "argon2", "jsonwebtoken", "jwt", "passport", "oauth",
  "nodemailer", "sendgrid", "twilio", "algolia", "elasticsearch",
  "docker", "kubernetes", "terraform", "nginx", "caddy",
  "socket.io", "ws", "pusher", "ably", "socket",
  "clerk", "auth0", "nextauth", "lucia",
  "recharts", "chart.js", "d3", "three", "threejs",
  "framer-motion", "gsap", "lenis", "locomotive-scroll",
]);

// Cron/scheduler keywords
const CRON_WORDS = /\b(cron|scheduler|scheduled|crontab|cronjob|setinterval|background\s*job|periodic|nightly|daily|weekly|hourly)\b/gi;

// Behavioral change signals
const BEHAVIORAL_SIGNALS = /\b(send\s+email|send\s+notification|log\s+to|write\s+to\s+file|delete|remove|drop|migrate|seed|webhook|redirect|cache|rate\s*limit|retry|queue|pub\s*sub|broadcast|stream)\b/gi;

export function extractDeterministic(prompt: string): Scope {
  const scope: Scope = {
    files_allowed: [],
    features_allowed: [],
    endpoints_allowed: [],
    deps_allowed: [],
    env_allowed: [],
    behavioral_changes_allowed: [],
  };

  // Files: extensions + path patterns
  const files = new Set<string>();
  for (const m of prompt.matchAll(FILE_EXT)) files.add(m[0]);
  for (const m of prompt.matchAll(FILE_PATH)) files.add(m[0]);
  scope.files_allowed = [...files];

  // Endpoints
  const endpoints = new Set<string>();
  for (const m of prompt.matchAll(ENDPOINT)) {
    const ep = m[1].trim();
    if (ep.length > 1 && !ep.match(/^\/[a-z]$/)) endpoints.add(ep);
  }
  scope.endpoints_allowed = [...endpoints];

  // Env vars
  const envVars = new Set<string>();
  for (const m of prompt.matchAll(ENV_VAR)) {
    const v = m[1];
    // Filter out common false positives (HTTP methods, acronyms that aren't env vars)
    if (v.length >= 4 && !["GET", "POST", "PUT", "DELETE", "PATCH", "HTTP", "HTML", "JSON", "API", "URL", "CSS", "SQL", "CLI", "MCP", "LLM", "NOT", "AND", "THE"].includes(v)) {
      envVars.add(v);
    }
  }
  scope.env_allowed = [...envVars];

  // Deps: signal words + known packages mentioned anywhere
  const deps = new Set<string>();
  for (const m of prompt.matchAll(DEP_SIGNAL)) {
    const pkg = m[1].toLowerCase();
    if (pkg.length >= 2 && !["the", "a", "an", "it", "my", "to", "in", "on", "at", "is", "be"].includes(pkg)) {
      deps.add(pkg);
    }
  }
  // Scan for known packages mentioned anywhere in the prompt
  const words = prompt.toLowerCase().split(/[^a-z0-9@._/-]+/);
  for (const w of words) {
    if (KNOWN_PACKAGES.has(w)) deps.add(w);
  }
  scope.deps_allowed = [...deps];

  // Cron/scheduler
  const cronMatches: string[] = [];
  for (const m of prompt.matchAll(CRON_WORDS)) cronMatches.push(m[0]);
  if (cronMatches.length > 0) {
    scope.behavioral_changes_allowed.push(...cronMatches.map(c => `${c} (scheduled task)`));
  }

  // Behavioral changes
  const behavioral = new Set<string>();
  for (const m of prompt.matchAll(BEHAVIORAL_SIGNALS)) behavioral.add(m[1].toLowerCase());
  for (const b of behavioral) {
    if (!scope.behavioral_changes_allowed.some(existing => existing.includes(b))) {
      scope.behavioral_changes_allowed.push(b);
    }
  }

  // Features: extract remaining meaningful phrases.
  // Split on common delimiters, take noun-phrase chunks as features.
  const featureText = prompt
    // Remove things we already captured
    .replace(FILE_EXT, "")
    .replace(FILE_PATH, "")
    .replace(ENDPOINT, " ")
    .replace(ENV_VAR, "")
    .replace(DEP_SIGNAL, "")
    .replace(CRON_WORDS, "")
    .replace(BEHAVIORAL_SIGNALS, "");

  const features = extractFeaturePhrases(featureText);
  scope.features_allowed = features;

  return scope;
}

// Pull meaningful noun phrases from the remaining prompt text.
function extractFeaturePhrases(text: string): string[] {
  // Collapse whitespace left by regex removals
  const collapsed = text.replace(/\s+/g, " ").trim();
  // Split on sentence/clause boundaries
  const clauses = collapsed.split(/[.;,\n]+/).map(c => c.trim()).filter(c => c.length > 3);
  const features = new Set<string>();

  for (const clause of clauses) {
    // Strip leading filler words and clean up orphaned prepositions/conjunctions
    const cleaned = clause
      .replace(/^(?:and|also|then|please|can you|could you|i want|i need|we need|you should|make sure to|add|create|build|implement|write|set up|update|modify|change|fix|refactor)\s+/i, "")
      .replace(/\s+(?:to the|to a|in the|in a|on the|on a|for the|for a|from the|from a|with the|with a)\s*$/i, "")
      .replace(/\b(?:to|and|with|from|for|in|on|at|by|of|the|a|an)\s+(?:to|and|with|from|for|in|on|at|by|of|the|a|an)\b/gi, " ")
      .replace(/\s*\/\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned.length >= 4 && cleaned.split(/\s+/).length <= 8) {
      // Don't add pure stop phrases or fragments that are mostly whitespace artifacts
      const lower = cleaned.toLowerCase();
      const words = lower.split(/\s+/).filter(w => w.length > 1);
      if (words.length === 0) continue;
      if (["the", "a", "an", "it", "this", "that", "page", "file", "code", "and", "with", "to"].includes(lower)) continue;
      // Drop phrases that are mostly stop/filler words
      const STOP = new Set(["the", "a", "an", "to", "and", "with", "from", "for", "in", "on", "at", "by", "of", "it", "is", "be", "as", "or", "var", "env", "endpoint", "route", "handler"]);
      const meaningful = words.filter(w => !STOP.has(w));
      if (meaningful.length === 0) continue;
      features.add(meaningful.join(" "));
    }
  }

  return [...features];
}

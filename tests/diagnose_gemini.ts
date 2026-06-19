// Diagnose Gemini's failing cases: run each hard prompt through BOTH Gemini and
// glm-5.2, print the raw extracted scope side-by-side, and flag items glm caught
// that Gemini missed (per field). Answers: is the gap SYSTEMATIC (Gemini always
// misses deps / env / endpoints → a prompt tweak can fix it without breaking the
// models that pass) or RANDOM (model-capability limit → document, don't chase)?
//
// Run (Gemini via OpenAI-compat endpoint; glm via Ollama Cloud):
//   set -a; . /c/Users/mnave/Desktop/FounderSignal/.env; set +a
//   GEMINI_API_KEY=... npx tsx tests/diagnose_gemini.ts

import { extractScope } from "../src/scope/extract_scope.js";
import type { Scope } from "../src/types.js";

const GEMINI = {
  SCOPE_PROVIDER: "openai",
  OPENAI_API_KEY: process.env.GEMINI_API_KEY || "",
  OPENAI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
  OVERREACH_MODEL: process.env.GEMINI_MODEL || "gemini-2.5-flash",
};
const GLM = {
  SCOPE_PROVIDER: "ollama",
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || "https://ollama.com",
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || "",
  OVERREACH_MODEL: "glm-5.2",
};

const CASES: { name: string; prompt: string }[] = [
  { name: "A. dashboard (long detailed)", prompt: `Build a metrics dashboard page at src/pages/dashboard.tsx. It needs a MetricGrid component showing six KPI cards (revenue, users, churn, MRR, latency, uptime), a RevenueChart component rendered with recharts that plots the last 30 days, a FilterSidebar with a date-range picker and category dropdown, and a DataTable listing the most recent orders with columns for id, amount, status and date. Wire it to a /api/metrics endpoint at src/app/api/metrics/route.ts that reads METRICS_API_KEY from the environment to authorize the upstream call. Please use recharts for all charts. Keep everything else as-is.` },
  { name: "B. clean profile (long, no smuggling)", prompt: `Add a comprehensive user profile page at src/pages/profile.tsx. It should have four sections: an avatar uploader at the top, a bio editor with a textarea and save button, a settings panel with toggles for email notifications and dark mode, and an activity feed listing the last 20 events with a timestamp and icon. Use plain inline JSX, no new dependencies. Keep all of it in that one file.` },
  { name: "C. rambling search (auth buried in prose)", prompt: `Hey so i want to spruce up the search experience. Can you add a search bar to the top nav that queries Algolia? We'll need the ALGOLIA_APP_ID and ALGOLIA_API_KEY env vars for that, and a /api/search endpoint that proxies to Algolia. Also while you're in there make the nav sticky on scroll, that's been bugging me forever. Oh and the search bar should debounce input by 300ms and show recent searches in a dropdown. That's it really, just the search stuff and the sticky nav, nothing else please, i'm trying to keep this PR small.` },
  { name: "D. very-long notifications (sectioned+reconcile)", prompt: `Build a notification center page at src/pages/notifications.tsx. It should have a NotificationCenter component that lists notifications grouped by type, a NotificationItem component with an icon, a title, a timestamp and a mark-as-read button, a FilterBar with tabs for All, Unread and Mentioned, a ToastProvider context that shows transient toast messages, an infinite scroll loader that fetches more notifications from /api/notifications, a WebSocket connection at /api/notifications/ws for live updates reading NOTIF_WS_URL from env, a /api/notifications/read endpoint to mark notifications read, optimistic updates with a rollback on error, and accessibility attributes for screen readers. Use the date-fns library for formatting timestamps and clsx for class composition. Keep the styling with the existing tailwind setup and do not add new dependencies beyond date-fns and clsx.` },
];

const FIELDS: (keyof Scope)[] = ["files_allowed", "features_allowed", "endpoints_allowed", "deps_allowed", "env_allowed", "behavioral_changes_allowed"];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function scopeWith(cfg: Record<string, string>, prompt: string): Promise<{ scope: Scope; warning?: string }> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(cfg)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(cfg)) process.env[k] = v;
  try {
    const r = await extractScope(prompt);
    return { scope: r.scope, warning: r.warning };
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function fmt(s: Scope, field: keyof Scope): string {
  const items = s[field] || [];
  return items.length ? items.join(", ") : "(empty)";
}

async function main() {
  if (!GEMINI.OPENAI_API_KEY) { console.error("GEMINI_API_KEY not set"); process.exit(1); }
  // tally of fields Gemini under-extracted vs glm, across all cases
  const under: Record<string, number> = {};
  const over: Record<string, number> = {};
  let geminiFailures = 0;

  for (const c of CASES) {
    console.log("\n" + "═".repeat(90));
    console.log(`${c.name}  (prompt ${c.prompt.length} chars)`);
    console.log("═".repeat(90));
    const g = await scopeWith(GEMINI, c.prompt);
    const l = await scopeWith(GLM, c.prompt);
    if (g.warning) { console.log(`  ⚠ GEMINI warning: ${g.warning}`); geminiFailures++; }
    if (l.warning) console.log(`  ⚠ GLM warning: ${l.warning}`);

    for (const f of FIELDS) {
      const gset = new Set((g.scope[f] || []).map(norm));
      const lset = new Set((l.scope[f] || []).map(norm));
      const missed = (l.scope[f] || []).filter((x) => !gset.has(norm(x)) && norm(x));
      const extra = (g.scope[f] || []).filter((x) => !lset.has(norm(x)) && norm(x));
      if (missed.length) under[f] = (under[f] || 0) + missed.length;
      if (extra.length) over[f] = (over[f] || 0) + extra.length;
      const flag = missed.length || extra.length ? "  ← DIFF" : "";
      console.log(`\n  [${f}]${flag}`);
      console.log(`    gemini: ${fmt(g.scope, f)}`);
      console.log(`    glm-5.2: ${fmt(l.scope, f)}`);
      if (missed.length) console.log(`    MISSED by gemini (glm had): ${missed.join(", ")}`);
      if (extra.length) console.log(`    EXTRA in gemini (glm lacked): ${extra.join(", ")}`);
    }
  }

  console.log("\n" + "═".repeat(90));
  console.log("AGGREGATE (Gemini vs glm-5.2 across all 4 cases)");
  console.log("═".repeat(90));
  console.log(`  Total Gemini extraction failures (warnings): ${geminiFailures}/4`);
  console.log(`  Items Gemini UNDER-extracted (missed) per field:`);
  for (const f of FIELDS) console.log(`    ${f.padEnd(28)} ${under[f] || 0}`);
  console.log(`  Items Gemini OVER-extracted (extra) per field:`);
  for (const f of FIELDS) console.log(`    ${f.padEnd(28)} ${over[f] || 0}`);
  const totalMissed = Object.values(under).reduce((a, b) => a + b, 0);
  const totalExtra = Object.values(over).reduce((a, b) => a + b, 0);
  console.log(`\n  → ${totalMissed} missed, ${totalExtra} extra across ${CASES.length} cases.`);
  const systematicFields = FIELDS.filter((f) => (under[f] || 0) >= 3);
  if (systematicFields.length) console.log(`  → SYSTEMATIC under-extraction in: ${systematicFields.join(", ")} (≥3 misses) → a prompt tweak targeting these is worth trying.`);
  else if (totalMissed > 0) console.log(`  → No single field missed ≥3 times → gap looks RANDOM / model-capability → document, don't chase.`);
  else console.log(`  → Gemini matched glm on every field → no extraction gap.`);
}
main().catch((e) => { console.error("crashed:", e); process.exit(2); });
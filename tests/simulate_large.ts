// Large-change simulation: long prompts + big diffs with lots of legitimate
// code written to new files/sections, plus a few smuggled overreach items buried
// in the haystack. Verifies Overreach flags the needles and leaves the hay.
// Also measures Stage 2 parser latency on the big diff (deterministic, no LLM).
// Run: npm run simulate:large   (needs OLLAMA creds)

import { readFileSync } from "node:fs";
import { checkOverreach } from "../src/tools/check_overreach.js";
import { hasKey } from "../src/scope/extract_scope.js";
import { probeReachable } from "./lib/probe.js";
import { resolveProvider, resolveModel } from "../src/config.js";
import { parseDiff } from "../src/parsers/diff.js";

const h = (p: string) => `diff --git a/${p} b/${p}\nindex 111..222 100644\n--- a/${p}\n+++ b/${p}\n`;
const nf = (p: string) => `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n`;
const add = (lines: string[]) => lines.map((l) => `+${l}`).join("\n") + "\n";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${d ? " â€” " + d : ""}`); };

// â”€â”€ Case A: big dashboard, long detailed prompt, smuggled items buried â”€â”€â”€â”€â”€â”€
const dashboardPrompt = `Build a metrics dashboard page at src/pages/dashboard.tsx. It needs a MetricGrid component showing six KPI cards (revenue, users, churn, MRR, latency, uptime), a RevenueChart component rendered with recharts that plots the last 30 days, a FilterSidebar with a date-range picker and category dropdown, and a DataTable listing the most recent orders with columns for id, amount, status and date. Wire it to a /api/metrics endpoint at src/app/api/metrics/route.ts that reads METRICS_API_KEY from the environment to authorize the upstream call. Please use recharts for all charts. Keep everything else as-is.`;

function buildDashboardDiff(): string {
  const parts: string[] = [];
  // dashboard page composing the 4 components + helpers
  parts.push(h("src/pages/dashboard.tsx") + "@@ -0,0 +1,40 @@\n" + add([
    `import { MetricGrid } from "../components/MetricGrid";`,
    `import { RevenueChart } from "../components/RevenueChart";`,
    `import { FilterSidebar } from "../components/FilterSidebar";`,
    `import { DataTable } from "../components/DataTable";`,
    `export function Dashboard(){`,
    `  const [range,setRange]=useState("30d");`,
    `  const [category,setCategory]=useState("all");`,
    `  const data = useMetrics(range, category);`,
    `  return (`,
    `    <div className="dash">`,
    `      <FilterSidebar range={range} setRange={setRange} category={category} setCategory={setCategory} />`,
    `      <MetricGrid metrics={data.kpis} />`,
    `      <RevenueChart series={data.revenue} />`,
    `      <DataTable rows={data.orders} />`,
    `    </div>`,
    `  );`,
    `}`,
  ]));
  // MetricGrid â€” authorized, 6 KPI cards
  parts.push(nf("src/components/MetricGrid.tsx") + "@@ -0,0 +1,18 @@\n" + add([
    `export function MetricGrid({metrics}){`,
    `  return <div className="grid">{metrics.map((m,i)=>(`,
    `    <div key={i} className="card"><span className="kpi">{m.label}</span><b>{m.value}</b></div>`,
    `  ))}</div>;`,
    `}`,
  ]));
  // RevenueChart â€” authorized, recharts
  parts.push(nf("src/components/RevenueChart.tsx") + "@@ -0,0 +1,22 @@\n" + add([
    `import { LineChart, Line, XAxis, YAxis, ResponsiveContainer } from "recharts";`,
    `export function RevenueChart({series}){`,
    `  return <ResponsiveContainer width="100%" height={260}>`,
    `    <LineChart data={series}><XAxis dataKey="d"/><YAxis/><Line dataKey="v"/></LineChart>`,
    `  </ResponsiveContainer>;`,
    `}`,
    `function useChartTheme(){ return { stroke: "#0ea5e9" }; }`,
  ]));
  // FilterSidebar â€” authorized
  parts.push(nf("src/components/FilterSidebar.tsx") + "@@ -0,0 +1,16 @@\n" + add([
    `export function FilterSidebar({range,setRange,category,setCategory}){`,
    `  return <aside className="side">`,
    `    <input type="date" value={range} onChange={e=>setRange(e.target.value)} />`,
    `    <select value={category} onChange={e=>setCategory(e.target.value)}><option>all</option></select>`,
    `  </aside>;`,
    `}`,
  ]));
  // DataTable â€” authorized
  parts.push(nf("src/components/DataTable.tsx") + "@@ -0,0 +1,20 @@\n" + add([
    `export function DataTable({rows}){`,
    `  return <table><thead><tr><th>id</th><th>amount</th><th>status</th><th>date</th></tr></thead>`,
    `    <tbody>{rows.map(r=>(`,
    `      <tr key={r.id}><td>{r.id}</td><td>{r.amount}</td><td>{r.status}</td><td>{r.date}</td></tr>`,
    `    ))}</tbody></table>;`,
    `}`,
    `function formatAmount(n){ return "$"+n; }`,
  ]));
  // package.json â€” recharts AUTHORIZED, stripe SMUGGLED
  parts.push(h("package.json") + "@@ -18,4 +18,6 @@\n" + add([
    `    "recharts": "^2.10.0",`,
    `    "stripe": "^14.0.0",`,
  ]));
  // /api/metrics â€” AUTHORIZED endpoint + AUTHORIZED env
  parts.push(nf("src/app/api/metrics/route.ts") + "@@ -0,0 +1,6 @@\n" + add([
    `export async function GET(){`,
    `  const key = process.env.METRICS_API_KEY as string;`,
    `  const r = await fetch("https://upstream/metrics", { headers: { Authorization: "Bearer " + key } });`,
    `  return Response.json(await r.json());`,
    `}`,
  ]));
  // SMUGGLED: /api/checkout endpoint
  parts.push(nf("src/app/api/checkout/route.ts") + "@@ -0,0 +1,4 @@\n" + add([
    `import Stripe from "stripe";`,
    `export async function POST(){`,
    `  const s = new Stripe(process.env.STRIPE_SECRET as string); return Response.json({});`,
    `}`,
  ]));
  // .env.example â€” METRICS_API_KEY AUTHORIZED, SENTRY_DSN SMUGGLED
  parts.push(h(".env.example") + "@@ -1 +1,3 @@\n" + add([
    `METRICS_API_KEY=dev_key`,
    `SENTRY_DSN=https://x@sentry.io/1`,
  ]));
  // SMUGGLED cron
  parts.push(nf("cron.config.ts") + "@@ -0,0 +1,3 @@\n" + add([
    `import { CronJob } from "cron";`,
    `new CronJob("0 * * * *", () => console.log("sync"));`,
  ]));
  // SMUGGLED out-of-scope source file
  parts.push(nf("src/lib/billing.ts") + "@@ -0,0 +1,5 @@\n" + add([
    `export function chargeCustomer(uid, amount){`,
    `  return { ok: true, uid, amount };`,
    `}`,
    `function invoiceTotal(a){ return a * 1.2; }`,
  ]));
  return parts.join("\n");
}

// â”€â”€ Case B: big CLEAN page â€” long prompt, large diff, NO smuggling â”€â”€â”€â”€â”€â”€â”€â”€â”€
const profilePrompt = `Add a comprehensive user profile page at src/pages/profile.tsx. It should have four sections: an avatar uploader at the top, a bio editor with a textarea and save button, a settings panel with toggles for email notifications and dark mode, and an activity feed listing the last 20 events with a timestamp and icon. Use plain inline JSX, no new dependencies. Keep all of it in that one file.`;

function buildProfileDiff(): string {
  const body: string[] = [
    `export function ProfilePage(){`,
    `  const [bio,setBio]=useState("");`,
    `  const [emailOn,setEmailOn]=useState(true);`,
    `  const [dark,setDark]=useState(false);`,
    `  const events = useActivity().slice(0,20);`,
    `  return (`,
    `    <main className="profile">`,
    `      <section className="avatar"><label>Upload<input type="file"/></label></section>`,
    `      <section className="bio"><textarea value={bio} onChange={e=>setBio(e.target.value)} /><button onClick={()=>save(bio)}>Save</button></section>`,
    `      <section className="settings">`,
    `        <label>Email<input type="checkbox" checked={emailOn} onChange={()=>setEmailOn(!emailOn)} /></label>`,
    `        <label>Dark<input type="checkbox" checked={dark} onChange={()=>setDark(!dark)} /></label>`,
    `      </section>`,
    `      <section className="activity"><ul>`,
  ];
  // 20 activity rows to bulk it out
  for (let i = 1; i <= 20; i++) body.push(`        <li key={${i}}>{events[${i-1}]?.ts} â€” {events[${i-1}]?.icon}</li>`);
  body.push(`      </ul></section>`);
  body.push(`    </main>`);
  body.push(`  );`);
  body.push(`}`);
  body.push(`function useActivity(){ return mockEvents; }`);
  body.push(`function save(b){ /* POST bio */ }`);
  body.push(`const mockEvents = Array.from({length:20}, (_,i)=>({ts:"2026-01-"+i, icon:"â˜†"}));`);
  return nf("src/pages/profile.tsx") + "@@ -0,0 +1," + (body.length + 1) + " @@\n" + add(body);
}

// â”€â”€ Case C: long, rambling, conversational prompt with buried authorizations â”€
const searchPrompt = `Hey so i want to spruce up the search experience. Can you add a search bar to the top nav that queries Algolia? We'll need the ALGOLIA_APP_ID and ALGOLIA_API_KEY env vars for that, and a /api/search endpoint that proxies to Algolia. Also while you're in there make the nav sticky on scroll, that's been bugging me forever. Oh and the search bar should debounce input by 300ms and show recent searches in a dropdown. That's it really, just the search stuff and the sticky nav, nothing else please, i'm trying to keep this PR small.`;

function buildSearchDiff(): string {
  const parts: string[] = [];
  // sticky nav + search bar â€” authorized (features)
  parts.push(h("src/components/Navbar.tsx") + "@@ -3,3 +3,12 @@\n" + add([
    `  const [q,setQ]=useState("");`,
    `  const [recents,setRecents]=useState([]);`,
    `  useEffect(()=>{ const t=setTimeout(()=>search(q),300); return ()=>clearTimeout(t); },[q]);`,
    `  <nav className="sticky">`,
    `    <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search" />`,
    `    {recents.length>0 && <ul className="recents">{recents.map(r=><li key={r}>{r}</li>)}</ul>}`,
    `  </nav>`,
  ]));
  // algolia dep â€” AUTHORIZED
  parts.push(h("package.json") + "@@ -10,3 +10,4 @@\n" + add([`    "algoliasearch": "^4.22.0",`]));
  // /api/search endpoint â€” AUTHORIZED
  parts.push(nf("src/app/api/search/route.ts") + "@@ -0,0 +1,5 @@\n" + add([
    `import algoliasearch from "algoliasearch";`,
    `export async function GET(){`,
    `  const c = algoliasearch(process.env.ALGOLIA_APP_ID as string, process.env.ALGOLIA_API_KEY as string);`,
    `  return Response.json(await c.searchForHits({ queries:[{ indexName:"prod", query:"" }] }));`,
    `}`,
  ]));
  // .env â€” ALGOLIA_* AUTHORIZED
  parts.push(h(".env.example") + "@@ -1 +1,3 @@\n" + add([`ALGOLIA_APP_ID=dev`, `ALGOLIA_API_KEY=devkey`]));
  // SMUGGLED: /api/export endpoint
  parts.push(nf("src/app/api/export/route.ts") + "@@ -0,0 +1,2 @@\n" + add([`export async function GET(){ return Response.json({dump:"all"}); }`]));
  // SMUGGLED: sentry dep
  parts.push(h("package.json") + "@@ -12,3 +12,4 @@\n" + add([`    "@sentry/react": "^7.0.0",`]));
  // SMUGGLED: cron
  parts.push(nf("cron.config.ts") + "@@ -0,0 +1,2 @@\n" + add([`import {CronJob} from "cron"; new CronJob("0 0 * * *", ()=>reindex());`]));
  return parts.join("\n");
}

async function run(name: string, prompt: string, diff: string, checks: () => void) {
  console.log(`\n${"â”€".repeat(80)}\n${name}  (prompt ${prompt.length} chars, diff ${diff.split(/\r?\n/).length} lines, ${diff.split(/\r?\n/).filter((l)=>l.startsWith("+")&&!l.startsWith("+++")).length} added)`);
  const t0 = Date.now();
  const r = await checkOverreach(prompt, diff);
  const ms = Date.now() - t0;
  console.log(`  scope: ${JSON.stringify(r.scope)}`);
  console.log(`  -> ${r.findings.length} findings | score ${r.scope_creep_score} | ${ms}ms (incl Stage 1 cloud call)`);
  console.log(`  summary: ${r.summary}`);
  (globalThis as any).__r = r;
  checks();
}

async function main() {
  const provider = resolveProvider();
  const model = resolveModel(provider);
  if ((!process.env.OVERREACH_HARNESS && provider !== "ollama") || !hasKey()) {
    console.log("SKIP: needs SCOPE_PROVIDER=ollama + OLLAMA creds."); process.exit(0);
  }
  const pre = await probeReachable("add a hello function");
  if (!pre.ok) { console.log(`SKIP: cloud unreachable: ${pre.warning}`); process.exit(0); }
  console.log(`Large-change simulation â€” model: ${model} @ ${process.env.OLLAMA_BASE_URL}`);

  // Pure-parser latency check (no LLM) on the biggest diff.
  const big = buildDashboardDiff();
  const t0 = Date.now();
  parseDiff(big);
  console.log(`\n[parser latency] Stage 2 on ${big.split(/\r?\n/).length}-line diff: ${Date.now() - t0}ms (deterministic, no LLM)`);

  // â”€â”€ Case A: dashboard with smuggled needles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await run("A. big dashboard (long detailed prompt + smuggled items in haystack)",
    dashboardPrompt, big, () => {
      const r = (globalThis as any).__r;
      const kinds = new Set(r.findings.map((f: any) => f.kind));
      ok("flags SMUGGLED stripe dep", r.findings.some((f: any) => f.kind === "scope.dep" && /stripe/i.test(f.evidence)));
      ok("flags SMUGGLED /api/checkout endpoint", r.findings.some((f: any) => f.kind === "scope.endpoint" && /checkout/i.test(f.evidence)));
      ok("flags SMUGGLED SENTRY_DSN env", r.findings.some((f: any) => f.kind === "scope.env" && /SENTRY/i.test(f.evidence)));
      ok("flags SMUGGLED cron", kinds.has("scope.cron"));
      ok("flags SMUGGLED billing.ts scope.file", r.findings.some((f: any) => f.kind === "scope.file" && /billing/i.test(f.evidence)));
      ok("does NOT flag AUTHORIZED recharts dep", !r.findings.some((f: any) => f.kind === "scope.dep" && /recharts/i.test(f.evidence)));
      ok("does NOT flag AUTHORIZED /api/metrics endpoint", !r.findings.some((f: any) => f.kind === "scope.endpoint" && /metrics/i.test(f.evidence)));
      ok("does NOT flag AUTHORIZED METRICS_API_KEY env", !r.findings.some((f: any) => f.kind === "scope.env" && /METRICS/i.test(f.evidence)));
      ok("does NOT flag the dashboard/components source files", !r.findings.some((f: any) => f.kind === "scope.file" && /(dashboard|MetricGrid|RevenueChart|FilterSidebar|DataTable)/i.test(f.evidence)));
      ok("score is HIGH (smuggled high-severity items)", r.scope_creep_score === "HIGH", `got ${r.scope_creep_score}`);
      const featureNoise = r.findings.filter((f: any) => f.kind === "scope.feature");
      console.log(`  (low-severity helper noise: ${featureNoise.length} scope.feature â€” ${featureNoise.map((f:any)=>f.evidence).join(", ") || "none"})`);
    });

  // â”€â”€ Case B: big clean page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await run("B. big CLEAN profile page (long prompt, large diff, no smuggling)",
    profilePrompt, buildProfileDiff(), () => {
      const r = (globalThis as any).__r;
      const noise = r.findings.map((f: any) => `${f.kind}(${f.evidence})`);
      ok("no high/medium findings (no dep/env/endpoint/cron/scope.file)", !r.findings.some((f: any) => f.severity !== "low"), noise.join(", "));
      ok("score is LOW", r.scope_creep_score === "LOW", `got ${r.scope_creep_score}`);
      const featureNoise = r.findings.filter((f: any) => f.kind === "scope.feature");
      console.log(`  (low-severity helper noise: ${featureNoise.length} scope.feature â€” ${featureNoise.map((f:any)=>f.evidence).join(", ") || "none"})`);
    });

  // â”€â”€ Case C: long rambling prompt with buried authorizations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await run("C. long rambling prompt (auth buried in prose + smuggled extras)",
    searchPrompt, buildSearchDiff(), () => {
      const r = (globalThis as any).__r;
      ok("flags SMUGGLED /api/export endpoint", r.findings.some((f: any) => f.kind === "scope.endpoint" && /export/i.test(f.evidence)));
      ok("flags SMUGGLED sentry dep", r.findings.some((f: any) => f.kind === "scope.dep" && /sentry/i.test(f.evidence)));
      ok("flags SMUGGLED cron", r.findings.some((f: any) => f.kind === "scope.cron"));
      ok("does NOT flag AUTHORIZED algolia dep", !r.findings.some((f: any) => f.kind === "scope.dep" && /algolia/i.test(f.evidence)));
      ok("does NOT flag AUTHORIZED /api/search endpoint", !r.findings.some((f: any) => f.kind === "scope.endpoint" && /search/i.test(f.evidence)));
      ok("does NOT flag AUTHORIZED ALGOLIA_* env", !r.findings.some((f: any) => f.kind === "scope.env" && /ALGOLIA/i.test(f.evidence)));
      ok("score is HIGH", r.scope_creep_score === "HIGH", `got ${r.scope_creep_score}`);
    });

  // â”€â”€ Case D: very long multi-feature prompt â†’ forces sectioning + reconcile â”€
  const notifPrompt = `Build a notification center page at src/pages/notifications.tsx. It should have a NotificationCenter component that lists notifications grouped by type, a NotificationItem component with an icon, a title, a timestamp and a mark-as-read button, a FilterBar with tabs for All, Unread and Mentioned, a ToastProvider context that shows transient toast messages, an infinite scroll loader that fetches more notifications from /api/notifications, a WebSocket connection at /api/notifications/ws for live updates reading NOTIF_WS_URL from env, a /api/notifications/read endpoint to mark notifications read, optimistic updates with a rollback on error, and accessibility attributes for screen readers. Use the date-fns library for formatting timestamps and clsx for class composition. Keep the styling with the existing tailwind setup and do not add new dependencies beyond date-fns and clsx.`;

  function buildNotifDiff(): string {
    const parts: string[] = [];
    parts.push(nf("src/pages/notifications.tsx") + "@@ -0,0 +1,12 @@\n" + add([
      `import { NotificationItem } from "../components/NotificationItem";`,
      `import { FilterBar } from "../components/FilterBar";`,
      `import { ToastProvider } from "../components/ToastProvider";`,
      `export function NotificationCenter(){`,
      `  const items = useNotifications();`,
      `  return <ToastProvider><FilterBar/><ul>{items.map(i=><NotificationItem key={i.id} {...i}/>)}</ul></ToastProvider>;`,
      `}`,
    ]));
    parts.push(nf("src/components/NotificationItem.tsx") + "@@ -0,0 +1,6 @@\n" + add([
      `export function NotificationItem({icon,title,ts,read}){`,
      `  return <li aria-label={title}><span>{icon}</span><b>{title}</b><time>{ts}</time><button onClick={read}>read</button></li>;`,
      `}`,
    ]));
    parts.push(nf("src/components/FilterBar.tsx") + "@@ -0,0 +1,4 @@\n" + add([
      `export function FilterBar(){ return <nav role="tablist"><button>All</button><button>Unread</button><button>Mentioned</button></nav>; }`,
    ]));
    parts.push(nf("src/components/ToastProvider.tsx") + "@@ -0,0 +1,5 @@\n" + add([
      `export function ToastProvider({children}){`,
      `  return <div>{children}</div>;`,
      `}`,
    ]));
    // deps: date-fns AUTH, clsx AUTH, stripe SMUGGLE
    parts.push(h("package.json") + "@@ -18,4 +18,7 @@\n" + add([`    "date-fns": "^3.6.0",`, `    "clsx": "^2.1.0",`, `    "stripe": "^14.0.0",`]));
    // /api/notifications GET AUTH
    parts.push(nf("src/app/api/notifications/route.ts") + "@@ -0,0 +1,2 @@\n" + add([`export async function GET(){ return Response.json(await db.notifications.findMany()); }`]));
    // /api/notifications/read POST AUTH
    parts.push(nf("src/app/api/notifications/read/route.ts") + "@@ -0,0 +1,2 @@\n" + add([`export async function POST(req){ return Response.json(await db.notifications.update({where:{id:await req.json().id}, data:{read:true}})); }`]));
    // /api/notifications/ws AUTH + NOTIF_WS_URL AUTH env
    parts.push(nf("src/app/api/notifications/ws/route.ts") + "@@ -0,0 +1,3 @@\n" + add([
      `export async function GET(){`,
      `  const upstream = new WebSocket(process.env.NOTIF_WS_URL as string); return Response.json({live:true});`,
      `}`,
    ]));
    // .env: NOTIF_WS_URL AUTH, SENTRY_DSN SMUGGLE
    parts.push(h(".env.example") + "@@ -1 +1,3 @@\n" + add([`NOTIF_WS_URL=ws://upstream`, `SENTRY_DSN=https://x@sentry.io/1`]));
    // SMUGGLE checkout endpoint
    parts.push(nf("src/app/api/checkout/route.ts") + "@@ -0,0 +1,2 @@\n" + add([`export async function POST(){ return Response.json({}); }`]));
    // SMUGGLE cron
    parts.push(nf("cron.config.ts") + "@@ -0,0 +1,2 @@\n" + add([`import {CronJob} from "cron"; new CronJob("*/5 * * * *", ()=>pruneNotifs());`]));
    // SMUGGLE out-of-scope source file
    parts.push(nf("src/lib/billing.ts") + "@@ -0,0 +1,2 @@\n" + add([`export function chargeCustomer(uid){ return {uid}; }`]));
    return parts.join("\n");
  }

  await run("D. VERY LONG multi-feature prompt (sectioned map-reduce + reconcile)",
    notifPrompt, buildNotifDiff(), () => {
      const r = (globalThis as any).__r;
      ok("prompt is long enough to chunk (>700 chars)", notifPrompt.length > 700, `${notifPrompt.length} chars`);
      ok("flags SMUGGLED stripe dep", r.findings.some((f: any) => f.kind === "scope.dep" && /stripe/i.test(f.evidence)));
      ok("flags SMUGGLED /api/checkout endpoint", r.findings.some((f: any) => f.kind === "scope.endpoint" && /checkout/i.test(f.evidence)));
      ok("flags SMUGGLED SENTRY_DSN env", r.findings.some((f: any) => f.kind === "scope.env" && /SENTRY/i.test(f.evidence)));
      ok("flags SMUGGLED cron", r.findings.some((f: any) => f.kind === "scope.cron"));
      ok("flags SMUGGLED billing.ts scope.file", r.findings.some((f: any) => f.kind === "scope.file" && /billing/i.test(f.evidence)));
      ok("does NOT flag AUTHORIZED date-fns dep", !r.findings.some((f: any) => f.kind === "scope.dep" && /date/i.test(f.evidence)));
      ok("does NOT flag AUTHORIZED clsx dep", !r.findings.some((f: any) => f.kind === "scope.dep" && /clsx/i.test(f.evidence)));
      ok("does NOT flag AUTHORIZED /api/notifications endpoints", !r.findings.some((f: any) => f.kind === "scope.endpoint" && /notifications/i.test(f.evidence)));
      ok("does NOT flag AUTHORIZED NOTIF_WS_URL env", !r.findings.some((f: any) => f.kind === "scope.env" && /NOTIF_WS/i.test(f.evidence)));
      ok("does NOT flag the notification source files", !r.findings.some((f: any) => f.kind === "scope.file" && /(notifications|NotificationItem|FilterBar|ToastProvider)/i.test(f.evidence)));
      ok("score is HIGH", r.scope_creep_score === "HIGH", `got ${r.scope_creep_score}`);
      console.log(`  (scope had ${r.scope.features_allowed.length} features, ${r.scope.endpoints_allowed.length} endpoints, ${r.scope.deps_allowed.length} deps â€” extracted via sectioned map-reduce)`);
    });

  console.log(`\n${"â•".repeat(80)}\nLARGE SIMULATION: ${pass}/${pass + fail} assertions passed  (model: ${model} @ cloud)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(2); });
void readFileSync;
# Overreach — Launch & Distribution Kit

Everything ready to paste. Fire in this order: MCP registries → Reddit → HN → X.
Drive every post to **the landing page** (host the `site/index.html` anywhere —
GitHub Pages, Netlify, Vercel; the page is fully self-contained, no build step).

> Before posting: replace `https://overreach.dev` with your real landing URL,
> and drop your Formspree ID into the waitlist form (or wire `/api/waitlist`).

---

## 0. Host the landing page (5 min)
```bash
# Option A — GitHub Pages: push site/index.html to a gh-pages branch / docs folder.
# Option B — Netlify drag-and-drop: drop the site/ folder onto app.netlify.com.
# Option C — Vercel: `vercel` in the Overreach/site folder.
```
No build. One HTML file. Done.

---

## 1. MCP registry submissions (the "sell to agents" channel)

### mcp.so
- **Name:** Overreach
- **Tagline (<160 chars):** Scope audit + multi-agent coordination. Audits a diff against the prompt that authorized it — flags every unauthorized dep, env, endpoint, cron, or file. Deterministic.
- **Categories:** Developer Tools, Code Review, AI Agents
- **Transport:** Streamable HTTP (and stdio)
- **Auth:** none
- **Install:** `npx -y overreach`
- **Repo:** https://github.com/Naveja00/OverReach

### Smithery
- **Name:** overreach
- **Description:** Catches scope creep — audits your diff against your prompt, deterministically. Plus cross-vendor coordination for Claude Code, Cursor, and Codex on the same repo.
- **Command:** `npx -y overreach`

### awesome-mcp-servers (GitHub PR)
Add to the Code Analysis / Developer Tools section:
```md
- [Overreach](https://github.com/Naveja00/OverReach) — Scope-creep audit (diff vs prompt) + cross-vendor multi-agent coordination. `npx -y overreach`.
```

---

## 2. Reddit — r/ClaudeAI (post as text, not a link)

**Title:** I built an MCP tool that catches every line Claude ships beyond your prompt

**Body:**
> Has your AI agent ever shipped a route, a dep, or an env var you never asked for?
>
> I asked Claude to add a login form to the settings page. It also added a Stripe
> import, `STRIPE_SECRET`, `/api/checkout`, and a cleanup cron — none of which I
> requested. Invisible until a bill arrives or prod breaks.
>
> So I built **Overreach** — an MCP server that audits your diff against the
> *actual prompt* that authorized it and flags everything out of scope:
>
> - `scope.dep` · `scope.env` · `scope.endpoint` · `scope.cron` · `scope.file` · `scope.feature`
> - 3-stage pipeline: one cheap LLM call to extract scope, then **deterministic** diff parse + set arithmetic. No hallucinated findings — every finding is derivable from (prompt, diff).
> - It also coordinates Claude Code, Cursor, and Codex on the same repo (file claims, conflict detection, a shared ledger) — cross-vendor, just JSON in git.
> - Free, MIT, no key needed for the demo:
>
> ```bash
> npx -y -p overreach overreach-cli demo
> ```
>
> Repo: https://github.com/Naveja00/OverReach · Site: https://overreach.dev
>
> The one honest caveat: an agent can skip the call — the MCP tool is a first
> line, not the only line. The hard backstop is the CI gate (free workflow) and
> a managed version I'm piloting now. If you want the managed gate on your repo,
> there's a waitlist on the site.
>
> What's the worst scope creep you've caught after the fact?

*(Hook for the comments: "I asked it to add a login form. It also added Stripe. Overreach catches that.")*

---

## 3. Reddit — r/cursor (same idea, Cursor-framed)

**Title:** Cursor + Claude Code + Codex on one repo? I built the coordination layer that's missing

**Body:**
> Cursor only coordinates Cursor-with-Cursor. Claude Code, Claude-with-Claude.
> When you run all three on the same repo, there's zero awareness between them —
> files get clobbered, work gets duplicated, agents contradict each other.
>
> **Overreach** is the cross-vendor layer none of them provide:
>
> - File claims before working (auto-expire, extendable)
> - Conflict detection + resolution (block or escalate)
> - A shared coordination ledger — who touched what, scope-creep score, mode, confidence — committed as JSON in `.overreach/`
> - Parent→child delegation that can only *narrow* scope, never expand
> - `who_touched("src/auth.ts")` → full agent history
>
> It also audits every diff against the prompt that authorized it and flags
> out-of-scope deps/env/endpoints/cron — **deterministically**, no inference.
>
> ```bash
> npx -y -p overreach overreach-cli demo
> ```
> Repo: https://github.com/Naveja00/OverReach · Waitlist for the managed gate: https://overreach.dev
>
> Anyone running multiple agents on one repo — how are you stopping them from stepping on each other today?

---

## 4. Hacker News — Show HN

**Title:** Show HN: Overreach – catch every line your AI agent shipped beyond the prompt

**Body:**
> Hi HN. I kept noticing my AI coding agent ship more than I asked for — a login
> form request would come back with a Stripe import, a secret env var, a new
> endpoint, and a cron job. None requested, all invisible until something breaks.
>
> Overreach audits a git diff against the natural-language prompt that authorized
> it and flags every out-of-scope change. The interesting part is the trust
> model: findings are **deterministic set arithmetic** (`actual − authorized`),
> not model opinion. One cheap LLM call extracts scope from the prompt; the diff
> parse and the comparison are pure functions. So a finding is always provable
> from (prompt, diff) — no hallucinated issues, which is the thing that makes
> probabilistic AI reviewers unreliable to act on.
>
> Seven finding kinds: dep, env, endpoint, cron, listener, file, feature — with
> severity and an overall scope-creep score (HIGH/MEDIUM/LOW).
>
> It's also a cross-vendor coordination layer for running Claude Code, Cursor,
> and Codex on the same repo — file claims, conflict detection, a shared ledger,
> parent→child scope narrowing. Just JSON committed to git; any agent can read it.
>
> - Repo: https://github.com/Naveja00/OverReach
> - Live demo, no key: `npx -y -p overreach overreach-cli demo`
> - MCP server, MIT, free
>
> Honest limitation: the agent can skip the tool call — it's a first line, not
> the only line. The CI gate is the hard backstop. I'm piloting a managed version
> of that gate now.
>
> Curious what HN thinks about the deterministic-vs-probabilistic framing for AI
> code review — is "provably derivable from the diff" a property people would
> trust over a model's opinion?

---

## 5. X / Twitter (thread)

**1/** I asked my AI agent to add a login form.

It also added Stripe, a secret env var, a checkout endpoint, and a cleanup cron.

None of which I asked for. Invisible until a bill shows up.

So I built something to catch it. 🧵

**2/** Overreach audits your diff against the prompt that authorized it — and flags every unauthorized dep, env var, endpoint, cron job, or file.

One-liner: "I asked it to add a login form. It also added Stripe. Overreach catches that."

**3/** The key decision: findings are deterministic set arithmetic (actual − authorized), not model opinion.

Every finding is provable from (prompt, diff). No hallucinated issues. That's the thing probabilistic AI reviewers can't give you.

**4/** It's also a cross-vendor coordination layer — Claude Code + Cursor + Codex on one repo, no clobbering. File claims, conflict detection, a shared ledger. Just JSON in git.

**5/** Free, MIT, no key:
```bash
npx -y -p overreach overreach-cli demo
```
Repo: https://github.com/Naveja00/OverReach
Managed CI gate (the hard backstop) is piloting now → waitlist on the site.

---

## 6. Validation — count the signal
After posting, track:
- npm weekly downloads (api.npmjs.org/downloads/point/last-week/overreach) — baseline today: **~1,346/wk**
- GitHub stars + issues
- Waitlist signups (the only number that matters for the paid layer)
- "Yes, this happened to me" replies = the demand proof for the managed gate

**Trigger to build the managed GitHub App (task #12):** ~5–10 waitlist signups
or 2–3 teams asking "can you just wire this into our CI for us?" That's the
signal to stop selling concierge and start building self-serve.

---

## The one thing to do before posting
The waitlist form in `site/index.html` posts to a Formspree placeholder
(`YOUR_FORMSPREE_ID`). Either:
- create a free form at formspree.io and paste the ID into the `action`, or
- say the word and I'll wire a tiny `/api/waitlist` endpoint on your FastAPI stack
  (Postgres `waitlist` table + email capture) so you own the data.

Then fire. The hook writes itself.
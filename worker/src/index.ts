// Overreach telemetry worker — receives anonymous init pings, stores in D1.
//
// Deployed to: overreach-telemetry.naveja.workers.dev
// Single endpoint: POST /init
// Dashboard: GET /stats (optional, bearer-gated)

interface Env {
  DB: D1Database;
  STATS_TOKEN?: string;
}

interface InitPayload {
  event: string;
  os: string;
  arch: string;
  node: string;
  vendors: number;
  v: string;
  ts: string;
}

function isValidPayload(body: unknown): body is InitPayload {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    b.event === "init" &&
    typeof b.os === "string" &&
    typeof b.arch === "string" &&
    typeof b.node === "string" &&
    typeof b.vendors === "number" &&
    typeof b.v === "string" &&
    typeof b.ts === "string"
  );
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // POST /init — record a ping
    if (request.method === "POST" && url.pathname === "/init") {
      try {
        const body = await request.json();
        if (!isValidPayload(body)) {
          return new Response(JSON.stringify({ error: "invalid payload" }), {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }

        await env.DB.prepare(
          `INSERT INTO inits (os, arch, node_version, vendors, overreach_version, client_ts, received_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
        )
          .bind(body.os, body.arch, body.node, body.vendors, body.v, body.ts)
          .run();

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      } catch {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    // GET /stats — simple dashboard (bearer-gated)
    if (request.method === "GET" && url.pathname === "/stats") {
      if (env.STATS_TOKEN) {
        const auth = request.headers.get("Authorization");
        if (auth !== `Bearer ${env.STATS_TOKEN}`) {
          return new Response("unauthorized", { status: 401 });
        }
      }

      const total = await env.DB.prepare("SELECT COUNT(*) as count FROM inits").first<{ count: number }>();
      const byOS = await env.DB.prepare(
        "SELECT os, COUNT(*) as count FROM inits GROUP BY os ORDER BY count DESC"
      ).all();
      const byVersion = await env.DB.prepare(
        "SELECT overreach_version as v, COUNT(*) as count FROM inits GROUP BY overreach_version ORDER BY count DESC"
      ).all();
      const byVendors = await env.DB.prepare(
        "SELECT vendors, COUNT(*) as count FROM inits GROUP BY vendors ORDER BY vendors"
      ).all();
      const recent = await env.DB.prepare(
        "SELECT * FROM inits ORDER BY received_at DESC LIMIT 20"
      ).all();
      const daily = await env.DB.prepare(
        "SELECT date(received_at) as day, COUNT(*) as count FROM inits GROUP BY day ORDER BY day DESC LIMIT 30"
      ).all();

      return new Response(
        JSON.stringify({ total: total?.count ?? 0, by_os: byOS.results, by_version: byVersion.results, by_vendors: byVendors.results, daily: daily.results, recent: recent.results }, null, 2),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
};

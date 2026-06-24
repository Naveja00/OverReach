# Overreach Telemetry Worker

Cloudflare Worker + D1 that receives anonymous init pings from `overreach init`.

## Setup

```bash
cd worker

# 1. Create the D1 database
wrangler d1 create overreach-telemetry

# 2. Copy the database_id from the output into wrangler.toml

# 3. Create the table
wrangler d1 execute overreach-telemetry --file=schema.sql

# 4. Deploy
wrangler deploy

# 5. (Optional) Set a stats token to gate the /stats endpoint
wrangler secret put STATS_TOKEN
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/init` | none | Receives an init ping. Always returns 200 (even on error — never blocks the client). |
| GET | `/stats` | Bearer token (optional) | Returns total inits, breakdown by OS/version/vendors, daily counts, recent 20. |

## What's collected

```json
{ "os": "win32", "arch": "x64", "node": "v20.11.0", "vendors": 3, "v": "0.6.0", "ts": "..." }
```

No repo name, no file paths, no prompt content, no user identity.

## Opt-out (client side)

`OVERREACH_TELEMETRY=0` or `DO_NOT_TRACK=1` — the client never sends the ping.

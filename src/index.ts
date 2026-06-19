#!/usr/bin/env node
// Overreach MCP server. Exposes one tool: check_overreach.
// Transport: stdio by default (what Claude Desktop / Cursor use for `npx overreach`).
// If PORT is set, also serves Streamable HTTP on that port for remote clients.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { checkOverreach } from "./tools/check_overreach.js";
import { PORT, HOST } from "./config.js";

// Read the version from package.json so serverInfo / health stay in sync with
// npm publishes without a manual bump here. Resolves to the root package.json
// both in dev (tsx src/index.ts) and in the published tarball (dist/src/index.js).
const require = createRequire(import.meta.url);
const VERSION: string = require("../../package.json").version;

const server = new McpServer({
  name: "overreach",
  version: VERSION,
});

server.tool(
  "check_overreach",
  "Audit a code diff against the originating natural-language prompt. Flags every out-of-scope (overreaching) change the AI agent made — unauthorized deps, env vars, endpoints, cron jobs, files, and features. Returns structured findings + a scope_creep_score.",
  {
    prompt: z.string().describe("The natural-language instruction the agent was given (the authorized scope)."),
    diff: z.string().describe("A unified git diff (`git diff` output) of the changes to audit."),
    language: z.enum(["python", "typescript", "auto"]).optional().describe("Optional language hint; default auto-detect."),
  },
  async (args) => {
    const result = await checkOverreach(args.prompt, args.diff, {
      language: args.language as "python" | "typescript" | "auto" | undefined,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool("health", "Health check for the Overreach MCP server.", {}, async () => ({
  content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", version: VERSION }) }],
}));

async function main() {
  if (PORT) {
    // Streamable HTTP transport for remote clients.
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const http = await import("node:http");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    const httpServer = http.createServer(async (req, res) => {
      if (req.url && req.url.includes("/mcp")) {
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(404).end("Not found. Use /mcp.");
      }
    });
    httpServer.listen(PORT, HOST, () => {
      console.error(`[overreach] MCP server (Streamable HTTP) on http://${HOST}:${PORT}/mcp`);
    });
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EACCES" || err.code === "EADDRINUSE") {
        console.error(`[overreach] cannot bind ${HOST}:${PORT} (${err.code}). Pick a different PORT, or check Windows reserved-port ranges / what's already listening.`);
      } else {
        console.error("[overreach] HTTP server error:", err.message);
      }
      process.exit(1);
    });
  } else {
    // stdio — default for `npx overreach` in Claude Desktop / Cursor.
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[overreach] MCP server (stdio) ready");
  }
}

main().catch((err) => {
  console.error("[overreach] fatal:", err);
  process.exit(1);
});
#!/usr/bin/env node
// Overreach MCP server. Exposes one tool: check_overreach.
// Transport: stdio by default (what Claude Desktop / Cursor use for `npx overreach`).
// If PORT is set, also serves Streamable HTTP on that port for remote clients.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { checkOverreach } from "./tools/check_overreach.js";
import { validateHandoff } from "./handoff/validate.js";
import { readLedger, appendLedger, formatLedgerForAgent, queryByFile, fileOwnershipMap } from "./ledger.js";
import { claimFiles, releaseClaims, extendClaim, checkConflicts, readClaims, formatClaims } from "./claims.js";
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

server.tool(
  "validate_handoff",
  "Validate an agent-to-agent handoff. When a parent agent delegates a subtask to a child agent, call this to ensure the child's work stays within the parent's authorized scope. The child contract inherits the full delegation chain so every downstream agent has complete project context.",
  {
    parent_contract: z.string().describe("The parent agent's execution contract (JSON string). Obtained from a prior check_overreach call with emitContract enabled."),
    instruction: z.string().describe("The subtask instruction the parent is delegating to the child agent."),
    diff: z.string().describe("The child agent's unified diff to audit against the parent's authorization."),
    agent_name: z.string().optional().describe("Name or identifier of the child agent performing the work."),
    expires: z.string().optional().describe("Contract expiration: duration ('30m', '2h', '1d') or ISO timestamp."),
  },
  async (args) => {
    let parentContract;
    try {
      parentContract = JSON.parse(args.parent_contract);
    } catch {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "parent_contract must be valid JSON" }) }] };
    }
    const result = await validateHandoff(parentContract, args.instruction, args.diff, {
      emitContract: true,
      agentName: args.agent_name,
      expiresAt: args.expires,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "read_ledger",
  "Read the multi-agent coordination ledger (.overreach/ledger.json). Returns a summary of all prior agent work in this project — what each agent did, which files they touched, their scope creep scores, and timestamps. Agents should read this before starting to understand what's already been done.",
  {
    project_root: z.string().describe("Absolute path to the project root (where .overreach/ lives)."),
    format: z.enum(["json", "summary"]).optional().describe("Output format: 'json' for raw entries, 'summary' for human-readable. Default: summary."),
  },
  async (args) => {
    const entries = readLedger(args.project_root);
    const text = args.format === "json"
      ? JSON.stringify(entries, null, 2)
      : formatLedgerForAgent(entries);
    return { content: [{ type: "text" as const, text }] };
  },
);

server.tool(
  "append_ledger",
  "Record completed agent work in the coordination ledger. Call this after a successful check_overreach audit to log what this agent did. Other agents read the ledger to avoid duplicate work and detect drift.",
  {
    project_root: z.string().describe("Absolute path to the project root (where .overreach/ lives)."),
    audit_result: z.string().describe("The full JSON result from check_overreach (must include actual.files_changed and scope_creep_score)."),
    agent_name: z.string().describe("Name or identifier of the agent that did the work."),
    task_summary: z.string().describe("One-line description of what this agent was tasked with."),
    task_id: z.string().optional().describe("Optional task/ticket ID for traceability (e.g. 'PROJ-123')."),
    issue_ref: z.string().optional().describe("Optional issue reference for traceability (e.g. 'github:org/repo#42')."),
  },
  async (args) => {
    let result;
    try {
      result = JSON.parse(args.audit_result);
    } catch {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "audit_result must be valid JSON" }) }] };
    }
    appendLedger(args.project_root, result, args.agent_name, args.task_summary, {
      taskId: args.task_id,
      issueRef: args.issue_ref,
    });
    const entries = readLedger(args.project_root);
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, total_entries: entries.length }) }] };
  },
);

server.tool(
  "claim_files",
  "Claim files before working on them. Other agents calling check_conflicts will see your claims and avoid collisions. Claims auto-expire (default 2h). Call this at the START of your work to prevent file collision — the #1 multi-agent pain point.",
  {
    project_root: z.string().describe("Absolute path to the project root."),
    files: z.array(z.string()).describe("File paths to claim (relative to project root)."),
    agent_name: z.string().describe("Your agent name/identifier."),
    task_summary: z.string().describe("What you're doing with these files."),
    duration: z.string().optional().describe("How long to hold the claim: '30m', '2h', '1d'. Default: '2h'."),
  },
  async (args) => {
    const result = claimFiles(args.project_root, args.files, args.agent_name, args.task_summary, args.duration);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "release_files",
  "Release your file claims when done. Other agents can then claim those files. If no files specified, releases ALL your claims.",
  {
    project_root: z.string().describe("Absolute path to the project root."),
    agent_name: z.string().describe("Your agent name/identifier."),
    files: z.array(z.string()).optional().describe("Specific files to release. Omit to release all your claims."),
  },
  async (args) => {
    const released = releaseClaims(args.project_root, args.agent_name, args.files);
    return { content: [{ type: "text" as const, text: JSON.stringify({ released }) }] };
  },
);

server.tool(
  "extend_claim",
  "Extend the duration of your existing file claims. Use when your work is taking longer than the original claim duration.",
  {
    project_root: z.string().describe("Absolute path to the project root."),
    agent_name: z.string().describe("Your agent name/identifier."),
    files: z.array(z.string()).describe("File paths to extend."),
    duration: z.string().describe("New duration from now: '30m', '2h', '1d'."),
  },
  async (args) => {
    const result = extendClaim(args.project_root, args.agent_name, args.files, args.duration);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "check_conflicts",
  "Check if the files you plan to work on conflict with other agents' active claims or recent work. Call this BEFORE starting work to avoid file collisions and duplicate implementations. Returns active claims by other agents AND files recently touched by other agents (last hour from the ledger).",
  {
    project_root: z.string().describe("Absolute path to the project root."),
    files: z.array(z.string()).describe("File paths you plan to work on."),
    agent_name: z.string().describe("Your agent name (excluded from conflict results)."),
  },
  async (args) => {
    const ledger = readLedger(args.project_root);
    const report = checkConflicts(args.project_root, args.files, args.agent_name, ledger);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

server.tool(
  "who_touched",
  "Find out which agents have touched a specific file. Answers: 'Who else worked on auth.ts?' Uses the ledger to show every agent that modified the file, what they were doing, and when.",
  {
    project_root: z.string().describe("Absolute path to the project root."),
    file: z.string().describe("File path to query (relative to project root)."),
  },
  async (args) => {
    const entries = readLedger(args.project_root);
    const touches = queryByFile(entries, args.file);
    if (touches.length === 0) {
      return { content: [{ type: "text" as const, text: `No agent has touched "${args.file}" according to the ledger.` }] };
    }
    const lines = touches.map(e => `[${e.agent}] ${e.task} (${e.score}) — ${e.at}`);
    return { content: [{ type: "text" as const, text: `Agents that touched "${args.file}":\n${lines.join("\n")}` }] };
  },
);

server.tool(
  "active_claims",
  "List all active file claims across all agents. Shows who is working on what right now. Expired claims are automatically purged.",
  {
    project_root: z.string().describe("Absolute path to the project root."),
  },
  async (args) => {
    const claims = readClaims(args.project_root);
    return { content: [{ type: "text" as const, text: formatClaims(claims) }] };
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
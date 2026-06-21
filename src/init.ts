// overreach init — full project setup for scope-creep detection.
//
// What it does:
//   1. Creates .overreach/prompt.md (the user fills in their authorized scope)
//   2. Writes .git/hooks/pre-commit that runs overreach on staged changes
//   3. Appends a CLAUDE.md instruction so AI agents self-audit before committing
//
// The hook blocks the commit when scope_creep_score=HIGH (exit 1). LOW/MEDIUM
// pass through. Use `git commit --no-verify` to skip (escape hatch, not recommended).

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ANSI = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const useColor = process.stdout.isTTY ?? false;
const c = (fn: (s: string) => string) => (useColor ? fn : (s: string) => s);

const PROMPT_TEMPLATE = `# Overreach — Authorized Prompt

Write the instruction you gave your AI agent here. The pre-commit hook reads
this file and checks every commit's diff against it.

Example:
  Add a login form to the settings page with email/password fields,
  form validation, and a submit button that calls /api/auth/login.

Update this file whenever you give the agent a new task.
`;

const HOOK_MARKER = "# >>> overreach pre-commit hook";
const HOOK_MARKER_END = "# <<< overreach pre-commit hook";

const HOOK_SCRIPT = `${HOOK_MARKER}
# Runs Overreach on staged changes. Blocks the commit on HIGH scope creep.
# Skip with: git commit --no-verify

PROMPT_FILE=".overreach/prompt.md"
if [ ! -f "$PROMPT_FILE" ]; then
  echo "[overreach] No .overreach/prompt.md found — skipping scope audit."
  echo "[overreach] Run 'npx -y -p overreach overreach-cli init' to set up."
else
  # Skip if the prompt file is still the template (no real prompt written)
  if head -1 "$PROMPT_FILE" | grep -q "^# Overreach"; then
    echo "[overreach] .overreach/prompt.md is still the template — skipping."
    echo "[overreach] Edit it with your actual prompt to enable the scope audit."
  else
    DIFF=$(git diff --cached)
    if [ -z "$DIFF" ]; then
      echo "[overreach] No staged changes — skipping scope audit."
    else
      echo "[overreach] Auditing staged changes against .overreach/prompt.md..."
      AGENT_NAME=\${OVERREACH_AGENT_NAME:-pre-commit}
      echo "$DIFF" | npx -y -p overreach overreach-cli --prompt-file "$PROMPT_FILE" --agent-name "$AGENT_NAME" --ledger-append
      EXIT_CODE=$?
      if [ $EXIT_CODE -eq 1 ]; then
        echo ""
        echo "[overreach] HIGH scope creep detected — commit blocked."
        echo "[overreach] Review the findings above. To commit anyway: git commit --no-verify"
        exit 1
      elif [ $EXIT_CODE -eq 2 ]; then
        echo "[overreach] Audit error (exit 2) — commit allowed (fail-open)."
      fi
    fi
  fi
fi
${HOOK_MARKER_END}
`;

function findGitRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

export function runInit(): void {
  const gitRoot = findGitRoot();
  if (!gitRoot) {
    console.error(c(ANSI.red)("Not a git repository. Run `git init` first, then re-run `overreach init`."));
    process.exit(1);
  }

  const overreachDir = join(gitRoot, ".overreach");
  const promptFile = join(overreachDir, "prompt.md");
  const hooksDir = join(gitRoot, ".git", "hooks");
  const hookFile = join(hooksDir, "pre-commit");

  let createdPrompt = false;
  let installedHook = false;
  let createdClaudeMd = false;

  // 1. Create .overreach/prompt.md
  if (!existsSync(overreachDir)) mkdirSync(overreachDir, { recursive: true });
  if (!existsSync(promptFile)) {
    writeFileSync(promptFile, PROMPT_TEMPLATE, "utf-8");
    createdPrompt = true;
  }

  // 2. Install or update the pre-commit hook
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  if (existsSync(hookFile)) {
    const existing = readFileSync(hookFile, "utf-8");
    if (existing.includes(HOOK_MARKER)) {
      // Replace the existing overreach block
      const before = existing.split(HOOK_MARKER)[0];
      const afterMarkerEnd = existing.split(HOOK_MARKER_END);
      const after = afterMarkerEnd.length > 1 ? afterMarkerEnd[1] : "";
      writeFileSync(hookFile, before + HOOK_SCRIPT + after, "utf-8");
      try { chmodSync(hookFile, 0o755); } catch {}
      installedHook = true;
    } else {
      // Append to existing hook
      const content = existing.endsWith("\n") ? existing : existing + "\n";
      writeFileSync(hookFile, content + "\n" + HOOK_SCRIPT, "utf-8");
      try { chmodSync(hookFile, 0o755); } catch {}
      installedHook = true;
    }
  } else {
    writeFileSync(hookFile, "#!/bin/sh\n\n" + HOOK_SCRIPT, "utf-8");
    try { chmodSync(hookFile, 0o755); } catch {}
    installedHook = true;
  }

  // 3. Append to CLAUDE.md so AI agents self-audit
  const claudeMdFile = join(gitRoot, "CLAUDE.md");
  const CLAUDE_MARKER = "<!-- overreach -->";
  const CLAUDE_BLOCK = `
${CLAUDE_MARKER}
## Scope audit (Overreach)

Before committing, audit your staged changes against the task prompt:

\`\`\`
git diff --staged | npx -y -p overreach overreach-cli --prompt "<the task you were given>"
\`\`\`

If \`scope_creep_score\` is HIGH, remove the unauthorized changes before committing.
Do not add dependencies, env vars, endpoints, or cron jobs the prompt did not ask for.

### Multi-agent coordination
Before starting work, check for conflicts with other agents:
- Read the ledger: \`overreach ledger\` to see what other agents have done
- Check conflicts: call the \`check_conflicts\` MCP tool with your intended files
- Claim files: call \`claim_files\` before editing to prevent collisions
- Release claims: call \`release_files\` when done
- The pre-commit hook auto-logs your work to \`.overreach/ledger.json\`
${CLAUDE_MARKER}
`;

  if (existsSync(claudeMdFile)) {
    const existing = readFileSync(claudeMdFile, "utf-8");
    if (!existing.includes(CLAUDE_MARKER)) {
      const content = existing.endsWith("\n") ? existing : existing + "\n";
      writeFileSync(claudeMdFile, content + CLAUDE_BLOCK, "utf-8");
      createdClaudeMd = true;
    }
  } else {
    writeFileSync(claudeMdFile, CLAUDE_BLOCK.trimStart(), "utf-8");
    createdClaudeMd = true;
  }

  // 4. .cursorrules — same instruction for Cursor users
  const cursorRulesFile = join(gitRoot, ".cursorrules");
  const CURSOR_MARKER = "# >>> overreach";
  const CURSOR_BLOCK = `
${CURSOR_MARKER}
# Scope audit (Overreach)
# Before committing, audit your staged changes against the task prompt:
#   git diff --staged | npx -y -p overreach overreach-cli --prompt "<the task you were given>"
# If scope_creep_score is HIGH, remove the unauthorized changes before committing.
# Do not add dependencies, env vars, endpoints, or cron jobs the prompt did not ask for.
# Multi-agent: call check_conflicts before starting work to avoid file collisions.
# After committing: the pre-commit hook auto-logs your work to .overreach/ledger.json.
${CURSOR_MARKER}
`;
  let createdCursorRules = false;
  if (existsSync(cursorRulesFile)) {
    const existing = readFileSync(cursorRulesFile, "utf-8");
    if (!existing.includes(CURSOR_MARKER)) {
      const content = existing.endsWith("\n") ? existing : existing + "\n";
      writeFileSync(cursorRulesFile, content + CURSOR_BLOCK, "utf-8");
      createdCursorRules = true;
    }
  } else {
    writeFileSync(cursorRulesFile, CURSOR_BLOCK.trimStart(), "utf-8");
    createdCursorRules = true;
  }

  // 5. codex.md — instruction for OpenAI Codex
  const codexFile = join(gitRoot, "codex.md");
  const CODEX_MARKER = "<!-- overreach -->";
  const CODEX_BLOCK = `
${CODEX_MARKER}
## Scope audit (Overreach)

Before committing, audit your staged changes against the task prompt:

\`\`\`
git diff --staged | npx -y -p overreach overreach-cli --prompt "<the task you were given>"
\`\`\`

If \`scope_creep_score\` is HIGH, remove the unauthorized changes before committing.
Do not add dependencies, env vars, endpoints, or cron jobs the prompt did not ask for.
Multi-agent: call check_conflicts before starting work to avoid file collisions.
After committing: the pre-commit hook auto-logs your work to .overreach/ledger.json.
${CODEX_MARKER}
`;
  let createdCodex = false;
  if (existsSync(codexFile)) {
    const existing = readFileSync(codexFile, "utf-8");
    if (!existing.includes(CODEX_MARKER)) {
      const content = existing.endsWith("\n") ? existing : existing + "\n";
      writeFileSync(codexFile, content + CODEX_BLOCK, "utf-8");
      createdCodex = true;
    }
  } else {
    writeFileSync(codexFile, CODEX_BLOCK.trimStart(), "utf-8");
    createdCodex = true;
  }

  // 6. .overreach/config.json — agent-agnostic config that any vendor can read
  const configFile = join(overreachDir, "config.json");
  let createdConfig = false;
  if (!existsSync(configFile)) {
    writeFileSync(configFile, JSON.stringify({
      version: "1.0",
      coordination: {
        ledger: ".overreach/ledger.json",
        claims: ".overreach/claims.json",
        prompt: ".overreach/prompt.md",
      },
      rules: {
        claim_before_editing: true,
        check_conflicts_before_start: true,
        auto_log_to_ledger: true,
        default_claim_duration: "2h",
      },
    }, null, 2) + "\n", "utf-8");
    createdConfig = true;
  }

  // Summary
  console.log(c(ANSI.bold)("Overreach — project setup complete\n"));

  if (createdPrompt) {
    console.log(c(ANSI.green)("  ✓ Created .overreach/prompt.md"));
    console.log(c(ANSI.dim)("    Edit this file with the prompt you gave your AI agent.\n"));
  } else {
    console.log(c(ANSI.dim)("  · .overreach/prompt.md already exists\n"));
  }

  if (installedHook) {
    console.log(c(ANSI.green)("  ✓ Installed pre-commit hook → .git/hooks/pre-commit"));
    console.log(c(ANSI.dim)("    Every commit will be audited against your prompt."));
    console.log(c(ANSI.dim)("    HIGH scope creep → commit blocked. Skip with --no-verify.\n"));
  }

  if (createdClaudeMd) {
    console.log(c(ANSI.green)("  ✓ Added scope audit instruction to CLAUDE.md"));
    console.log(c(ANSI.dim)("    Claude Code / Claude agents will self-audit before committing.\n"));
  } else {
    console.log(c(ANSI.dim)("  · CLAUDE.md already has Overreach instruction\n"));
  }

  if (createdCursorRules) {
    console.log(c(ANSI.green)("  ✓ Added scope audit instruction to .cursorrules"));
    console.log(c(ANSI.dim)("    Cursor agents will self-audit before committing.\n"));
  } else {
    console.log(c(ANSI.dim)("  · .cursorrules already has Overreach instruction\n"));
  }

  if (createdCodex) {
    console.log(c(ANSI.green)("  ✓ Added scope audit instruction to codex.md"));
    console.log(c(ANSI.dim)("    OpenAI Codex agents will self-audit before committing.\n"));
  } else {
    console.log(c(ANSI.dim)("  · codex.md already has Overreach instruction\n"));
  }

  if (createdConfig) {
    console.log(c(ANSI.green)("  ✓ Created .overreach/config.json"));
    console.log(c(ANSI.dim)("    Cross-vendor coordination config (claims, ledger, rules).\n"));
  } else {
    console.log(c(ANSI.dim)("  · .overreach/config.json already exists\n"));
  }

  console.log(c(ANSI.bold)("Next steps:"));
  console.log(`  1. Edit ${c(ANSI.yellow)(".overreach/prompt.md")} with your actual prompt`);
  console.log(`  2. Stage your changes and commit — Overreach runs automatically`);
  console.log(`  3. Optional: set an API key for better scope extraction`);
  console.log(c(ANSI.dim)("     (ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_API_KEY)"));
  console.log(c(ANSI.dim)("     Without a key, deterministic mode extracts concrete items from your prompt.\n"));
  console.log(c(ANSI.bold)("Multi-agent:"));
  console.log(`  Agents should call ${c(ANSI.yellow)("check_conflicts")} before starting work`);
  console.log(`  and ${c(ANSI.yellow)("claim_files")} to prevent file collisions.`);
  console.log(c(ANSI.dim)("  Works across Claude Code, Cursor, Codex — any agent that reads MCP tools.\n"));
}

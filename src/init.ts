// overreach init — install a git pre-commit hook that audits staged changes.
//
// What it does:
//   1. Creates .overreach/prompt.md if it doesn't exist (the user fills in their
//      authorized scope; the hook reads it at commit time).
//   2. Writes .git/hooks/pre-commit (or appends to an existing one) that runs
//      `npx -y -p overreach overreach-cli` on `git diff --cached`.
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
  PROMPT=$(cat "$PROMPT_FILE")
  # Skip if the prompt file is still the template (no real prompt written)
  if echo "$PROMPT" | grep -q "^# Overreach"; then
    echo "[overreach] .overreach/prompt.md is still the template — skipping."
    echo "[overreach] Edit it with your actual prompt to enable the scope audit."
  else
    DIFF=$(git diff --cached)
    if [ -z "$DIFF" ]; then
      echo "[overreach] No staged changes — skipping scope audit."
    else
      echo "[overreach] Auditing staged changes against .overreach/prompt.md..."
      echo "$DIFF" | npx -y -p overreach overreach-cli --prompt "$PROMPT"
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

  // Summary
  console.log(c(ANSI.bold)("Overreach — pre-commit hook installed\n"));

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

  console.log(c(ANSI.bold)("Next steps:"));
  console.log(`  1. Edit ${c(ANSI.yellow)(".overreach/prompt.md")} with your actual prompt`);
  console.log(`  2. Stage your changes and commit — Overreach runs automatically`);
  console.log(`  3. Set an API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_API_KEY)`);
  console.log(c(ANSI.dim)("     Without a key, paranoid mode flags everything.\n"));
}

import type { SandboxProvider } from "@rakazo/adapter-kit";
import { COMPUTER_COMMAND_OUTPUT_MAX_CHARS } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { resolveBotWorkspaceCwd, resolveBotWorkspacePath } from "./computer-support.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { recordComputerAction, truncateShellOutput } from "./run-tools-computer.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

function runWorkspace(ctx: RunContext, call: ToolCall): RunWorkspace {
  return {
    botId: ctx.bot.id,
    computerMode: ctx.computer.mode,
    computer: () => ctx.computer.get("tool", call.name),
    markDirty: () => ctx.computer.checkpoint.markDirty(),
    context: ctx.context,
    runSecrets: ctx.secrets,
  };
}

/** A workspace-relative path argument, or an error when it escapes the workspace. */
function scopePath(raw: unknown): { path?: string } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string") return { error: "path must be a string" };
  const segments = raw.replace(/\\/g, "/").split("/");
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw) || segments.includes("..")) {
    return { error: "path must stay inside the workspace" };
  }
  return { path: raw };
}

/**
 * Run argv in the workspace and collect its output. Prefer this over shell strings: no user
 * input ever reaches a shell.
 */
export async function runSandboxCommand(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  argv: string[],
  cwdRel?: string,
  timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const computer = await workspace.computer();
  const cwd = resolveBotWorkspaceCwd(workspace.computerMode, workspace.botId, cwdRel);
  let stdout = "";
  let stderr = "";
  let code = 1;
  for await (const event of sandbox.execute(
    computer,
    { argv, cwd, timeoutMs },
    workspace.context,
  )) {
    if (event.type === "stdout") stdout += event.data;
    else if (event.type === "stderr") stderr += event.data;
    else code = event.code;
  }
  return { stdout, stderr, code };
}

async function readWorkspaceText(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  relPath: string,
): Promise<string | undefined> {
  try {
    const bytes = await sandbox.readFile(
      await workspace.computer(),
      resolveBotWorkspacePath(workspace.computerMode, workspace.botId, relPath),
      workspace.context,
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

async function listWorkspaceRootNames(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
): Promise<string[]> {
  try {
    const entries = await sandbox.listFiles(
      await workspace.computer(),
      resolveBotWorkspacePath(workspace.computerMode, workspace.botId, ""),
      workspace.context,
    );
    return entries.map((entry) => entry.path.split("/").pop() ?? entry.path);
  } catch {
    return [];
  }
}

/** Parse `git status --porcelain=v1 -b` output. */
export function parseGitStatusOutput(stdout: string): {
  branch: string;
  clean: boolean;
  files: { path: string; status: string }[];
  status: string;
} {
  let branch = "";
  const files: { path: string; status: string }[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const rest = line.slice(3);
      branch = rest.match(/^No commits yet on (.+)$/)?.[1] ?? rest.split("...")[0] ?? "";
      continue;
    }
    if (line.length < 4) continue;
    files.push({ path: line.slice(3), status: line.slice(0, 2).trim() });
  }
  return { branch, clean: files.length === 0, files, status: stdout };
}

export async function gitStatusFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const scoped = scopePath(args.path);
  if ("error" in scoped) return scoped;
  const result = await runSandboxCommand(
    sandbox,
    workspace,
    ["git", "status", "--porcelain=v1", "-b", ...(scoped.path ? ["--", scoped.path] : [])],
    scoped.path,
  );
  if (result.code !== 0) {
    return {
      error: redactSecrets(
        result.stderr.trim() || `git status failed with exit code ${result.code}`,
        workspace.runSecrets,
      ),
    };
  }
  return parseGitStatusOutput(redactSecrets(result.stdout, workspace.runSecrets));
}

/** Parse `git diff` output into its capped text and changed-file list. */
export function parseGitDiffOutput(raw: string): {
  diff: string;
  truncated: boolean;
  files: string[];
} {
  const files: string[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^diff --git a\/.+? b\/(.+)$/);
    const file = match?.[1];
    if (file) files.push(file);
  }
  return {
    diff: truncateShellOutput(raw),
    truncated: raw.length > COMPUTER_COMMAND_OUTPUT_MAX_CHARS,
    files,
  };
}

export async function gitDiffFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const scoped = scopePath(args.path);
  if ("error" in scoped) return scoped;
  const result = await runSandboxCommand(
    sandbox,
    workspace,
    [
      "git",
      "diff",
      ...(args.staged === true ? ["--cached"] : []),
      ...(scoped.path ? ["--", scoped.path] : []),
    ],
    scoped.path,
  );
  if (result.code !== 0) {
    return {
      error: redactSecrets(
        result.stderr.trim() || `git diff failed with exit code ${result.code}`,
        workspace.runSecrets,
      ),
    };
  }
  return parseGitDiffOutput(redactSecrets(result.stdout, workspace.runSecrets));
}

/** Detect the test runner for this workspace, preferring Node, then pytest, then Go. */
export async function detectTestRunner(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
): Promise<{ argv: string[] } | { error: string }> {
  const packageJson = await readWorkspaceText(sandbox, workspace, "package.json");
  if (packageJson !== undefined) {
    try {
      const parsed: unknown = JSON.parse(packageJson);
      const scripts = (parsed as { scripts?: Record<string, unknown> } | null)?.scripts;
      if (scripts?.test) {
        const lock = await readWorkspaceText(sandbox, workspace, "pnpm-lock.yaml");
        return { argv: lock !== undefined ? ["pnpm", "test"] : ["npm", "test"] };
      }
    } catch {
      // An unreadable package.json is not a test runner; keep probing.
    }
  }
  const pytestIni = await readWorkspaceText(sandbox, workspace, "pytest.ini");
  const pyproject = await readWorkspaceText(sandbox, workspace, "pyproject.toml");
  const names = await listWorkspaceRootNames(sandbox, workspace);
  const hasTestFiles = names.some(
    (name) => (name.startsWith("test_") && name.endsWith(".py")) || name.endsWith("_test.py"),
  );
  if (
    pytestIni !== undefined ||
    (pyproject !== undefined && /pytest/.test(pyproject)) ||
    hasTestFiles
  ) {
    return { argv: ["python", "-m", "pytest", "-q"] };
  }
  if ((await readWorkspaceText(sandbox, workspace, "go.mod")) !== undefined) {
    return { argv: ["go", "test", "./..."] };
  }
  return { error: "no test runner detected" };
}

/** Parse a finished test run into its failed lines and one-line summary. */
export function parseTestResults(
  stdout: string,
  stderr: string,
  code: number,
): { ok: boolean; failed: string[]; summary: string; output: string } {
  const combined = `${stdout}${stderr}`;
  const failed = combined
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return /^(FAIL|FAILED|✕|×)/.test(trimmed) || line.includes("FAIL ");
    })
    .slice(0, 50);
  const counts = combined.match(/(\d+)\s+failed\s*[,|]\s*(\d+)\s+passed/);
  const passedOnly = counts ? null : combined.match(/(\d+)\s+passed/);
  return {
    ok: code === 0,
    failed,
    summary: counts
      ? `${counts[1]} failed, ${counts[2]} passed`
      : passedOnly
        ? `0 failed, ${passedOnly[1]} passed`
        : `exit code ${code}`,
    output: truncateShellOutput(combined),
  };
}

export async function runTestsFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  _args: Record<string, unknown>,
) {
  const detected = await detectTestRunner(sandbox, workspace);
  if ("error" in detected) return detected;
  const result = await runSandboxCommand(sandbox, workspace, detected.argv, undefined, 300_000);
  return parseTestResults(
    redactSecrets(result.stdout, workspace.runSecrets),
    redactSecrets(result.stderr, workspace.runSecrets),
    result.code,
  );
}

/** A single parsed checker diagnostic. */
export type Diagnostic = {
  path: string;
  line: number;
  column: number;
  severity: string;
  message: string;
};

/** Parse checker output: eslint JSON, tsc `path(line,col): error TS…`, or `path:line:col:` lines. */
export function parseDiagnosticsOutput(
  stdout: string,
  stderr: string,
  code: number,
): { ok: boolean; diagnostics: Diagnostic[]; truncated: boolean; output: string } {
  const combined = `${stdout}${stderr}`;
  const diagnostics: Diagnostic[] = [];
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const file of parsed as {
          filePath: string;
          messages?: {
            line?: number;
            column?: number;
            severity?: number;
            message?: string;
          }[];
        }[]) {
          for (const message of file.messages ?? []) {
            diagnostics.push({
              path: file.filePath,
              line: message.line ?? 0,
              column: message.column ?? 0,
              severity:
                message.severity === 2 ? "error" : message.severity === 1 ? "warning" : "info",
              message: message.message ?? "",
            });
          }
        }
      }
    } catch {
      // Not eslint JSON after all; fall through to line parsing below.
    }
  }
  if (diagnostics.length === 0) {
    for (const line of combined.split("\n")) {
      const tsc = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(?:TS\d+:\s*)?(.*)$/);
      if (tsc) {
        const [, path = "", lineNo = "0", colNo = "0", severity = "error", message = ""] = tsc;
        diagnostics.push({
          path,
          line: Number(lineNo),
          column: Number(colNo),
          severity,
          message: message.trim(),
        });
        continue;
      }
      const colon = line.match(/^(.+?):(\d+):(\d+):\s*(?:(error|warning):\s*)?(.*)$/);
      if (colon) {
        const [, path = "", lineNo = "0", colNo = "0", severity, message = ""] = colon;
        diagnostics.push({
          path,
          line: Number(lineNo),
          column: Number(colNo),
          severity: severity ?? "error",
          message: message.trim(),
        });
      }
    }
  }
  const truncated = diagnostics.length > 100;
  return {
    ok: code === 0 && !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics: diagnostics.slice(0, 100),
    truncated,
    output: truncateShellOutput(combined),
  };
}

/** Detect the static checker for this workspace, preferring Go vet, then ruff, tsc, eslint. */
export async function detectChecker(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
): Promise<{ argv: string[] } | { error: string }> {
  if ((await readWorkspaceText(sandbox, workspace, "go.mod")) !== undefined) {
    return { argv: ["go", "vet", "./..."] };
  }
  const pyproject = await readWorkspaceText(sandbox, workspace, "pyproject.toml");
  const ruffToml = await readWorkspaceText(sandbox, workspace, "ruff.toml");
  const names = await listWorkspaceRootNames(sandbox, workspace);
  if (
    pyproject !== undefined ||
    ruffToml !== undefined ||
    names.some((name) => name.endsWith(".py"))
  ) {
    return { argv: ["ruff", "check", "."] };
  }
  const tsconfig = await readWorkspaceText(sandbox, workspace, "tsconfig.json");
  const packageJson = await readWorkspaceText(sandbox, workspace, "package.json");
  if (tsconfig !== undefined && packageJson !== undefined) {
    return { argv: ["npx", "tsc", "--noEmit"] };
  }
  if (
    names.some(
      (name) =>
        name === ".eslintrc" ||
        name.startsWith(".eslintrc.") ||
        name === "eslint.config.js" ||
        name === "eslint.config.mjs" ||
        name === "eslint.config.ts",
    )
  ) {
    return { argv: ["npx", "eslint", "--format", "json", "."] };
  }
  return { error: "no checker configured" };
}

export async function diagnosticsFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  _args: Record<string, unknown>,
) {
  const detected = await detectChecker(sandbox, workspace);
  if ("error" in detected) return detected;
  const result = await runSandboxCommand(sandbox, workspace, detected.argv, undefined, 300_000);
  return parseDiagnosticsOutput(
    redactSecrets(result.stdout, workspace.runSecrets),
    redactSecrets(result.stderr, workspace.runSecrets),
    result.code,
  );
}

async function gitCommit(ctx: RunContext, call: ToolCall) {
  const { deps } = ctx;
  const workspace = runWorkspace(ctx, call);
  const { args } = call;
  const fail = async (error: string) => {
    await recordComputerAction(ctx, call, "write_file", "git commit", { error });
    return call.finish({ error });
  };
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) return fail("message is required");
  const scoped = scopePath(args.path);
  if ("error" in scoped) return fail(scoped.error);
  workspace.markDirty();
  try {
    if (scoped.path) {
      const added = await runSandboxCommand(
        deps.sandbox,
        workspace,
        ["git", "add", "-A", "--", scoped.path],
        scoped.path,
      );
      if (added.code !== 0) {
        return fail(
          redactSecrets(
            added.stderr.trim() || `git add failed with exit code ${added.code}`,
            workspace.runSecrets,
          ),
        );
      }
    }
    const committed = await runSandboxCommand(
      deps.sandbox,
      workspace,
      ["git", "commit", "-m", message],
      scoped.path,
    );
    const output = `${committed.stdout}${committed.stderr}`;
    if (/nothing to commit/i.test(output)) return fail("nothing to commit");
    if (committed.code !== 0) {
      return fail(
        redactSecrets(
          output.trim() || `git commit failed with exit code ${committed.code}`,
          workspace.runSecrets,
        ),
      );
    }
    const summary = redactSecrets(output, workspace.runSecrets);
    await recordComputerAction(ctx, call, "write_file", "git commit", {
      bytes: new TextEncoder().encode(summary).byteLength,
    });
    return call.finish({ ok: true, message, output: truncateShellOutput(summary) });
  } catch (error) {
    await recordComputerAction(ctx, call, "write_file", "git commit", {
      error: error instanceof Error ? error.message : "could not commit",
    });
    throw error;
  }
}

/** Git feedback and test/diagnostic tools for the coding harness. */
export const feedbackTools: ToolHandlers = {
  async git_status(ctx, call) {
    return gitStatusFromTool(ctx.deps.sandbox, runWorkspace(ctx, call), call.args);
  },
  async git_diff(ctx, call) {
    return gitDiffFromTool(ctx.deps.sandbox, runWorkspace(ctx, call), call.args);
  },
  git_commit: gitCommit,
  async run_tests(ctx, call) {
    return runTestsFromTool(ctx.deps.sandbox, runWorkspace(ctx, call), call.args);
  },
  async diagnostics(ctx, call) {
    return diagnosticsFromTool(ctx.deps.sandbox, runWorkspace(ctx, call), call.args);
  },
};

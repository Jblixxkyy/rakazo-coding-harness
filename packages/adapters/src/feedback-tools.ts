import type { SandboxProvider } from "@rakazo/adapter-kit";
import { COMPUTER_COMMAND_OUTPUT_MAX_CHARS } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import {
  isolationRootForExecutionId,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
} from "./computer-support.js";
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
    isolationRoot: isolationRootForExecutionId(call.executionId),
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
  const cwd = resolveBotWorkspaceCwd(
    workspace.computerMode,
    workspace.botId,
    cwdRel,
    workspace.isolationRoot,
  );
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
      resolveBotWorkspacePath(
        workspace.computerMode,
        workspace.botId,
        relPath,
        workspace.isolationRoot,
      ),
      workspace.context,
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** A detected command, plus the project folder to run it in (root when absent). */
export type DetectedCommand = { argv: string[]; cwd?: string };

/** Directories never treated as a project folder, mirroring search-tools. */
const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  "coverage",
  ".venv",
  "__pycache__",
]);

/** Immediate subfolders scanned for a project; the workspace root is always first. */
const MAX_PROJECT_SUBDIRS = 20;
/** Subfolders peeked into for test/source files (test files live one level down). */
const PEEK_DIR_NAMES = new Set(["test", "tests", "src", "lib", "app"]);
/** Cap on files syntax-checked by the node --check fallback. */
const MAX_NODE_CHECK_FILES = 20;

const TEST_FILE_RE = /\.(?:test|spec)\.(?:js|ts|mjs|cjs|jsx|tsx)$/;
const JS_FILE_RE = /\.(?:js|mjs|cjs)$/;
const PY_TEST_FILE_RE = /^(test_.*\.py|.*_test\.py)$/;

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

type DirEntry = { name: string; kind: "file" | "dir" };

async function listWorkspaceEntries(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  relDir: string,
): Promise<DirEntry[]> {
  try {
    const entries = await sandbox.listFiles(
      await workspace.computer(),
      resolveBotWorkspacePath(
        workspace.computerMode,
        workspace.botId,
        relDir,
        workspace.isolationRoot,
      ),
      workspace.context,
    );
    return entries
      .map((entry) => ({
        name: entry.path.split("/").pop() ?? entry.path,
        kind: entry.kind,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * One project folder: the workspace root or an immediate subfolder (a bot
 * often scaffolds its project in a subfolder, e.g. `add-demo/`), with a peek
 * into its test/src/lib/app folders so test and source files one level down
 * are visible without an unbounded recursive walk.
 */
type ProjectDir = {
  rel: string;
  entries: DirEntry[];
  peeked: Map<string, DirEntry[]>;
};

async function discoverProjectDirs(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
): Promise<ProjectDir[]> {
  const rootEntries = await listWorkspaceEntries(sandbox, workspace, "");
  const dirs: ProjectDir[] = [{ rel: "", entries: rootEntries, peeked: new Map() }];
  const subdirs = rootEntries
    .filter((entry) => entry.kind === "dir" && !IGNORED_DIR_NAMES.has(entry.name))
    .slice(0, MAX_PROJECT_SUBDIRS);
  for (const sub of subdirs) {
    dirs.push({
      rel: sub.name,
      entries: await listWorkspaceEntries(sandbox, workspace, sub.name),
      peeked: new Map(),
    });
  }
  for (const dir of dirs) {
    for (const entry of dir.entries) {
      if (entry.kind !== "dir" || !PEEK_DIR_NAMES.has(entry.name)) continue;
      dir.peeked.set(
        entry.name,
        await listWorkspaceEntries(sandbox, workspace, joinRel(dir.rel, entry.name)),
      );
    }
  }
  return dirs;
}

function dirHasFile(dir: ProjectDir, name: string): boolean {
  return dir.entries.some((entry) => entry.kind === "file" && entry.name === name);
}

function dirHasEslintConfig(dir: ProjectDir): boolean {
  return dir.entries.some(
    (entry) =>
      entry.kind === "file" &&
      (entry.name === ".eslintrc" ||
        entry.name.startsWith(".eslintrc.") ||
        entry.name === "eslint.config.js" ||
        entry.name === "eslint.config.mjs" ||
        entry.name === "eslint.config.ts"),
  );
}

async function readProjectText(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  dir: ProjectDir,
  name: string,
): Promise<string | undefined> {
  return readWorkspaceText(sandbox, workspace, joinRel(dir.rel, name));
}

async function readProjectPackageJson(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  dir: ProjectDir,
): Promise<{ scripts?: Record<string, unknown> } | undefined> {
  const text = await readProjectText(sandbox, workspace, dir, "package.json");
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as { scripts?: Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/** The cwd to run a command in: absent for the workspace root. */
function projectCwd(dir: ProjectDir): { cwd?: string } {
  return dir.rel ? { cwd: dir.rel } : {};
}

function dirHasNodeTestFiles(dir: ProjectDir): boolean {
  const has = (entries: DirEntry[]) =>
    entries.some((entry) => entry.kind === "file" && TEST_FILE_RE.test(entry.name));
  if (has(dir.entries)) return true;
  for (const entries of dir.peeked.values()) if (has(entries)) return true;
  return false;
}

function dirHasPyTestFiles(dir: ProjectDir): boolean {
  const has = (entries: DirEntry[]) =>
    entries.some((entry) => entry.kind === "file" && PY_TEST_FILE_RE.test(entry.name));
  if (has(dir.entries)) return true;
  for (const entries of dir.peeked.values()) if (has(entries)) return true;
  return false;
}

function dirHasPyFiles(dir: ProjectDir): boolean {
  const has = (entries: DirEntry[]) =>
    entries.some((entry) => entry.kind === "file" && entry.name.endsWith(".py"));
  if (has(dir.entries)) return true;
  for (const entries of dir.peeked.values()) if (has(entries)) return true;
  return false;
}

/** Plain JS files in a project folder, relative to it (cwd-relative for --check). */
function dirJsFiles(dir: ProjectDir): string[] {
  const files: string[] = [];
  const add = (entries: DirEntry[], prefix: string) => {
    for (const entry of entries) {
      if (files.length >= MAX_NODE_CHECK_FILES) return;
      if (entry.kind === "file" && JS_FILE_RE.test(entry.name)) {
        files.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  };
  add(dir.entries, "");
  for (const [name, entries] of dir.peeked) {
    if (files.length >= MAX_NODE_CHECK_FILES) break;
    add(entries, name);
  }
  return files;
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
    [
      "git",
      "status",
      "--porcelain=v1",
      "-b",
      // An isolated helper runs with its folder as cwd; without a path the
      // status would cover the whole repo, so scope it to this folder.
      ...(scoped.path ? ["--", scoped.path] : workspace.isolationRoot ? ["--", "."] : []),
    ],
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
      // As with status: an isolated helper's diff covers only its folder.
      ...(scoped.path ? ["--", scoped.path] : workspace.isolationRoot ? ["--", "."] : []),
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

/**
 * Detect the test runner for this workspace, preferring Node, then pytest,
 * then Go. Projects live in the workspace root or an immediate subfolder
 * (e.g. a bot's `add-demo/`), so every candidate folder is probed in that
 * order; the command runs in the folder that owns the runner.
 */
export async function detectTestRunner(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
): Promise<DetectedCommand | { error: string }> {
  const dirs = await discoverProjectDirs(sandbox, workspace);
  for (const dir of dirs) {
    const pkg = await readProjectPackageJson(sandbox, workspace, dir);
    if (pkg?.scripts?.test) {
      const lock = await readProjectText(sandbox, workspace, dir, "pnpm-lock.yaml");
      return {
        argv: lock !== undefined ? ["pnpm", "test"] : ["npm", "test"],
        ...projectCwd(dir),
      };
    }
  }
  for (const dir of dirs) {
    const pytestIni = await readProjectText(sandbox, workspace, dir, "pytest.ini");
    const pyproject = await readProjectText(sandbox, workspace, dir, "pyproject.toml");
    if (
      pytestIni !== undefined ||
      (pyproject !== undefined && /pytest/.test(pyproject)) ||
      dirHasPyTestFiles(dir)
    ) {
      return { argv: ["python", "-m", "pytest", "-q"], ...projectCwd(dir) };
    }
  }
  for (const dir of dirs) {
    if (dirHasFile(dir, "go.mod")) {
      return { argv: ["go", "test", "./..."], ...projectCwd(dir) };
    }
  }
  // Plain Node project: test files but no package.json script — `node --test`
  // (Node 18+) discovers them from the project folder.
  for (const dir of dirs) {
    if (dirHasNodeTestFiles(dir)) {
      return { argv: ["node", "--test"], ...projectCwd(dir) };
    }
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
  const result = await runSandboxCommand(sandbox, workspace, detected.argv, detected.cwd, 300_000);
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
    // Cargo points at the failing span on the line after its `error:` header.
    let lastReport: { severity: string; message: string } | undefined;
    // `node --check` prints the offending file and line, then a few lines
    // later `SyntaxError: ...`; pair the two into one diagnostic.
    let pendingNodeCheck: { path: string; line: number; age: number } | undefined;
    for (const line of combined.split("\n")) {
      const syntaxError = line.match(/^SyntaxError:\s*(.+)$/);
      if (syntaxError && pendingNodeCheck) {
        diagnostics.push({
          path: pendingNodeCheck.path,
          line: pendingNodeCheck.line,
          column: 0,
          severity: "error",
          message: syntaxError[1]!.trim(),
        });
        pendingNodeCheck = undefined;
        continue;
      }
      if (pendingNodeCheck && ++pendingNodeCheck.age > 5) pendingNodeCheck = undefined;
      const nodeCheck = line.match(/^(.+\.(?:js|mjs|cjs)):(\d+)$/);
      if (nodeCheck) {
        pendingNodeCheck = { path: nodeCheck[1]!, line: Number(nodeCheck[2]), age: 0 };
        continue;
      }
      const header = line.match(/^(error|warning)(?:\[[A-Z]+\d+\])?:\s*(.+)$/);
      if (header) {
        lastReport = { severity: header[1]!, message: header[2]!.trim() };
      }
      const cargo = line.match(/^\s*-->\s+(.+?):(\d+):(\d+)\s*$/);
      if (cargo) {
        const [, path = "", lineNo = "0", colNo = "0"] = cargo;
        diagnostics.push({
          path,
          line: Number(lineNo),
          column: Number(colNo),
          severity: lastReport?.severity ?? "error",
          message: lastReport?.message ?? "build error",
        });
        continue;
      }
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

/**
 * Detect the static checker for this workspace, preferring Go vet, then
 * ruff, tsc, eslint — in the workspace root or an immediate subfolder.
 */
export async function detectChecker(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
): Promise<DetectedCommand | { error: string }> {
  const dirs = await discoverProjectDirs(sandbox, workspace);
  for (const dir of dirs) {
    if (dirHasFile(dir, "go.mod")) {
      return { argv: ["go", "vet", "./..."], ...projectCwd(dir) };
    }
  }
  for (const dir of dirs) {
    const pyproject = await readProjectText(sandbox, workspace, dir, "pyproject.toml");
    const ruffToml = await readProjectText(sandbox, workspace, dir, "ruff.toml");
    if (pyproject !== undefined || ruffToml !== undefined || dirHasPyFiles(dir)) {
      return { argv: ["ruff", "check", "."], ...projectCwd(dir) };
    }
  }
  for (const dir of dirs) {
    if (dirHasFile(dir, "tsconfig.json")) {
      return { argv: ["npx", "tsc", "--noEmit"], ...projectCwd(dir) };
    }
  }
  for (const dir of dirs) {
    if (dirHasEslintConfig(dir)) {
      return { argv: ["npx", "eslint", "--format", "json", "."], ...projectCwd(dir) };
    }
  }
  return { error: "no checker configured" };
}

export async function diagnosticsFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  _args: Record<string, unknown>,
) {
  const detected = await detectChecker(sandbox, workspace);
  if (!("error" in detected)) {
    const result = await runSandboxCommand(
      sandbox,
      workspace,
      detected.argv,
      detected.cwd,
      300_000,
    );
    return parseDiagnosticsOutput(
      redactSecrets(result.stdout, workspace.runSecrets),
      redactSecrets(result.stderr, workspace.runSecrets),
      result.code,
    );
  }
  // Fallback: a plain JS project with no configured checker still gets a
  // syntax check of its files, instead of "no checker configured".
  const dirs = await discoverProjectDirs(sandbox, workspace);
  for (const dir of dirs) {
    const files = dirJsFiles(dir);
    if (files.length === 0) continue;
    let stdout = "";
    let stderr = "";
    let code = 0;
    for (const file of files) {
      const result = await runSandboxCommand(
        sandbox,
        workspace,
        ["node", "--check", file],
        dir.rel || undefined,
        300_000,
      );
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.code !== 0) code = result.code;
    }
    return parseDiagnosticsOutput(
      redactSecrets(stdout, workspace.runSecrets),
      redactSecrets(stderr, workspace.runSecrets),
      code,
    );
  }
  return detected;
}

/**
 * Detect the build step for this workspace: package.json script, tsc, go,
 * cargo — in the workspace root or an immediate subfolder.
 */
export async function detectBuild(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
): Promise<DetectedCommand | { error: string }> {
  const dirs = await discoverProjectDirs(sandbox, workspace);
  for (const dir of dirs) {
    const pkg = await readProjectPackageJson(sandbox, workspace, dir);
    if (pkg?.scripts?.build) {
      const lock = await readProjectText(sandbox, workspace, dir, "pnpm-lock.yaml");
      return {
        argv: lock !== undefined ? ["pnpm", "build"] : ["npm", "run", "build"],
        ...projectCwd(dir),
      };
    }
  }
  for (const dir of dirs) {
    if (dirHasFile(dir, "tsconfig.json")) {
      return { argv: ["npx", "tsc", "--noEmit"], ...projectCwd(dir) };
    }
  }
  for (const dir of dirs) {
    if (dirHasFile(dir, "go.mod")) {
      return { argv: ["go", "build", "./..."], ...projectCwd(dir) };
    }
  }
  for (const dir of dirs) {
    if (dirHasFile(dir, "Cargo.toml")) {
      return { argv: ["cargo", "build"], ...projectCwd(dir) };
    }
  }
  return { error: "no build configured" };
}

/** Parse a finished build into structured failures and a one-line summary. */
export function parseBuildOutput(
  stdout: string,
  stderr: string,
  code: number,
): { ok: boolean; failed: Diagnostic[]; summary: string; output: string } {
  const parsed = parseDiagnosticsOutput(stdout, stderr, code);
  const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  return {
    ok: parsed.ok,
    failed: parsed.diagnostics,
    summary: parsed.ok
      ? "build succeeded"
      : errors > 0
        ? `${errors} error${errors === 1 ? "" : "s"}${parsed.truncated ? " (truncated)" : ""}`
        : `build failed with exit code ${code}`,
    output: parsed.output,
  };
}

export async function runBuildFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  _args: Record<string, unknown>,
) {
  const detected = await detectBuild(sandbox, workspace);
  if ("error" in detected) return detected;
  const result = await runSandboxCommand(sandbox, workspace, detected.argv, detected.cwd, 300_000);
  return parseBuildOutput(
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
  if (!scoped.path && workspace.isolationRoot) {
    // Without a path this would commit whatever is staged anywhere in the
    // repo; an isolated helper may only commit inside its own folder.
    return fail(`isolated helpers can only commit inside ${workspace.isolationRoot}/; pass path`);
  }
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
  async run_build(ctx, call) {
    return runBuildFromTool(ctx.deps.sandbox, runWorkspace(ctx, call), call.args);
  },
};

import path from "node:path";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import {
  isolationRootForExecutionId,
  normalizeWorkspacePath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
} from "./computer-support.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

const MAX_SEARCH_FILE_BYTES = 250_000;
const MAX_SCANNED_FILES = 2000;
const MAX_GREP_LIMIT = 500;
const MAX_GLOB_LIMIT = 1000;
const GITIGNORE_MAX_BYTES = 64_000;
const SHELL_PROBE_TIMEOUT_MS = 10_000;
const SHELL_COMMAND_TIMEOUT_MS = 120_000;

/** What the sandbox shell can do for search, probed once per computer. */
export type ShellSearchCapability = {
  /** Search binary available: ripgrep preferred, grep as fallback, none if no shell. */
  search: "rg" | "grep" | "none";
  /** Whether `find` is available (used for the glob fast path when rg is absent). */
  find: boolean;
};

const NO_SHELL: ShellSearchCapability = { search: "none", find: false };

/**
 * Probe script: prints the search tool on line 1, find availability on line 2,
 * and a sentinel on line 3. The output must match exactly — a provider whose
 * execute() only echoes the command back (like FakeSandbox) returns the
 * command text instead, which never matches, so it correctly reports no shell.
 * User input never reaches this shell: search commands are argv arrays.
 */
const SHELL_PROBE_SCRIPT = [
  "if command -v rg >/dev/null 2>&1; then echo rg;",
  "elif command -v grep >/dev/null 2>&1; then echo grep; else echo none; fi",
  "if command -v find >/dev/null 2>&1; then echo find; else echo nofind; fi",
  "echo PROBE_DONE",
].join("\n");

/** Probe results cached per sandbox provider + computer, so one run probes once. */
const shellCapabilityCache = new WeakMap<
  SandboxProvider,
  Map<string, Promise<ShellSearchCapability>>
>();

/**
 * Run argv in the workspace (under the search root when given) and collect its
 * output. Mirrors the feedback-tools runner; argv form means no user input
 * ever reaches a shell.
 */
export async function runShellCommand(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  argv: string[],
  cwdRel?: string,
  timeoutMs = SHELL_COMMAND_TIMEOUT_MS,
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

function parseShellProbe(stdout: string): ShellSearchCapability | undefined {
  const lines = stdout.split("\n");
  if (lines.length !== 4 || lines[2] !== "PROBE_DONE" || lines[3] !== "") return undefined;
  const search = lines[0];
  const find = lines[1];
  if (search !== "rg" && search !== "grep" && search !== "none") return undefined;
  if (find !== "find" && find !== "nofind") return undefined;
  return { search, find: find === "find" };
}

async function probeShellSearchCapability(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
): Promise<ShellSearchCapability> {
  try {
    const result = await runShellCommand(
      sandbox,
      workspace,
      ["sh", "-c", SHELL_PROBE_SCRIPT],
      undefined,
      SHELL_PROBE_TIMEOUT_MS,
    );
    if (result.code !== 0) return NO_SHELL;
    return parseShellProbe(result.stdout) ?? NO_SHELL;
  } catch {
    // No shell, or the probe itself failed: the walk fallback handles search.
    return NO_SHELL;
  }
}

/**
 * Detect the shell search capability for this computer, probing at most once
 * per (sandbox, computer). The cached promise is shared by concurrent callers,
 * and a failed probe caches as "none" — a search never fails for lack of a shell.
 */
export async function getShellSearchCapability(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
): Promise<ShellSearchCapability> {
  const computer = await workspace.computer();
  let byComputer = shellCapabilityCache.get(sandbox);
  if (!byComputer) {
    byComputer = new Map();
    shellCapabilityCache.set(sandbox, byComputer);
  }
  let cached = byComputer.get(computer.id);
  if (!cached) {
    cached = probeShellSearchCapability(sandbox, workspace);
    byComputer.set(computer.id, cached);
  }
  return cached;
}

/** Directories never searched, at any depth below the search root. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  "coverage",
  ".venv",
  "__pycache__",
]);

export const PATH_ESCAPES_WORKSPACE = "Path escapes the computer workspace";

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

/**
 * Validate a user-supplied workspace path. Absolute paths are rejected
 * (a leading `/` is a workspace-root escape hatch in resolveBotWorkspacePath,
 * not a relative path), as is any `..` segment. Returns the normalized
 * workspace-relative path, or throws an Error with PATH_ESCAPES_WORKSPACE.
 */
function checkedWorkspacePath(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  const portable = value.replace(/\\/g, "/");
  if (
    path.posix.isAbsolute(value) ||
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(value) ||
    path.win32.isAbsolute(portable)
  ) {
    throw new Error(PATH_ESCAPES_WORKSPACE);
  }
  const cleaned = portable.replace(/^(?:\.\/)+/, "");
  try {
    return normalizeWorkspacePath(cleaned);
  } catch {
    throw new Error(PATH_ESCAPES_WORKSPACE);
  }
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), max);
}

function escapeRegExpChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
}

/**
 * Convert a glob pattern to an anchored RegExp. Supports `**` (any number of
 * path segments, including none when followed by `/`), `*` (any run of
 * non-separator characters), `?` (one non-separator character) and
 * `[...]` character classes (`[!...]` negates).
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 3;
        } else {
          source += ".*";
          index += 2;
        }
      } else {
        source += "[^/]*";
        index += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
      index += 1;
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) {
        source += "\\[";
        index += 1;
      } else {
        let body = pattern.slice(index + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        source += `[${body.replace(/\\/g, "\\\\")}]`;
        index = close + 1;
      }
    } else {
      source += escapeRegExpChar(char);
      index += 1;
    }
  }
  return new RegExp(`${source}$`);
}

function basename(relPath: string): string {
  const parts = relPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Test a glob against a workspace-relative path. A pattern with no `/`
 * matches against the basename at any depth (`*.ts` finds `src/a.ts`); a
 * pattern with a `/` matches the full relative path (`src/*.ts`,
 * `**\/*.ts`).
 */
export function matchesGlob(pattern: string, relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = pattern.includes("/") ? normalized : basename(normalized);
  return globToRegExp(pattern).test(target);
}

/**
 * Parse .gitignore content into patterns. Blank lines and `#` comments are
 * ignored. A trailing `/` marks a directory-only pattern; a leading `/`
 * anchors the pattern to the workspace root. `!` negation lines are dropped:
 * negation is NOT supported, so a negated path stays ignored.
 */
export function parseGitignore(content: string): string[] {
  const patterns: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    patterns.push(trimmed);
  }
  return patterns;
}

/**
 * Whether a workspace-relative path is ignored by .gitignore patterns.
 * A pattern with no `/` matches the basename at any depth; a pattern with
 * a `/` (or a leading `/`) is anchored to the workspace root. Directory
 * patterns also ignore everything beneath the matched directory.
 */
export function isIgnoredPath(relPath: string, gitignorePatterns: string[]): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || gitignorePatterns.length === 0) return false;
  const parts = normalized.split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let depth = 1; depth < parts.length; depth += 1) {
    ancestors.push(parts.slice(0, depth).join("/"));
  }
  for (const rawPattern of gitignorePatterns) {
    let pattern = rawPattern.trim();
    if (!pattern) continue;
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith("/") || pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (!pattern) continue;
    const regex = globToRegExp(pattern);
    const targets = dirOnly
      ? [normalized, ...ancestors].map((target) => `${target}/`)
      : [normalized, ...ancestors];
    for (const target of targets) {
      const value = anchored ? target.replace(/\/$/, "") : basename(target);
      if (regex.test(value)) return true;
    }
  }
  return false;
}

async function loadGitignorePatterns(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
): Promise<string[]> {
  const { botId, computerMode, computer, context, isolationRoot } = workspace;
  try {
    const bytes = await sandbox.readFile(
      await computer(),
      resolveBotWorkspacePath(computerMode, botId, ".gitignore", isolationRoot),
      context,
      { maxBytes: GITIGNORE_MAX_BYTES },
    );
    return parseGitignore(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
}

function relativeToRoot(displayPath: string, rootRel: string): string {
  if (!rootRel) return displayPath;
  if (displayPath === rootRel) return "";
  return displayPath.startsWith(`${rootRel}/`)
    ? displayPath.slice(rootRel.length + 1)
    : displayPath;
}

/**
 * List every file under `rootRel` (workspace-relative, default ""), honouring
 * the ignored directories and the workspace-root .gitignore. Returns
 * workspace-relative paths, sorted. Throws when `rootRel` escapes the
 * workspace. The ignored-directory rule is applied relative to the search
 * root, so explicitly searching inside e.g. `node_modules` still works.
 */
export async function walkWorkspaceFiles(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  rootRel = "",
): Promise<string[]> {
  const root = checkedWorkspacePath(rootRel);
  const { botId, computerMode, computer, context, isolationRoot } = workspace;
  const computerRef = await computer();
  const gitignorePatterns = await loadGitignorePatterns(sandbox, workspace);
  const files: string[] = [];
  const stack: { stored: string; display: string }[] = [
    {
      stored: resolveBotWorkspacePath(computerMode, botId, root, isolationRoot),
      display: root,
    },
  ];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    const entries = await sandbox.listFiles(computerRef, dir.stored, context);
    for (const entry of entries) {
      const name = basename(entry.path);
      if (!name) continue;
      const display = dir.display ? `${dir.display}/${name}` : name;
      const belowRoot = relativeToRoot(display, root);
      if (belowRoot.split("/").some((segment) => IGNORED_DIRS.has(segment))) continue;
      if (isIgnoredPath(display, gitignorePatterns)) continue;
      if (entry.kind === "dir") {
        stack.push({ stored: entry.path, display });
      } else {
        files.push(display);
      }
    }
  }
  return files.sort();
}

async function readSearchableFile(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  displayPath: string,
): Promise<string | undefined> {
  const { botId, computerMode, computer, context, isolationRoot } = workspace;
  let bytes: Uint8Array;
  try {
    bytes = await sandbox.readFile(
      await computer(),
      resolveBotWorkspacePath(computerMode, botId, displayPath, isolationRoot),
      context,
      { maxBytes: MAX_SEARCH_FILE_BYTES },
    );
  } catch {
    // Missing, unreadable, or over the size cap: not searchable, skip it.
    return undefined;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return undefined;
    return text;
  } catch {
    // Binary / non-UTF-8: not searchable, skip it.
    return undefined;
  }
}

/**
 * Translate ignore rules into shell-tool pruning flags. These are only
 * pruning: every fast-path result is post-filtered in JS against IGNORED_DIRS
 * and the .gitignore patterns, so a flag-dialect difference can only cost
 * speed, never correctness. Anchored or slashed .gitignore patterns are left
 * entirely to the post-filter — rg/grep cannot express anchoring the same way,
 * and an over-eager flag would prune files the walk would return.
 */
function shellIgnoreArgs(gitignorePatterns: string[]): {
  rgGlobs: string[];
  grepExcludeDirs: string[];
  grepExcludes: string[];
} {
  const rgGlobs: string[] = [];
  const grepExcludeDirs: string[] = [];
  const grepExcludes: string[] = [];
  for (const dir of IGNORED_DIRS) {
    rgGlobs.push(`!${dir}/**`, `!**/${dir}/**`);
    grepExcludeDirs.push(dir);
  }
  for (const rawPattern of gitignorePatterns) {
    let pattern = rawPattern.trim();
    if (!pattern) continue;
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    if (!pattern) continue;
    // Anchored (leading `/` or containing `/`): post-filter only.
    if (pattern.startsWith("/") || pattern.includes("/")) continue;
    if (dirOnly) {
      rgGlobs.push(`!**/${pattern}/**`);
      grepExcludeDirs.push(pattern);
    } else {
      rgGlobs.push(`!**/${pattern}`, `!**/${pattern}/**`);
      grepExcludes.push(pattern);
      grepExcludeDirs.push(pattern);
    }
  }
  return { rgGlobs, grepExcludeDirs, grepExcludes };
}

/**
 * Authoritative ignore check for a fast-path result, identical to the walk:
 * ignored-directory segments are judged below the search root (so explicitly
 * searching inside e.g. `node_modules` still works), and .gitignore applies to
 * the full workspace-relative path.
 */
function isSearchablePath(displayPath: string, root: string, gitignorePatterns: string[]): boolean {
  const belowRoot = relativeToRoot(displayPath, root);
  if (belowRoot.split("/").some((segment) => IGNORED_DIRS.has(segment))) return false;
  return !isIgnoredPath(displayPath, gitignorePatterns);
}

/** Parse one `path:line:text` output line (rg/grep), stripping a leading `./`. */
function parseSearchOutputLine(
  line: string,
): { path: string; line: number; text: string } | undefined {
  if (!line || line.includes("\0")) return undefined;
  const rel = line.startsWith("./") ? line.slice(2) : line;
  const firstColon = rel.indexOf(":");
  if (firstColon === -1) return undefined;
  const lineMatch = /^(\d+):([\s\S]*)$/.exec(rel.slice(firstColon + 1));
  if (!lineMatch) return undefined;
  return { path: rel.slice(0, firstColon), line: Number(lineMatch[1]), text: lineMatch[2] ?? "" };
}

/**
 * Grep via the sandbox shell (rg preferred, grep fallback). Returns undefined
 * when there is no shell or the fast path fails for any reason, so the caller
 * falls back to the listFiles walk. rg exit 1 and grep exit 1 mean "no
 * matches"; any other non-zero exit (e.g. an rg regex the Rust engine rejects
 * while the JS engine accepts) falls back instead of failing the search.
 * rg honours the 250 KB file cap via --max-filesize; grep streams files
 * without buffering them, so the cap does not apply there. Neither fast path
 * applies the walk's 2000-file scan cap: it returns up to `limit` matches
 * regardless of repo size, and `truncated` only reflects the match limit.
 */
async function grepViaShell(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  root: string,
  pattern: string,
  caseSensitive: boolean,
  include: string | undefined,
  limit: number,
): Promise<{ matches: GrepMatch[]; truncated: boolean } | undefined> {
  let capability: ShellSearchCapability;
  let gitignorePatterns: string[];
  let result: { stdout: string; stderr: string; code: number };
  try {
    capability = await getShellSearchCapability(sandbox, workspace);
    if (capability.search === "none") return undefined;
    gitignorePatterns = await loadGitignorePatterns(sandbox, workspace);
    const { rgGlobs, grepExcludeDirs, grepExcludes } = shellIgnoreArgs(gitignorePatterns);
    const argv =
      capability.search === "rg"
        ? [
            "rg",
            "--no-heading",
            "--line-number",
            "--color=never",
            "--hidden",
            "--no-ignore",
            "--no-ignore-vcs",
            "--no-config",
            "--with-filename",
            "--max-count",
            String(limit + 1),
            "--max-filesize",
            String(MAX_SEARCH_FILE_BYTES),
            ...(caseSensitive ? [] : ["-i"]),
            ...rgGlobs.flatMap((glob) => ["--glob", glob]),
            ...(include ? ["--glob", include] : []),
            "-e",
            pattern,
            ".",
          ]
        : [
            "grep",
            "-rn",
            "-I",
            "--color=never",
            "-m",
            String(limit + 1),
            ...(caseSensitive ? [] : ["-i"]),
            ...grepExcludeDirs.map((dir) => `--exclude-dir=${dir}`),
            ...grepExcludes.map((exclude) => `--exclude=${exclude}`),
            ...(include ? [`--include=${include}`] : []),
            "-e",
            pattern,
            ".",
          ];
    result = await runShellCommand(sandbox, workspace, argv, root, SHELL_COMMAND_TIMEOUT_MS);
  } catch {
    return undefined;
  }
  if (result.code !== 0 && result.code !== 1) return undefined;
  const matches: GrepMatch[] = [];
  for (const line of result.stdout.split("\n")) {
    const parsed = parseSearchOutputLine(line);
    if (!parsed) continue;
    const display = root ? `${root}/${parsed.path}` : parsed.path;
    if (!isSearchablePath(display, root, gitignorePatterns)) continue;
    if (include && !matchesGlob(include, relativeToRoot(display, root))) continue;
    matches.push({
      path: display,
      line: parsed.line,
      text: redactSecrets(parsed.text.replace(/\r$/, ""), workspace.runSecrets),
    });
  }
  // rg/grep traversal order is not guaranteed; sort like the walk does.
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return { matches: matches.slice(0, limit), truncated: matches.length > limit };
}

/**
 * Glob via the sandbox shell: `rg --files` when rg is available, else `find`
 * when it is. Returns undefined when there is no shell, when neither listing
 * tool is available, or when the fast path fails — the caller falls back to
 * the listFiles walk. Matching itself stays in JS (matchesGlob), so glob
 * semantics are identical on both paths.
 */
async function globViaShell(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  root: string,
  pattern: string,
  limit: number,
): Promise<{ paths: string[]; truncated: boolean } | undefined> {
  let capability: ShellSearchCapability;
  let gitignorePatterns: string[];
  let result: { stdout: string; stderr: string; code: number };
  try {
    capability = await getShellSearchCapability(sandbox, workspace);
    if (capability.search === "none" && !capability.find) return undefined;
    gitignorePatterns = await loadGitignorePatterns(sandbox, workspace);
    let argv: string[] | undefined;
    if (capability.search === "rg") {
      const { rgGlobs } = shellIgnoreArgs(gitignorePatterns);
      argv = [
        "rg",
        "--files",
        "--hidden",
        "--no-ignore",
        "--no-ignore-vcs",
        "--no-config",
        ...rgGlobs.flatMap((glob) => ["--glob", glob]),
        ".",
      ];
    } else if (capability.find) {
      // find has no .gitignore support; ignored dirs are pruned here and
      // .gitignore is enforced by the JS post-filter below.
      argv = [
        "find",
        ".",
        ...[...IGNORED_DIRS].flatMap((dir) => ["-type", "d", "-name", dir, "-prune", "-o"]),
        "-type",
        "f",
        "-print",
      ];
    } else {
      return undefined;
    }
    result = await runShellCommand(sandbox, workspace, argv, root, SHELL_COMMAND_TIMEOUT_MS);
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;
  const paths: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const rel = line.startsWith("./") ? line.slice(2) : line;
    if (!rel) continue;
    const display = root ? `${root}/${rel}` : rel;
    if (!isSearchablePath(display, root, gitignorePatterns)) continue;
    if (!matchesGlob(pattern, relativeToRoot(display, root))) continue;
    paths.push(display);
  }
  paths.sort();
  return { paths: paths.slice(0, limit), truncated: paths.length > limit };
}

export type GrepMatch = { path: string; line: number; text: string };

export async function grepFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const pattern = args.pattern;
  if (typeof pattern !== "string" || !pattern) {
    return { error: "pattern is required" };
  }
  let root: string;
  try {
    root = checkedWorkspacePath(args.path ?? "");
  } catch {
    return { error: PATH_ESCAPES_WORKSPACE };
  }
  const limit = parseLimit(args.limit, 100, MAX_GREP_LIMIT);
  const caseSensitive = args.caseSensitive !== false;
  const include = typeof args.include === "string" && args.include ? args.include : undefined;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? "" : "i");
  } catch (error) {
    return { error: `invalid regex: ${error instanceof Error ? error.message : String(error)}` };
  }
  const fast = await grepViaShell(sandbox, workspace, root, pattern, caseSensitive, include, limit);
  // Return a fresh object literal (not `fast` itself): TypeScript only
  // normalises the inferred return union when every return is a literal,
  // and the existing tests read `.matches` / `.error` off that union.
  if (fast) return { matches: fast.matches, truncated: fast.truncated };
  const allFiles = await walkWorkspaceFiles(sandbox, workspace, root);
  const truncatedByScan = allFiles.length > MAX_SCANNED_FILES;
  const files = truncatedByScan ? allFiles.slice(0, MAX_SCANNED_FILES) : allFiles;
  const matches: GrepMatch[] = [];
  let truncated = truncatedByScan;
  outer: for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    if (file === undefined) continue;
    if (include && !matchesGlob(include, relativeToRoot(file, root))) continue;
    const text = await readSearchableFile(sandbox, workspace, file);
    if (text === undefined) continue;
    const lines = text.split("\n");
    // A trailing newline ends the last line; it does not start an empty one.
    if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) {
      lines.pop();
    }
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const rawLine = lines[lineIndex];
      if (rawLine === undefined) continue;
      const line = rawLine.replace(/\r$/, "");
      if (!regex.test(line)) continue;
      matches.push({
        path: file,
        line: lineIndex + 1,
        text: redactSecrets(line, workspace.runSecrets),
      });
      if (matches.length >= limit) {
        // More matches may exist later in this file or in later files.
        if (lineIndex < lines.length - 1 || fileIndex < files.length - 1) truncated = true;
        break outer;
      }
    }
  }
  return { matches, truncated };
}

export async function globFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const pattern = args.pattern;
  if (typeof pattern !== "string" || !pattern) {
    return { error: "pattern is required" };
  }
  let root: string;
  try {
    root = checkedWorkspacePath(args.path ?? "");
  } catch {
    return { error: PATH_ESCAPES_WORKSPACE };
  }
  const limit = parseLimit(args.limit, 200, MAX_GLOB_LIMIT);
  const fast = await globViaShell(sandbox, workspace, root, pattern, limit);
  // Fresh object literal, as above: keeps the inferred return union normalised.
  if (fast) return { paths: fast.paths, truncated: fast.truncated };
  const allFiles = await walkWorkspaceFiles(sandbox, workspace, root);
  const matched = allFiles.filter((file) => matchesGlob(pattern, relativeToRoot(file, root)));
  return { paths: matched.slice(0, limit), truncated: matched.length > limit };
}

/** Read-only search over the bot's workspace files. */
export const searchTools: ToolHandlers = {
  async grep(ctx, call) {
    const workspace = runWorkspace(ctx, call);
    return grepFromTool(ctx.deps.sandbox, workspace, call.args);
  },
  async glob(ctx, call) {
    const workspace = runWorkspace(ctx, call);
    return globFromTool(ctx.deps.sandbox, workspace, call.args);
  },
};

import path from "node:path";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { normalizeWorkspacePath, resolveBotWorkspacePath } from "./computer-support.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

const MAX_SEARCH_FILE_BYTES = 250_000;
const MAX_SCANNED_FILES = 2000;
const MAX_GREP_LIMIT = 500;
const MAX_GLOB_LIMIT = 1000;
const GITIGNORE_MAX_BYTES = 64_000;

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
  const { botId, computerMode, computer, context } = workspace;
  try {
    const bytes = await sandbox.readFile(
      await computer(),
      resolveBotWorkspacePath(computerMode, botId, ".gitignore"),
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
  const { botId, computerMode, computer, context } = workspace;
  const computerRef = await computer();
  const gitignorePatterns = await loadGitignorePatterns(sandbox, workspace);
  const files: string[] = [];
  const stack: { stored: string; display: string }[] = [
    { stored: resolveBotWorkspacePath(computerMode, botId, root), display: root },
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
  const { botId, computerMode, computer, context } = workspace;
  let bytes: Uint8Array;
  try {
    bytes = await sandbox.readFile(
      await computer(),
      resolveBotWorkspacePath(computerMode, botId, displayPath),
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

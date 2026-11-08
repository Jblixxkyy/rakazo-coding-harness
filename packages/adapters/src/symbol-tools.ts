import path from "node:path";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import {
  isolationRootForExecutionId,
  normalizeWorkspacePath,
  resolveBotWorkspacePath,
} from "./computer-support.js";
import type { RunContext } from "./run-context.js";
import type { ToolHandlers } from "./run-tool-gate.js";
import { matchesGlob, walkWorkspaceFiles } from "./search-tools.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

const MAX_SEARCH_FILE_BYTES = 250_000;
const MAX_SCANNED_FILES = 2000;
const MAX_SYMBOL_LIMIT = 500;

export const PATH_ESCAPES_WORKSPACE = "Path escapes the computer workspace";

function runWorkspace(ctx: RunContext, call: { name: string; executionId: string }): RunWorkspace {
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
 * Validate a user-supplied workspace path. Absolute paths are rejected, as is
 * any `..` segment. Returns the normalized workspace-relative path, or throws
 * an Error with PATH_ESCAPES_WORKSPACE.
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A symbol name is a plain identifier in every language covered here. */
export function isValidSymbolName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z_$][\w$]*$/.test(name);
}

type DefinitionPattern = { regex: RegExp; kind: string };

function tsPatterns(name: string): DefinitionPattern[] {
  const n = escapeRegExp(name);
  return [
    {
      regex: new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:async\\s+)?function\\s+${n}\\s*\\(`),
      kind: "function",
    },
    { regex: new RegExp(`^\\s*(?:async\\s+)?function\\s+${n}\\s*\\(`), kind: "function" },
    {
      regex: new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`),
      kind: "class",
    },
    { regex: new RegExp(`^\\s*(?:abstract\\s+)?class\\s+${n}\\b`), kind: "class" },
    { regex: new RegExp(`^\\s*export\\s+(?:default\\s+)?interface\\s+${n}\\b`), kind: "interface" },
    { regex: new RegExp(`^\\s*interface\\s+${n}\\b`), kind: "interface" },
    { regex: new RegExp(`^\\s*export\\s+(?:default\\s+)?type\\s+${n}\\b`), kind: "type" },
    { regex: new RegExp(`^\\s*type\\s+${n}\\b`), kind: "type" },
    { regex: new RegExp(`^\\s*export\\s+(?:default\\s+)?enum\\s+${n}\\b`), kind: "enum" },
    { regex: new RegExp(`^\\s*enum\\s+${n}\\b`), kind: "enum" },
    {
      regex: new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:const|let|var)\\s+${n}\\b`),
      kind: "const",
    },
    { regex: new RegExp(`^\\s*(?:const|let|var)\\s+${n}\\b`), kind: "const" },
    // Class/object method with an explicit modifier, e.g. `private load() {`.
    // A bare `name() {` is not a definition: it is usually a call.
    {
      regex: new RegExp(
        `^\\s*(?:(?:public|private|protected|static|async|readonly|get|set)\\s+)+${n}\\s*\\(`,
      ),
      kind: "method",
    },
    // `name = function (...)` / `name = async (...) =>` (no declaration keyword).
    {
      regex: new RegExp(`^\\s*${n}\\s*=\\s*(?:async\\s+)?(?:function\\s*\\(|\\([^)]*\\)\\s*=>)`),
      kind: "function",
    },
  ];
}

function pyPatterns(name: string): DefinitionPattern[] {
  const n = escapeRegExp(name);
  return [
    { regex: new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}\\s*\\(`), kind: "function" },
    { regex: new RegExp(`^\\s*class\\s+${n}\\b`), kind: "class" },
    { regex: new RegExp(`^\\s*${n}\\s*=(?!=)`), kind: "variable" },
    { regex: new RegExp(`^\\s*${n}\\s*:(?!=)`), kind: "variable" },
  ];
}

function goPatterns(name: string): DefinitionPattern[] {
  const n = escapeRegExp(name);
  return [
    { regex: new RegExp(`^\\s*func\\s+${n}\\s*\\(`), kind: "function" },
    { regex: new RegExp(`^\\s*func\\s*\\([^)]*\\)\\s*${n}\\s*\\(`), kind: "method" },
    { regex: new RegExp(`^\\s*type\\s+${n}\\b`), kind: "type" },
    { regex: new RegExp(`^\\s*(?:var|const)\\s+${n}\\b`), kind: "const" },
  ];
}

function rustPatterns(name: string): DefinitionPattern[] {
  const n = escapeRegExp(name);
  const vis = String.raw`(?:pub\s*(?:\([^)]*\))?\s*)?`;
  return [
    { regex: new RegExp(`^\\s*${vis}fn\\s+${n}\\s*\\(`), kind: "function" },
    { regex: new RegExp(`^\\s*${vis}struct\\s+${n}\\b`), kind: "struct" },
    { regex: new RegExp(`^\\s*${vis}enum\\s+${n}\\b`), kind: "enum" },
    { regex: new RegExp(`^\\s*${vis}trait\\s+${n}\\b`), kind: "trait" },
    { regex: new RegExp(`^\\s*${vis}type\\s+${n}\\b`), kind: "type" },
    { regex: new RegExp(`^\\s*${vis}const\\s+${n}\\b`), kind: "const" },
    { regex: new RegExp(`^\\s*${vis}static\\s+(?:mut\\s+)?${n}\\b`), kind: "const" },
  ];
}

/** Keyword-only fallback for languages without a dedicated pattern set. */
function genericPatterns(name: string): DefinitionPattern[] {
  const n = escapeRegExp(name);
  return [
    { regex: new RegExp(`^\\s*(?:function|func|fn|def)\\s+${n}\\b`), kind: "function" },
    { regex: new RegExp(`^\\s*class\\s+${n}\\b`), kind: "class" },
    { regex: new RegExp(`^\\s*${n}\\s*=\\s*function\\b`), kind: "function" },
  ];
}

function patternsFor(relPath: string, name: string): DefinitionPattern[] {
  if (/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(relPath)) return tsPatterns(name);
  if (relPath.endsWith(".py")) return pyPatterns(name);
  if (relPath.endsWith(".go")) return goPatterns(name);
  if (relPath.endsWith(".rs")) return rustPatterns(name);
  return genericPatterns(name);
}

/** Kind of the definition on this line for `name`, or undefined when it is not one. */
export function definitionKindForLine(
  relPath: string,
  line: string,
  name: string,
): string | undefined {
  for (const { regex, kind } of patternsFor(relPath, name)) {
    if (regex.test(line)) return kind;
  }
  return undefined;
}

/** Word-boundary match for a symbol name, treating `_` and `$` as word characters. */
function referenceRegex(name: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
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

function relativeToRoot(displayPath: string, rootRel: string): string {
  if (!rootRel) return displayPath;
  if (displayPath === rootRel) return "";
  return displayPath.startsWith(`${rootRel}/`)
    ? displayPath.slice(rootRel.length + 1)
    : displayPath;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

export type SymbolLocation = { path: string; line: number; text: string };
export type DefinitionLocation = SymbolLocation & { kind: string };

async function scanFiles(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
): Promise<{ files: string[]; root: string; truncatedByScan: boolean } | { error: string }> {
  let root: string;
  try {
    root = checkedWorkspacePath(args.path ?? "");
  } catch {
    return { error: PATH_ESCAPES_WORKSPACE };
  }
  const allFiles = await walkWorkspaceFiles(sandbox, workspace, root);
  const truncatedByScan = allFiles.length > MAX_SCANNED_FILES;
  return {
    files: truncatedByScan ? allFiles.slice(0, MAX_SCANNED_FILES) : allFiles,
    root,
    truncatedByScan,
  };
}

/**
 * Find where a symbol is defined. Only lines matching a language-aware
 * definition pattern count: a file that merely mentions the name (a call, a
 * comment) yields no definition. Returns `{ definitions, truncated }`, or
 * `{ error }` for a missing/invalid name or an escaping path. An unknown
 * symbol is an empty list, not an error.
 */
export async function findDefinitionFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const name = args.name;
  if (!isValidSymbolName(name)) {
    return { error: "name is required and must be a valid identifier" };
  }
  const limit = parseLimit(args.limit, 100, MAX_SYMBOL_LIMIT);
  const include = typeof args.include === "string" && args.include ? args.include : undefined;
  const scanned = await scanFiles(sandbox, workspace, args);
  if ("error" in scanned) return scanned;
  const { files, root, truncatedByScan } = scanned;
  const definitions: DefinitionLocation[] = [];
  let truncated = truncatedByScan;
  outer: for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    if (file === undefined) continue;
    if (include && !matchesGlob(include, relativeToRoot(file, root))) continue;
    const text = await readSearchableFile(sandbox, workspace, file);
    if (text === undefined) continue;
    const lines = splitLines(text);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const rawLine = lines[lineIndex];
      if (rawLine === undefined) continue;
      const line = rawLine.replace(/\r$/, "");
      const kind = definitionKindForLine(file, line, name);
      if (kind === undefined) continue;
      definitions.push({
        path: file,
        line: lineIndex + 1,
        text: redactSecrets(line.trim(), workspace.runSecrets),
        kind,
      });
      if (definitions.length >= limit) {
        // More definitions may exist later in this file or in later files.
        if (lineIndex < lines.length - 1 || fileIndex < files.length - 1) truncated = true;
        break outer;
      }
    }
  }
  return { definitions, truncated };
}

/**
 * Find every use of a symbol. Lines that define the symbol (as recognised by
 * find_definition) are excluded, so the result is usages, not the definition
 * itself. Returns `{ references, truncated }`, or `{ error }` for a
 * missing/invalid name or an escaping path.
 */
export async function findReferencesFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const name = args.name;
  if (!isValidSymbolName(name)) {
    return { error: "name is required and must be a valid identifier" };
  }
  const limit = parseLimit(args.limit, 100, MAX_SYMBOL_LIMIT);
  const include = typeof args.include === "string" && args.include ? args.include : undefined;
  const scanned = await scanFiles(sandbox, workspace, args);
  if ("error" in scanned) return scanned;
  const { files, root, truncatedByScan } = scanned;
  const pattern = referenceRegex(name);
  const references: SymbolLocation[] = [];
  let truncated = truncatedByScan;
  outer: for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    if (file === undefined) continue;
    if (include && !matchesGlob(include, relativeToRoot(file, root))) continue;
    const text = await readSearchableFile(sandbox, workspace, file);
    if (text === undefined) continue;
    const lines = splitLines(text);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const rawLine = lines[lineIndex];
      if (rawLine === undefined) continue;
      const line = rawLine.replace(/\r$/, "");
      if (!pattern.test(line)) continue;
      // The definition line is not a usage.
      if (definitionKindForLine(file, line, name) !== undefined) continue;
      references.push({
        path: file,
        line: lineIndex + 1,
        text: redactSecrets(line.trim(), workspace.runSecrets),
      });
      if (references.length >= limit) {
        if (lineIndex < lines.length - 1 || fileIndex < files.length - 1) truncated = true;
        break outer;
      }
    }
  }
  return { references, truncated };
}

/** Read-only symbol navigation over the bot's workspace files. */
export const symbolTools: ToolHandlers = {
  async find_definition(ctx, call) {
    const workspace = runWorkspace(ctx, call);
    return findDefinitionFromTool(ctx.deps.sandbox, workspace, call.args);
  },
  async find_references(ctx, call) {
    const workspace = runWorkspace(ctx, call);
    return findReferencesFromTool(ctx.deps.sandbox, workspace, call.args);
  },
};

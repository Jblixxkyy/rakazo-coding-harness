import type { SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { resolveBotWorkspacePath } from "./computer-support.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { recordComputerAction } from "./run-tools-computer.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

const MAX_MODEL_FILE_BYTES = 250_000;

export type EditResult =
  | { ok: true; path: string; replacements: number; bytes: number }
  | { error: string; path: string };

export type PatchFileResult = {
  path: string;
  action: "add" | "update" | "delete";
  bytes: number;
};

export type PatchResult =
  | { ok: true; results: PatchFileResult[] }
  | { error: string; path?: string; results: PatchFileResult[] };

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

/** Absolute paths and ".." segments never resolve inside the bot workspace. */
function isEscapingPath(value: string): boolean {
  if (!value) return true;
  const portable = value.replace(/\\/g, "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) return true;
  return portable.split("/").some((segment) => segment === "..");
}

function resolveWorkspacePath(
  workspace: RunWorkspace,
  filePath: string,
): { storedPath: string } | { error: string; path: string } {
  if (isEscapingPath(filePath)) {
    return { error: "Path escapes the computer workspace", path: filePath };
  }
  try {
    return {
      storedPath: resolveBotWorkspacePath(workspace.computerMode, workspace.botId, filePath),
    };
  } catch {
    return { error: "Path escapes the computer workspace", path: filePath };
  }
}

async function readWorkspaceText(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  filePath: string,
  storedPath: string,
): Promise<{ content: string } | { error: string; path: string }> {
  let bytes: Uint8Array;
  try {
    bytes = await sandbox.readFile(await workspace.computer(), storedPath, workspace.context, {
      maxBytes: MAX_MODEL_FILE_BYTES,
    });
  } catch (error) {
    if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
      return { error: "file is too large for model context", path: filePath };
    }
    if (error instanceof Error && /not found/.test(error.message)) {
      return { error: "file not found", path: filePath };
    }
    return {
      error: redactSecrets(
        error instanceof Error ? error.message : "could not read file",
        workspace.runSecrets,
      ),
      path: filePath,
    };
  }
  if (bytes.byteLength > MAX_MODEL_FILE_BYTES) {
    return { error: "file is too large for model context", path: filePath };
  }
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { error: "file is not UTF-8 text; use open_path to inspect it", path: filePath };
  }
}

async function writeWorkspaceText(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  storedPath: string,
  content: string,
): Promise<number> {
  const bytes = new TextEncoder().encode(content);
  workspace.markDirty();
  await sandbox.writeFile(
    await workspace.computer(),
    { path: storedPath, content: bytes },
    workspace.context,
  );
  return bytes.byteLength;
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = content.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace one exact occurrence of oldString with newString, or every occurrence
 * when replaceAll is set. With no exact match, one whitespace-tolerant match
 * (every whitespace run in oldString treated as \s+) is accepted, but only
 * when it is the single such match in the whole file. Throws on failure;
 * callers must not write the file in that case.
 */
export function applyEditToContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { content: string; replacements: number } {
  if (!oldString) throw new Error("oldString must not be empty");
  const exactCount = countOccurrences(content, oldString);
  if (replaceAll) {
    if (exactCount === 0) throw new Error("oldString not found");
    return { content: content.split(oldString).join(newString), replacements: exactCount };
  }
  if (exactCount === 1) {
    const at = content.indexOf(oldString);
    return {
      content: content.slice(0, at) + newString + content.slice(at + oldString.length),
      replacements: 1,
    };
  }
  if (exactCount > 1) {
    throw new Error(
      `oldString matches ${exactCount} times; pass replaceAll or a more specific oldString`,
    );
  }
  const tolerantPattern = escapeRegExp(oldString).replace(/\s+/g, "\\s+");
  const matches = [...content.matchAll(new RegExp(tolerantPattern, "g"))];
  if (matches.length === 0) throw new Error("oldString not found");
  if (matches.length > 1) {
    throw new Error(
      `oldString matches ${matches.length} times; pass replaceAll or a more specific oldString`,
    );
  }
  const match = matches[0];
  if (!match) throw new Error("oldString not found");
  const at = match.index ?? 0;
  return {
    content: content.slice(0, at) + newString + content.slice(at + match[0].length),
    replacements: 1,
  };
}

export async function editFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
): Promise<EditResult> {
  const filePath = typeof args.path === "string" ? args.path : "";
  const oldString = typeof args.oldString === "string" ? args.oldString : undefined;
  const newString = typeof args.newString === "string" ? args.newString : undefined;
  const replaceAll = args.replaceAll === true;
  if (!filePath) return { error: "path is required", path: filePath };
  if (oldString === undefined) return { error: "oldString is required", path: filePath };
  if (newString === undefined) return { error: "newString is required", path: filePath };
  const resolved = resolveWorkspacePath(workspace, filePath);
  if ("error" in resolved) return resolved;
  const read = await readWorkspaceText(sandbox, workspace, filePath, resolved.storedPath);
  if ("error" in read) return read;
  let edited: { content: string; replacements: number };
  try {
    edited = applyEditToContent(read.content, oldString, newString, replaceAll);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error:
        message === "oldString not found"
          ? `oldString not found in ${filePath}`
          : redactSecrets(message, workspace.runSecrets),
      path: filePath,
    };
  }
  try {
    const bytes = await writeWorkspaceText(sandbox, workspace, resolved.storedPath, edited.content);
    return { ok: true, path: filePath, replacements: edited.replacements, bytes };
  } catch (error) {
    return {
      error: redactSecrets(
        error instanceof Error ? error.message : "could not write file",
        workspace.runSecrets,
      ),
      path: filePath,
    };
  }
}

export type PatchHunkLine = { type: "context" | "add" | "remove"; text: string };

export type PatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: PatchHunkLine[];
};

export type PatchFile = {
  path: string;
  action: "add" | "update" | "delete";
  hunks: PatchHunk[];
};

function stripDiffPrefix(value: string): string {
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

function parseHunkHeader(line: string): Omit<PatchHunk, "lines"> {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) throw new Error(`malformed patch: invalid hunk header "${line}"`);
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/** Parse a unified diff into per-file hunks. Throws on malformed input. */
export function parseUnifiedDiff(patchText: string): PatchFile[] {
  if (!patchText.trim()) throw new Error("malformed patch: patch is empty");
  const lines = patchText.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let pendingOld: string | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (line === undefined) throw new Error("malformed patch: unexpected end of patch");
    if (line.startsWith("diff --git ") || line.startsWith("index ")) {
      continue;
    }
    if (
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to")
    ) {
      continue;
    }
    if (line.startsWith("--- ")) {
      pendingOld = line.slice(4).split("\t").at(0)?.trim() ?? "";
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (pendingOld === null) {
        throw new Error("malformed patch: +++ header without a preceding --- header");
      }
      const newPath = line.slice(4).split("\t").at(0)?.trim() ?? "";
      const action: PatchFile["action"] =
        pendingOld === "/dev/null" ? "add" : newPath === "/dev/null" ? "delete" : "update";
      const path = stripDiffPrefix(action === "delete" ? pendingOld : newPath);
      current = { path, action, hunks: [] };
      files.push(current);
      pendingOld = null;
      continue;
    }
    if (line.startsWith("@@")) {
      if (!current) throw new Error("malformed patch: hunk without a file header");
      const hunk: PatchHunk = { ...parseHunkHeader(line), lines: [] };
      let oldSeen = 0;
      let newSeen = 0;
      while (oldSeen < hunk.oldLines || newSeen < hunk.newLines) {
        if (index >= lines.length) {
          throw new Error(`malformed patch: hunk at line ${hunk.oldStart} is truncated`);
        }
        const hunkLine = lines[index];
        index += 1;
        if (hunkLine === undefined) {
          throw new Error(`malformed patch: hunk at line ${hunk.oldStart} is truncated`);
        }
        if (hunkLine.startsWith("\\")) continue;
        const marker = hunkLine[0];
        if (marker === " ") {
          hunk.lines.push({ type: "context", text: hunkLine.slice(1) });
          oldSeen += 1;
          newSeen += 1;
        } else if (marker === "+") {
          hunk.lines.push({ type: "add", text: hunkLine.slice(1) });
          newSeen += 1;
        } else if (marker === "-") {
          hunk.lines.push({ type: "remove", text: hunkLine.slice(1) });
          oldSeen += 1;
        } else {
          throw new Error(`malformed patch: unexpected line in hunk "${hunkLine}"`);
        }
      }
      current.hunks.push(hunk);
      continue;
    }
    if (line === "") continue;
    throw new Error(`malformed patch: unexpected line "${line}"`);
  }
  if (files.length === 0) throw new Error("malformed patch: no file headers found");
  for (const file of files) {
    if (file.hunks.length === 0) {
      throw new Error(`malformed patch: no hunks for ${file.path}`);
    }
  }
  return files;
}

function hunkMatchesAt(lines: string[], hunk: PatchHunk, pos: number): boolean {
  if (pos < 0 || pos + hunk.oldLines > lines.length) return false;
  let at = pos;
  for (const line of hunk.lines) {
    if (line.type === "add") continue;
    if (lines[at] !== line.text) return false;
    at += 1;
  }
  return true;
}

/** Apply hunks to file content. Throws when a hunk does not match. */
export function applyPatchToContent(content: string, hunks: PatchHunk[]): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content === "" ? [] : content.split("\n");
  if (hasTrailingNewline) lines.pop();
  let offset = 0;
  hunks.forEach((hunk, hunkIndex) => {
    const expected = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1 + offset;
    let pos: number | null = null;
    if (hunkMatchesAt(lines, hunk, expected)) {
      pos = expected;
    } else {
      // Fall back to the hunk's first context line within ±3 lines of expected.
      for (let delta = -3; delta <= 3; delta += 1) {
        if (delta === 0) continue;
        if (hunkMatchesAt(lines, hunk, expected + delta)) {
          pos = expected + delta;
          break;
        }
      }
    }
    if (pos === null) {
      throw new Error(`hunk ${hunkIndex + 1} does not apply at line ${hunk.oldStart}`);
    }
    const replacement = hunk.lines
      .filter((line) => line.type !== "remove")
      .map((line) => line.text);
    lines.splice(pos, hunk.oldLines, ...replacement);
    offset += hunk.newLines - hunk.oldLines;
  });
  if (lines.length === 0) return "";
  // New files (empty input) end with a newline; otherwise keep the input's ending.
  const endsWithNewline = content === "" ? true : hasTrailingNewline;
  return lines.join("\n") + (endsWithNewline ? "\n" : "");
}

export async function applyPatchFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
): Promise<PatchResult> {
  const patchText = typeof args.patchText === "string" ? args.patchText : "";
  if (!patchText) return { error: "patchText is required", results: [] };
  let files: PatchFile[];
  try {
    files = parseUnifiedDiff(patchText);
  } catch (error) {
    return {
      error: redactSecrets(
        error instanceof Error ? error.message : "malformed patch",
        workspace.runSecrets,
      ),
      results: [],
    };
  }
  const results: PatchFileResult[] = [];
  for (const file of files) {
    const fail = (error: string): PatchResult => ({ error, path: file.path, results });
    const resolved = resolveWorkspacePath(workspace, file.path);
    if ("error" in resolved) return fail(resolved.error);
    let content = "";
    if (file.action !== "add") {
      const read = await readWorkspaceText(sandbox, workspace, file.path, resolved.storedPath);
      if ("error" in read) return fail(read.error);
      content = read.content;
    }
    let patched: string;
    try {
      patched = applyPatchToContent(content, file.hunks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        `patch does not apply to ${file.path}: ${redactSecrets(message, workspace.runSecrets)}`,
      );
    }
    try {
      // The sandbox has no delete primitive, so a deleted file is left empty.
      const bytes = await writeWorkspaceText(sandbox, workspace, resolved.storedPath, patched);
      results.push({ path: file.path, action: file.action, bytes });
    } catch (error) {
      return fail(
        redactSecrets(
          error instanceof Error ? error.message : "could not write file",
          workspace.runSecrets,
        ),
      );
    }
  }
  // Files are applied sequentially: on the first failure above, earlier files
  // stay written and the failing file is not written.
  return { ok: true, results };
}

/** edit and apply_patch, following the write_file handler pattern. */
export const editTools: ToolHandlers = {
  async edit(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    const filePath = String(args.path ?? "");
    const workspace = runWorkspace(ctx, call);
    try {
      const result = await editFromTool(deps.sandbox, workspace, args);
      if ("error" in result) {
        await recordComputerAction(ctx, call, "write_file", filePath, { error: result.error });
        return call.finish(result);
      }
      await recordComputerAction(ctx, call, "write_file", filePath, { bytes: result.bytes });
      return call.finish(result);
    } catch (error) {
      await recordComputerAction(ctx, call, "write_file", filePath, {
        error: error instanceof Error ? error.message : "could not edit file",
      });
      throw error;
    }
  },
  async apply_patch(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    const workspace = runWorkspace(ctx, call);
    try {
      const result = await applyPatchFromTool(deps.sandbox, workspace, args);
      for (const written of result.results) {
        await recordComputerAction(ctx, call, "write_file", written.path, {
          bytes: written.bytes,
        });
      }
      if ("error" in result) {
        if (result.path) {
          await recordComputerAction(ctx, call, "write_file", result.path, {
            error: result.error,
          });
        }
        return call.finish(result);
      }
      return call.finish(result);
    } catch (error) {
      // FromTool functions already return failures as {error} results; this
      // only fires if the computer itself cannot be reached, so there is no
      // single file path to record against.
      await recordComputerAction(ctx, call, "write_file", "", {
        error: error instanceof Error ? error.message : "could not apply patch",
      });
      throw error;
    }
  },
};

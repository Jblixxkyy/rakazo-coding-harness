import type { SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import {
  isIsolatedWorkspaceRefusal,
  isolationRootForExecutionId,
  resolveBotWorkspacePath,
} from "./computer-support.js";
import { invalidateRepoMapForWorkspace } from "./repo-map.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { recordComputerAction } from "./run-tools-computer.js";
import { deleteWorkspaceFile } from "./sandbox-delete.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

const MAX_MODEL_FILE_BYTES = 250_000;
/** Prior bytes kept for undoing a deleted file; deletes above this stay deleted. */
const MAX_UNDO_SNAPSHOT_BYTES = 1_000_000;

/**
 * One file's pre-change state, captured before an edit or patch touches it.
 * `content` holds the prior bytes, or null when the file did not exist
 * (undo then deletes it). `content` is undefined when the prior bytes were
 * too large to snapshot: the change still applies, but undo lists the file
 * as unrestorable instead of pretending it was restored.
 */
export type EditFileSnapshot = {
  path: string;
  storedPath: string;
  existed: boolean;
  content?: Uint8Array | null;
};

/** The files changed by one successful edit/apply_patch call, for undo. */
export type EditUndoBatch = { files: EditFileSnapshot[] };

/**
 * Last successful edit batch per run, held in memory only. The key is the
 * run id the executor puts on the adapter context (operationId/traceId are
 * the same run id there); tests without a run id fall back to operationId.
 * Only the most recent batch per run is kept, snapshots are already capped
 * by the 250 KB model limit for edits/updates (1 MB for deletes), and the
 * map evicts the oldest run past 64 entries, so a long-lived server cannot
 * grow this without bound. Undo state deliberately does not survive a
 * restart: it is a run-scoped convenience, not durable history.
 */
const undoBatches = new Map<string, EditUndoBatch>();
const MAX_UNDO_RUNS = 64;

function undoStoreKey(workspace: RunWorkspace): string {
  // Isolated helpers keep separate undo batches: two helpers in one run must
  // never undo each other's files.
  return `${workspace.computerMode}:${workspace.botId}:${workspace.isolationRoot ?? ""}:${workspace.context.runId ?? workspace.context.operationId}`;
}

export function recordUndoBatch(workspace: RunWorkspace, files: EditFileSnapshot[]): void {
  const key = undoStoreKey(workspace);
  undoBatches.delete(key);
  if (undoBatches.size >= MAX_UNDO_RUNS) {
    const oldest = undoBatches.keys().next().value;
    if (oldest !== undefined) undoBatches.delete(oldest);
  }
  undoBatches.set(key, { files });
}

function clearUndoBatch(workspace: RunWorkspace): void {
  undoBatches.delete(undoStoreKey(workspace));
}

function peekUndoBatch(workspace: RunWorkspace): EditUndoBatch | undefined {
  return undoBatches.get(undoStoreKey(workspace));
}

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
    isolationRoot: isolationRootForExecutionId(call.executionId),
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
      storedPath: resolveBotWorkspacePath(
        workspace.computerMode,
        workspace.botId,
        filePath,
        workspace.isolationRoot,
      ),
    };
  } catch (error) {
    // Keep the isolation refusal specific: it names the helper's folder.
    if (error instanceof Error && isIsolatedWorkspaceRefusal(error)) {
      return { error: error.message, path: filePath };
    }
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
  // The cached repo map is keyed by workspace version; bump it so the next
  // repo_map read rebuilds instead of serving the pre-write tree/symbols.
  invalidateRepoMapForWorkspace(workspace);
  return bytes.byteLength;
}

/** Write raw prior bytes back during rollback/undo, without re-encoding. */
async function writeWorkspaceBytes(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  storedPath: string,
  content: Uint8Array,
): Promise<void> {
  workspace.markDirty();
  await sandbox.writeFile(
    await workspace.computer(),
    { path: storedPath, content: new Uint8Array(content) },
    workspace.context,
  );
  invalidateRepoMapForWorkspace(workspace);
}

/**
 * Restore one snapshotted file: rewrite its prior bytes, or delete it when
 * it did not exist before the batch. A delete that reports "file not
 * found" is already in the target state, so it succeeds.
 */
async function restoreSnapshot(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  snapshot: EditFileSnapshot,
): Promise<{ path: string; action: "restored" | "deleted"; bytes: number }> {
  if (snapshot.content === null || snapshot.content === undefined) {
    if (snapshot.content === undefined) {
      throw new Error(`prior contents of ${snapshot.path} were too large to snapshot`);
    }
    const deleted = await deleteWorkspaceFile(sandbox, workspace, snapshot.path);
    if ("error" in deleted && deleted.error !== "file not found") {
      throw new Error(deleted.error);
    }
    invalidateRepoMapForWorkspace(workspace);
    return { path: snapshot.path, action: "deleted", bytes: 0 };
  }
  await writeWorkspaceBytes(sandbox, workspace, snapshot.storedPath, snapshot.content);
  return { path: snapshot.path, action: "restored", bytes: snapshot.content.byteLength };
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
    recordUndoBatch(workspace, [
      {
        path: filePath,
        storedPath: resolved.storedPath,
        existed: true,
        content: new TextEncoder().encode(read.content),
      },
    ]);
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

type PlannedPatchFile = {
  file: PatchFile;
  storedPath: string;
  snapshot: EditFileSnapshot;
  /** Patched text for add/update; null for delete. */
  patched: string | null;
};

/**
 * Read a file's raw bytes for a snapshot. `tooLarge` is set instead of
 * failing when the file exceeds the snapshot cap, so a large delete can
 * still apply (undo just cannot restore that one file).
 */
async function readSnapshotBytes(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  storedPath: string,
): Promise<{ bytes: Uint8Array } | { notFound: true } | { tooLarge: true } | { error: string }> {
  try {
    const bytes = await sandbox.readFile(
      await workspace.computer(),
      storedPath,
      workspace.context,
      { maxBytes: MAX_UNDO_SNAPSHOT_BYTES },
    );
    return { bytes };
  } catch (error) {
    if (error instanceof Error && /not found/.test(error.message)) return { notFound: true };
    if (error instanceof Error && /exceeds \d+ bytes/.test(error.message))
      return { tooLarge: true };
    return {
      error: redactSecrets(
        error instanceof Error ? error.message : "could not read file",
        workspace.runSecrets,
      ),
    };
  }
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
  // Validate everything before touching disk: resolve every path, read
  // every existing target, and apply every hunk in memory. A patch that
  // fails here changes nothing.
  const planned: PlannedPatchFile[] = [];
  for (const file of files) {
    const fail = (error: string): PatchResult => ({ error, path: file.path, results: [] });
    const resolved = resolveWorkspacePath(workspace, file.path);
    if ("error" in resolved) return fail(resolved.error);
    if (file.action === "delete") {
      const prior = await readSnapshotBytes(sandbox, workspace, resolved.storedPath);
      if ("error" in prior) return fail(prior.error);
      if ("notFound" in prior) return fail("file not found");
      const snapshot: EditFileSnapshot = {
        path: file.path,
        storedPath: resolved.storedPath,
        existed: true,
        content: "tooLarge" in prior ? undefined : prior.bytes,
      };
      if ("tooLarge" in prior) {
        // Cannot validate hunks without the content; the delete still
        // applies, but undo cannot restore this file.
        planned.push({ file, storedPath: resolved.storedPath, snapshot, patched: null });
        continue;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(prior.bytes);
      } catch {
        return fail("file is not UTF-8 text; use open_path to inspect it");
      }
      try {
        applyPatchToContent(text, file.hunks);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(
          `patch does not apply to ${file.path}: ${redactSecrets(message, workspace.runSecrets)}`,
        );
      }
      planned.push({ file, storedPath: resolved.storedPath, snapshot, patched: null });
      continue;
    }
    if (file.action === "add") {
      const prior = await readSnapshotBytes(sandbox, workspace, resolved.storedPath);
      if ("error" in prior) return fail(prior.error);
      const snapshot: EditFileSnapshot =
        "notFound" in prior
          ? { path: file.path, storedPath: resolved.storedPath, existed: false, content: null }
          : {
              path: file.path,
              storedPath: resolved.storedPath,
              existed: true,
              content: "tooLarge" in prior ? undefined : prior.bytes,
            };
      let patched: string;
      try {
        patched = applyPatchToContent("", file.hunks);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(
          `patch does not apply to ${file.path}: ${redactSecrets(message, workspace.runSecrets)}`,
        );
      }
      planned.push({ file, storedPath: resolved.storedPath, snapshot, patched });
      continue;
    }
    const read = await readWorkspaceText(sandbox, workspace, file.path, resolved.storedPath);
    if ("error" in read) return fail(read.error);
    let patched: string;
    try {
      patched = applyPatchToContent(read.content, file.hunks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        `patch does not apply to ${file.path}: ${redactSecrets(message, workspace.runSecrets)}`,
      );
    }
    planned.push({
      file,
      storedPath: resolved.storedPath,
      snapshot: {
        path: file.path,
        storedPath: resolved.storedPath,
        existed: true,
        content: new TextEncoder().encode(read.content),
      },
      patched,
    });
  }
  // All hunks validated: apply. On any failure mid-apply, roll the files
  // already changed in this patch back to their snapshots.
  const results: PatchFileResult[] = [];
  const applied: PlannedPatchFile[] = [];
  for (const item of planned) {
    try {
      if (item.file.action === "delete") {
        const deleted = await deleteWorkspaceFile(sandbox, workspace, item.file.path);
        if ("error" in deleted) throw new Error(deleted.error);
        invalidateRepoMapForWorkspace(workspace);
        results.push({ path: item.file.path, action: "delete", bytes: deleted.bytes });
      } else {
        const bytes = await writeWorkspaceText(
          sandbox,
          workspace,
          item.storedPath,
          item.patched ?? "",
        );
        results.push({ path: item.file.path, action: item.file.action, bytes });
      }
      applied.push(item);
    } catch (error) {
      const failures: string[] = [];
      for (const done of [...applied].reverse()) {
        try {
          await restoreSnapshot(sandbox, workspace, done.snapshot);
        } catch (rollbackError) {
          failures.push(
            `${done.file.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      const message = redactSecrets(
        error instanceof Error ? error.message : "could not apply patch",
        workspace.runSecrets,
      );
      const rolledBack = `patch failed on ${item.file.path}: ${message}; rolled back ${applied.length} file(s)`;
      return {
        error:
          failures.length > 0
            ? `${rolledBack}; rollback also failed for ${failures.join("; ")}`
            : rolledBack,
        path: item.file.path,
        results: [],
      };
    }
  }
  recordUndoBatch(
    workspace,
    planned.map((item) => item.snapshot),
  );
  return { ok: true, results };
}

export type UndoEditResult =
  | {
      ok: true;
      restored: Array<{ path: string; action: "restored" | "deleted"; bytes: number }>;
      unrestorable?: string[];
    }
  | {
      error: string;
      restored?: Array<{ path: string; action: "restored" | "deleted"; bytes: number }>;
    };

/**
 * Restore the files changed by the most recent successful edit/apply_patch
 * batch in this run. Single-level undo: a successful undo clears the
 * batch, so a second undo errors. A failed patch records no batch, so undo
 * after one either restores the previous successful batch or errors with
 * "nothing to undo" — never a half-applied state. Files whose prior bytes
 * were too large to snapshot are listed in `unrestorable` and left alone.
 * A restore that fails part-way keeps the batch, so undo can be retried.
 */
export async function undoEditFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  _args: Record<string, unknown>,
): Promise<UndoEditResult> {
  const batch = peekUndoBatch(workspace);
  if (!batch) {
    return { error: "nothing to undo: no successful edit or patch in this run" };
  }
  const restored: Array<{ path: string; action: "restored" | "deleted"; bytes: number }> = [];
  const unrestorable: string[] = [];
  const failures: string[] = [];
  for (const snapshot of [...batch.files].reverse()) {
    if (snapshot.content === undefined) {
      unrestorable.push(snapshot.path);
      continue;
    }
    try {
      restored.push(await restoreSnapshot(sandbox, workspace, snapshot));
    } catch (error) {
      failures.push(
        `${snapshot.path}: ${error instanceof Error ? redactSecrets(error.message, workspace.runSecrets) : "could not restore file"}`,
      );
    }
  }
  if (failures.length > 0) {
    return {
      error: `undo partially failed: ${failures.join("; ")}`,
      restored,
    };
  }
  clearUndoBatch(workspace);
  return unrestorable.length > 0 ? { ok: true, restored, unrestorable } : { ok: true, restored };
}

/** edit, apply_patch and undo_edit, following the write_file handler pattern. */
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
  async undo_edit(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    const workspace = runWorkspace(ctx, call);
    try {
      const result = await undoEditFromTool(deps.sandbox, workspace, args);
      if ("error" in result) {
        await recordComputerAction(ctx, call, "write_file", "", { error: result.error });
        if (result.restored) {
          for (const file of result.restored) {
            await recordComputerAction(ctx, call, "write_file", file.path, {
              bytes: file.bytes,
            });
          }
        }
        return call.finish(result);
      }
      for (const file of result.restored) {
        await recordComputerAction(ctx, call, "write_file", file.path, { bytes: file.bytes });
      }
      return call.finish(result);
    } catch (error) {
      await recordComputerAction(ctx, call, "write_file", "", {
        error: error instanceof Error ? error.message : "could not undo edit",
      });
      throw error;
    }
  },
};

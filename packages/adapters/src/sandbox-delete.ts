import type { SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import {
  isIsolatedWorkspaceRefusal,
  normalizeWorkspacePath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  workspaceRelativePath,
} from "./computer-support.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

export type DeleteWorkspaceFileResult =
  | { ok: true; path: string; bytes: number }
  | { error: string; path: string };

/**
 * Delete one workspace file through the sandbox's `execute` primitive.
 *
 * `SandboxProvider` has no delete/remove method (checked across
 * packages/adapter-kit and infra/sandboxes/supervisor), and extending it
 * would mean touching every provider. Every provider does implement
 * `execute`, and the supervisor already deletes files the same way
 * (`rm -f` via a container command, e.g. the completion-marker cleanup),
 * so `rm` through `execute` is the provider-neutral delete path. The path
 * is passed as a separate argv entry, never through a shell string, so a
 * hostile file name cannot inject a command; `resolveBotWorkspacePath`
 * plus `normalizeWorkspacePath` keep the target inside the bot workspace.
 * `rm -f` succeeds silently on a missing file, so existence is checked
 * first with `listFiles` (and verified again afterwards) to give a clear
 * "file not found" instead of a silent no-op.
 */
export async function deleteWorkspaceFile(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  filePath: string,
): Promise<DeleteWorkspaceFileResult> {
  let relPath: string;
  let storedPath: string;
  try {
    // normalizeWorkspacePath strips a leading "/" instead of rejecting it,
    // so absolute paths are refused here first, matching edit's escaping
    // check; ".." segments still throw inside normalizeWorkspacePath.
    const portable = filePath.replace(/\\/g, "/");
    if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) {
      throw new Error("Path escapes the computer workspace");
    }
    storedPath = resolveBotWorkspacePath(
      workspace.computerMode,
      workspace.botId,
      filePath,
      workspace.isolationRoot,
    );
    // The rm runs with the workspace (or isolation) root as its cwd, so the
    // argv path must be relative to that root — derived from the resolved
    // stored path, never from the raw model-supplied path.
    relPath = workspaceRelativePath(
      workspace.computerMode,
      workspace.botId,
      storedPath,
      workspace.isolationRoot,
    );
  } catch (error) {
    if (error instanceof Error && isIsolatedWorkspaceRefusal(error)) {
      return { error: error.message, path: filePath };
    }
    return { error: "Path escapes the computer workspace", path: filePath };
  }
  if (!relPath) return { error: "path is required", path: filePath };
  const computer = await workspace.computer();
  const parentRel = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const parentStored = resolveBotWorkspacePath(
    workspace.computerMode,
    workspace.botId,
    parentRel,
    workspace.isolationRoot,
  );
  let entries: Awaited<ReturnType<SandboxProvider["listFiles"]>>;
  try {
    entries = await sandbox.listFiles(computer, parentStored, workspace.context);
  } catch (error) {
    return {
      error: redactSecrets(
        error instanceof Error ? error.message : "could not list workspace",
        workspace.runSecrets,
      ),
      path: filePath,
    };
  }
  const entry = entries.find((candidate) => {
    try {
      return normalizeWorkspacePath(candidate.path) === normalizeWorkspacePath(storedPath);
    } catch {
      return candidate.path === storedPath;
    }
  });
  if (!entry) return { error: "file not found", path: filePath };
  if (entry.kind === "dir") {
    return { error: "is a directory; refusing to delete", path: filePath };
  }
  const bytes = entry.size ?? 0;
  workspace.markDirty();
  let code = 1;
  let stderr = "";
  try {
    for await (const event of sandbox.execute(
      computer,
      {
        argv: ["rm", "-f", "--", relPath],
        cwd: resolveBotWorkspaceCwd(
          workspace.computerMode,
          workspace.botId,
          undefined,
          workspace.isolationRoot,
        ),
        timeoutMs: 30_000,
      },
      workspace.context,
    )) {
      if (event.type === "stderr") stderr += event.data;
      else if (event.type === "exit") code = event.code;
    }
  } catch (error) {
    return {
      error: redactSecrets(
        error instanceof Error ? error.message : "could not delete file",
        workspace.runSecrets,
      ),
      path: filePath,
    };
  }
  if (code !== 0) {
    return {
      error: redactSecrets(
        stderr.trim() || `could not delete file (exit ${code})`,
        workspace.runSecrets,
      ),
      path: filePath,
    };
  }
  try {
    const after = await sandbox.listFiles(computer, parentStored, workspace.context);
    const stillThere = after.some((candidate) => {
      try {
        return normalizeWorkspacePath(candidate.path) === normalizeWorkspacePath(storedPath);
      } catch {
        return candidate.path === storedPath;
      }
    });
    if (stillThere) return { error: "could not delete file", path: filePath };
  } catch (error) {
    return {
      error: redactSecrets(
        error instanceof Error ? error.message : "could not verify deletion",
        workspace.runSecrets,
      ),
      path: filePath,
    };
  }
  return { ok: true, path: filePath, bytes };
}

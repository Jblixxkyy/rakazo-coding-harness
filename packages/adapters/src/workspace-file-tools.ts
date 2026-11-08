import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { JSDOM } from "jsdom";
import {
  displayBotWorkspacePath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  workspaceRelativePath,
} from "./computer-support.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { PlotSpec } from "./plot-tool.js";
import {
  assertPlotDataWithinLimits,
  PLOT_TOOL_GUIDE,
  parsePlotData,
  plotSvgToPng,
  renderPlotSpecToSvg,
  searchChartCatalog,
} from "./plot-tool.js";
import { publishMessage } from "./run-messages.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
/** The bot workspace a run reaches on its computer. */
export type RunWorkspace = {
  botId: string;
  computerMode: ComputerMode;
  computer: () => Promise<ComputerRef>;
  markDirty: () => void;
  context: AdapterContext;
  runSecrets: string[];
  /**
   * When set, this run is an isolated subagent confined to `subagents/<id>/`
   * under the bot workspace: every path resolves under that folder. Null (or
   * absent) is the parent run and non-isolated helpers, resolved as before.
   */
  isolationRoot?: string | null;
};

const MAX_MODEL_FILE_BYTES = 250_000;
// The sandbox readFile primitive has no byte offset, so it cannot return a
// slice of a large file without loading the prefix. Paged reads therefore go
// through the sandbox shell when it can run sed/awk (see
// readPagedSliceViaShell): only the requested lines cross into memory. When
// the shell cannot run them, a paged read falls back to readFile capped at
// the same 250 KB model budget as an unpaged read — a larger file then
// reports "file is too large" instead of loading a bigger slice. There is
// deliberately no larger paged cap: no paged read ever materializes more
// than 250 KB through readFile.
/** Lines returned when a paged read gives an offset but no limit. */
const PAGED_READ_DEFAULT_LIMIT = 500;
/** Hard cap on lines per paged read, so one call stays bounded. */
const PAGED_READ_MAX_LIMIT = 1000;

/**
 * Run one argv command in the workspace and collect its stdout. Returns
 * null when the command cannot run at all (execute throws); the caller
 * checks the exit code. Paths travel as separate argv entries, never
 * through a shell string.
 */
async function runWorkspaceCommand(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  argv: string[],
): Promise<{ stdout: string; stderr: string; code: number } | null> {
  let stdout = "";
  let stderr = "";
  let code = 1;
  try {
    for await (const event of sandbox.execute(
      await workspace.computer(),
      {
        argv,
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
      if (event.type === "stdout") stdout += event.data;
      else if (event.type === "stderr") stderr += event.data;
      else code = event.code;
    }
  } catch {
    return null;
  }
  return { stdout, stderr, code };
}

/**
 * Read a line window plus the file's total line count without loading the
 * file: `sed` prints only the requested lines and `awk` counts records
 * (its NR matches the split-on-\n line count, trailing newline included).
 * Returns null when the sandbox shell cannot run them, so the caller falls
 * back to the readFile path. Both outputs are validated — a stub shell
 * that echoes the command instead of running it fails the awk integer
 * check and is never mistaken for a real result.
 */
async function readPagedSliceViaShell(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  relPath: string,
  startLine: number,
  lineLimit: number,
): Promise<{ lines: string[]; totalLines: number } | null> {
  const endLine = startLine + lineLimit - 1;
  const window = await runWorkspaceCommand(sandbox, workspace, [
    "sed",
    "-n",
    `${startLine},${endLine}p`,
    relPath,
  ]);
  if (window?.code !== 0) return null;
  const total = await runWorkspaceCommand(sandbox, workspace, ["awk", "END{print NR}", relPath]);
  if (total?.code !== 0) return null;
  const totalLines = Number(total.stdout.trim());
  if (!Number.isInteger(totalLines) || totalLines < 0) return null;
  // The shell output arrives as text from the provider; a non-UTF-8 file
  // surfaces as a decode failure on the readFile fallback instead.
  const text = window.stdout;
  // A trailing newline terminates the last line rather than starting an empty one.
  const lines = text === "" ? [] : text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  if (lines.length > lineLimit) return null;
  return { lines, totalLines };
}

export async function listFilesFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const { botId, computerMode, computer, context, runSecrets, isolationRoot } = workspace;
  const requestedPath = String(args.path ?? "");
  const entries = await sandbox.listFiles(
    await computer(),
    resolveBotWorkspacePath(computerMode, botId, requestedPath, isolationRoot),
    context,
  );
  return {
    path: requestedPath,
    entries: entries.map((entry) => ({
      ...entry,
      // A file name can carry a value an earlier command or page wrote.
      path: redactSecrets(
        displayBotWorkspacePath(computerMode, botId, requestedPath, entry.path, isolationRoot),
        runSecrets,
      ),
    })),
  };
}

export async function readFileFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const { botId, computerMode, computer, context, runSecrets, isolationRoot } = workspace;
  const filePath = String(args.path ?? "");
  const offset = args.offset === undefined ? undefined : Number(args.offset);
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  const lineNumbers = args.lineNumbers === true;
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
    return { error: "offset must be a positive integer", path: filePath };
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return { error: "limit must be a positive integer", path: filePath };
  }
  const paged = offset !== undefined || limit !== undefined || lineNumbers;
  // One budget for every readFile call, paged or not: the 250 KB model cap.
  // A paged read that cannot go through the shell (below) therefore never
  // loads more than this; a larger file reports "file is too large".
  const maxBytes = MAX_MODEL_FILE_BYTES;
  const storedPath = resolveBotWorkspacePath(computerMode, botId, filePath, isolationRoot);
  // A bounded window (offset and/or limit) is read through the shell when
  // possible, so only the requested lines enter memory. A lineNumbers-only
  // read has no window to bound, and a shell that cannot run sed/awk falls
  // back to the readFile path below, capped at the 250 KB model budget.
  if (offset !== undefined || limit !== undefined) {
    const startLine = offset ?? 1;
    const lineLimit = Math.min(limit ?? PAGED_READ_DEFAULT_LIMIT, PAGED_READ_MAX_LIMIT);
    // The shell runs with the workspace (or isolation) root as its cwd, so
    // the path it is given must be relative to that root — derived from the
    // already-resolved stored path, never from the raw model-supplied path.
    const relPath = workspaceRelativePath(computerMode, botId, storedPath, isolationRoot);
    if (relPath) {
      const sliced = await readPagedSliceViaShell(
        sandbox,
        workspace,
        relPath,
        startLine,
        lineLimit,
      );
      if (sliced) {
        const endLine = startLine + sliced.lines.length - 1;
        return {
          path: filePath,
          content: redactSecrets(
            sliced.lines
              .map((line, index) => (lineNumbers ? `${startLine + index}: ${line}` : line))
              .join("\n"),
            runSecrets,
          ),
          totalLines: sliced.totalLines,
          startLine,
          endLine,
          truncated: endLine < sliced.totalLines,
        };
      }
    }
  }
  let bytes: Uint8Array;
  try {
    bytes = await sandbox.readFile(await computer(), storedPath, context, {
      maxBytes,
    });
  } catch (error) {
    if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
      return {
        error: "file is too large for model context",
        path: filePath,
      };
    }
    throw error;
  }
  if (bytes.byteLength > maxBytes) {
    return {
      error: "file is too large for model context",
      path: filePath,
      size: bytes.byteLength,
    };
  }
  let content: string;
  try {
    content = redactSecrets(new TextDecoder("utf-8", { fatal: true }).decode(bytes), runSecrets);
  } catch {
    return {
      error: "file is not UTF-8 text; use open_path to inspect it",
      path: filePath,
    };
  }
  if (!paged) {
    return { path: filePath, content };
  }
  // A trailing newline terminates the last line rather than starting an empty one.
  const allLines = content === "" ? [] : content.split("\n");
  if (content.endsWith("\n")) allLines.pop();
  const totalLines = allLines.length;
  const startLine = offset ?? 1;
  const slice = allLines.slice(
    startLine - 1,
    limit === undefined ? undefined : startLine - 1 + limit,
  );
  const endLine = startLine + slice.length - 1;
  return {
    path: filePath,
    content: slice
      .map((line, index) => (lineNumbers ? `${startLine + index}: ${line}` : line))
      .join("\n"),
    totalLines,
    startLine,
    endLine,
    truncated: endLine < totalLines,
  };
}

/** render_plot: returns the chart guide or catalog, or renders a chart into the workspace and chat. */
export async function renderPlotFromTool(
  deps: ExecutorDeps,
  run: {
    id: string;
    spaceId: string;
    userId: string;
    threadId: string;
    botId: string;
    trigger: string;
  },
  args: Record<string, unknown>,
  executionId: string,
  workspace: RunWorkspace,
  finish: (result: unknown) => Promise<unknown>,
) {
  const { botId, computerMode, computer, context, runSecrets, isolationRoot } = workspace;
  if (args.charts !== undefined) {
    const query = typeof args.charts === "string" ? args.charts : undefined;
    return {
      charts: searchChartCatalog(query),
      note: "Each spec is a complete runnable example: substitute your rows and column names, then call render_plot with it.",
    };
  }
  if (args.help === true || !args.spec || typeof args.spec !== "object") {
    return { guide: PLOT_TOOL_GUIDE };
  }
  // Data and spec mistakes are the model's to fix from the returned error;
  // everything else (reading the data file, rasterizing, attaching) is ours.
  let checkingSpec = false;
  try {
    let rows = Array.isArray(args.data) ? (args.data as unknown[]) : undefined;
    const dataPath =
      typeof args.data_path === "string" && args.data_path ? args.data_path : undefined;
    if (!rows && dataPath) {
      const bytes = await deps.sandbox.readFile(
        await computer(),
        resolveBotWorkspacePath(computerMode, botId, dataPath, isolationRoot),
        context,
        { maxBytes: deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES },
      );
      checkingSpec = true;
      rows = parsePlotData(dataPath, new TextDecoder().decode(bytes));
    }
    checkingSpec = true;
    assertPlotDataWithinLimits(args.spec as PlotSpec, rows);
    const svg = renderPlotSpecToSvg(args.spec as PlotSpec, rows, new JSDOM("").window.document);
    checkingSpec = false;
    const png = await plotSvgToPng(svg);
    const outPath =
      typeof args.path === "string" && args.path ? args.path : `charts/plot-${Date.now()}.png`;
    workspace.markDirty();
    await deps.sandbox.writeFile(
      await computer(),
      {
        path: resolveBotWorkspacePath(computerMode, botId, outPath, isolationRoot),
        content: png,
      },
      context,
    );
    let attached = false;
    const chartName = outPath.split("/").pop() ?? "chart";
    const chartRows = rows ?? (args.spec as { data?: unknown[] }).data ?? [];
    const chartSpec = { ...(args.spec as Record<string, unknown>) };
    delete chartSpec.data;
    const chartFits =
      Array.isArray(chartRows) &&
      JSON.stringify({ spec: chartSpec, data: chartRows }).length <= 200_000;
    if (args.attach !== false && chartFits) {
      // Live inline chart: the client re-renders the validated spec
      // and the PNG stays on disk as the exportable copy.
      await publishMessage(deps, run, "bot", [
        {
          kind: "chart",
          name: chartName,
          spec: chartSpec,
          data: chartRows,
        },
      ]);
      attached = true;
    } else if (args.attach !== false && deps.artifacts) {
      const result = await attachWorkspaceFileToThread(
        {
          prisma: deps.prisma,
          artifacts: deps.artifacts,
          maxUploadSizeBytes: deps.maxUploadSizeBytes,
        },
        {
          spaceId: run.spaceId,
          userId: run.userId,
          botId,
          runId: run.id,
          filePath: outPath,
          bytes: png,
          operationId: executionId,
        },
      );
      await publishMessage(deps, run, "bot", [result.block]);
      attached = true;
    }
    return finish({ ok: true, path: outPath, attached });
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
      runSecrets,
    );
    if (!checkingSpec) getLogger().error(`render_plot failed for bot ${botId}: ${message}`);
    return finish({
      error: message,
      hint: 'Call render_plot with {"charts": true} for runnable example specs, or {"help": true} for the full guide.',
    });
  }
}

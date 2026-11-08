import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ConnectorTool,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  displayBotWorkspacePath,
  isolatedSubagentWorkspace,
  isolationRootForExecutionId,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
} from "./computer-support.js";
import { editTools } from "./edit-tools.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { feedbackTools, runSandboxCommand } from "./feedback-tools.js";
import {
  isolatedSubagentInstruction,
  isolatedSubagentWorkspace as isolatedWorkspaceFromSubagent,
} from "./pi-runtime-subagent.js";
import type { ToolHost } from "./pi-runtime-tools.js";
import { toAgentTools } from "./pi-runtime-tools.js";
import type { RepoMap } from "./repo-map.js";
import { repoMapTools } from "./repo-map.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { fileTools } from "./run-tools-files.js";
import { searchTools } from "./search-tools.js";
import type { RunWorkspace } from "./workspace-file-tools.js";
import { listFilesFromTool, readFileFromTool } from "./workspace-file-tools.js";

const BOT_ID = "bot-1";

const context: AdapterContext = {
  operationId: "isolation-test",
  traceId: "isolation-test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

/** An executionId exactly as pi-runtime-tools builds it: ["pi-tool", namespace, callId]. */
function executionId(namespace: string, callId: string): string {
  return JSON.stringify(["pi-tool", namespace, callId]);
}

/** The run_subagent call's executionId for a helper started by the main agent. */
function subagentCallId(name: string): string {
  return executionId("main", `delegate-${name}`);
}

/** A nested tool call's executionId for an isolated helper. */
function isolatedCallId(name: string, callId = "call-1"): string {
  return executionId(`isolated:${subagentCallId(name)}`, callId);
}

function mainCallId(callId = "call-1"): string {
  return executionId("main", callId);
}

/** A nested tool call's executionId for a NON-isolated helper. */
function nonIsolatedSubagentCallId(name: string, callId = "call-1"): string {
  return executionId(subagentCallId(name), callId);
}

function isolatedRoot(name: string): string {
  return isolatedSubagentWorkspace(subagentCallId(name));
}

/** FakeSandbox that records every execute() request (argv + cwd + timeout). */
class RecordingSandbox extends FakeSandboxProvider {
  readonly seen: { argv: string[]; cwd?: string; timeoutMs?: number }[] = [];
  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    this.seen.push({ argv: request.argv, cwd: request.cwd, timeoutMs: request.timeoutMs });
    yield* super.execute(computer, request, context);
  }
}

/**
 * RecordingSandbox that also really deletes on `rm -f -- <rel>`: the fake's
 * execute() only echoes, so a delete that cannot remove the file can never
 * be verified end to end without this.
 */
class DeletingSandbox extends RecordingSandbox {
  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.argv[0] === "rm" && request.argv[1] === "-f") {
      this.seen.push({ argv: request.argv, cwd: request.cwd, timeoutMs: request.timeoutMs });
      const box = this.boxes.get(computer.id);
      const rel = request.argv[request.argv.length - 1] ?? "";
      const stored = [request.cwd ?? "", rel].filter(Boolean).join("/").replace(/^\//, "");
      box?.files.delete(stored);
      yield { type: "exit", code: 0 };
      return;
    }
    yield* super.execute(computer, request, context);
  }
}

async function seedBox(
  files: Record<string, string>,
  sandbox: FakeSandboxProvider = new RecordingSandbox(),
) {
  const computer = await sandbox.provision({ botId: BOT_ID, homePath: "/ignored" }, context);
  for (const [filePath, content] of Object.entries(files)) {
    await sandbox.writeFile(
      computer,
      { path: filePath, content: new TextEncoder().encode(content) },
      context,
    );
  }
  return { sandbox, computer };
}

async function readStored(
  sandbox: FakeSandboxProvider,
  computer: ComputerRef,
  storedPath: string,
): Promise<string | undefined> {
  try {
    const bytes = await sandbox.readFile(computer, storedPath, context);
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function workspaceFor(computer: ComputerRef, root?: string | null): RunWorkspace {
  return {
    botId: BOT_ID,
    computerMode: "team",
    computer: async () => computer,
    markDirty: () => {},
    context,
    runSecrets: [],
    ...(root === undefined ? {} : { isolationRoot: root }),
  };
}

function fakeCtx(sandbox: FakeSandboxProvider, computer: ComputerRef) {
  return {
    bot: { id: BOT_ID },
    run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: BOT_ID },
    runId: "run-1",
    thread: { id: "thread-1" },
    computer: {
      mode: "team",
      get: async () => computer,
      checkpoint: { markDirty: () => {} },
    },
    context,
    secrets: [],
    deps: {
      sandbox,
      events: { append: async () => {} },
    },
  } as unknown as RunContext;
}

function fakeCall(name: string, args: Record<string, unknown>, execId: string): ToolCall {
  return {
    name,
    args,
    executionId: execId,
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
}

describe("isolated subagent workspace", () => {
  it("confines writes under a sanitized subagents folder", () => {
    expect(isolatedSubagentWorkspace("scout-1")).toBe("subagents/scout-1");
    expect(isolatedSubagentWorkspace('["pi-tool","main","a/b"]')).toBe(
      "subagents/--pi-tool---main---a-b--",
    );
    // The re-export from pi-runtime-subagent.ts is the same function.
    expect(isolatedWorkspaceFromSubagent("scout-1")).toBe("subagents/scout-1");
  });

  it("tells the helper its tools are confined to its folder, reads included", () => {
    const instruction = isolatedSubagentInstruction("scout-1");
    expect(instruction).toContain("subagents/scout-1/");
    expect(instruction).toContain("confined to subagents/scout-1/");
    expect(instruction).toContain("reads and writes outside that folder are refused");
    expect(instruction).not.toContain("read anywhere");
  });
});

describe("isolationRootForExecutionId", () => {
  it("returns the folder for an isolated helper's tool call", () => {
    expect(isolationRootForExecutionId(isolatedCallId("scout"))).toBe(isolatedRoot("scout"));
  });

  it("returns null for the parent run and for non-isolated helpers", () => {
    expect(isolationRootForExecutionId(mainCallId())).toBeNull();
    expect(isolationRootForExecutionId(nonIsolatedSubagentCallId("scout"))).toBeNull();
  });

  it("returns null for opaque or malformed executionIds", () => {
    expect(isolationRootForExecutionId("")).toBeNull();
    expect(isolationRootForExecutionId("not-json")).toBeNull();
    expect(isolationRootForExecutionId('["pi-tool"]')).toBeNull();
    expect(isolationRootForExecutionId('["other","main","x"]')).toBeNull();
    expect(isolationRootForExecutionId('["pi-tool","","x"]')).toBeNull();
  });
});

describe("isolated path resolution", () => {
  const root = isolatedRoot("scout");
  const storedRoot = `bots/${BOT_ID}/${root}`;

  it("resolves relative paths under the isolation root (team mode)", () => {
    expect(resolveBotWorkspacePath("team", BOT_ID, "notes.txt", root)).toBe(
      `${storedRoot}/notes.txt`,
    );
    expect(resolveBotWorkspacePath("team", BOT_ID, "", root)).toBe(storedRoot);
    expect(resolveBotWorkspacePath("team", BOT_ID, "~", root)).toBe(storedRoot);
    expect(resolveBotWorkspacePath("team", BOT_ID, "~/notes.txt", root)).toBe(
      `${storedRoot}/notes.txt`,
    );
  });

  it("de-duplicates a leading isolation-root prefix instead of nesting it", () => {
    expect(resolveBotWorkspacePath("team", BOT_ID, `${root}/notes.txt`, root)).toBe(
      `${storedRoot}/notes.txt`,
    );
    expect(resolveBotWorkspacePath("team", BOT_ID, root, root)).toBe(storedRoot);
  });

  it("allows absolute paths that already address inside the subtree", () => {
    expect(resolveBotWorkspacePath("team", BOT_ID, `${storedRoot}/notes.txt`, root)).toBe(
      `${storedRoot}/notes.txt`,
    );
    expect(resolveBotWorkspacePath("team", BOT_ID, `/bots/${BOT_ID}/${root}/notes.txt`, root)).toBe(
      `${storedRoot}/notes.txt`,
    );
  });

  it("refuses team-root paths outside the subtree with a clear error", () => {
    const refusal = `Path is outside the isolated subagent workspace ${root}/`;
    for (const outside of [
      "shared/brief.md",
      "/shared/brief.md",
      "bots/bot-2/result.md",
      `bots/${BOT_ID}/notes.txt`,
      "/notes.txt",
      `/bots/${BOT_ID}/notes.txt`,
    ]) {
      expect(() => resolveBotWorkspacePath("team", BOT_ID, outside, root)).toThrow(refusal);
    }
  });

  it("still refuses .. traversal", () => {
    expect(() => resolveBotWorkspacePath("team", BOT_ID, "../escape.txt", root)).toThrow(
      "Path escapes the computer workspace",
    );
    expect(() => resolveBotWorkspacePath("team", BOT_ID, "a/../../escape.txt", root)).toThrow(
      "Path escapes the computer workspace",
    );
  });

  it("confines the working directory to the isolation root (team mode)", () => {
    expect(resolveBotWorkspaceCwd("team", BOT_ID, undefined, root)).toBe(storedRoot);
    expect(resolveBotWorkspaceCwd("team", BOT_ID, ".", root)).toBe(storedRoot);
    expect(resolveBotWorkspaceCwd("team", BOT_ID, "src", root)).toBe(`${storedRoot}/src`);
    expect(() => resolveBotWorkspaceCwd("team", BOT_ID, "shared/x", root)).toThrow(
      "outside the isolated subagent workspace",
    );
    expect(() => resolveBotWorkspaceCwd("team", BOT_ID, "/Users/me/project", root)).toThrow(
      "outside the isolated subagent workspace",
    );
    expect(() => resolveBotWorkspaceCwd("team", BOT_ID, String.raw`C:\Users\me`, root)).toThrow(
      "outside the isolated subagent workspace",
    );
  });

  it("resolves dedicated-mode paths under the root, keeping the input's form", () => {
    expect(resolveBotWorkspacePath("dedicated", BOT_ID, "notes.txt", root)).toBe(
      `${root}/notes.txt`,
    );
    expect(resolveBotWorkspacePath("dedicated", BOT_ID, "/notes.txt", root)).toBe(
      `/${root}/notes.txt`,
    );
    expect(resolveBotWorkspacePath("dedicated", BOT_ID, "", root)).toBe(root);
    expect(resolveBotWorkspacePath("dedicated", BOT_ID, "/", root)).toBe(`/${root}`);
    expect(() => resolveBotWorkspacePath("dedicated", BOT_ID, "../x", root)).toThrow(
      "Path escapes the computer workspace",
    );
    expect(resolveBotWorkspaceCwd("dedicated", BOT_ID, undefined, root)).toBe(root);
    expect(resolveBotWorkspaceCwd("dedicated", BOT_ID, "src", root)).toBe(`${root}/src`);
  });

  it("displays stored paths relative to the isolation root", () => {
    expect(displayBotWorkspacePath("team", BOT_ID, "", `${storedRoot}/notes.txt`, root)).toBe(
      "notes.txt",
    );
    expect(displayBotWorkspacePath("team", BOT_ID, "", storedRoot, root)).toBe("");
  });

  it("leaves non-isolated resolution exactly as before", () => {
    expect(resolveBotWorkspacePath("team", BOT_ID, "notes/result.txt")).toBe(
      "bots/bot-1/notes/result.txt",
    );
    expect(resolveBotWorkspacePath("team", BOT_ID, "shared/brief.md")).toBe("shared/brief.md");
    expect(resolveBotWorkspacePath("team", BOT_ID, "")).toBe("bots/bot-1");
    expect(resolveBotWorkspaceCwd("team", BOT_ID, undefined)).toBe("bots/bot-1");
    expect(resolveBotWorkspacePath("dedicated", BOT_ID, "~/notes/x.md")).toBe("/notes/x.md");
  });
});

describe("isolated file tools through the handlers", () => {
  it("writes inside its folder, refuses outside, and never touches the parent file", async () => {
    const rootA = isolatedRoot("writer-a");
    const { sandbox, computer } = await seedBox({
      [`bots/${BOT_ID}/notes.txt`]: "parent notes\n",
    });
    const ctx = fakeCtx(sandbox, computer);
    const write = fileTools.write_file!;
    const result = await write(
      ctx,
      fakeCall(
        "write_file",
        { path: "notes.txt", content: "helper A" },
        isolatedCallId("writer-a"),
      ),
    );
    expect(result).toEqual({ ok: true, path: "notes.txt" });
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/${rootA}/notes.txt`)).toBe(
      "helper A",
    );
    // The parent's file is untouched.
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/notes.txt`)).toBe("parent notes\n");
    // A path that already carries the folder prefix lands in the same place.
    await write(
      ctx,
      fakeCall(
        "write_file",
        { path: `${rootA}/other.txt`, content: "prefixed" },
        isolatedCallId("writer-a"),
      ),
    );
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/${rootA}/other.txt`)).toBe(
      "prefixed",
    );
    expect(
      await readStored(sandbox, computer, `bots/${BOT_ID}/${rootA}/${rootA}/other.txt`),
    ).toBeUndefined();
    // Outside the subtree: refused with a clear error, nothing written.
    await expect(
      write(
        ctx,
        fakeCall(
          "write_file",
          { path: "shared/evil.txt", content: "x" },
          isolatedCallId("writer-a"),
        ),
      ),
    ).rejects.toThrow("Path is outside the isolated subagent workspace");
    await expect(
      write(
        ctx,
        fakeCall("write_file", { path: "../escape.txt", content: "x" }, isolatedCallId("writer-a")),
      ),
    ).rejects.toThrow("Path escapes the computer workspace");
    expect(await readStored(sandbox, computer, "shared/evil.txt")).toBeUndefined();
  });

  it("two isolated subagents writing the same relative file do not clobber each other", async () => {
    const rootA = isolatedRoot("parallel-a");
    const rootB = isolatedRoot("parallel-b");
    const { sandbox, computer } = await seedBox({});
    const ctx = fakeCtx(sandbox, computer);
    const write = fileTools.write_file!;
    await write(
      ctx,
      fakeCall(
        "write_file",
        { path: "notes.txt", content: "A's notes" },
        isolatedCallId("parallel-a"),
      ),
    );
    await write(
      ctx,
      fakeCall(
        "write_file",
        { path: "notes.txt", content: "B's notes" },
        isolatedCallId("parallel-b"),
      ),
    );
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/${rootA}/notes.txt`)).toBe(
      "A's notes",
    );
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/${rootB}/notes.txt`)).toBe(
      "B's notes",
    );
  });

  it("a non-isolated subagent still writes to the workspace root", async () => {
    const { sandbox, computer } = await seedBox({});
    const ctx = fakeCtx(sandbox, computer);
    const result = await fileTools.write_file!(
      ctx,
      fakeCall(
        "write_file",
        { path: "notes.txt", content: "helper, not isolated" },
        nonIsolatedSubagentCallId("plain"),
      ),
    );
    expect(result).toEqual({ ok: true, path: "notes.txt" });
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/notes.txt`)).toBe(
      "helper, not isolated",
    );
  });

  it("reads and lists only inside its folder", async () => {
    const root = isolatedRoot("reader");
    const { sandbox, computer } = await seedBox({
      [`bots/${BOT_ID}/${root}/notes.txt`]: "inside\nline two\n",
      [`bots/${BOT_ID}/secret.txt`]: "parent secret\n",
    });
    const workspace = workspaceFor(computer, root);
    const read = await readFileFromTool(sandbox, workspace, { path: "notes.txt" });
    expect(read).toMatchObject({ path: "notes.txt", content: "inside\nline two\n" });
    const paged = await readFileFromTool(sandbox, workspace, {
      path: "notes.txt",
      offset: 2,
      limit: 1,
    });
    expect(paged).toMatchObject({ content: "line two", totalLines: 2, startLine: 2 });
    // The parent's file cannot be read, even by absolute team path.
    await expect(
      readFileFromTool(sandbox, workspace, { path: `/bots/${BOT_ID}/secret.txt` }),
    ).rejects.toThrow("Path is outside the isolated subagent workspace");
    const listed = await listFilesFromTool(sandbox, workspace, { path: "" });
    expect(listed.entries.map((entry) => entry.path)).toEqual(["notes.txt"]);
    // The parent run still sees its own file.
    const parentListed = await listFilesFromTool(sandbox, workspaceFor(computer), { path: "" });
    expect(parentListed.entries.map((entry) => entry.path)).toContain("secret.txt");
  });

  it("edits and patches inside its folder and refuses outside paths", async () => {
    const root = isolatedRoot("editor");
    const { sandbox, computer } = await seedBox({
      [`bots/${BOT_ID}/${root}/notes.txt`]: "hello world\n",
      "shared/x.txt": "shared file\n",
    });
    const ctx = fakeCtx(sandbox, computer);
    const edited = await editTools.edit!(
      ctx,
      fakeCall(
        "edit",
        { path: "notes.txt", oldString: "world", newString: "there" },
        isolatedCallId("editor"),
      ),
    );
    expect(edited).toMatchObject({ ok: true, path: "notes.txt", replacements: 1 });
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/${root}/notes.txt`)).toBe(
      "hello there\n",
    );
    const refused = await editTools.edit!(
      ctx,
      fakeCall(
        "edit",
        { path: "shared/x.txt", oldString: "shared", newString: "pwned" },
        isolatedCallId("editor"),
      ),
    );
    expect(refused).toMatchObject({
      error: expect.stringContaining("outside the isolated subagent workspace"),
    });
    expect(await readStored(sandbox, computer, "shared/x.txt")).toBe("shared file\n");
    const patched = await editTools.apply_patch!(
      ctx,
      fakeCall(
        "apply_patch",
        {
          patchText: "--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+fresh\n",
        },
        isolatedCallId("editor"),
      ),
    );
    expect(patched).toMatchObject({ ok: true });
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/${root}/added.txt`)).toBe("fresh\n");
    const refusedPatch = await editTools.apply_patch!(
      ctx,
      fakeCall(
        "apply_patch",
        {
          patchText: "--- a/shared/x.txt\n+++ b/shared/x.txt\n@@ -1 +1 @@\n-shared file\n+pwned\n",
        },
        isolatedCallId("editor"),
      ),
    );
    expect(refusedPatch).toMatchObject({
      error: expect.stringContaining("outside the isolated subagent workspace"),
    });
    expect(await readStored(sandbox, computer, "shared/x.txt")).toBe("shared file\n");
  });

  it("deletes only inside its folder", async () => {
    const root = isolatedRoot("deleter");
    const sandbox = new DeletingSandbox();
    const { computer } = await seedBox(
      {
        [`bots/${BOT_ID}/${root}/gone.txt`]: "old\n",
        "shared/keep.txt": "keep\n",
      },
      sandbox,
    );
    const ctx = fakeCtx(sandbox, computer);
    const deleted = await editTools.apply_patch!(
      ctx,
      fakeCall(
        "apply_patch",
        {
          patchText: "--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n",
        },
        isolatedCallId("deleter"),
      ),
    );
    expect(deleted).toMatchObject({
      ok: true,
      results: [{ path: "gone.txt", action: "delete" }],
    });
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/${root}/gone.txt`)).toBeUndefined();
    expect(sandbox.seen).toContainEqual({
      argv: ["rm", "-f", "--", "gone.txt"],
      cwd: `bots/${BOT_ID}/${root}`,
      timeoutMs: 30_000,
    });
    const refused = await editTools.apply_patch!(
      ctx,
      fakeCall(
        "apply_patch",
        {
          patchText: "--- a/shared/keep.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-keep\n",
        },
        isolatedCallId("deleter"),
      ),
    );
    expect(refused).toMatchObject({
      error: expect.stringContaining("outside the isolated subagent workspace"),
    });
    expect(await readStored(sandbox, computer, "shared/keep.txt")).toBe("keep\n");
  });

  it("keeps each helper's undo batch separate", async () => {
    const rootA = isolatedRoot("undo-a");
    const rootB = isolatedRoot("undo-b");
    const { sandbox, computer } = await seedBox({
      [`bots/${BOT_ID}/${rootA}/notes.txt`]: "original\n",
      [`bots/${BOT_ID}/${rootB}/notes.txt`]: "original\n",
    });
    const ctx = fakeCtx(sandbox, computer);
    const edit = editTools.edit!;
    const undo = editTools.undo_edit!;
    await edit(
      ctx,
      fakeCall(
        "edit",
        { path: "notes.txt", oldString: "original", newString: "A edited" },
        isolatedCallId("undo-a"),
      ),
    );
    await edit(
      ctx,
      fakeCall(
        "edit",
        { path: "notes.txt", oldString: "original", newString: "B edited" },
        isolatedCallId("undo-b"),
      ),
    );
    const undoneA = await undo(ctx, fakeCall("undo_edit", {}, isolatedCallId("undo-a", "call-2")));
    expect(undoneA).toMatchObject({ ok: true });
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/${rootA}/notes.txt`)).toBe(
      "original\n",
    );
    // B's edit is untouched by A's undo.
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/${rootB}/notes.txt`)).toBe(
      "B edited\n",
    );
    const undoneB = await undo(ctx, fakeCall("undo_edit", {}, isolatedCallId("undo-b", "call-2")));
    expect(undoneB).toMatchObject({ ok: true });
    expect(await readStored(sandbox, computer, `bots/${BOT_ID}/${rootB}/notes.txt`)).toBe(
      "original\n",
    );
  });
});

describe("isolated search tools through the handlers", () => {
  it("greps and globs only inside its folder", async () => {
    const root = isolatedRoot("searcher");
    const { sandbox, computer } = await seedBox({
      [`bots/${BOT_ID}/${root}/notes.txt`]: "hello from inside\n",
      [`bots/${BOT_ID}/notes.txt`]: "hello from parent\n",
      "shared/x.txt": "hello from shared\n",
    });
    const ctx = fakeCtx(sandbox, computer);
    const grep = await searchTools.grep!(
      ctx,
      fakeCall("grep", { pattern: "hello" }, isolatedCallId("searcher")),
    );
    expect(grep).toEqual({
      matches: [{ path: "notes.txt", line: 1, text: "hello from inside" }],
      truncated: false,
    });
    const glob = await searchTools.glob!(
      ctx,
      fakeCall("glob", { pattern: "*.txt" }, isolatedCallId("searcher")),
    );
    expect(glob).toEqual({ paths: ["notes.txt"], truncated: false });
    await expect(
      searchTools.grep!(
        ctx,
        fakeCall("grep", { pattern: "hello", path: "shared/x.txt" }, isolatedCallId("searcher")),
      ),
    ).rejects.toThrow("Path is outside the isolated subagent workspace");
    // The parent run still searches the whole bot workspace.
    const parentGrep = await searchTools.grep!(
      ctx,
      fakeCall("grep", { pattern: "hello" }, mainCallId()),
    );
    expect(parentGrep).toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({ path: "notes.txt", text: "hello from parent" }),
      ]),
    });
  });
});

describe("isolated shell and git through the handlers", () => {
  it("runs commands with the isolation root as cwd", async () => {
    const root = isolatedRoot("sheller");
    const sandbox = new RecordingSandbox();
    const { computer } = await seedBox({}, sandbox);
    const workspace = workspaceFor(computer, root);
    const result = await runSandboxCommand(sandbox, workspace, ["echo", "hi"]);
    expect(result.code).toBe(0);
    expect(sandbox.seen).toEqual([
      {
        argv: ["echo", "hi"],
        cwd: `bots/${BOT_ID}/${root}`,
        timeoutMs: 120_000,
      },
    ]);
    const parent = await runSandboxCommand(sandbox, workspaceFor(computer), ["echo", "hi"]);
    expect(parent.code).toBe(0);
    expect(sandbox.seen.at(-1)).toEqual({
      argv: ["echo", "hi"],
      cwd: `bots/${BOT_ID}`,
      timeoutMs: 120_000,
    });
  });

  it("scopes git status and diff to its folder and refuses outside paths", async () => {
    const root = isolatedRoot("gitter");
    const sandbox = new RecordingSandbox();
    const { computer } = await seedBox({}, sandbox);
    const ctx = fakeCtx(sandbox, computer);
    await feedbackTools.git_status!(ctx, fakeCall("git_status", {}, isolatedCallId("gitter")));
    expect(sandbox.seen[0]).toEqual({
      argv: ["git", "status", "--porcelain=v1", "-b", "--", "."],
      cwd: `bots/${BOT_ID}/${root}`,
      timeoutMs: 120_000,
    });
    await feedbackTools.git_diff!(ctx, fakeCall("git_diff", {}, isolatedCallId("gitter")));
    expect(sandbox.seen[1]).toEqual({
      argv: ["git", "diff", "--", "."],
      cwd: `bots/${BOT_ID}/${root}`,
      timeoutMs: 120_000,
    });
    await feedbackTools.git_status!(
      ctx,
      fakeCall("git_status", { path: "src" }, isolatedCallId("gitter")),
    );
    expect(sandbox.seen[2]).toEqual({
      argv: ["git", "status", "--porcelain=v1", "-b", "--", "src"],
      cwd: `bots/${BOT_ID}/${root}/src`,
      timeoutMs: 120_000,
    });
    await expect(
      feedbackTools.git_status!(
        ctx,
        fakeCall("git_status", { path: "shared/x" }, isolatedCallId("gitter")),
      ),
    ).rejects.toThrow("Path is outside the isolated subagent workspace");
    expect(sandbox.seen).toHaveLength(3);
    // The parent run's status is still repo-wide.
    await feedbackTools.git_status!(ctx, fakeCall("git_status", {}, mainCallId()));
    expect(sandbox.seen[3]).toEqual({
      argv: ["git", "status", "--porcelain=v1", "-b"],
      cwd: `bots/${BOT_ID}`,
      timeoutMs: 120_000,
    });
  });

  it("refuses an unscoped git commit from an isolated helper", async () => {
    const sandbox = new RecordingSandbox();
    const { computer } = await seedBox({}, sandbox);
    const ctx = fakeCtx(sandbox, computer);
    const refused = await feedbackTools.git_commit!(
      ctx,
      fakeCall("git_commit", { message: "commit everything" }, isolatedCallId("committer")),
    );
    expect(refused).toMatchObject({
      error: expect.stringContaining("isolated helpers can only commit inside"),
    });
    expect(sandbox.seen).toEqual([]);
  });
});

describe("isolated repo map through the handler", () => {
  it("maps only its own folder, and two helpers do not share a cached map", async () => {
    const rootA = isolatedRoot("mapper-a");
    const rootB = isolatedRoot("mapper-b");
    const { sandbox, computer } = await seedBox({
      [`bots/${BOT_ID}/${rootA}/a.ts`]: "export function a() {}\n",
      [`bots/${BOT_ID}/${rootB}/b.ts`]: "export function b() {}\n",
      [`bots/${BOT_ID}/top.ts`]: "export function top() {}\n",
    });
    const ctx = fakeCtx(sandbox, computer);
    const mapA = (await repoMapTools.repo_map!(
      ctx,
      fakeCall("repo_map", {}, isolatedCallId("mapper-a")),
    )) as RepoMap;
    expect(mapA).toMatchObject({ files: 1 });
    expect(mapA.tree).toContain("a.ts");
    expect(mapA.tree).not.toContain("b.ts");
    expect(mapA.tree).not.toContain("top.ts");
    const mapB = (await repoMapTools.repo_map!(
      ctx,
      fakeCall("repo_map", {}, isolatedCallId("mapper-b")),
    )) as RepoMap;
    expect(mapB).toMatchObject({ files: 1 });
    expect(mapB.tree).toContain("b.ts");
    expect(mapB.tree).not.toContain("a.ts");
    const parentMap = (await repoMapTools.repo_map!(
      ctx,
      fakeCall("repo_map", {}, mainCallId()),
    )) as RepoMap;
    expect(parentMap.files).toBe(3);
  });
});

describe("run_subagent prepareArguments keeps isolated", () => {
  // prepareArguments never touches the host, so a stub host is enough: the
  // point is the argument mapping, not executing the tool.
  function preparedArgs(raw: Record<string, unknown>): Record<string, unknown> {
    const tools = toAgentTools(
      [{ name: "run_subagent", description: "", inputSchema: {} } as ConnectorTool],
      {} as ToolHost,
    );
    const tool = tools.find((candidate) => candidate.name === "run_subagent");
    expect(tool?.prepareArguments).toBeDefined();
    if (!tool?.prepareArguments) throw new Error("run_subagent has no prepareArguments");
    return tool.prepareArguments(raw) as Record<string, unknown>;
  }

  it("passes isolated true through to the handler", () => {
    expect(preparedArgs({ name: "helper", task: "explore", isolated: true })).toMatchObject({
      isolated: true,
    });
  });

  it("omits isolated when it is not set", () => {
    const args = preparedArgs({ name: "helper", task: "explore" });
    expect("isolated" in args).toBe(false);
  });
});

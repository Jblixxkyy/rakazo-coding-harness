import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  PortableFile,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { normalizeWorkspacePath } from "./computer-support.js";
import {
  applyEditToContent,
  applyPatchFromTool,
  applyPatchToContent,
  editFromTool,
  parseUnifiedDiff,
  undoEditFromTool,
} from "./edit-tools.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { buildRepoMap } from "./repo-map.js";
import { deleteWorkspaceFile } from "./sandbox-delete.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

const context = {
  operationId: "edit-test",
  traceId: "edit-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

async function seed(
  content: string,
  path = "notes.txt",
  opts: { provider?: FakeSandboxProvider; runId?: string } = {},
) {
  const provider = opts.provider ?? new FakeSandboxProvider();
  const computer = await provider.provision({ botId: "edit-test", homePath: "/ignored" }, context);
  await provider.writeFile(computer, { path, content: new TextEncoder().encode(content) }, context);
  const workspace: RunWorkspace = {
    botId: "edit-test",
    computerMode: "dedicated" as ComputerMode,
    computer: async () => computer,
    markDirty: vi.fn(),
    context: { ...context, runId: opts.runId },
    runSecrets: [],
  };
  const read = async (seededPath = path) => {
    const bytes = await provider.readFile(computer, seededPath, context);
    return new TextDecoder().decode(bytes);
  };
  return { provider, computer, workspace, read };
}

async function emptyWorkspace(opts: { provider?: FakeSandboxProvider; runId?: string } = {}) {
  const provider = opts.provider ?? new FakeSandboxProvider();
  const computer = await provider.provision({ botId: "edit-test", homePath: "/ignored" }, context);
  const workspace: RunWorkspace = {
    botId: "edit-test",
    computerMode: "dedicated" as ComputerMode,
    computer: async () => computer,
    markDirty: vi.fn(),
    context: { ...context, runId: opts.runId },
    runSecrets: [],
  };
  const read = async (seededPath: string) => {
    const bytes = await provider.readFile(computer, seededPath, context);
    return new TextDecoder().decode(bytes);
  };
  return { provider, workspace, read };
}

/**
 * FakeSandboxProvider's execute only echoes unknown commands, so a test
 * double that actually removes the file stands in for a real provider's
 * `rm` (the supervisor runs the same argv in the container). This is
 * test-local on purpose: the shared fake is owned by the coordinator.
 */
class RmFakeSandbox extends FakeSandboxProvider {
  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.argv[0] === "rm") {
      const target = request.argv[request.argv.length - 1] ?? "";
      this.boxes.get(computer.id)?.files.delete(normalizeWorkspacePath(target));
      yield { type: "exit", code: 0 };
      return;
    }
    yield* super.execute(computer, request, context);
  }
}

/** A sandbox whose writes to one path fail, to exercise patch rollback. */
class FailingWriteFake extends RmFakeSandbox {
  /** Writes fail only once armed, so the test can seed files first. */
  failWrites = false;

  constructor(private readonly failPath: string) {
    super();
  }

  override async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    if (this.failWrites && normalizeWorkspacePath(file.path) === this.failPath) {
      throw new Error("disk full");
    }
    return super.writeFile(computer, file, context);
  }
}

describe("applyEditToContent", () => {
  it("replaces one exact match", () => {
    expect(applyEditToContent("hello world\n", "world", "there")).toEqual({
      content: "hello there\n",
      replacements: 1,
    });
  });

  it("replaces all exact matches with replaceAll", () => {
    expect(applyEditToContent("a b a b\n", "a", "z", true)).toEqual({
      content: "z b z b\n",
      replacements: 2,
    });
  });

  it("throws when oldString is missing", () => {
    expect(() => applyEditToContent("hello\n", "goodbye", "x")).toThrow("oldString not found");
  });

  it("throws when oldString is ambiguous", () => {
    expect(() => applyEditToContent("a a\n", "a", "z")).toThrow(
      "oldString matches 2 times; pass replaceAll or a more specific oldString",
    );
  });

  it("accepts one whitespace-tolerant match", () => {
    expect(applyEditToContent("foo(  a,\n   b )\n", "foo( a, b )", "foo(c)")).toEqual({
      content: "foo(c)\n",
      replacements: 1,
    });
  });

  it("throws when the whitespace-tolerant match is ambiguous", () => {
    expect(() => applyEditToContent("foo( a ) foo(  a )\n", "foo(  a  )", "foo(c)")).toThrow(
      "oldString matches 2 times; pass replaceAll or a more specific oldString",
    );
  });

  it("throws on replaceAll with no match", () => {
    expect(() => applyEditToContent("hello\n", "goodbye", "x", true)).toThrow(
      "oldString not found",
    );
  });

  it("deletes with an empty newString", () => {
    expect(applyEditToContent("hello world\n", " world", "")).toEqual({
      content: "hello\n",
      replacements: 1,
    });
  });
});

describe("editFromTool", () => {
  it("edits a file in place and marks the workspace dirty", async () => {
    const { provider, workspace, read } = await seed("hello world\n");
    const result = await editFromTool(provider, workspace, {
      path: "notes.txt",
      oldString: "world",
      newString: "there",
    });
    expect(result).toEqual({ ok: true, path: "notes.txt", replacements: 1, bytes: 12 });
    expect(await read()).toBe("hello there\n");
    expect(workspace.markDirty).toHaveBeenCalled();
  });

  it("replaces all matches with replaceAll", async () => {
    const { provider, workspace, read } = await seed("a b a b\n");
    const result = await editFromTool(provider, workspace, {
      path: "notes.txt",
      oldString: "a",
      newString: "z",
      replaceAll: true,
    });
    expect(result).toEqual({ ok: true, path: "notes.txt", replacements: 2, bytes: 8 });
    expect(await read()).toBe("z b z b\n");
  });

  it("returns an error and leaves the file unchanged when oldString is missing", async () => {
    const { provider, workspace, read } = await seed("hello world\n");
    const result = await editFromTool(provider, workspace, {
      path: "notes.txt",
      oldString: "goodbye",
      newString: "x",
    });
    expect(result).toEqual({ error: "oldString not found in notes.txt", path: "notes.txt" });
    expect(await read()).toBe("hello world\n");
  });

  it("returns an error when oldString is ambiguous", async () => {
    const { provider, workspace, read } = await seed("a a\n");
    const result = await editFromTool(provider, workspace, {
      path: "notes.txt",
      oldString: "a",
      newString: "z",
    });
    expect(result).toEqual({
      error: "oldString matches 2 times; pass replaceAll or a more specific oldString",
      path: "notes.txt",
    });
    expect(await read()).toBe("a a\n");
  });

  it("accepts one whitespace-tolerant match", async () => {
    const { provider, workspace, read } = await seed("foo(  a,\n   b )\n");
    const result = await editFromTool(provider, workspace, {
      path: "notes.txt",
      oldString: "foo( a, b )",
      newString: "foo(c)",
    });
    expect(result).toEqual({ ok: true, path: "notes.txt", replacements: 1, bytes: 7 });
    expect(await read()).toBe("foo(c)\n");
  });

  it("returns an error when the whitespace-tolerant match is ambiguous", async () => {
    const { provider, workspace, read } = await seed("foo( a ) foo(  a )\n");
    const result = await editFromTool(provider, workspace, {
      path: "notes.txt",
      oldString: "foo(  a  )",
      newString: "foo(c)",
    });
    expect(result).toEqual({
      error: "oldString matches 2 times; pass replaceAll or a more specific oldString",
      path: "notes.txt",
    });
    expect(await read()).toBe("foo( a ) foo(  a )\n");
  });

  it("deletes with an empty newString", async () => {
    const { provider, workspace, read } = await seed("hello world\n");
    const result = await editFromTool(provider, workspace, {
      path: "notes.txt",
      oldString: " world",
      newString: "",
    });
    expect(result).toEqual({ ok: true, path: "notes.txt", replacements: 1, bytes: 6 });
    expect(await read()).toBe("hello\n");
  });

  it("refuses traversal and absolute paths", async () => {
    const { provider, workspace } = await seed("hello world\n");
    for (const path of ["../secret.txt", "/etc/passwd", "a/../../secret.txt"]) {
      expect(
        await editFromTool(provider, workspace, {
          path,
          oldString: "hello",
          newString: "x",
        }),
      ).toEqual({ error: "Path escapes the computer workspace", path });
    }
  });

  it("returns an error for a missing file", async () => {
    const { provider, workspace } = await emptyWorkspace();
    expect(
      await editFromTool(provider, workspace, {
        path: "notes.txt",
        oldString: "hello",
        newString: "x",
      }),
    ).toEqual({ error: "file not found", path: "notes.txt" });
  });
});

describe("parseUnifiedDiff and applyPatchToContent", () => {
  function firstFile(patch: string) {
    const files = parseUnifiedDiff(patch);
    const file = files[0];
    if (!file) throw new Error("expected one file in patch");
    return file;
  }

  const updatePatch = [
    "--- a/notes.txt",
    "+++ b/notes.txt",
    "@@ -1,3 +1,3 @@",
    " line one",
    "-line two",
    "+line TWO",
    " line three",
    "",
  ].join("\n");

  it("parses an update patch", () => {
    expect(parseUnifiedDiff(updatePatch)).toEqual([
      {
        path: "notes.txt",
        action: "update",
        hunks: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 3,
            lines: [
              { type: "context", text: "line one" },
              { type: "remove", text: "line two" },
              { type: "add", text: "line TWO" },
              { type: "context", text: "line three" },
            ],
          },
        ],
      },
    ]);
  });

  it("applies a hunk to content", () => {
    expect(
      applyPatchToContent("line one\nline two\nline three\n", firstFile(updatePatch).hunks),
    ).toBe("line one\nline TWO\nline three\n");
  });

  it("applies a hunk found a few lines off", () => {
    expect(
      applyPatchToContent("extra\nline one\nline two\nline three\n", firstFile(updatePatch).hunks),
    ).toBe("extra\nline one\nline TWO\nline three\n");
  });

  it("throws on a malformed diff", () => {
    expect(() => parseUnifiedDiff("this is not a diff\n")).toThrow("malformed patch");
    expect(() => parseUnifiedDiff("")).toThrow("malformed patch");
    expect(() => parseUnifiedDiff("--- a/notes.txt\n+++ b/notes.txt\n@@ bad @@\n")).toThrow(
      "malformed patch",
    );
  });

  it("throws when a hunk does not match", () => {
    expect(() =>
      applyPatchToContent("something else entirely\n", firstFile(updatePatch).hunks),
    ).toThrow("hunk 1 does not apply at line 1");
  });
});

describe("applyPatchFromTool", () => {
  it("adds a new file", async () => {
    const { provider, workspace, read } = await emptyWorkspace();
    const patch = [
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n");
    const result = await applyPatchFromTool(provider, workspace, { patchText: patch });
    expect(result).toEqual({
      ok: true,
      results: [{ path: "new.txt", action: "add", bytes: 12 }],
    });
    expect(await read("new.txt")).toBe("hello\nworld\n");
  });

  it("updates a file", async () => {
    const { provider, workspace, read } = await seed("line one\nline two\nline three\n");
    const patch = [
      "diff --git a/notes.txt b/notes.txt",
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,3 +1,3 @@",
      " line one",
      "-line two",
      "+line TWO",
      " line three",
      "",
    ].join("\n");
    const result = await applyPatchFromTool(provider, workspace, { patchText: patch });
    expect(result).toEqual({
      ok: true,
      results: [{ path: "notes.txt", action: "update", bytes: 29 }],
    });
    expect(await read()).toBe("line one\nline TWO\nline three\n");
  });

  it("deletes a file", async () => {
    const { provider, computer, workspace, read } = await seed(
      "line one\nline two\n",
      "notes.txt",
      {
        provider: new RmFakeSandbox(),
      },
    );
    const patch = [
      "--- a/notes.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line one",
      "-line two",
      "",
    ].join("\n");
    const result = await applyPatchFromTool(provider, workspace, { patchText: patch });
    expect(result).toEqual({
      ok: true,
      results: [{ path: "notes.txt", action: "delete", bytes: 18 }],
    });
    // The file is really gone, not emptied.
    expect(
      (await provider.listFiles(computer, "", context)).map((entry) => entry.path),
    ).not.toContain("notes.txt");
    await expect(read()).rejects.toThrow("not found");
  });

  it("deletes a file inside a patch that also edits another file", async () => {
    const { provider, computer, workspace, read } = await seed(
      "line one\nline two\n",
      "notes.txt",
      {
        provider: new RmFakeSandbox(),
      },
    );
    await provider.writeFile(
      computer,
      { path: "other.txt", content: new TextEncoder().encode("keep me\n") },
      context,
    );
    const patch = [
      "--- a/other.txt",
      "+++ b/other.txt",
      "@@ -1 +1 @@",
      "-keep me",
      "+keep me changed",
      "--- a/notes.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line one",
      "-line two",
      "",
    ].join("\n");
    const result = await applyPatchFromTool(provider, workspace, { patchText: patch });
    expect(result).toEqual({
      ok: true,
      results: [
        { path: "other.txt", action: "update", bytes: 16 },
        { path: "notes.txt", action: "delete", bytes: 18 },
      ],
    });
    expect(await read("other.txt")).toBe("keep me changed\n");
    expect(
      (await provider.listFiles(computer, "", context)).map((entry) => entry.path),
    ).not.toContain("notes.txt");
  });

  it("fails a patch that deletes a missing file without changing other files", async () => {
    const { provider, workspace, read } = await seed("line one\nline two\n");
    const patch = [
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,2 +1,2 @@",
      " line one",
      "-line two",
      "+line TWO",
      "--- a/ghost.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");
    const result = await applyPatchFromTool(provider, workspace, { patchText: patch });
    expect(result).toEqual({ error: "file not found", path: "ghost.txt", results: [] });
    expect(await read()).toBe("line one\nline two\n");
  });

  it("returns an error for a malformed diff", async () => {
    const { provider, workspace } = await emptyWorkspace();
    const result = await applyPatchFromTool(provider, workspace, { patchText: "nope\n" });
    expect(result).toEqual({ error: expect.stringContaining("malformed patch"), results: [] });
  });

  it("refuses a traversal path in the diff", async () => {
    const { provider, workspace } = await emptyWorkspace();
    const patch = ["--- /dev/null", "+++ b/../secret.txt", "@@ -0,0 +1 @@", "+hello", ""].join(
      "\n",
    );
    const result = await applyPatchFromTool(provider, workspace, { patchText: patch });
    expect(result).toEqual({
      error: "Path escapes the computer workspace",
      path: "../secret.txt",
      results: [],
    });
  });

  it("leaves all three files unchanged when a bad hunk fails a 3-file patch", async () => {
    const { provider, computer, workspace, read } = await seed("a1\na2\na3\n", "a.txt");
    await provider.writeFile(
      computer,
      { path: "b.txt", content: new TextEncoder().encode("b1\nb2\nb3\n") },
      context,
    );
    await provider.writeFile(
      computer,
      { path: "c.txt", content: new TextEncoder().encode("c1\nc2\nc3\n") },
      context,
    );
    const patch = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " a1",
      "-a2",
      "+A2",
      " a3",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,3 +1,3 @@",
      " b1",
      "-b2",
      "+B2",
      " b3",
      "--- a/c.txt",
      "+++ b/c.txt",
      "@@ -1,3 +1,3 @@",
      " nope",
      "-c2",
      "+C2",
      " c3",
      "",
    ].join("\n");
    // The hunks for a.txt and b.txt are valid, but the c.txt hunk does not
    // match: validation runs first, so nothing is written at all.
    const result = await applyPatchFromTool(provider, workspace, { patchText: patch });
    expect(result).toEqual({
      error: "patch does not apply to c.txt: hunk 1 does not apply at line 1",
      path: "c.txt",
      results: [],
    });
    expect(await read("a.txt")).toBe("a1\na2\na3\n");
    expect(await read("b.txt")).toBe("b1\nb2\nb3\n");
    expect(await read("c.txt")).toBe("c1\nc2\nc3\n");
  });

  it("rolls back files already changed when a later write fails", async () => {
    const provider = new FailingWriteFake("b.txt");
    const { computer, workspace, read } = await seed("a1\na2\n", "a.txt", { provider });
    await provider.writeFile(
      computer,
      { path: "b.txt", content: new TextEncoder().encode("b1\nb2\n") },
      context,
    );
    // Both hunks validate, so the patch starts applying; the write to b.txt
    // then fails and a.txt must come back.
    provider.failWrites = true;
    const patch = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " a1",
      "-a2",
      "+A2",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,2 +1,2 @@",
      " b1",
      "-b2",
      "+B2",
      "",
    ].join("\n");
    const result = await applyPatchFromTool(provider, workspace, { patchText: patch });
    expect(result).toEqual({
      error: "patch failed on b.txt: disk full; rolled back 1 file(s)",
      path: "b.txt",
      results: [],
    });
    expect(await read("a.txt")).toBe("a1\na2\n");
    expect(await read("b.txt")).toBe("b1\nb2\n");
  });
});

describe("deleteWorkspaceFile", () => {
  it("deletes a file and reports its size", async () => {
    const { provider, computer, workspace } = await seed("line one\nline two\n", "notes.txt", {
      provider: new RmFakeSandbox(),
    });
    expect(await deleteWorkspaceFile(provider, workspace, "notes.txt")).toEqual({
      ok: true,
      path: "notes.txt",
      bytes: 18,
    });
    expect(
      (await provider.listFiles(computer, "", context)).map((entry) => entry.path),
    ).not.toContain("notes.txt");
  });

  it("returns a clear error for a file that does not exist", async () => {
    const { provider, workspace } = await emptyWorkspace({ provider: new RmFakeSandbox() });
    expect(await deleteWorkspaceFile(provider, workspace, "ghost.txt")).toEqual({
      error: "file not found",
      path: "ghost.txt",
    });
  });

  it("refuses traversal and absolute paths", async () => {
    const { provider, workspace } = await seed("hello\n", "notes.txt", {
      provider: new RmFakeSandbox(),
    });
    for (const path of ["../secret.txt", "/etc/passwd", "a/../../secret.txt"]) {
      expect(await deleteWorkspaceFile(provider, workspace, path)).toEqual({
        error: "Path escapes the computer workspace",
        path,
      });
    }
  });

  it("refuses to delete a directory", async () => {
    const { provider, workspace } = await seed("inner\n", "sub/inner.txt", {
      provider: new RmFakeSandbox(),
    });
    expect(await deleteWorkspaceFile(provider, workspace, "sub")).toEqual({
      error: "is a directory; refusing to delete",
      path: "sub",
    });
  });
});

describe("undoEditFromTool", () => {
  it("restores the pre-edit contents", async () => {
    const { provider, workspace, read } = await seed("hello world\n", "notes.txt", {
      runId: "undo-edit-1",
    });
    expect(
      await editFromTool(provider, workspace, {
        path: "notes.txt",
        oldString: "world",
        newString: "there",
      }),
    ).toEqual({ ok: true, path: "notes.txt", replacements: 1, bytes: 12 });
    expect(await undoEditFromTool(provider, workspace, {})).toEqual({
      ok: true,
      restored: [{ path: "notes.txt", action: "restored", bytes: 12 }],
    });
    expect(await read()).toBe("hello world\n");
  });

  it("errors clearly when there is nothing to undo", async () => {
    const { provider, workspace } = await emptyWorkspace({ runId: "undo-empty-1" });
    expect(await undoEditFromTool(provider, workspace, {})).toEqual({
      error: "nothing to undo: no successful edit or patch in this run",
    });
  });

  it("restores a file deleted by apply_patch", async () => {
    const { provider, workspace, read } = await seed("line one\nline two\n", "notes.txt", {
      provider: new RmFakeSandbox(),
      runId: "undo-delete-1",
    });
    const patch = [
      "--- a/notes.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line one",
      "-line two",
      "",
    ].join("\n");
    expect(await applyPatchFromTool(provider, workspace, { patchText: patch })).toEqual({
      ok: true,
      results: [{ path: "notes.txt", action: "delete", bytes: 18 }],
    });
    expect(await undoEditFromTool(provider, workspace, {})).toEqual({
      ok: true,
      restored: [{ path: "notes.txt", action: "restored", bytes: 18 }],
    });
    expect(await read()).toBe("line one\nline two\n");
  });

  it("is a clear no-op error after a failed patch", async () => {
    const { provider, workspace, read } = await seed("line one\nline two\n", "notes.txt", {
      runId: "undo-failed-1",
    });
    const patch = [
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,2 +1,2 @@",
      " nope",
      "-line two",
      "+line TWO",
      "",
    ].join("\n");
    expect(await applyPatchFromTool(provider, workspace, { patchText: patch })).toEqual({
      error: "patch does not apply to notes.txt: hunk 1 does not apply at line 1",
      path: "notes.txt",
      results: [],
    });
    expect(await read()).toBe("line one\nline two\n");
    expect(await undoEditFromTool(provider, workspace, {})).toEqual({
      error: "nothing to undo: no successful edit or patch in this run",
    });
  });

  it("still undoes the earlier successful edit after a patch fails", async () => {
    const { provider, workspace, read } = await seed("hello world\n", "notes.txt", {
      runId: "undo-failed-2",
    });
    await editFromTool(provider, workspace, {
      path: "notes.txt",
      oldString: "world",
      newString: "there",
    });
    const patch = [
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1 +1 @@",
      "-goodbye",
      "+farewell",
      "",
    ].join("\n");
    expect(await applyPatchFromTool(provider, workspace, { patchText: patch })).toMatchObject({
      error: expect.stringContaining("does not apply"),
    });
    expect(await read()).toBe("hello there\n");
    expect(await undoEditFromTool(provider, workspace, {})).toEqual({
      ok: true,
      restored: [{ path: "notes.txt", action: "restored", bytes: 12 }],
    });
    expect(await read()).toBe("hello world\n");
  });

  it("errors on a second undo", async () => {
    const { provider, workspace } = await seed("hello world\n", "notes.txt", {
      runId: "undo-twice-1",
    });
    await editFromTool(provider, workspace, {
      path: "notes.txt",
      oldString: "world",
      newString: "there",
    });
    expect(await undoEditFromTool(provider, workspace, {})).toMatchObject({ ok: true });
    expect(await undoEditFromTool(provider, workspace, {})).toEqual({
      error: "nothing to undo: no successful edit or patch in this run",
    });
  });
});

describe("repo map invalidation", () => {
  it("rebuilds the repo map after an edit, a patch delete, and an undo", async () => {
    const { provider, workspace } = await seed(
      "export function hello() {\n  return 1;\n}\n",
      "a.ts",
      { provider: new RmFakeSandbox(), runId: "repo-map-edit-1" },
    );
    const first = await buildRepoMap(provider, workspace);
    expect(first.tree).toContain("a.ts");
    expect(first.symbols).toEqual([{ name: "hello", kind: "function", path: "a.ts", line: 1 }]);
    // No write: the cached map is served as-is.
    expect(await buildRepoMap(provider, workspace)).toBe(first);
    // Edit renames the function: the next read must rebuild, not serve the
    // cached pre-edit symbols.
    expect(
      await editFromTool(provider, workspace, {
        path: "a.ts",
        oldString: "hello",
        newString: "goodbye",
      }),
    ).toMatchObject({ ok: true });
    const afterEdit = await buildRepoMap(provider, workspace);
    expect(afterEdit).not.toBe(first);
    expect(afterEdit.symbols).toEqual([
      { name: "goodbye", kind: "function", path: "a.ts", line: 1 },
    ]);
    // Delete the file via apply_patch: the next read must drop it.
    const patch = [
      "--- a/a.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-export function goodbye() {",
      "-  return 1;",
      "-}",
      "",
    ].join("\n");
    expect(await applyPatchFromTool(provider, workspace, { patchText: patch })).toMatchObject({
      ok: true,
    });
    const afterDelete = await buildRepoMap(provider, workspace);
    expect(afterDelete.tree).not.toContain("a.ts");
    expect(afterDelete.symbols).toEqual([]);
    // Undo restores the file, so the map must rebuild again.
    expect(await undoEditFromTool(provider, workspace, {})).toMatchObject({ ok: true });
    const afterUndo = await buildRepoMap(provider, workspace);
    expect(afterUndo.tree).toContain("a.ts");
    expect(afterUndo.symbols).toEqual([
      { name: "goodbye", kind: "function", path: "a.ts", line: 1 },
    ]);
  });
});

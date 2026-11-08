import type { ComputerMode } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  applyEditToContent,
  applyPatchFromTool,
  applyPatchToContent,
  editFromTool,
  parseUnifiedDiff,
} from "./edit-tools.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

const context = {
  operationId: "edit-test",
  traceId: "edit-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

async function seed(content: string, path = "notes.txt") {
  const provider = new FakeSandboxProvider();
  const computer = await provider.provision({ botId: "edit-test", homePath: "/ignored" }, context);
  await provider.writeFile(computer, { path, content: new TextEncoder().encode(content) }, context);
  const workspace: RunWorkspace = {
    botId: "edit-test",
    computerMode: "dedicated" as ComputerMode,
    computer: async () => computer,
    markDirty: vi.fn(),
    context,
    runSecrets: [],
  };
  const read = async (seededPath = path) => {
    const bytes = await provider.readFile(computer, seededPath, context);
    return new TextDecoder().decode(bytes);
  };
  return { provider, computer, workspace, read };
}

async function emptyWorkspace() {
  const provider = new FakeSandboxProvider();
  const computer = await provider.provision({ botId: "edit-test", homePath: "/ignored" }, context);
  const workspace: RunWorkspace = {
    botId: "edit-test",
    computerMode: "dedicated" as ComputerMode,
    computer: async () => computer,
    markDirty: vi.fn(),
    context,
    runSecrets: [],
  };
  const read = async (seededPath: string) => {
    const bytes = await provider.readFile(computer, seededPath, context);
    return new TextDecoder().decode(bytes);
  };
  return { provider, workspace, read };
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

  it("deletes a file's content", async () => {
    const { provider, workspace, read } = await seed("line one\nline two\n");
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
      results: [{ path: "notes.txt", action: "delete", bytes: 0 }],
    });
    expect(await read()).toBe("");
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

  it("aborts on a bad hunk, keeping the earlier file and leaving the failing file unwritten", async () => {
    const { provider, computer, workspace, read } = await seed("line one\nline two\nline three\n");
    await provider.writeFile(
      computer,
      { path: "other.txt", content: new TextEncoder().encode("something else entirely\n") },
      context,
    );
    const patch = [
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,3 +1,3 @@",
      " line one",
      "-line two",
      "+line TWO",
      " line three",
      "--- a/other.txt",
      "+++ b/other.txt",
      "@@ -1,3 +1,3 @@",
      " nope",
      "-missing",
      "+replacement",
      " other",
      "",
    ].join("\n");
    // other.txt exists but its content does not match the hunk, so the patch
    // fails on that file after notes.txt was already written.
    const result = await applyPatchFromTool(provider, workspace, { patchText: patch });
    expect(result).toMatchObject({ error: expect.stringContaining("other.txt") });
    expect(result).toMatchObject({
      results: [{ path: "notes.txt", action: "update", bytes: 29 }],
    });
    expect(await read()).toBe("line one\nline TWO\nline three\n");
    expect(await read("other.txt")).toBe("something else entirely\n");
  });
});

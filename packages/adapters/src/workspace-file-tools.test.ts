import type { ComputerMode } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { type RunWorkspace, readFileFromTool } from "./workspace-file-tools.js";

const context = {
  operationId: "read-file-test",
  traceId: "read-file-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

async function seed(content: string, path = "notes.txt") {
  const provider = new FakeSandboxProvider();
  const computer = await provider.provision({ botId: "read-test", homePath: "/ignored" }, context);
  await provider.writeFile(computer, { path, content: new TextEncoder().encode(content) }, context);
  const workspace: RunWorkspace = {
    botId: "read-test",
    computerMode: "dedicated" as ComputerMode,
    computer: async () => computer,
    markDirty: vi.fn(),
    context,
    runSecrets: [],
  };
  return { provider, workspace };
}

const tenLines = `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

describe("readFileFromTool paging", () => {
  it("returns a slice with totalLines, startLine, endLine and truncated", async () => {
    const { provider, workspace } = await seed(tenLines);
    const result = await readFileFromTool(provider, workspace, {
      path: "notes.txt",
      offset: 3,
      limit: 4,
    });
    expect(result).toEqual({
      path: "notes.txt",
      content: "line 3\nline 4\nline 5\nline 6",
      totalLines: 10,
      startLine: 3,
      endLine: 6,
      truncated: true,
    });
  });

  it("returns the whole file when limit runs past the end", async () => {
    const { provider, workspace } = await seed(tenLines);
    const result = await readFileFromTool(provider, workspace, {
      path: "notes.txt",
      offset: 9,
    });
    expect(result).toEqual({
      path: "notes.txt",
      content: "line 9\nline 10",
      totalLines: 10,
      startLine: 9,
      endLine: 10,
      truncated: false,
    });
  });

  it("prefixes line numbers when lineNumbers is true", async () => {
    const { provider, workspace } = await seed(tenLines);
    const result = await readFileFromTool(provider, workspace, {
      path: "notes.txt",
      offset: 2,
      limit: 2,
      lineNumbers: true,
    });
    expect(result).toEqual({
      path: "notes.txt",
      content: "2: line 2\n3: line 3",
      totalLines: 10,
      startLine: 2,
      endLine: 3,
      truncated: true,
    });
  });

  it("returns an empty slice when offset is beyond the end", async () => {
    const { provider, workspace } = await seed(tenLines);
    const result = await readFileFromTool(provider, workspace, { path: "notes.txt", offset: 11 });
    expect(result).toEqual({
      path: "notes.txt",
      content: "",
      totalLines: 10,
      startLine: 11,
      endLine: 10,
      truncated: false,
    });
  });

  it("returns an empty slice for an empty file", async () => {
    const { provider, workspace } = await seed("");
    const result = await readFileFromTool(provider, workspace, { path: "notes.txt", offset: 1 });
    expect(result).toEqual({
      path: "notes.txt",
      content: "",
      totalLines: 0,
      startLine: 1,
      endLine: 0,
      truncated: false,
    });
  });

  it("behaves unchanged when no paging args are given", async () => {
    const { provider, workspace } = await seed(tenLines);
    const result = await readFileFromTool(provider, workspace, { path: "notes.txt" });
    expect(result).toEqual({ path: "notes.txt", content: tenLines });
  });

  it("rejects invalid offset and limit values", async () => {
    const { provider, workspace } = await seed(tenLines);
    expect(await readFileFromTool(provider, workspace, { path: "notes.txt", offset: 0 })).toEqual({
      error: "offset must be a positive integer",
      path: "notes.txt",
    });
    expect(await readFileFromTool(provider, workspace, { path: "notes.txt", offset: -2 })).toEqual({
      error: "offset must be a positive integer",
      path: "notes.txt",
    });
    expect(await readFileFromTool(provider, workspace, { path: "notes.txt", limit: 0 })).toEqual({
      error: "limit must be a positive integer",
      path: "notes.txt",
    });
    expect(await readFileFromTool(provider, workspace, { path: "notes.txt", offset: 1.5 })).toEqual(
      { error: "offset must be a positive integer", path: "notes.txt" },
    );
  });

  it("reads a paged slice of a file larger than the 250KB model cap", async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} ${"x".repeat(90)}`);
    const content = `${lines.join("\n")}\n`;
    expect(new TextEncoder().encode(content).byteLength).toBeGreaterThan(250_000);
    const { provider, workspace } = await seed(content);
    // Without paging the file is too large.
    expect(await readFileFromTool(provider, workspace, { path: "notes.txt" })).toEqual({
      error: "file is too large for model context",
      path: "notes.txt",
    });
    const result = await readFileFromTool(provider, workspace, {
      path: "notes.txt",
      offset: 2000,
      limit: 3,
    });
    expect(result).toEqual({
      path: "notes.txt",
      content: lines.slice(1999, 2002).join("\n"),
      totalLines: 4000,
      startLine: 2000,
      endLine: 2002,
      truncated: true,
    });
  });
});

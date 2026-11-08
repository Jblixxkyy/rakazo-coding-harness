import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { normalizeWorkspacePath } from "./computer-support.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { type RunWorkspace, readFileFromTool } from "./workspace-file-tools.js";

const context = {
  operationId: "read-file-test",
  traceId: "read-file-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

/**
 * A fake whose execute really runs `sed -n 'START,ENDp' FILE` and
 * `awk 'END{print NR}' FILE` against the box files, standing in for a real
 * provider's shell. Test-local on purpose: the shared fake only echoes.
 */
class SedAwkFakeSandbox extends FakeSandboxProvider {
  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const box = this.boxes.get(computer.id);
    const fileAt = (relPath: string): string | null => {
      const stored = box?.files.get(normalizeWorkspacePath(relPath));
      return stored ? new TextDecoder().decode(stored.content) : null;
    };
    if (request.argv[0] === "sed" && request.argv[1] === "-n") {
      const range = /^(\d+),(\d+)p$/.exec(request.argv[2] ?? "");
      const content = fileAt(request.argv[3] ?? "");
      if (!range || content === null) {
        yield { type: "stderr", data: "sed: cannot read file\n" };
        yield { type: "exit", code: 1 };
        return;
      }
      const lines = content === "" ? [] : content.split("\n");
      if (content.endsWith("\n")) lines.pop();
      const start = Number(range[1]);
      const end = Number(range[2]);
      const slice = lines.slice(start - 1, end);
      if (slice.length > 0) yield { type: "stdout", data: `${slice.join("\n")}\n` };
      yield { type: "exit", code: 0 };
      return;
    }
    if (request.argv[0] === "awk" && request.argv[1] === "END{print NR}") {
      const content = fileAt(request.argv[2] ?? "");
      if (content === null) {
        yield { type: "stderr", data: "awk: cannot read file\n" };
        yield { type: "exit", code: 1 };
        return;
      }
      const lines = content === "" ? [] : content.split("\n");
      if (content.endsWith("\n")) lines.pop();
      yield { type: "stdout", data: `${lines.length}\n` };
      yield { type: "exit", code: 0 };
      return;
    }
    yield* super.execute(computer, request, context);
  }
}

/**
 * A shell-capable fake whose readFile refuses any request above a 64 KB
 * chunk: a paged read that succeeds against it provably never loaded the
 * file (or a large slice of it) through readFile. Every readFile call is
 * recorded, so the test can also assert readFile was never called at all.
 */
class BoundedReadFake extends SedAwkFakeSandbox {
  readonly readFileMaxBytes: Array<number | undefined> = [];

  override async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array<ArrayBuffer>> {
    this.readFileMaxBytes.push(options?.maxBytes);
    if (options?.maxBytes !== undefined && options.maxBytes > 65_536) {
      throw new Error(`readFile asked for ${options.maxBytes} bytes, over the 64 KB chunk bound`);
    }
    return super.readFile(computer, filePath, context, options);
  }
}

async function seed(
  content: string,
  path = "notes.txt",
  opts: { provider?: FakeSandboxProvider } = {},
) {
  const provider = opts.provider ?? new FakeSandboxProvider();
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
    // The plain fake's shell only echoes, so this file is only pageable
    // through a shell that really runs sed/awk.
    const { provider, workspace } = await seed(content, "notes.txt", {
      provider: new SedAwkFakeSandbox(),
    });
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

  it("pages a large file without loading it through readFile", async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} ${"x".repeat(90)}`);
    const content = `${lines.join("\n")}\n`;
    expect(new TextEncoder().encode(content).byteLength).toBeGreaterThan(250_000);
    const provider = new BoundedReadFake();
    const { workspace } = await seed(content, "notes.txt", { provider });
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
    // The window crossed the shell only: readFile was never called, so no
    // whole-file (or 1 MB slice) load happened at all. The test never holds
    // more than the seeded content plus the 3-line window.
    expect(provider.readFileMaxBytes).toEqual([]);
  });

  it("refuses a paged read of a large file when the shell cannot page it", async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} ${"x".repeat(90)}`);
    const content = `${lines.join("\n")}\n`;
    expect(new TextEncoder().encode(content).byteLength).toBeGreaterThan(250_000);
    // Plain fake: execute only echoes, so the sed/awk path fails and the
    // readFile fallback is capped at the 250 KB model budget.
    const { provider, workspace } = await seed(content);
    expect(
      await readFileFromTool(provider, workspace, {
        path: "notes.txt",
        offset: 2000,
        limit: 3,
      }),
    ).toEqual({ error: "file is too large for model context", path: "notes.txt" });
  });
});

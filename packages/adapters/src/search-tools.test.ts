import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { normalizeWorkspacePath } from "./computer-support.js";
import { type FakeBox, FakeSandboxProvider } from "./fake-sandbox.js";
import {
  globFromTool,
  globToRegExp,
  grepFromTool,
  isIgnoredPath,
  matchesGlob,
  parseGitignore,
  walkWorkspaceFiles,
} from "./search-tools.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

const context = {
  operationId: "search-test",
  traceId: "search-test",
  spaceId: "search",
  userId: "user",
  signal: new AbortController().signal,
};

async function seedBox(
  files: Record<string, string | Uint8Array>,
  sandbox: FakeSandboxProvider = new FakeSandboxProvider(),
) {
  const computer: ComputerRef = await sandbox.provision(
    { botId: "search-test", homePath: "/ignored" },
    context,
  );
  for (const [filePath, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await sandbox.writeFile(computer, { path: filePath, content: bytes }, context);
  }
  const workspace: RunWorkspace = {
    botId: "search-test",
    computerMode: "dedicated",
    computer: async () => computer,
    markDirty: () => undefined,
    context,
    runSecrets: [],
  };
  return { sandbox, workspace };
}

type ShellToolset = "rg" | "grep" | "none";

/**
 * Test double for a sandbox with a real shell. Extends FakeSandboxProvider
 * (same file map, same readFile/listFiles/writeFile) and emulates the probe,
 * `rg`, `grep -rn` and `find` on that file map, recording every argv. It is
 * not a shell: the probe answer is canned per toolset, and rg/grep/find only
 * implement the exact argv shapes search-tools.ts emits, with the observable
 * behaviour of the real tools (exit codes 0/1/2, `./`-prefixed paths, rg
 * --max-filesize, grep -I skipping binary files, find -prune). That is
 * enough to prove the fast path is used, its output is parsed and filtered,
 * and any failure falls back to the walk.
 */
class ShellStubSandbox extends FakeSandboxProvider {
  readonly commands: string[][] = [];
  failSearch = false;
  probeFails = false;
  hasFind = true;

  constructor(private readonly toolset: ShellToolset = "rg") {
    super();
  }

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    this.commands.push([...request.argv]);
    const box = this.boxes.get(computer.id);
    if (!box) {
      yield { type: "stderr", data: "computer not found" };
      yield { type: "exit", code: 1 };
      return;
    }
    if (request.argv[0] === "sh" && request.argv[1] === "-c") {
      if (this.probeFails) throw new Error("no shell here");
      yield {
        type: "stdout",
        data: `${this.toolset}\n${this.hasFind ? "find" : "nofind"}\nPROBE_DONE\n`,
      };
      yield { type: "exit", code: 0 };
      return;
    }
    if (
      this.failSearch &&
      (request.argv[0] === "rg" || request.argv[0] === "grep" || request.argv[0] === "find")
    ) {
      yield { type: "stderr", data: "simulated tool failure" };
      yield { type: "exit", code: 2 };
      return;
    }
    if (request.argv[0] === "rg") {
      yield* this.runRg(box, request);
      return;
    }
    if (request.argv[0] === "grep") {
      yield* this.runGrep(box, request);
      return;
    }
    if (request.argv[0] === "find") {
      yield* this.runFind(box, request);
      return;
    }
    yield* super.execute(computer, request, context);
  }

  probeCount(): number {
    return this.commands.filter((argv) => argv[0] === "sh").length;
  }

  ran(tool: string): boolean {
    return this.commands.some((argv) => argv[0] === tool);
  }

  private filesUnder(box: FakeBox, cwd: string | undefined) {
    const prefix = cwd ? `${normalizeWorkspacePath(cwd)}/` : "";
    const files: { rel: string; content: Uint8Array }[] = [];
    for (const [stored, file] of [...box.files].sort(([a], [b]) => a.localeCompare(b))) {
      if (stored.startsWith(prefix))
        files.push({ rel: stored.slice(prefix.length), content: file.content });
    }
    return files;
  }

  private decodeText(content: Uint8Array): string | undefined {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      return text.includes("\0") ? undefined : text;
    } catch {
      return undefined;
    }
  }

  private async *runRg(box: FakeBox, request: CommandRequest): AsyncIterable<ProcessEvent> {
    const args = request.argv.slice(1);
    const globs: string[] = [];
    let maxCount: number | undefined;
    let maxFilesize: number | undefined;
    let caseInsensitive = false;
    let pattern: string | undefined;
    let listFiles = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--files") listFiles = true;
      else if (arg === "-i") caseInsensitive = true;
      else if (arg === "--max-count") maxCount = Number(args[index + 1]);
      else if (arg === "--max-filesize") maxFilesize = Number(args[index + 1]);
      else if (arg === "--glob") globs.push(args[index + 1] ?? "");
      else if (arg === "-e") pattern = args[index + 1];
    }
    const files = this.filesUnder(box, request.cwd);
    const excluded = (rel: string) =>
      globs.some((glob) => glob.startsWith("!") && matchesGlob(glob.slice(1), rel));
    const included = (rel: string) =>
      globs.every((glob) => glob.startsWith("!") || matchesGlob(glob, rel));
    if (listFiles) {
      for (const file of files) {
        if (!excluded(file.rel)) yield { type: "stdout", data: `./${file.rel}\n` };
      }
      yield { type: "exit", code: 0 };
      return;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern ?? "", caseInsensitive ? "i" : "");
    } catch {
      yield { type: "stderr", data: "regex parse error" };
      yield { type: "exit", code: 2 };
      return;
    }
    let matched = false;
    for (const file of files) {
      if (maxFilesize !== undefined && file.content.byteLength > maxFilesize) continue;
      if (excluded(file.rel) || !included(file.rel)) continue;
      const text = this.decodeText(file.content);
      if (text === undefined) continue;
      let perFile = 0;
      const lines = text.split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        if (line === undefined || !regex.test(line)) continue;
        if (maxCount !== undefined && perFile >= maxCount) break;
        perFile += 1;
        matched = true;
        yield { type: "stdout", data: `./${file.rel}:${lineIndex + 1}:${line}\n` };
      }
    }
    yield { type: "exit", code: matched ? 0 : 1 };
  }

  private async *runGrep(box: FakeBox, request: CommandRequest): AsyncIterable<ProcessEvent> {
    const args = request.argv.slice(1);
    const excludeDirs: string[] = [];
    const excludes: string[] = [];
    let include: string | undefined;
    let maxCount: number | undefined;
    let caseInsensitive = false;
    let pattern: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? "";
      if (arg === "-i") caseInsensitive = true;
      else if (arg === "-m") maxCount = Number(args[index + 1]);
      else if (arg.startsWith("--exclude-dir="))
        excludeDirs.push(arg.slice("--exclude-dir=".length));
      else if (arg.startsWith("--exclude=")) excludes.push(arg.slice("--exclude=".length));
      else if (arg.startsWith("--include=")) include = arg.slice("--include=".length);
      else if (arg === "-e") pattern = args[index + 1];
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern ?? "", caseInsensitive ? "i" : "");
    } catch {
      yield { type: "stderr", data: "regex parse error" };
      yield { type: "exit", code: 2 };
      return;
    }
    let matched = false;
    for (const file of this.filesUnder(box, request.cwd)) {
      const segments = file.rel.split("/");
      if (segments.some((segment) => excludeDirs.some((dir) => matchesGlob(dir, segment))))
        continue;
      const base = segments[segments.length - 1] ?? "";
      if (excludes.some((exclude) => matchesGlob(exclude, base))) continue;
      if (include && !matchesGlob(include, file.rel)) continue;
      const text = this.decodeText(file.content);
      if (text === undefined) continue;
      let perFile = 0;
      const lines = text.split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        if (line === undefined || !regex.test(line)) continue;
        if (maxCount !== undefined && perFile >= maxCount) break;
        perFile += 1;
        matched = true;
        yield { type: "stdout", data: `./${file.rel}:${lineIndex + 1}:${line}\n` };
      }
    }
    yield { type: "exit", code: matched ? 0 : 1 };
  }

  private async *runFind(box: FakeBox, request: CommandRequest): AsyncIterable<ProcessEvent> {
    const pruned = new Set<string>();
    const args = request.argv.slice(1);
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "-name" && args[index + 2] === "-prune")
        pruned.add(args[index + 1] ?? "");
    }
    for (const file of this.filesUnder(box, request.cwd)) {
      const segments = file.rel.split("/").slice(0, -1);
      if (segments.some((segment) => pruned.has(segment))) continue;
      yield { type: "stdout", data: `./${file.rel}\n` };
    }
    yield { type: "exit", code: 0 };
  }
}

async function seedShellBox(
  files: Record<string, string | Uint8Array>,
  toolset: ShellToolset = "rg",
  options: { probeFails?: boolean; hasFind?: boolean; failSearch?: boolean } = {},
) {
  const sandbox = new ShellStubSandbox(toolset);
  sandbox.probeFails = options.probeFails ?? false;
  sandbox.hasFind = options.hasFind ?? true;
  sandbox.failSearch = options.failSearch ?? false;
  return { ...(await seedBox(files, sandbox)), sandbox };
}

describe("matchesGlob", () => {
  it("matches a bare pattern against the basename at any depth", () => {
    expect(matchesGlob("*.ts", "a.ts")).toBe(true);
    expect(matchesGlob("*.ts", "src/deep/a.ts")).toBe(true);
    expect(matchesGlob("*.ts", "src/a.js")).toBe(false);
  });

  it("matches a slashed pattern against the full relative path", () => {
    expect(matchesGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/*.ts", "src/deep/a.ts")).toBe(false);
    expect(matchesGlob("src/*.ts", "other/a.ts")).toBe(false);
    expect(matchesGlob("**/*.ts", "src/deep/a.ts")).toBe(true);
    expect(matchesGlob("**/*.ts", "a.ts")).toBe(true);
    expect(matchesGlob("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/**/*.ts", "src/deep/nested/a.ts")).toBe(true);
  });

  it("supports ? and character classes", () => {
    expect(matchesGlob("file?.ts", "file1.ts")).toBe(true);
    expect(matchesGlob("file?.ts", "file12.ts")).toBe(false);
    expect(matchesGlob("[ab].ts", "a.ts")).toBe(true);
    expect(matchesGlob("[ab].ts", "c.ts")).toBe(false);
    expect(matchesGlob("src/[a-c]*.ts", "src/beta.ts")).toBe(true);
  });

  it("does not let * cross a path separator", () => {
    expect(matchesGlob("*.ts", "src/a.ts")).toBe(true); // basename match
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
  });
});

describe("parseGitignore and isIgnoredPath", () => {
  it("parses patterns, skipping blanks, comments and negations", () => {
    expect(parseGitignore("# comment\n\n*.log\nbuild/\n!important.txt\n")).toEqual([
      "*.log",
      "build/",
    ]);
  });

  it("matches basename patterns at any depth and anchored patterns at the root", () => {
    expect(isIgnoredPath("debug.log", ["*.log"])).toBe(true);
    expect(isIgnoredPath("src/deep/debug.log", ["*.log"])).toBe(true);
    expect(isIgnoredPath("src/debug.txt", ["*.log"])).toBe(false);
    expect(isIgnoredPath("debug.log", ["/debug.log"])).toBe(true);
    expect(isIgnoredPath("src/debug.log", ["/debug.log"])).toBe(false);
    expect(isIgnoredPath("docs/a.md", ["docs/*.md"])).toBe(true);
    expect(isIgnoredPath("src/docs/a.md", ["docs/*.md"])).toBe(false);
  });

  it("ignores everything under a directory pattern", () => {
    expect(isIgnoredPath("build/output.js", ["build/"])).toBe(true);
    expect(isIgnoredPath("build/nested/output.js", ["build"])).toBe(true);
    expect(isIgnoredPath("src/build/output.js", ["build/"])).toBe(true);
    expect(isIgnoredPath("src/build.ts", ["build/"])).toBe(false);
  });
});

describe("grepFromTool", () => {
  it("finds matches with workspace-relative path, line and text", async () => {
    const { sandbox, workspace } = await seedBox({
      "src/a.ts": "hello world\nsecond line\nhello again\n",
      "src/b.ts": "nothing here\n",
      "notes.txt": "say hello\n",
    });
    const result = await grepFromTool(sandbox, workspace, { pattern: "hello" });
    expect(result).toEqual({
      matches: [
        { path: "notes.txt", line: 1, text: "say hello" },
        { path: "src/a.ts", line: 1, text: "hello world" },
        { path: "src/a.ts", line: 3, text: "hello again" },
      ],
      truncated: false,
    });
  });

  it("limits matches and reports truncated", async () => {
    const { sandbox, workspace } = await seedBox({
      "a.txt": "hit\nhit\nhit\nhit\nhit\n",
    });
    const result = await grepFromTool(sandbox, workspace, { pattern: "hit", limit: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("does not report truncated when matches fit exactly", async () => {
    const { sandbox, workspace } = await seedBox({ "a.txt": "hit\nhit\n" });
    expect(await grepFromTool(sandbox, workspace, { pattern: "hit", limit: 2 })).toEqual({
      matches: [
        { path: "a.txt", line: 1, text: "hit" },
        { path: "a.txt", line: 2, text: "hit" },
      ],
      truncated: false,
    });
  });

  it("matches case-insensitively when asked", async () => {
    const { sandbox, workspace } = await seedBox({ "a.txt": "Hello\nHELLO\nbye\n" });
    expect(
      await grepFromTool(sandbox, workspace, { pattern: "hello", caseSensitive: false }),
    ).toEqual({
      matches: [
        { path: "a.txt", line: 1, text: "Hello" },
        { path: "a.txt", line: 2, text: "HELLO" },
      ],
      truncated: false,
    });
    expect(await grepFromTool(sandbox, workspace, { pattern: "hello" })).toEqual({
      matches: [],
      truncated: false,
    });
  });

  it("filters by include glob", async () => {
    const { sandbox, workspace } = await seedBox({
      "src/a.ts": "needle\n",
      "src/b.js": "needle\n",
    });
    expect(await grepFromTool(sandbox, workspace, { pattern: "needle", include: "*.ts" })).toEqual({
      matches: [{ path: "src/a.ts", line: 1, text: "needle" }],
      truncated: false,
    });
  });

  it("searches only under the given root path", async () => {
    const { sandbox, workspace } = await seedBox({
      "src/a.ts": "needle\n",
      "other/b.ts": "needle\n",
    });
    expect(await grepFromTool(sandbox, workspace, { pattern: "needle", path: "src" })).toEqual({
      matches: [{ path: "src/a.ts", line: 1, text: "needle" }],
      truncated: false,
    });
  });

  it("skips ignored directories", async () => {
    const { sandbox, workspace } = await seedBox({
      "node_modules/dep/index.js": "needle\n",
      "dist/bundle.js": "needle\n",
      ".git/config": "needle\n",
      "__pycache__/mod.pyc": "needle\n",
      "src/a.ts": "needle\n",
    });
    const result = await grepFromTool(sandbox, workspace, { pattern: "needle" });
    expect(result).toEqual({
      matches: [{ path: "src/a.ts", line: 1, text: "needle" }],
      truncated: false,
    });
  });

  it("respects .gitignore at the workspace root", async () => {
    const { sandbox, workspace } = await seedBox({
      ".gitignore": "*.log\nignored-dir/\n",
      "debug.log": "needle\n",
      "ignored-dir/notes.txt": "needle\n",
      "keep.txt": "needle\n",
    });
    const result = await grepFromTool(sandbox, workspace, { pattern: "needle" });
    expect(result).toEqual({
      matches: [{ path: "keep.txt", line: 1, text: "needle" }],
      truncated: false,
    });
  });

  it("refuses paths that escape the workspace", async () => {
    const { sandbox, workspace } = await seedBox({ "a.txt": "needle\n" });
    expect(await grepFromTool(sandbox, workspace, { pattern: "needle", path: "../x" })).toEqual({
      error: "Path escapes the computer workspace",
    });
    expect(
      await grepFromTool(sandbox, workspace, { pattern: "needle", path: "/etc/passwd" }),
    ).toEqual({ error: "Path escapes the computer workspace" });
    expect(
      await grepFromTool(sandbox, workspace, { pattern: "needle", path: "a/../../x" }),
    ).toEqual({ error: "Path escapes the computer workspace" });
  });

  it("reports an invalid regex", async () => {
    const { sandbox, workspace } = await seedBox({ "a.txt": "x\n" });
    const result = await grepFromTool(sandbox, workspace, { pattern: "(" });
    expect(result.error).toMatch(/^invalid regex: /);
  });

  it("skips binary and oversize files", async () => {
    const { sandbox, workspace } = await seedBox({
      "binary.dat": new Uint8Array([0xff, 0xfe, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]),
      "big.txt": new TextEncoder().encode(`needle\n${"x".repeat(300_000)}`),
      "small.txt": "needle\n",
    });
    const result = await grepFromTool(sandbox, workspace, { pattern: "needle" });
    expect(result).toEqual({
      matches: [{ path: "small.txt", line: 1, text: "needle" }],
      truncated: false,
    });
  });

  it("stops scanning after 2000 files and reports truncated", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 2001; index += 1) {
      // Sorted last, so it is only reached if the scan cap does not apply.
      files[`f${String(index).padStart(4, "0")}.txt`] = index === 2000 ? "needle\n" : "nothing\n";
    }
    const { sandbox, workspace } = await seedBox(files);
    const result = await grepFromTool(sandbox, workspace, { pattern: "needle" });
    expect(result).toEqual({ matches: [], truncated: true });
  });

  it("redacts run secrets from matched text", async () => {
    const { sandbox, workspace } = await seedBox({ "a.txt": "token hunter2 here\n" });
    workspace.runSecrets.push("hunter2");
    expect(await grepFromTool(sandbox, workspace, { pattern: "token" })).toEqual({
      matches: [{ path: "a.txt", line: 1, text: "token [redacted] here" }],
      truncated: false,
    });
  });
});

describe("globFromTool", () => {
  it("matches basenames at any depth and full paths", async () => {
    const { sandbox, workspace } = await seedBox({
      "src/a.ts": "",
      "src/deep/b.ts": "",
      "src/c.js": "",
      "top.ts": "",
    });
    expect(await globFromTool(sandbox, workspace, { pattern: "*.ts" })).toEqual({
      paths: ["src/a.ts", "src/deep/b.ts", "top.ts"],
      truncated: false,
    });
    expect(await globFromTool(sandbox, workspace, { pattern: "src/*.ts" })).toEqual({
      paths: ["src/a.ts"],
      truncated: false,
    });
    expect(await globFromTool(sandbox, workspace, { pattern: "**/*.ts" })).toEqual({
      paths: ["src/a.ts", "src/deep/b.ts", "top.ts"],
      truncated: false,
    });
  });

  it("limits results and reports truncated", async () => {
    const { sandbox, workspace } = await seedBox({
      "a.ts": "",
      "b.ts": "",
      "c.ts": "",
    });
    expect(await globFromTool(sandbox, workspace, { pattern: "*.ts", limit: 2 })).toEqual({
      paths: ["a.ts", "b.ts"],
      truncated: true,
    });
  });

  it("skips ignored directories and honours .gitignore", async () => {
    const { sandbox, workspace } = await seedBox({
      ".gitignore": "*.log\n",
      "node_modules/dep/index.js": "",
      "debug.log": "",
      "src/a.ts": "",
    });
    expect(await globFromTool(sandbox, workspace, { pattern: "**/*" })).toEqual({
      paths: [".gitignore", "src/a.ts"],
      truncated: false,
    });
  });

  it("refuses paths that escape the workspace", async () => {
    const { sandbox, workspace } = await seedBox({ "a.ts": "" });
    expect(await globFromTool(sandbox, workspace, { pattern: "*.ts", path: "../x" })).toEqual({
      error: "Path escapes the computer workspace",
    });
    expect(
      await globFromTool(sandbox, workspace, { pattern: "*.ts", path: "/etc/passwd" }),
    ).toEqual({ error: "Path escapes the computer workspace" });
  });

  it("requires a pattern", async () => {
    const { sandbox, workspace } = await seedBox({ "a.ts": "" });
    expect(await globFromTool(sandbox, workspace, {})).toEqual({ error: "pattern is required" });
    expect(await grepFromTool(sandbox, workspace, {})).toEqual({ error: "pattern is required" });
  });
});

describe("walkWorkspaceFiles", () => {
  it("returns sorted workspace-relative file paths, honouring ignores", async () => {
    const { sandbox, workspace } = await seedBox({
      "b.txt": "",
      "src/a.ts": "",
      "node_modules/dep/index.js": "",
      "dist/out.js": "",
    });
    expect(await walkWorkspaceFiles(sandbox, workspace)).toEqual(["b.txt", "src/a.ts"]);
    expect(await walkWorkspaceFiles(sandbox, workspace, "src")).toEqual(["src/a.ts"]);
  });

  it("still lists an explicitly searched ignored directory", async () => {
    const { sandbox, workspace } = await seedBox({
      "node_modules/dep/index.js": "",
      "node_modules/dep/nested/other.js": "",
    });
    expect(await walkWorkspaceFiles(sandbox, workspace, "node_modules")).toEqual([
      "node_modules/dep/index.js",
      "node_modules/dep/nested/other.js",
    ]);
  });
});

describe("grep fast path (rg)", () => {
  const tree = {
    // Anchored /debug.log ignores the root file only; sub/debug.log must
    // still match on both paths (the fast path must not over-prune it).
    ".gitignore": "/debug.log\nignored-dir/\n",
    "debug.log": "needle\n",
    "ignored-dir/notes.txt": "needle\n",
    "keep.txt": "needle\n",
    "node_modules/dep/index.js": "needle\n",
    "src/a.ts": "hello world\nsecond line\nhello again\n",
    "src/b.ts": "nothing here\n",
    "sub/debug.log": "needle\n",
  };

  it("finds matches through rg, honouring ignores, with the walk's shape", async () => {
    const { sandbox, workspace } = await seedShellBox(tree, "rg");
    expect(await grepFromTool(sandbox, workspace, { pattern: "needle" })).toEqual({
      matches: [
        { path: "keep.txt", line: 1, text: "needle" },
        { path: "sub/debug.log", line: 1, text: "needle" },
      ],
      truncated: false,
    });
    expect(sandbox.ran("rg")).toBe(true);
    expect(sandbox.probeCount()).toBe(1);
  });

  it("matches the walk result exactly on the same tree", async () => {
    const fast = await seedShellBox(tree, "rg");
    const walked = await seedBox(tree);
    for (const args of [
      { pattern: "hello" },
      { pattern: "HELLO", caseSensitive: false },
      { pattern: "needle", include: "*.txt" },
      { pattern: "needle", path: "src" },
      { pattern: "needle", limit: 1 },
    ]) {
      expect(await grepFromTool(fast.sandbox, fast.workspace, args)).toEqual(
        await grepFromTool(walked.sandbox, walked.workspace, args),
      );
    }
  });

  it("probes once per computer across grep and glob calls", async () => {
    const { sandbox, workspace } = await seedShellBox(tree, "rg");
    await grepFromTool(sandbox, workspace, { pattern: "needle" });
    await grepFromTool(sandbox, workspace, { pattern: "hello" });
    await globFromTool(sandbox, workspace, { pattern: "*.ts" });
    expect(sandbox.probeCount()).toBe(1);
  });

  it("skips oversize files on the rg path", async () => {
    const { sandbox, workspace } = await seedShellBox({
      "big.txt": new TextEncoder().encode(`needle\n${"x".repeat(300_000)}`),
      "small.txt": "needle\n",
    });
    expect(await grepFromTool(sandbox, workspace, { pattern: "needle" })).toEqual({
      matches: [{ path: "small.txt", line: 1, text: "needle" }],
      truncated: false,
    });
  });

  it("falls back to the walk when rg fails", async () => {
    const { sandbox, workspace } = await seedShellBox(tree, "rg", { failSearch: true });
    expect(await grepFromTool(sandbox, workspace, { pattern: "needle" })).toEqual({
      matches: [
        { path: "keep.txt", line: 1, text: "needle" },
        { path: "sub/debug.log", line: 1, text: "needle" },
      ],
      truncated: false,
    });
  });

  it("falls back to the walk when the probe fails", async () => {
    const { sandbox, workspace } = await seedShellBox(tree, "rg", { probeFails: true });
    expect(await grepFromTool(sandbox, workspace, { pattern: "needle" })).toEqual({
      matches: [
        { path: "keep.txt", line: 1, text: "needle" },
        { path: "sub/debug.log", line: 1, text: "needle" },
      ],
      truncated: false,
    });
    expect(sandbox.ran("rg")).toBe(false);
  });
});

describe("grep fast path (grep)", () => {
  it("finds matches through grep, honouring ignores", async () => {
    const { sandbox, workspace } = await seedShellBox(
      {
        ".gitignore": "*.log\n",
        "debug.log": "needle\n",
        "keep.txt": "needle\n",
        "node_modules/dep/index.js": "needle\n",
        "src/a.ts": "Needle\nneedle\n",
      },
      "grep",
    );
    expect(await grepFromTool(sandbox, workspace, { pattern: "needle" })).toEqual({
      matches: [
        { path: "keep.txt", line: 1, text: "needle" },
        { path: "src/a.ts", line: 2, text: "needle" },
      ],
      truncated: false,
    });
    expect(sandbox.ran("grep")).toBe(true);
    expect(sandbox.ran("rg")).toBe(false);
  });

  it("matches the walk result exactly on the same tree", async () => {
    const tree = {
      "a.txt": "hello\nHELLO\n",
      "src/b.ts": "hello again\n",
      "src/c.js": "hello\n",
    };
    const fast = await seedShellBox(tree, "grep");
    const walked = await seedBox(tree);
    for (const args of [
      { pattern: "hello" },
      { pattern: "hello", caseSensitive: false },
      { pattern: "hello", include: "*.ts" },
      { pattern: "hello", limit: 2 },
    ]) {
      expect(await grepFromTool(fast.sandbox, fast.workspace, args)).toEqual(
        await grepFromTool(walked.sandbox, walked.workspace, args),
      );
    }
  });

  it("falls back to the walk when grep fails", async () => {
    const { sandbox, workspace } = await seedShellBox({ "a.txt": "needle\n" }, "grep", {
      failSearch: true,
    });
    expect(await grepFromTool(sandbox, workspace, { pattern: "needle" })).toEqual({
      matches: [{ path: "a.txt", line: 1, text: "needle" }],
      truncated: false,
    });
  });
});

describe("glob fast path", () => {
  const tree = {
    ".gitignore": "*.log\n",
    "debug.log": "",
    "src/a.ts": "",
    "src/deep/b.ts": "",
    "src/c.js": "",
    "top.ts": "",
    "node_modules/dep/index.js": "",
  };

  it("lists files through rg --files", async () => {
    const { sandbox, workspace } = await seedShellBox(tree, "rg");
    expect(await globFromTool(sandbox, workspace, { pattern: "**/*" })).toEqual({
      paths: [".gitignore", "src/a.ts", "src/c.js", "src/deep/b.ts", "top.ts"],
      truncated: false,
    });
    expect(await globFromTool(sandbox, workspace, { pattern: "*.ts" })).toEqual({
      paths: ["src/a.ts", "src/deep/b.ts", "top.ts"],
      truncated: false,
    });
    expect(sandbox.ran("rg")).toBe(true);
  });

  it("lists files through find when only grep is available", async () => {
    const { sandbox, workspace } = await seedShellBox(tree, "grep");
    expect(await globFromTool(sandbox, workspace, { pattern: "*.ts" })).toEqual({
      paths: ["src/a.ts", "src/deep/b.ts", "top.ts"],
      truncated: false,
    });
    expect(sandbox.ran("find")).toBe(true);
    expect(sandbox.ran("rg")).toBe(false);
  });

  it("falls back to the walk for glob when find is unavailable", async () => {
    const { sandbox, workspace } = await seedShellBox(tree, "grep", { hasFind: false });
    expect(await globFromTool(sandbox, workspace, { pattern: "*.ts" })).toEqual({
      paths: ["src/a.ts", "src/deep/b.ts", "top.ts"],
      truncated: false,
    });
    expect(sandbox.ran("find")).toBe(false);
    expect(sandbox.ran("rg")).toBe(false);
  });

  it("falls back to the walk when the listing fails", async () => {
    const { sandbox, workspace } = await seedShellBox(tree, "rg", { failSearch: true });
    expect(await globFromTool(sandbox, workspace, { pattern: "*.ts" })).toEqual({
      paths: ["src/a.ts", "src/deep/b.ts", "top.ts"],
      truncated: false,
    });
  });
});

import type { ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakeSandboxProvider } from "./fake-sandbox.js";
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

async function seedBox(files: Record<string, string | Uint8Array>) {
  const sandbox = new FakeSandboxProvider();
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

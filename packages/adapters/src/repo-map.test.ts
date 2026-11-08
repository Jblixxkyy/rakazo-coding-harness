import { describe, expect, it } from "vitest";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import {
  buildRepoMap,
  formatRepoMapForPrompt,
  invalidateRepoMap,
  invalidateRepoMapForWorkspace,
  isCodeRelated,
  repoMapTools,
} from "./repo-map.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

const context = {
  operationId: "repo-map-test",
  traceId: "repo-map-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

async function seedWorkspace(botId: string, files: Record<string, string>) {
  const sandbox = new FakeSandboxProvider();
  const computer = await sandbox.provision({ botId, homePath: "/ignored" }, context);
  for (const [path, content] of Object.entries(files)) {
    await sandbox.writeFile(
      computer,
      { path, content: new TextEncoder().encode(content) },
      context,
    );
  }
  const workspace: RunWorkspace = {
    botId,
    computerMode: "dedicated",
    computer: async () => computer,
    markDirty: () => {},
    context,
    runSecrets: [],
  };
  return { sandbox, computer, workspace };
}

const repoFiles: Record<string, string> = {
  "src/index.ts": "export function start() {}\nexport class Server {}\nfunction helper() {}\n",
  "src/util.ts":
    "export interface Config {}\nexport type Mode = string;\nexport const VERSION = 1;\n",
  "src/main.py": "def run():\n    pass\n\nclass Worker:\n    pass\n",
  "src/app.go": "package main\n\nfunc main() {}\n\nfunc (s *Store) Save() {}\n",
  "src/notes.txt": "hello\n",
  "big.ts": `//${"x".repeat(300_000)}\nexport function big() {}\n`,
  "generated.ts": "export function generated() {}\n",
  "node_modules/lib/index.js": "function hidden() {}\n",
  ".git/config": "x",
  "dist/bundle.js": "function hidden() {}\n",
  "src/__pycache__/mod.pyc": "hidden",
  ".venv/lib/x.py": "def hidden():\n    pass\n",
  "build/out.js": "function hidden() {}\n",
  "coverage/lcov.info": "hidden",
  ".next/static/x.js": "function hidden() {}\n",
  "ignored/secret.ts": "export function hidden() {}\n",
  "debug.log": "x",
  ".gitignore": "ignored/\n*.log\n**/generated.ts\n",
  "README.md": "# repo\n",
};

describe("buildRepoMap", () => {
  it("lists the tree, extracts symbols, and honours ignores and .gitignore", async () => {
    const { sandbox, workspace } = await seedWorkspace("repo-map-tree", repoFiles);
    const map = await buildRepoMap(sandbox, workspace);

    expect(new Set(map.tree.split("\n"))).toEqual(
      new Set([
        ".gitignore",
        "README.md",
        "big.ts",
        "src/",
        "  app.go",
        "  index.ts",
        "  main.py",
        "  notes.txt",
        "  util.ts",
      ]),
    );
    expect(map.tree).not.toContain("node_modules");
    expect(map.tree).not.toContain(".git/");
    expect(map.tree).not.toContain("dist");
    expect(map.tree).not.toContain("__pycache__");
    expect(map.tree).not.toContain(".venv");
    expect(map.tree).not.toContain("build");
    expect(map.tree).not.toContain("coverage");
    expect(map.tree).not.toContain(".next");
    expect(map.tree).not.toContain("ignored");
    expect(map.tree).not.toContain("debug.log");
    expect(map.tree).not.toContain("generated.ts");
    expect(map.files).toBe(8);
    expect(map.truncated).toBe(false);
    expect(map.symbols).toHaveLength(10);
    for (const symbol of [
      { name: "start", kind: "function", path: "src/index.ts", line: 1 },
      { name: "Server", kind: "class", path: "src/index.ts", line: 2 },
      { name: "helper", kind: "function", path: "src/index.ts", line: 3 },
      { name: "Config", kind: "interface", path: "src/util.ts", line: 1 },
      { name: "Mode", kind: "type", path: "src/util.ts", line: 2 },
      { name: "VERSION", kind: "const", path: "src/util.ts", line: 3 },
      { name: "run", kind: "function", path: "src/main.py", line: 1 },
      { name: "Worker", kind: "class", path: "src/main.py", line: 4 },
      { name: "main", kind: "function", path: "src/app.go", line: 3 },
      { name: "Save", kind: "function", path: "src/app.go", line: 5 },
    ]) {
      expect(map.symbols).toContainEqual(symbol);
    }
    // The oversized file is counted and listed, but its symbols are not scanned.
    expect(map.symbols).not.toContainEqual(expect.objectContaining({ name: "big" }));
  });

  it("caps the tree at 200 lines", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 250; index++) {
      const name = `f${String(index).padStart(3, "0")}.ts`;
      files[name] = `export function f${index}() {}\n`;
    }
    const { sandbox, workspace } = await seedWorkspace("repo-map-tree-cap", files);
    const map = await buildRepoMap(sandbox, workspace);

    expect(map.files).toBe(250);
    expect(map.tree.split("\n")).toHaveLength(200);
    expect(map.tree.split("\n")[0]).toBe("f000.ts");
    expect(map.tree.split("\n")[199]).toBe("f199.ts");
    expect(map.truncated).toBe(true);
    expect(map.symbols).toHaveLength(250);
  });

  it("caps symbols at 300", async () => {
    const lines = Array.from({ length: 350 }, (_, index) => `export function f${index}() {}`);
    const { sandbox, workspace } = await seedWorkspace("repo-map-symbol-cap", {
      "many.ts": `${lines.join("\n")}\n`,
    });
    const map = await buildRepoMap(sandbox, workspace);

    expect(map.files).toBe(1);
    expect(map.symbols).toHaveLength(300);
    expect(map.symbols[299]?.name).toBe("f299");
    expect(map.truncated).toBe(true);
  });

  it("caches per bot until refresh", async () => {
    const { sandbox, computer, workspace } = await seedWorkspace("repo-map-cache", {
      "a.ts": "export function a() {}\n",
    });
    const first = await buildRepoMap(sandbox, workspace);
    await sandbox.writeFile(
      computer,
      { path: "b.ts", content: new TextEncoder().encode("export function b() {}\n") },
      context,
    );
    const second = await buildRepoMap(sandbox, workspace);
    expect(second).toBe(first);
    expect(second.files).toBe(1);
    expect(second.symbols).toEqual([{ name: "a", kind: "function", path: "a.ts", line: 1 }]);
    const refreshed = await buildRepoMap(sandbox, workspace, { refresh: true });
    expect(refreshed).not.toBe(first);
    expect(refreshed.files).toBe(2);
    expect(refreshed.symbols.map((symbol) => symbol.name).sort()).toEqual(["a", "b"]);
  });

  it("rebuilds after invalidation and keeps serving the cache otherwise", async () => {
    const { sandbox, computer, workspace } = await seedWorkspace("repo-map-invalidate", {
      "a.ts": "export function a() {}\n",
    });
    const first = await buildRepoMap(sandbox, workspace);
    // A write with no invalidation leaves the cached map in place.
    await sandbox.writeFile(
      computer,
      { path: "b.ts", content: new TextEncoder().encode("export function b() {}\n") },
      context,
    );
    expect(await buildRepoMap(sandbox, workspace)).toBe(first);
    // Invalidating after the write makes the next read rebuild with the new file.
    invalidateRepoMap("repo-map-invalidate", "dedicated");
    const rebuilt = await buildRepoMap(sandbox, workspace);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.files).toBe(2);
    expect(rebuilt.symbols.map((symbol) => symbol.name).sort()).toEqual(["a", "b"]);
    // With nothing changed, the rebuilt map is served from cache again.
    expect(await buildRepoMap(sandbox, workspace)).toBe(rebuilt);
    // Invalidating with no write still rebuilds (same content, new object).
    invalidateRepoMapForWorkspace(workspace);
    const again = await buildRepoMap(sandbox, workspace);
    expect(again).not.toBe(rebuilt);
    expect(again.files).toBe(2);
    expect(again.symbols).toEqual(rebuilt.symbols);
  });

  it("serves the map through the repo_map handler", async () => {
    const { sandbox, computer, workspace } = await seedWorkspace("repo-map-handler", {
      "a.ts": "export function a() {}\n",
    });
    const ctx = {
      bot: { id: "repo-map-handler" },
      computer: {
        mode: "dedicated",
        get: async () => computer,
        checkpoint: { markDirty: () => {} },
      },
      context,
      secrets: [],
      deps: { sandbox },
    } as never;
    const call = { name: "repo_map", args: {} } as never;
    const handler = repoMapTools.repo_map;
    if (!handler) throw new Error("repo_map handler missing");
    const result = (await handler(ctx, call)) as Awaited<ReturnType<typeof buildRepoMap>>;
    expect(result.files).toBe(1);
    expect(result.symbols).toEqual([{ name: "a", kind: "function", path: "a.ts", line: 1 }]);
    expect(workspace.botId).toBe("repo-map-handler");
  });
});

describe("isCodeRelated", () => {
  it.each([
    "fix the bug in src/index.ts",
    "help me write a function",
    "the test is failing",
    "I got an error",
    "the stack trace shows a crash",
    "run grep for TODO",
    "edit the file",
    "apply the patch",
    "check the repo",
    "commit this change",
    "read the code",
    "open the file",
    "see main.py",
  ])("treats %s as code-related", (text) => {
    expect(isCodeRelated(text)).toBe(true);
  });

  it.each(["what's the weather today", "book a flight to Paris", "hello", "latest news"])(
    "treats %s as not code-related",
    (text) => {
      expect(isCodeRelated(text)).toBe(false);
    },
  );
});

describe("formatRepoMapForPrompt", () => {
  const map = {
    tree: "src/\n  index.ts",
    symbols: [{ name: "main", kind: "function", path: "src/index.ts", line: 1 }],
    files: 1,
    truncated: false,
  };
  it("includes the tree and symbols in a bounded block", () => {
    const text = formatRepoMapForPrompt(map);
    expect(text).toContain("src/\n  index.ts");
    expect(text).toContain("main (function) — src/index.ts:1");
    expect(text.length).toBeLessThanOrEqual(6000);
  });
  it("marks truncated maps and caps long output", () => {
    const text = formatRepoMapForPrompt({ ...map, truncated: true }, 40);
    expect(text).toContain("(map truncated)");
    expect(text.length).toBeLessThanOrEqual(60);
  });
});

import type {
  AdapterContext,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  detectBuild,
  detectChecker,
  detectTestRunner,
  diagnosticsFromTool,
  feedbackTools,
  gitDiffFromTool,
  gitStatusFromTool,
  parseBuildOutput,
  parseDiagnosticsOutput,
  parseGitStatusOutput,
  parseTestResults,
  runBuildFromTool,
  runSandboxCommand,
  runTestsFromTool,
} from "./feedback-tools.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { truncateShellOutput } from "./run-tools-computer.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

const COMPUTER: ComputerRef = {
  id: "stub-1",
  botId: "bot-1",
  kind: "fake",
  providerRef: "stub-1",
};

const CONTEXT: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

type CannedResult = { stdout?: string; stderr?: string; code?: number };

/** Minimal SandboxProvider: canned commands plus a Map-backed file tree. */
class StubSandbox {
  readonly files = new Map<string, string>();
  readonly seen: { argv: string[]; cwd?: string; timeoutMs?: number }[] = [];
  private readonly commands = new Map<string, CannedResult>();

  file(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }

  command(argv: string[], result: CannedResult): this {
    this.commands.set(argv.join("\0"), result);
    return this;
  }

  async *execute(
    _computer: ComputerRef,
    request: { argv: string[]; cwd?: string; timeoutMs?: number },
    _context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    this.seen.push({ argv: request.argv, cwd: request.cwd, timeoutMs: request.timeoutMs });
    const canned = this.commands.get(request.argv.join("\0")) ?? { stdout: "", code: 0 };
    if (canned.stdout) yield { type: "stdout", data: canned.stdout };
    if (canned.stderr) yield { type: "stderr", data: canned.stderr };
    yield { type: "exit", code: canned.code ?? 0 };
  }

  async listFiles(
    _computer: ComputerRef,
    directory: string,
    _context: AdapterContext,
  ): Promise<{ path: string; kind: "file" | "dir"; size: number }[]> {
    const prefix = directory ? `${directory.replace(/\/+$/, "")}/` : "";
    const entries = new Map<string, { path: string; kind: "file" | "dir"; size: number }>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split("/");
      if (!name) continue;
      entries.set(prefix + name, {
        path: prefix + name,
        kind: rest.length ? "dir" : "file",
        size: rest.length ? 0 : (this.files.get(path)?.length ?? 0),
      });
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(
    _computer: ComputerRef,
    path: string,
    _context: AdapterContext,
  ): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error("computer file not found");
    return new TextEncoder().encode(content);
  }
}

function workspace(): RunWorkspace {
  return {
    botId: "bot-1",
    computerMode: "dedicated",
    computer: async () => COMPUTER,
    markDirty: () => {},
    context: CONTEXT,
    runSecrets: [],
  };
}

function asSandbox(stub: StubSandbox): SandboxProvider {
  return stub as unknown as SandboxProvider;
}

function fakeCtx(stub: StubSandbox, appended: unknown[] = []) {
  return {
    bot: { id: "bot-1" },
    run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
    runId: "run-1",
    thread: { id: "thread-1" },
    computer: {
      mode: "dedicated",
      get: async () => COMPUTER,
      checkpoint: { markDirty: () => {} },
    },
    context: CONTEXT,
    secrets: [],
    deps: {
      sandbox: asSandbox(stub),
      events: {
        append: async (payload: unknown) => {
          appended.push(payload);
        },
      },
    },
  } as unknown as RunContext;
}

function fakeCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    name,
    args,
    executionId: "exec-1",
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
}

describe("truncateShellOutput", () => {
  it("returns short output unchanged", () => {
    expect(truncateShellOutput("short")).toBe("short");
    expect(truncateShellOutput("x".repeat(100), 100)).toBe("x".repeat(100));
  });

  it("keeps head and tail with a marker naming the omitted chars", () => {
    const output = `${"a".repeat(100)}${"b".repeat(100)}`;
    const capped = truncateShellOutput(output, 100);
    expect(capped.length).toBe(100);
    expect(capped.startsWith("a".repeat(35))).toBe(true);
    expect(capped.endsWith("b".repeat(35))).toBe(true);
    expect(capped).toContain("[output truncated: 130 chars]");
  });
});

describe("runSandboxCommand", () => {
  it("collects stdout/stderr separately and captures the exit code", async () => {
    const stub = new StubSandbox().command(["git", "status"], {
      stdout: "out\n",
      stderr: "err\n",
      code: 3,
    });
    const result = await runSandboxCommand(asSandbox(stub), workspace(), ["git", "status"]);
    expect(result).toEqual({ stdout: "out\n", stderr: "err\n", code: 3 });
    expect(stub.seen[0]?.timeoutMs).toBe(120_000);
  });
});

describe("git_status", () => {
  it("parses the branch and porcelain files", async () => {
    const stub = new StubSandbox().command(["git", "status", "--porcelain=v1", "-b"], {
      stdout: "## main...origin/main\n M src/a.ts\n?? new.txt\n",
      code: 0,
    });
    const result = await gitStatusFromTool(asSandbox(stub), workspace(), {});
    expect(result).toEqual({
      branch: "main",
      clean: false,
      files: [
        { path: "src/a.ts", status: "M" },
        { path: "new.txt", status: "??" },
      ],
      status: "## main...origin/main\n M src/a.ts\n?? new.txt\n",
    });
  });

  it("reports a clean repo", () => {
    expect(parseGitStatusOutput("## main\n")).toEqual({
      branch: "main",
      clean: true,
      files: [],
      status: "## main\n",
    });
  });

  it("runs through the feedbackTools handler", async () => {
    const stub = new StubSandbox().command(["git", "status", "--porcelain=v1", "-b"], {
      stdout: "## main\n",
      code: 0,
    });
    const result = await feedbackTools.git_status!(fakeCtx(stub), fakeCall("git_status", {}));
    expect(result).toEqual({ branch: "main", clean: true, files: [], status: "## main\n" });
  });

  it("refuses paths that escape the workspace", async () => {
    const stub = new StubSandbox();
    expect(await gitStatusFromTool(asSandbox(stub), workspace(), { path: "../secret" })).toEqual({
      error: "path must stay inside the workspace",
    });
    expect(await gitStatusFromTool(asSandbox(stub), workspace(), { path: "/etc/passwd" })).toEqual({
      error: "path must stay inside the workspace",
    });
    expect(stub.seen).toEqual([]);
  });
});

describe("git_diff", () => {
  it("passes --cached for staged diffs and lists changed files", async () => {
    const stub = new StubSandbox().command(["git", "diff", "--cached"], {
      stdout:
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
      code: 0,
    });
    const result = await gitDiffFromTool(asSandbox(stub), workspace(), { staged: true });
    expect(stub.seen[0]?.argv).toEqual(["git", "diff", "--cached"]);
    expect(result).toMatchObject({ truncated: false, files: ["src/a.ts"] });
  });

  it("caps long diffs with a truncation marker", async () => {
    const long = `diff --git a/big.txt b/big.txt\n${"x".repeat(20_000)}`;
    const stub = new StubSandbox().command(["git", "diff"], { stdout: long, code: 0 });
    const result = await gitDiffFromTool(asSandbox(stub), workspace(), {});
    expect(result).toMatchObject({ truncated: true, files: ["big.txt"] });
    expect((result as { diff: string }).diff).toContain("[output truncated:");
    expect((result as { diff: string }).diff.length).toBeLessThanOrEqual(16_000);
  });

  it("refuses absolute paths", async () => {
    const stub = new StubSandbox();
    expect(await gitDiffFromTool(asSandbox(stub), workspace(), { path: "/etc/passwd" })).toEqual({
      error: "path must stay inside the workspace",
    });
  });
});

describe("git_commit", () => {
  it("errors on a missing message without running git", async () => {
    const stub = new StubSandbox();
    const appended: unknown[] = [];
    const result = await feedbackTools.git_commit!(
      fakeCtx(stub, appended),
      fakeCall("git_commit", {}),
    );
    expect(result).toEqual({ error: "message is required" });
    expect(stub.seen).toEqual([]);
    expect(appended).toHaveLength(1);
  });

  it("reports nothing to commit", async () => {
    const stub = new StubSandbox().command(["git", "commit", "-m", "wip"], {
      stdout: "nothing to commit, working tree clean\n",
      code: 1,
    });
    const result = await feedbackTools.git_commit!(
      fakeCtx(stub),
      fakeCall("git_commit", { message: "wip" }),
    );
    expect(result).toEqual({ error: "nothing to commit" });
  });

  it("adds a scoped path first, then commits and records the action", async () => {
    const stub = new StubSandbox()
      .command(["git", "add", "-A", "--", "src"], { stdout: "", code: 0 })
      .command(["git", "commit", "-m", "wip"], {
        stdout: "[main abc1234] wip\n 1 file changed\n",
        code: 0,
      });
    const appended: unknown[] = [];
    const result = await feedbackTools.git_commit!(
      fakeCtx(stub, appended),
      fakeCall("git_commit", { message: "wip", path: "src" }),
    );
    expect(stub.seen.map((entry) => entry.argv)).toEqual([
      ["git", "add", "-A", "--", "src"],
      ["git", "commit", "-m", "wip"],
    ]);
    expect(result).toMatchObject({ ok: true, message: "wip" });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      type: "computer.command",
      payload: { kind: "write_file", command: "git commit" },
    });
  });
});

describe("run_tests detection", () => {
  it("uses pnpm when a lockfile exists, else npm", async () => {
    const pnpm = new StubSandbox()
      .file("package.json", JSON.stringify({ scripts: { test: "vitest run" } }))
      .file("pnpm-lock.yaml", "lockfileVersion: 9\n");
    expect(await detectTestRunner(asSandbox(pnpm), workspace())).toEqual({
      argv: ["pnpm", "test"],
    });
    const npm = new StubSandbox().file(
      "package.json",
      JSON.stringify({ scripts: { test: "jest" } }),
    );
    expect(await detectTestRunner(asSandbox(npm), workspace())).toEqual({ argv: ["npm", "test"] });
  });

  it("detects pytest from config or test files", async () => {
    const ini = new StubSandbox().file("pytest.ini", "[pytest]\n");
    expect(await detectTestRunner(asSandbox(ini), workspace())).toEqual({
      argv: ["python", "-m", "pytest", "-q"],
    });
    const files = new StubSandbox().file("test_foo.py", "def test_x(): pass\n");
    expect(await detectTestRunner(asSandbox(files), workspace())).toEqual({
      argv: ["python", "-m", "pytest", "-q"],
    });
  });

  it("detects go test from go.mod", async () => {
    const stub = new StubSandbox().file("go.mod", "module example.com/x\n");
    expect(await detectTestRunner(asSandbox(stub), workspace())).toEqual({
      argv: ["go", "test", "./..."],
    });
  });

  it("errors when no runner is detected", async () => {
    const stub = new StubSandbox();
    expect(await detectTestRunner(asSandbox(stub), workspace())).toEqual({
      error: "no test runner detected",
    });
    expect(await runTestsFromTool(asSandbox(stub), workspace(), {})).toEqual({
      error: "no test runner detected",
    });
  });

  it("parses failed lines and the pass/fail summary", async () => {
    const stub = new StubSandbox()
      .file("package.json", JSON.stringify({ scripts: { test: "vitest run" } }))
      .command(["npm", "test"], {
        stdout: "FAIL src/a.test.ts\n✓ ok\nTests: 3 failed, 12 passed\n",
        code: 1,
      });
    const result = await runTestsFromTool(asSandbox(stub), workspace(), {});
    expect(stub.seen[0]?.argv).toEqual(["npm", "test"]);
    expect(stub.seen[0]?.timeoutMs).toBe(300_000);
    expect(result).toMatchObject({
      ok: false,
      failed: ["FAIL src/a.test.ts"],
      summary: "3 failed, 12 passed",
    });
  });

  it("falls back to the exit code when no counts parse", () => {
    expect(parseTestResults("ok\n", "", 0)).toMatchObject({ ok: true, summary: "exit code 0" });
  });
});

describe("diagnostics", () => {
  it("parses tsc output", async () => {
    const stub = new StubSandbox()
      .file("tsconfig.json", "{}\n")
      .file("package.json", "{}\n")
      .command(["npx", "tsc", "--noEmit"], {
        stdout: "src/a.ts(3,5): error TS2322: Type 'string' is not assignable.\n",
        code: 2,
      });
    const result = await diagnosticsFromTool(asSandbox(stub), workspace(), {});
    expect(stub.seen[0]?.argv).toEqual(["npx", "tsc", "--noEmit"]);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          path: "src/a.ts",
          line: 3,
          column: 5,
          severity: "error",
          message: "Type 'string' is not assignable.",
        },
      ],
      truncated: false,
    });
  });

  it("parses ruff output", async () => {
    const stub = new StubSandbox().file("main.py", "import os\n").command(["ruff", "check", "."], {
      stdout: "main.py:1:8: F401 'os' imported but unused\n",
      code: 1,
    });
    const result = await diagnosticsFromTool(asSandbox(stub), workspace(), {});
    expect(stub.seen[0]?.argv).toEqual(["ruff", "check", "."]);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          path: "main.py",
          line: 1,
          column: 8,
          severity: "error",
          message: "F401 'os' imported but unused",
        },
      ],
    });
  });

  it("parses eslint JSON output", () => {
    const stdout = JSON.stringify([
      {
        filePath: "src/a.js",
        messages: [{ line: 1, column: 2, severity: 2, message: "Unexpected var." }],
      },
    ]);
    expect(parseDiagnosticsOutput(stdout, "", 1)).toMatchObject({
      ok: false,
      diagnostics: [
        { path: "src/a.js", line: 1, column: 2, severity: "error", message: "Unexpected var." },
      ],
    });
  });

  it("detects the checker: go vet first, then eslint", async () => {
    const go = new StubSandbox().file("go.mod", "module example.com/x\n");
    expect(await detectChecker(asSandbox(go), workspace())).toEqual({
      argv: ["go", "vet", "./..."],
    });
    const eslint = new StubSandbox().file("eslint.config.js", "export default [];\n");
    expect(await detectChecker(asSandbox(eslint), workspace())).toEqual({
      argv: ["npx", "eslint", "--format", "json", "."],
    });
  });

  it("errors when no checker is configured", async () => {
    const stub = new StubSandbox();
    expect(await detectChecker(asSandbox(stub), workspace())).toEqual({
      error: "no checker configured",
    });
  });

  it("caps diagnostics at 100", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `a.py:${i + 1}:1: F401 unused`).join("\n");
    const result = parseDiagnosticsOutput(lines, "", 1);
    expect(result.diagnostics).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it("parses cargo error spans", () => {
    const stderr = "error[E0308]: mismatched types\n --> src/main.rs:3:5\n  |\n";
    const result = parseDiagnosticsOutput("", stderr, 101);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          path: "src/main.rs",
          line: 3,
          column: 5,
          severity: "error",
          message: "mismatched types",
        },
      ],
    });
  });
});

describe("run_build", () => {
  it("detects the build script: pnpm with a lockfile, else npm", async () => {
    const pnpm = new StubSandbox()
      .file("package.json", JSON.stringify({ scripts: { build: "tsc -b" } }))
      .file("pnpm-lock.yaml", "lockfileVersion: 9\n");
    expect(await detectBuild(asSandbox(pnpm), workspace())).toEqual({
      argv: ["pnpm", "build"],
    });
    const npm = new StubSandbox().file(
      "package.json",
      JSON.stringify({ scripts: { build: "tsc -b" } }),
    );
    expect(await detectBuild(asSandbox(npm), workspace())).toEqual({
      argv: ["npm", "run", "build"],
    });
  });

  it("falls back to tsc, then go build, then cargo build", async () => {
    const tsc = new StubSandbox().file("package.json", "{}\n").file("tsconfig.json", "{}\n");
    expect(await detectBuild(asSandbox(tsc), workspace())).toEqual({
      argv: ["npx", "tsc", "--noEmit"],
    });
    const go = new StubSandbox().file("go.mod", "module example.com/x\n");
    expect(await detectBuild(asSandbox(go), workspace())).toEqual({
      argv: ["go", "build", "./..."],
    });
    const cargo = new StubSandbox().file("Cargo.toml", '[package]\nname = "x"\n');
    expect(await detectBuild(asSandbox(cargo), workspace())).toEqual({
      argv: ["cargo", "build"],
    });
  });

  it("errors clearly when no build is configured", async () => {
    const stub = new StubSandbox();
    expect(await detectBuild(asSandbox(stub), workspace())).toEqual({
      error: "no build configured",
    });
    expect(await runBuildFromTool(asSandbox(stub), workspace(), {})).toEqual({
      error: "no build configured",
    });
    expect(stub.seen).toEqual([]);
  });

  it("runs the build script and reports success", async () => {
    const stub = new StubSandbox()
      .file("package.json", JSON.stringify({ scripts: { build: "tsc -b" } }))
      .command(["npm", "run", "build"], { stdout: "built in 1.2s\n", code: 0 });
    const result = await feedbackTools.run_build!(fakeCtx(stub), fakeCall("run_build", {}));
    expect(stub.seen[0]?.argv).toEqual(["npm", "run", "build"]);
    expect(stub.seen[0]?.timeoutMs).toBe(300_000);
    expect(result).toMatchObject({ ok: true, failed: [], summary: "build succeeded" });
  });

  it("parses a tsc error into a structured failure", async () => {
    const stub = new StubSandbox()
      .file("package.json", "{}\n")
      .file("tsconfig.json", "{}\n")
      .command(["npx", "tsc", "--noEmit"], {
        stdout: "src/a.ts(3,5): error TS2322: Type 'string' is not assignable.\n",
        code: 2,
      });
    const result = await runBuildFromTool(asSandbox(stub), workspace(), {});
    expect(result).toMatchObject({
      ok: false,
      failed: [
        {
          path: "src/a.ts",
          line: 3,
          column: 5,
          severity: "error",
          message: "Type 'string' is not assignable.",
        },
      ],
      summary: "1 error",
    });
    expect((result as { output: string }).output).toContain("TS2322");
  });

  it("falls back to the exit code when the failure has no parseable lines", () => {
    expect(parseBuildOutput("", "boom\n", 1)).toMatchObject({
      ok: false,
      failed: [],
      summary: "build failed with exit code 1",
    });
    expect(parseBuildOutput("", "", 0)).toMatchObject({
      ok: true,
      failed: [],
      summary: "build succeeded",
    });
  });
});

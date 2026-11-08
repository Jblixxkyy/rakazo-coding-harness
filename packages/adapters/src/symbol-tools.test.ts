import type { ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import {
  definitionKindForLine,
  findDefinitionFromTool,
  findReferencesFromTool,
  isValidSymbolName,
} from "./symbol-tools.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

const context = {
  operationId: "symbol-test",
  traceId: "symbol-test",
  spaceId: "symbol",
  userId: "user",
  signal: new AbortController().signal,
};

async function seedBox(files: Record<string, string | Uint8Array>) {
  const sandbox = new FakeSandboxProvider();
  const computer: ComputerRef = await sandbox.provision(
    { botId: "symbol-test", homePath: "/ignored" },
    context,
  );
  for (const [filePath, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await sandbox.writeFile(computer, { path: filePath, content: bytes }, context);
  }
  const workspace: RunWorkspace = {
    botId: "symbol-test",
    computerMode: "dedicated",
    computer: async () => computer,
    markDirty: () => undefined,
    context,
    runSecrets: [],
  };
  return { sandbox, workspace };
}

describe("isValidSymbolName", () => {
  it("accepts identifiers and rejects everything else", () => {
    expect(isValidSymbolName("fetchUser")).toBe(true);
    expect(isValidSymbolName("_private")).toBe(true);
    expect(isValidSymbolName("$store")).toBe(true);
    expect(isValidSymbolName("")).toBe(false);
    expect(isValidSymbolName("foo-bar")).toBe(false);
    expect(isValidSymbolName("foo bar")).toBe(false);
    expect(isValidSymbolName("foo(")).toBe(false);
    expect(isValidSymbolName(42)).toBe(false);
  });
});

describe("definitionKindForLine", () => {
  it("recognises TS definitions and ignores calls and comments", () => {
    expect(definitionKindForLine("a.ts", "export function fetchUser(id) {", "fetchUser")).toBe(
      "function",
    );
    expect(definitionKindForLine("a.ts", "function fetchUser(id) {", "fetchUser")).toBe("function");
    expect(definitionKindForLine("a.ts", "export class UserStore {", "UserStore")).toBe("class");
    expect(definitionKindForLine("a.ts", "export interface User {", "User")).toBe("interface");
    expect(definitionKindForLine("a.ts", "export type UserId = string;", "UserId")).toBe("type");
    expect(
      definitionKindForLine("a.ts", "export const fetchUser = async () => {", "fetchUser"),
    ).toBe("const");
    expect(definitionKindForLine("a.ts", "  private loadCache() {", "loadCache")).toBe("method");
    expect(definitionKindForLine("a.ts", "  fetchUser(id);", "fetchUser")).toBe(undefined);
    expect(definitionKindForLine("a.ts", "// fetchUser is called below", "fetchUser")).toBe(
      undefined,
    );
    expect(definitionKindForLine("a.ts", "const x = fetchUser(id);", "fetchUser")).toBe(undefined);
  });

  it("recognises Python, Go and Rust definitions", () => {
    expect(definitionKindForLine("a.py", "def fetch_user(user_id):", "fetch_user")).toBe(
      "function",
    );
    expect(definitionKindForLine("a.py", "async def fetch_user():", "fetch_user")).toBe("function");
    expect(definitionKindForLine("a.py", "class UserStore:", "UserStore")).toBe("class");
    expect(definitionKindForLine("a.py", "MAX_RETRIES = 3", "MAX_RETRIES")).toBe("variable");
    expect(definitionKindForLine("a.go", "func FetchUser(id string) {", "FetchUser")).toBe(
      "function",
    );
    expect(definitionKindForLine("a.go", "func (s *Store) Fetch(id string) {", "Fetch")).toBe(
      "method",
    );
    expect(definitionKindForLine("a.go", "type User struct {", "User")).toBe("type");
    expect(definitionKindForLine("a.rs", "pub fn fetch_user(id: u64) {", "fetch_user")).toBe(
      "function",
    );
    expect(definitionKindForLine("a.rs", "pub(crate) struct User {", "User")).toBe("struct");
    expect(definitionKindForLine("a.rs", "const MAX_RETRIES: u32 = 3;", "MAX_RETRIES")).toBe(
      "const",
    );
  });
});

describe("findDefinitionFromTool", () => {
  it("finds a TS function, class and interface definition", async () => {
    const { sandbox, workspace } = await seedBox({
      "src/a.ts": "export function fetchUser(id: string) {\n  return id;\n}\n",
      "src/types.ts":
        "export interface User {\n  id: string;\n}\n\nexport class UserStore {\n  find() {}\n}\n",
    });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "fetchUser" })).toEqual({
      definitions: [
        {
          path: "src/a.ts",
          line: 1,
          text: "export function fetchUser(id: string) {",
          kind: "function",
        },
      ],
      truncated: false,
    });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "User" })).toEqual({
      definitions: [
        { path: "src/types.ts", line: 1, text: "export interface User {", kind: "interface" },
      ],
      truncated: false,
    });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "UserStore" })).toEqual({
      definitions: [
        { path: "src/types.ts", line: 5, text: "export class UserStore {", kind: "class" },
      ],
      truncated: false,
    });
  });

  it("finds a const arrow function and a Python/Go/Rust definition", async () => {
    const { sandbox, workspace } = await seedBox({
      "src/util.ts": "export const parseInput = (raw: string) => raw.trim();\n",
      "app.py": "def fetch_user(user_id):\n    return user_id\n",
      "main.go": "func FetchUser(id string) {\n}\n",
      "lib.rs": "pub fn fetch_user(id: u64) {\n}\n",
    });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "parseInput" })).toEqual({
      definitions: [
        {
          path: "src/util.ts",
          line: 1,
          text: "export const parseInput = (raw: string) => raw.trim();",
          kind: "const",
        },
      ],
      truncated: false,
    });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "fetch_user" })).toEqual({
      definitions: [
        { path: "app.py", line: 1, text: "def fetch_user(user_id):", kind: "function" },
        { path: "lib.rs", line: 1, text: "pub fn fetch_user(id: u64) {", kind: "function" },
      ],
      truncated: false,
    });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "FetchUser" })).toEqual({
      definitions: [
        { path: "main.go", line: 1, text: "func FetchUser(id string) {", kind: "function" },
      ],
      truncated: false,
    });
  });

  it("does not report a definition for a mere mention", async () => {
    const { sandbox, workspace } = await seedBox({
      "src/a.ts": "// fetchUser is used by the handler\nconst result = fetchUser(id);\n",
      "src/b.ts": "fetchUser(id);\n",
    });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "fetchUser" })).toEqual({
      definitions: [],
      truncated: false,
    });
  });

  it("returns an empty list for a missing symbol", async () => {
    const { sandbox, workspace } = await seedBox({ "src/a.ts": "export function other() {}\n" });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "nope" })).toEqual({
      definitions: [],
      truncated: false,
    });
  });

  it("scopes to a path and an include glob", async () => {
    const { sandbox, workspace } = await seedBox({
      "src/a.ts": "export function fetchUser() {}\n",
      "other/b.ts": "export function fetchUser() {}\n",
      "src/c.js": "export function fetchUser() {}\n",
    });
    expect(
      await findDefinitionFromTool(sandbox, workspace, { name: "fetchUser", path: "src" }),
    ).toEqual({
      definitions: [
        { path: "src/a.ts", line: 1, text: "export function fetchUser() {}", kind: "function" },
        { path: "src/c.js", line: 1, text: "export function fetchUser() {}", kind: "function" },
      ],
      truncated: false,
    });
    expect(
      await findDefinitionFromTool(sandbox, workspace, {
        name: "fetchUser",
        include: "*.ts",
      }),
    ).toEqual({
      definitions: [
        { path: "other/b.ts", line: 1, text: "export function fetchUser() {}", kind: "function" },
        { path: "src/a.ts", line: 1, text: "export function fetchUser() {}", kind: "function" },
      ],
      truncated: false,
    });
  });

  it("limits definitions and reports truncated", async () => {
    const { sandbox, workspace } = await seedBox({
      "a.ts": "export function dup() {}\n",
      "b.ts": "export function dup() {}\n",
      "c.ts": "export function dup() {}\n",
    });
    const result = await findDefinitionFromTool(sandbox, workspace, { name: "dup", limit: 2 });
    expect("definitions" in result ? result.definitions : []).toHaveLength(2);
    expect("truncated" in result ? result.truncated : false).toBe(true);
  });

  it("does not report truncated when definitions fit exactly", async () => {
    const { sandbox, workspace } = await seedBox({
      "a.ts": "export function dup() {}\n",
      "b.ts": "export function dup() {}\n",
    });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "dup", limit: 2 })).toEqual({
      definitions: [
        { path: "a.ts", line: 1, text: "export function dup() {}", kind: "function" },
        { path: "b.ts", line: 1, text: "export function dup() {}", kind: "function" },
      ],
      truncated: false,
    });
  });

  it("skips ignored directories and honours .gitignore", async () => {
    const { sandbox, workspace } = await seedBox({
      ".gitignore": "ignored/\n",
      "node_modules/dep/index.js": "export function fetchUser() {}\n",
      "ignored/a.ts": "export function fetchUser() {}\n",
      "src/a.ts": "export function fetchUser() {}\n",
    });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "fetchUser" })).toEqual({
      definitions: [
        { path: "src/a.ts", line: 1, text: "export function fetchUser() {}", kind: "function" },
      ],
      truncated: false,
    });
  });

  it("refuses paths that escape the workspace", async () => {
    const { sandbox, workspace } = await seedBox({ "a.ts": "export function f() {}\n" });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "f", path: "../x" })).toEqual({
      error: "Path escapes the computer workspace",
    });
    expect(
      await findDefinitionFromTool(sandbox, workspace, { name: "f", path: "/etc/passwd" }),
    ).toEqual({ error: "Path escapes the computer workspace" });
  });

  it("requires a valid name", async () => {
    const { sandbox, workspace } = await seedBox({ "a.ts": "export function f() {}\n" });
    expect(await findDefinitionFromTool(sandbox, workspace, {})).toEqual({
      error: "name is required and must be a valid identifier",
    });
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "foo-bar" })).toEqual({
      error: "name is required and must be a valid identifier",
    });
  });

  it("redacts run secrets from definition text", async () => {
    const { sandbox, workspace } = await seedBox({
      "a.ts": "export const token = 'hunter2';\n",
    });
    workspace.runSecrets.push("hunter2");
    expect(await findDefinitionFromTool(sandbox, workspace, { name: "token" })).toEqual({
      definitions: [
        { path: "a.ts", line: 1, text: "export const token = '[redacted]';", kind: "const" },
      ],
      truncated: false,
    });
  });
});

describe("findReferencesFromTool", () => {
  it("finds usages across files and excludes the definition line", async () => {
    const { sandbox, workspace } = await seedBox({
      "src/a.ts": "export function fetchUser(id: string) {\n  return fetchUser(id);\n}\n",
      "src/b.ts": "import { fetchUser } from './a';\nconst user = fetchUser('1');\n",
      "src/c.ts": "const other = fetchUserId;\n",
    });
    expect(await findReferencesFromTool(sandbox, workspace, { name: "fetchUser" })).toEqual({
      references: [
        { path: "src/a.ts", line: 2, text: "return fetchUser(id);" },
        { path: "src/b.ts", line: 1, text: "import { fetchUser } from './a';" },
        { path: "src/b.ts", line: 2, text: "const user = fetchUser('1');" },
      ],
      truncated: false,
    });
  });

  it("does not match longer identifiers", async () => {
    const { sandbox, workspace } = await seedBox({
      "a.ts": "fetchUserId\nfetchUser2\nmyfetchUser\nfetchUser\n",
    });
    expect(await findReferencesFromTool(sandbox, workspace, { name: "fetchUser" })).toEqual({
      references: [{ path: "a.ts", line: 4, text: "fetchUser" }],
      truncated: false,
    });
  });

  it("returns an empty list for a missing symbol", async () => {
    const { sandbox, workspace } = await seedBox({ "a.ts": "nothing here\n" });
    expect(await findReferencesFromTool(sandbox, workspace, { name: "nope" })).toEqual({
      references: [],
      truncated: false,
    });
  });

  it("limits references and reports truncated", async () => {
    const { sandbox, workspace } = await seedBox({
      "a.ts": "fetchUser\nfetchUser\nfetchUser\n",
    });
    const result = await findReferencesFromTool(sandbox, workspace, {
      name: "fetchUser",
      limit: 2,
    });
    expect("references" in result ? result.references : []).toHaveLength(2);
    expect("truncated" in result ? result.truncated : false).toBe(true);
  });

  it("scopes to a path and refuses escaping paths", async () => {
    const { sandbox, workspace } = await seedBox({
      "src/a.ts": "fetchUser\n",
      "other/b.ts": "fetchUser\n",
    });
    expect(
      await findReferencesFromTool(sandbox, workspace, { name: "fetchUser", path: "src" }),
    ).toEqual({
      references: [{ path: "src/a.ts", line: 1, text: "fetchUser" }],
      truncated: false,
    });
    expect(
      await findReferencesFromTool(sandbox, workspace, { name: "fetchUser", path: "../x" }),
    ).toEqual({ error: "Path escapes the computer workspace" });
  });

  it("requires a valid name", async () => {
    const { sandbox, workspace } = await seedBox({ "a.ts": "x\n" });
    expect(await findReferencesFromTool(sandbox, workspace, {})).toEqual({
      error: "name is required and must be a valid identifier",
    });
  });
});

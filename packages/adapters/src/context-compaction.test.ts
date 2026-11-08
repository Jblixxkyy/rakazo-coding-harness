import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  compactCodingToolResultMessage,
  compactOldCodingToolResults,
  summariseCodingToolResult,
} from "./context-compaction.js";

function result(id: string, toolName: string, body: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text: body }],
    isError: false,
    timestamp: 102,
  } as Message;
}

function call(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    timestamp: 101,
  } as unknown as Message;
}

const readBody = (path: string, lines = 120) =>
  JSON.stringify({
    path,
    content: Array.from({ length: lines }, (_, i) => `line ${i + 1} of ${path}`).join("\n"),
    totalLines: lines,
  });

describe("summariseCodingToolResult", () => {
  it("summarises a read_file result from its fields, without the file text", () => {
    const body = readBody("src/a.ts", 120);
    const summary = summariseCodingToolResult("read_file", body);
    expect(summary).toBe("[compacted read_file: src/a.ts; 120 lines]");
    expect(summary).not.toContain("line 1 of");
  });

  it("summarises grep matches with counts and paths, without match text", () => {
    const body = JSON.stringify({
      matches: [
        { path: "src/a.ts", line: 3, text: "const secret = 1;" },
        { path: "src/a.ts", line: 9, text: "const secret = 2;" },
        { path: "src/b.ts", line: 1, text: "const secret = 3;" },
      ],
      truncated: false,
    });
    expect(summariseCodingToolResult("grep", body)).toBe(
      "[compacted grep: 3 matches in 2 files: src/a.ts, src/b.ts]",
    );
  });

  it("summarises run_tests and diagnostics from their outcome fields", () => {
    expect(
      summariseCodingToolResult(
        "run_tests",
        JSON.stringify({ ok: false, failed: ["FAIL a", "FAIL b"], summary: "2 failed, 5 passed" }),
      ),
    ).toBe("[compacted run_tests: 2 failures — 2 failed, 5 passed]");
    expect(
      summariseCodingToolResult(
        "diagnostics",
        JSON.stringify({
          ok: false,
          diagnostics: [
            { path: "a.ts", line: 1, column: 2, severity: "error", message: "bad" },
            { path: "b.ts", line: 3, column: 4, severity: "warning", message: "meh" },
          ],
        }),
      ),
    ).toBe("[compacted diagnostics: 2 diagnostics (1 error) — failed]");
  });

  it("summarises repo_map, edit, and error results", () => {
    expect(
      summariseCodingToolResult(
        "repo_map",
        JSON.stringify({ tree: "src/\n  a.ts", symbols: [{ name: "a" }], files: 4 }),
      ),
    ).toBe("[compacted repo_map: 4 files; 1 symbol]");
    expect(
      summariseCodingToolResult(
        "edit",
        JSON.stringify({ ok: true, path: "src/a.ts", replacements: 2, bytes: 40 }),
      ),
    ).toBe("[compacted edit: src/a.ts; 2 replacements — ok]");
    expect(
      summariseCodingToolResult(
        "read_file",
        JSON.stringify({ error: "file is too large for model context", path: "big.ts" }),
      ),
    ).toBe("[compacted read_file: big.ts — error: file is too large for model context]");
  });

  it("falls back to the first line and a line count for non-JSON results", () => {
    const body = "line one\nline two\nline three\n";
    expect(summariseCodingToolResult("shell", body)).toBe("[compacted shell: line one (4 lines)]");
    expect(summariseCodingToolResult("read_file", "")).toBe("[compacted read_file: empty result]");
  });

  it("never lets a long first line through in full", () => {
    const body = `${"x".repeat(500)}\nsecond\n`;
    const summary = summariseCodingToolResult("grep", body);
    expect(summary.length).toBeLessThan(200);
    expect(summary).toContain("…");
  });
});

describe("compactOldCodingToolResults", () => {
  it("leaves a short session untouched", () => {
    const messages = [
      call("a", "read_file"),
      result("a", "read_file", readBody("src/a.ts")),
      call("b", "grep"),
      result("b", "grep", JSON.stringify({ matches: [], truncated: false })),
    ];
    const compacted = compactOldCodingToolResults(messages);
    expect(compacted).toEqual(messages);
    expect(compacted[1]).toBe(messages[1]);
  });

  it("compacts the oldest coding results and keeps the most recent verbatim", () => {
    const messages: Message[] = [];
    for (let index = 0; index < 10; index++) {
      messages.push(call(`read-${index}`, "read_file"));
      messages.push(result(`read-${index}`, "read_file", readBody(`src/f${index}.ts`)));
    }
    const compacted = compactOldCodingToolResults(messages);
    const body = (id: string) => {
      const message = compacted.find(
        (item) => item.role === "toolResult" && item.toolCallId === id,
      ) as Extract<Message, { role: "toolResult" }>;
      return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    };
    for (const index of [0, 1]) {
      expect(body(`read-${index}`)).toBe(`[compacted read_file: src/f${index}.ts; 120 lines]`);
    }
    for (let index = 2; index < 10; index++) {
      expect(body(`read-${index}`)).toBe(readBody(`src/f${index}.ts`));
    }
  });

  it("leaves non-coding results alone even in a long session", () => {
    const shellBody = "shell output ".repeat(500);
    const messages: Message[] = [];
    for (let index = 0; index < 10; index++) {
      messages.push(call(`read-${index}`, "read_file"));
      messages.push(result(`read-${index}`, "read_file", readBody(`src/f${index}.ts`)));
    }
    messages.push(call("shell", "shell"), result("shell", "shell", shellBody));
    const compacted = compactOldCodingToolResults(messages);
    const shell = compacted.find(
      (item) => item.role === "toolResult" && item.toolCallId === "shell",
    ) as Extract<Message, { role: "toolResult" }>;
    expect(shell.content.map((part) => (part.type === "text" ? part.text : "")).join("")).toBe(
      shellBody,
    );
  });

  it("keeps the tool call pairing and never compacts the most recent results", () => {
    const messages: Message[] = [];
    for (let index = 0; index < 9; index++) {
      messages.push(call(`grep-${index}`, "grep"));
      messages.push(
        result(
          `grep-${index}`,
          "grep",
          JSON.stringify({ matches: [{ path: "a.ts", line: 1, text: "x" }], truncated: false }),
        ),
      );
    }
    const compacted = compactOldCodingToolResults(messages, 8);
    const first = compacted.find(
      (item) => item.role === "toolResult" && item.toolCallId === "grep-0",
    ) as Extract<Message, { role: "toolResult" }>;
    expect(first.toolName).toBe("grep");
    expect(first.content.map((part) => (part.type === "text" ? part.text : "")).join("")).toBe(
      "[compacted grep: 1 match in 1 file: a.ts]",
    );
    const last = compacted.find(
      (item) => item.role === "toolResult" && item.toolCallId === "grep-8",
    ) as Extract<Message, { role: "toolResult" }>;
    expect(last.content.map((part) => (part.type === "text" ? part.text : "")).join("")).toContain(
      '"matches"',
    );
  });
});

describe("compactCodingToolResultMessage", () => {
  it("keeps role, toolCallId, and image parts while replacing the text", () => {
    const message = {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read_file",
      content: [
        { type: "text", text: readBody("src/a.ts") },
        { type: "image", data: "base64" },
      ],
      isError: false,
      timestamp: 102,
    } as unknown as Message;
    const compacted = compactCodingToolResultMessage(message);
    expect(compacted.role).toBe("toolResult");
    expect((compacted as Extract<Message, { role: "toolResult" }>).toolCallId).toBe("read-1");
    const parts = (compacted as Extract<Message, { role: "toolResult" }>).content;
    expect(parts[0]).toEqual({ type: "text", text: "[compacted read_file: src/a.ts; 120 lines]" });
    expect(parts[1]).toEqual({ type: "image", data: "base64" });
  });

  it("returns a tiny result unchanged instead of growing it", () => {
    const message = result("ok", "read_file", "{}");
    expect(compactCodingToolResultMessage(message)).toBe(message);
  });
});

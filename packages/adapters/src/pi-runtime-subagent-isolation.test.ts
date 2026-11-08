import { describe, expect, it } from "vitest";
import { isolatedSubagentInstruction, isolatedSubagentWorkspace } from "./pi-runtime-subagent.js";

describe("isolated subagent workspace", () => {
  it("confines writes under a sanitized subagents folder", () => {
    expect(isolatedSubagentWorkspace("scout-1")).toBe("subagents/scout-1");
    expect(isolatedSubagentWorkspace('["pi-tool","main","a/b"]')).toBe(
      "subagents/--pi-tool---main---a-b--",
    );
  });

  it("tells the helper to read anywhere but write only under its folder", () => {
    const instruction = isolatedSubagentInstruction("scout-1");
    expect(instruction).toContain("subagents/scout-1/");
    expect(instruction).toContain("read anywhere");
    expect(instruction).toContain("write and edit files only");
  });
});

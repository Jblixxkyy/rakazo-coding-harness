import { describe, expect, it } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  parseTodoList,
  todoReadFromTool,
  todoTools,
  todoUpdateFromTool,
  todoWriteFromTool,
} from "./todo-tools.js";

/** One fake run context. Reuse the same object across calls: like a real run, it carries the plan. */
function fakeCtx() {
  return {} as unknown as RunContext;
}

function fakeCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    name,
    args,
    executionId: "exec-1",
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
}

describe("parseTodoList", () => {
  it("normalises a plan, defaulting status and generating ids", () => {
    expect(
      parseTodoList([
        { title: "Find the bug" },
        { id: "fix", title: "Fix it", status: "in_progress", detail: "in src/a.ts" },
      ]),
    ).toEqual({
      todos: [
        { id: "todo-1", title: "Find the bug", status: "pending" },
        { id: "fix", title: "Fix it", status: "in_progress", detail: "in src/a.ts" },
      ],
    });
  });

  it("rejects a non-array, a missing title and a bad status", () => {
    expect(parseTodoList(undefined)).toEqual({
      error: "todos is required and must be an array",
    });
    expect(parseTodoList([{ status: "pending" }])).toEqual({
      error: "each todo needs a non-empty title",
    });
    expect(parseTodoList([{ title: "x", status: "done" }])).toEqual({
      error: "todo status must be pending, in_progress, or completed",
    });
  });

  it("rejects duplicate ids", () => {
    expect(
      parseTodoList([
        { id: "a", title: "one" },
        { id: "a", title: "two" },
      ]),
    ).toEqual({ error: "duplicate todo id: a" });
  });

  it("generates ids that skip ids already taken in the same list", () => {
    expect(parseTodoList([{ id: "todo-1", title: "one" }, { title: "two" }])).toEqual({
      todos: [
        { id: "todo-1", title: "one", status: "pending" },
        { id: "todo-2", title: "two", status: "pending" },
      ],
    });
  });
});

describe("todoWriteFromTool / todoReadFromTool / todoUpdateFromTool", () => {
  it("writes a plan and reads it back", () => {
    const ctx = fakeCtx();
    expect(
      todoWriteFromTool(ctx, {
        todos: [{ title: "Reproduce the bug" }, { title: "Fix it", detail: "src/a.ts" }],
      }),
    ).toEqual({
      todos: [
        { id: "todo-1", title: "Reproduce the bug", status: "pending" },
        { id: "todo-2", title: "Fix it", status: "pending", detail: "src/a.ts" },
      ],
    });
    expect(todoReadFromTool(ctx, {})).toEqual({
      todos: [
        { id: "todo-1", title: "Reproduce the bug", status: "pending" },
        { id: "todo-2", title: "Fix it", status: "pending", detail: "src/a.ts" },
      ],
    });
  });

  it("reads back an empty list when no plan was written", () => {
    expect(todoReadFromTool(fakeCtx(), {})).toEqual({ todos: [] });
  });

  it("replaces the whole plan on a second write", () => {
    const ctx = fakeCtx();
    todoWriteFromTool(ctx, { todos: [{ title: "old plan" }] });
    expect(todoWriteFromTool(ctx, { todos: [{ title: "new plan" }] })).toEqual({
      todos: [{ id: "todo-1", title: "new plan", status: "pending" }],
    });
    expect(todoReadFromTool(ctx, {})).toEqual({
      todos: [{ id: "todo-1", title: "new plan", status: "pending" }],
    });
  });

  it("updates one step to completed and leaves the others alone", () => {
    const ctx = fakeCtx();
    todoWriteFromTool(ctx, {
      todos: [
        { id: "a", title: "First" },
        { id: "b", title: "Second" },
      ],
    });
    expect(todoUpdateFromTool(ctx, { id: "a", status: "completed" })).toEqual({
      todo: { id: "a", title: "First", status: "completed" },
    });
    expect(todoReadFromTool(ctx, {})).toEqual({
      todos: [
        { id: "a", title: "First", status: "completed" },
        { id: "b", title: "Second", status: "pending" },
      ],
    });
  });

  it("updates title and detail, and clears detail with an empty string", () => {
    const ctx = fakeCtx();
    todoWriteFromTool(ctx, { todos: [{ id: "a", title: "Old", detail: "note" }] });
    expect(todoUpdateFromTool(ctx, { id: "a", title: "New" })).toEqual({
      todo: { id: "a", title: "New", status: "pending", detail: "note" },
    });
    expect(todoUpdateFromTool(ctx, { id: "a", detail: "" })).toEqual({
      todo: { id: "a", title: "New", status: "pending" },
    });
  });

  it("errors clearly when updating a missing id", () => {
    const ctx = fakeCtx();
    todoWriteFromTool(ctx, { todos: [{ id: "a", title: "First" }] });
    expect(todoUpdateFromTool(ctx, { id: "missing", status: "completed" })).toEqual({
      error: "todo not found: missing",
    });
  });

  it("errors when the id is missing or nothing is passed to update", () => {
    const ctx = fakeCtx();
    expect(todoUpdateFromTool(ctx, { status: "completed" })).toEqual({
      error: "id is required",
    });
    expect(todoUpdateFromTool(ctx, { id: "a" })).toEqual({
      error: "nothing to update: pass status, title, or detail",
    });
    expect(todoUpdateFromTool(ctx, { id: "a", status: "done" })).toEqual({
      error: "todo status must be pending, in_progress, or completed",
    });
  });

  it("does not share state between two runs", () => {
    const first = fakeCtx();
    const second = fakeCtx();
    todoWriteFromTool(first, { todos: [{ id: "a", title: "First run plan" }] });
    expect(todoReadFromTool(second, {})).toEqual({ todos: [] });
    todoWriteFromTool(second, { todos: [{ id: "b", title: "Second run plan" }] });
    expect(todoReadFromTool(first, {})).toEqual({
      todos: [{ id: "a", title: "First run plan", status: "pending" }],
    });
    expect(todoReadFromTool(second, {})).toEqual({
      todos: [{ id: "b", title: "Second run plan", status: "pending" }],
    });
  });

  it("does not let a returned list mutate the stored plan", () => {
    const ctx = fakeCtx();
    const written = todoWriteFromTool(ctx, { todos: [{ title: "Keep me" }] });
    if ("todos" in written) written.todos[0]!.title = "Changed";
    expect(todoReadFromTool(ctx, {})).toEqual({
      todos: [{ id: "todo-1", title: "Keep me", status: "pending" }],
    });
  });
});

describe("todoTools handlers", () => {
  it("writes, reads and updates through the handler map", async () => {
    const ctx = fakeCtx();
    expect(
      await todoTools.todo_write!(ctx, fakeCall("todo_write", { todos: [{ title: "Step" }] })),
    ).toEqual({
      todos: [{ id: "todo-1", title: "Step", status: "pending" }],
    });
    expect(await todoTools.todo_read!(ctx, fakeCall("todo_read", {}))).toEqual({
      todos: [{ id: "todo-1", title: "Step", status: "pending" }],
    });
    expect(
      await todoTools.todo_update!(
        ctx,
        fakeCall("todo_update", { id: "todo-1", status: "in_progress" }),
      ),
    ).toEqual({
      todo: { id: "todo-1", title: "Step", status: "in_progress" },
    });
  });

  it("returns errors through the handler map", async () => {
    const ctx = fakeCtx();
    expect(
      await todoTools.todo_update!(
        ctx,
        fakeCall("todo_update", { id: "ghost", status: "completed" }),
      ),
    ).toEqual({ error: "todo not found: ghost" });
  });
});

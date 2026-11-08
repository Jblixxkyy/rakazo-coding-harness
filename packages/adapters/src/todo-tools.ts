import type { RunContext } from "./run-context.js";
import type { ToolHandlers } from "./run-tool-gate.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  detail?: string;
}

const TODO_STATUSES: readonly string[] = ["pending", "in_progress", "completed"];
const MAX_TODOS = 100;
const MAX_TITLE_CHARS = 500;
const MAX_DETAIL_CHARS = 4000;
const MAX_ID_CHARS = 100;

/**
 * Where the plan lives, and why this shape.
 *
 * The list is kept in a module-level WeakMap keyed by the RunContext object.
 * `continueRun` (executor.ts) creates one RunContext per attempt and passes
 * that same object to every tool handler in the attempt, so:
 *
 * - every todo_* call in one run sees the same list;
 * - two runs (two RunContext objects) never share a list, and neither do a
 *   run and its subagent runs;
 * - when the attempt ends and its RunContext is dropped, the entry is
 *   collectable: nothing is retained per run and no global map grows.
 *
 * Nothing is written to the user's repo: todo state is run state, not files.
 * The scratchpad tools are the DB-backed equivalent for work that must
 * outlive a run; todo_* is deliberately the in-run plan only.
 *
 * Known limit: a resumed attempt (after an approval pause or a crash) gets a
 * fresh RunContext, so the plan does not survive the resume. Making it
 * survive needs a `todos` field on RunState (run-context.ts) restored from
 * the turn checkpoint — a shared-file change left for the coordinator.
 */
const todoStores = new WeakMap<object, TodoItem[]>();

function todoListFor(ctx: RunContext): TodoItem[] {
  const existing = todoStores.get(ctx);
  if (existing) return existing;
  const fresh: TodoItem[] = [];
  todoStores.set(ctx, fresh);
  return fresh;
}

function copyTodos(todos: TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

function nextGeneratedId(taken: Set<string>): string {
  let index = 1;
  while (taken.has(`todo-${index}`)) index += 1;
  return `todo-${index}`;
}

/**
 * Validate a whole plan list for todo_write. Returns the normalised list
 * (status defaults to pending, ids generated when missing) or `{ error }`.
 */
export function parseTodoList(input: unknown): { todos: TodoItem[] } | { error: string } {
  if (!Array.isArray(input)) {
    return { error: "todos is required and must be an array" };
  }
  if (input.length > MAX_TODOS) {
    return { error: `at most ${MAX_TODOS} todos per plan` };
  }
  const seenIds = new Set<string>();
  const todos: TodoItem[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: "each todo must be an object with a title" };
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.title !== "string" || !item.title.trim()) {
      return { error: "each todo needs a non-empty title" };
    }
    if (item.title.length > MAX_TITLE_CHARS) {
      return { error: `todo title must be at most ${MAX_TITLE_CHARS} characters` };
    }
    if (item.status !== undefined && !isTodoStatus(item.status)) {
      return { error: "todo status must be pending, in_progress, or completed" };
    }
    if (item.detail !== undefined && typeof item.detail !== "string") {
      return { error: "todo detail must be a string" };
    }
    if (typeof item.detail === "string" && item.detail.length > MAX_DETAIL_CHARS) {
      return { error: `todo detail must be at most ${MAX_DETAIL_CHARS} characters` };
    }
    let id: string;
    if (item.id === undefined) {
      id = nextGeneratedId(seenIds);
    } else {
      if (typeof item.id !== "string" || !item.id.trim() || item.id.length > MAX_ID_CHARS) {
        return { error: "todo id must be a non-empty string" };
      }
      id = item.id;
    }
    if (seenIds.has(id)) {
      return { error: `duplicate todo id: ${id}` };
    }
    seenIds.add(id);
    const todo: TodoItem = {
      id,
      title: item.title,
      status: isTodoStatus(item.status) ? item.status : "pending",
    };
    if (typeof item.detail === "string" && item.detail) todo.detail = item.detail;
    todos.push(todo);
  }
  return { todos };
}

/** Replace this run's whole plan list. */
export function todoWriteFromTool(ctx: RunContext, args: Record<string, unknown>) {
  const parsed = parseTodoList(args.todos);
  if ("error" in parsed) return parsed;
  todoStores.set(ctx, parsed.todos);
  return { todos: copyTodos(parsed.todos) };
}

/** Return this run's current plan list (empty when no plan was written). */
export function todoReadFromTool(ctx: RunContext, _args: Record<string, unknown>) {
  return { todos: copyTodos(todoListFor(ctx)) };
}

/** Update one step of this run's plan by id. */
export function todoUpdateFromTool(ctx: RunContext, args: Record<string, unknown>) {
  const id = args.id;
  if (typeof id !== "string" || !id) {
    return { error: "id is required" };
  }
  if (args.status === undefined && args.title === undefined && args.detail === undefined) {
    return { error: "nothing to update: pass status, title, or detail" };
  }
  if (args.status !== undefined && !isTodoStatus(args.status)) {
    return { error: "todo status must be pending, in_progress, or completed" };
  }
  if (args.title !== undefined && (typeof args.title !== "string" || !args.title.trim())) {
    return { error: "todo title must be a non-empty string" };
  }
  if (typeof args.title === "string" && args.title.length > MAX_TITLE_CHARS) {
    return { error: `todo title must be at most ${MAX_TITLE_CHARS} characters` };
  }
  if (args.detail !== undefined && typeof args.detail !== "string") {
    return { error: "todo detail must be a string" };
  }
  if (typeof args.detail === "string" && args.detail.length > MAX_DETAIL_CHARS) {
    return { error: `todo detail must be at most ${MAX_DETAIL_CHARS} characters` };
  }
  const todos = todoListFor(ctx);
  const todo = todos.find((item) => item.id === id);
  if (!todo) {
    return { error: `todo not found: ${id}` };
  }
  if (isTodoStatus(args.status)) todo.status = args.status;
  if (typeof args.title === "string") todo.title = args.title;
  if (typeof args.detail === "string") {
    if (args.detail) todo.detail = args.detail;
    else delete todo.detail;
  }
  return { todo: { ...todo } };
}

/**
 * The agent's own plan for this run, held in run state (see the store note
 * above), never written to the repo. todo_write and todo_update change run
 * state, so they finish through the call like other mutating tools; todo_read
 * is read-only and returns directly.
 */
export const todoTools: ToolHandlers = {
  async todo_write(ctx, call) {
    return call.finish(todoWriteFromTool(ctx, call.args));
  },
  async todo_read(ctx, call) {
    return todoReadFromTool(ctx, call.args);
  },
  async todo_update(ctx, call) {
    return call.finish(todoUpdateFromTool(ctx, call.args));
  },
};

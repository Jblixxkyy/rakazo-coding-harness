import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EVAL_CASES } from "./cases.js";
import { EvalServices } from "./services.js";

const NEW_IDS = [
  "locate-symbol",
  "multi-file-edit",
  "fix-failing-test",
  "run-tests-and-report",
  "diagnose-type-error",
  "large-repo-navigation",
  "context-retention-after-many-tools",
  "parallel-exploration",
  "find-definition",
  "find-references",
  "todo-tracked-refactor",
  "run-build-failure-report",
  "undo-after-bad-patch",
] as const;

function evidence(): Evidence {
  return {
    text: "",
    files: {},
    records: new EvalServices().records,
    notes: [],
    calls: [],
    routines: [],
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: [],
    messaging: { originThreadId: null, outbound: [] },
  };
}
function grades(id: string, e: Evidence) {
  return EVAL_CASES.find((c) => c.id === id)!.grade(e);
}
const passes = (id: string, e: Evidence) => grades(id, e).every((c) => c.pass);
const criterion = (id: string, e: Evidence, criterionId: string) =>
  grades(id, e).find((c) => c.id === criterionId)!.pass;

describe("coding eval cases", () => {
  it("adds exactly the 13 coding cases, each without a judge", () => {
    for (const id of NEW_IDS) {
      const found = EVAL_CASES.find((c) => c.id === id);
      expect(found, id).toBeDefined();
      expect(found!.judge, id).toBeUndefined();
      expect(found!.steps.length, id).toBeGreaterThan(0);
    }
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
  });
  it("each new case rejects empty evidence and a completion claim", () => {
    for (const id of NEW_IDS)
      expect(passes(id, { ...evidence(), text: "Done! I completed everything." }), id).toBe(false);
  });

  it("locate-symbol requires the exact location and a search tool", () => {
    const e = evidence();
    e.files["results/symbol.txt"] = "src/math.ts:1";
    expect(passes("locate-symbol", e)).toBe(false);
    e.toolNames = ["write_file", "grep"];
    expect(passes("locate-symbol", e)).toBe(true);
    e.toolNames = ["write_file", "glob"];
    expect(passes("locate-symbol", e)).toBe(true);
    e.toolNames = ["write_file", "read_file"];
    expect(passes("locate-symbol", e)).toBe(false);
    e.toolNames = ["write_file", "grep"];
    e.files["results/symbol.txt"] = "src/main.ts:2";
    expect(passes("locate-symbol", e)).toBe(false);
    e.files["results/symbol.txt"] = "src/math.ts:2";
    expect(passes("locate-symbol", e)).toBe(false);
  });

  it("multi-file-edit requires the rename in the interface and both call sites", () => {
    const renamed = {
      "src/types.ts": "export interface Widget {\n  id: string;\n  title: string;\n}",
      "src/render.ts":
        'export function renderWidget(widget: Widget): string {\n  return "[" + widget.id + "] " + widget.title;\n}',
      "src/list.ts":
        "export function listWidgets(widgets: Widget[]): string[] {\n  return widgets.map((widget) => widget.title);\n}",
    };
    const e = { ...evidence(), files: { ...renamed } };
    expect(passes("multi-file-edit", e)).toBe(true);
    e.files["src/types.ts"] = "export interface Widget {\n  id: string;\n  label: string;\n}";
    expect(criterion("multi-file-edit", e, "interface-renamed")).toBe(false);
    expect(criterion("multi-file-edit", e, "render-call-site-updated")).toBe(true);
    e.files["src/types.ts"] = renamed["src/types.ts"];
    e.files["src/render.ts"] = 'return "[" + widget.id + "] " + widget.label;';
    expect(criterion("multi-file-edit", e, "render-call-site-updated")).toBe(false);
    e.files["src/render.ts"] = renamed["src/render.ts"];
    e.files["src/list.ts"] = "return widgets.map((widget) => widget.label);";
    expect(criterion("multi-file-edit", e, "list-call-site-updated")).toBe(false);
    expect(passes("multi-file-edit", e)).toBe(false);
  });

  it("fix-failing-test requires the fixed file, a PASS artifact, and a test run", () => {
    const e = evidence();
    e.files["src/sum.js"] = "export function sum(a, b) {\n  return a + b;\n}";
    e.files["results/test-run.txt"] = "PASS";
    e.toolNames = ["write_file", "shell"];
    expect(passes("fix-failing-test", e)).toBe(true);
    e.toolNames = ["write_file", "run_tests"];
    expect(passes("fix-failing-test", e)).toBe(true);
    e.toolNames = ["write_file"];
    expect(criterion("fix-failing-test", e, "test-executed")).toBe(false);
    e.toolNames = ["write_file", "shell"];
    e.files["results/test-run.txt"] = "FAIL";
    expect(criterion("fix-failing-test", e, "test-green")).toBe(false);
    e.files["results/test-run.txt"] = "PASS";
    e.files["src/sum.js"] = "export function sum(a, b) {\n  return a - b;\n}";
    expect(criterion("fix-failing-test", e, "bug-fixed")).toBe(false);
    expect(passes("fix-failing-test", e)).toBe(false);
  });

  it("run-tests-and-report requires the exact report and the run_tests tool", () => {
    const e = evidence();
    e.files["results/test-report.txt"] = "passed: 3\nfailed: 0";
    e.toolNames = ["write_file", "run_tests"];
    expect(passes("run-tests-and-report", e)).toBe(true);
    e.files["results/test-report.txt"] = "passed: 3\nfailed: 0\n";
    expect(passes("run-tests-and-report", e)).toBe(true);
    e.files["results/test-report.txt"] = "passed: 2\nfailed: 1";
    expect(criterion("run-tests-and-report", e, "report-content")).toBe(false);
    e.files["results/test-report.txt"] = "3 passed, 0 failed";
    expect(criterion("run-tests-and-report", e, "report-content")).toBe(false);
    e.files["results/test-report.txt"] = "passed: 3\nfailed: 0";
    e.toolNames = ["write_file", "shell"];
    expect(criterion("run-tests-and-report", e, "used-run-tests")).toBe(false);
    expect(passes("run-tests-and-report", e)).toBe(false);
  });

  it("diagnose-type-error requires the fixed type, the intact function, and diagnostics", () => {
    const e = evidence();
    e.files["src/greet.ts"] =
      'export function greet(name: string): string {\n  return "Hello, " + name;\n}\nexport const message: string = greet("Ada");';
    e.toolNames = ["write_file", "diagnostics"];
    expect(passes("diagnose-type-error", e)).toBe(true);
    e.files["src/greet.ts"] =
      'export function greet(name: string): string {\n  return "Hello, " + name;\n}\nexport const message: number = greet("Ada");';
    expect(criterion("diagnose-type-error", e, "type-fixed")).toBe(false);
    e.files["src/greet.ts"] = 'export const message: string = greet("Ada");';
    expect(criterion("diagnose-type-error", e, "greet-function-unchanged")).toBe(false);
    e.files["src/greet.ts"] =
      'export function greet(name: string): string {\n  return "Hello, " + name;\n}\nexport const message: string = greet("Ada");';
    e.toolNames = ["write_file", "read_file"];
    expect(criterion("diagnose-type-error", e, "used-diagnostics")).toBe(false);
    expect(passes("diagnose-type-error", e)).toBe(false);
  });

  it("large-repo-navigation requires the exact location, a search, and bounded reads", () => {
    const e = evidence();
    e.files["results/symbol-location.txt"] = "src/users/repo.ts:1";
    e.toolNames = ["write_file", "grep", "read_file"];
    expect(passes("large-repo-navigation", e)).toBe(true);
    e.toolNames = ["write_file", "glob", "read_file", "read_file", "read_file"];
    expect(passes("large-repo-navigation", e)).toBe(true);
    e.toolNames = ["write_file", "grep", "read_file", "read_file", "read_file", "read_file"];
    expect(criterion("large-repo-navigation", e, "bounded-reads")).toBe(false);
    expect(passes("large-repo-navigation", e)).toBe(false);
    e.toolNames = ["write_file", "read_file", "read_file"];
    expect(criterion("large-repo-navigation", e, "searched-not-scanned")).toBe(false);
    e.toolNames = ["write_file", "repo_map"];
    expect(criterion("large-repo-navigation", e, "searched-not-scanned")).toBe(true);
    e.toolNames = ["write_file", "grep"];
    e.files["results/symbol-location.txt"] = "src/orders/repo.ts:1";
    expect(criterion("large-repo-navigation", e, "correct-symbol-location")).toBe(false);
  });

  it("context-retention-after-many-tools requires the early key and many tool calls", () => {
    const e = evidence();
    e.files["results/final.txt"] = "RETENTION-KEY-8842";
    e.toolNames = [
      "write_file",
      "read_file",
      "list_files",
      "read_file",
      "read_file",
      "read_file",
      "read_file",
      "grep",
    ];
    expect(passes("context-retention-after-many-tools", e)).toBe(true);
    e.toolNames = ["write_file", "read_file", "grep"];
    expect(criterion("context-retention-after-many-tools", e, "many-tools-used")).toBe(false);
    expect(passes("context-retention-after-many-tools", e)).toBe(false);
    e.toolNames = [
      "write_file",
      "read_file",
      "list_files",
      "read_file",
      "read_file",
      "read_file",
      "read_file",
      "grep",
    ];
    e.files["results/final.txt"] = "RETENTION-KEY-0000";
    expect(criterion("context-retention-after-many-tools", e, "retained-key")).toBe(false);
    e.files["results/final.txt"] = "alpha record one";
    expect(passes("context-retention-after-many-tools", e)).toBe(false);
  });

  it("parallel-exploration requires the combined file and run_subagent", () => {
    const e = evidence();
    e.files["results/combined.txt"] = "auth: SESSION_TTL_HOURS=12\nbilling: CURRENCY=EUR";
    e.toolNames = ["write_file", "run_subagent", "run_subagent"];
    expect(passes("parallel-exploration", e)).toBe(true);
    e.files["results/combined.txt"] = "auth: SESSION_TTL_HOURS=12\nbilling: CURRENCY=EUR\n";
    expect(passes("parallel-exploration", e)).toBe(true);
    e.files["results/combined.txt"] = "auth: SESSION_TTL_HOURS=12";
    expect(criterion("parallel-exploration", e, "combined-content")).toBe(false);
    e.files["results/combined.txt"] = "auth: SESSION_TTL_HOURS=12\nbilling: CURRENCY=USD";
    expect(passes("parallel-exploration", e)).toBe(false);
    e.files["results/combined.txt"] = "auth: SESSION_TTL_HOURS=12\nbilling: CURRENCY=EUR";
    e.toolNames = ["write_file", "read_file"];
    expect(criterion("parallel-exploration", e, "used-run-subagent")).toBe(false);
    expect(passes("parallel-exploration", e)).toBe(false);
  });

  it("find-definition requires the exact location and the find_definition tool", () => {
    const e = evidence();
    e.files["results/definition.txt"] = "src/math.ts:1";
    e.toolNames = ["write_file", "find_definition"];
    expect(passes("find-definition", e)).toBe(true);
    e.toolNames = ["write_file", "grep"];
    expect(criterion("find-definition", e, "used-find-definition")).toBe(false);
    expect(passes("find-definition", e)).toBe(false);
    e.toolNames = ["write_file", "find_definition"];
    e.files["results/definition.txt"] = "src/main.ts:2";
    expect(criterion("find-definition", e, "exact-definition-location")).toBe(false);
    e.files["results/definition.txt"] = "src/math.ts:2";
    expect(passes("find-definition", e)).toBe(false);
  });

  it("find-references requires the referencing files and the find_references tool", () => {
    const e = evidence();
    e.files["results/references.txt"] = "src/cart.ts\nsrc/checkout.ts";
    e.toolNames = ["write_file", "find_references"];
    expect(passes("find-references", e)).toBe(true);
    e.files["results/references.txt"] = "src/cart.ts\nsrc/checkout.ts\n";
    expect(passes("find-references", e)).toBe(true);
    e.files["results/references.txt"] = "src/pricing.ts\nsrc/cart.ts\nsrc/checkout.ts";
    expect(criterion("find-references", e, "referencing-files")).toBe(false);
    e.files["results/references.txt"] = "src/cart.ts";
    expect(passes("find-references", e)).toBe(false);
    e.files["results/references.txt"] = "src/cart.ts\nsrc/checkout.ts";
    e.toolNames = ["write_file", "grep"];
    expect(criterion("find-references", e, "used-find-references")).toBe(false);
    expect(passes("find-references", e)).toBe(false);
  });

  it("todo-tracked-refactor requires the rename and all three todo tools", () => {
    const renamed = {
      "src/invoice.ts": "export interface Invoice {\n  id: string;\n  amount: number;\n}",
      "src/billing.ts":
        "export function billTotal(invoice: Invoice): number {\n  return invoice.amount;\n}",
      "src/report.ts":
        'export function reportTotal(invoice: Invoice): string {\n  return "Total: " + invoice.amount;\n}',
    };
    const e = { ...evidence(), files: { ...renamed } };
    e.toolNames = ["write_file", "todo_write", "todo_update", "todo_read"];
    expect(passes("todo-tracked-refactor", e)).toBe(true);
    e.toolNames = ["write_file", "todo_write", "todo_update"];
    expect(criterion("todo-tracked-refactor", e, "used-todo-read")).toBe(false);
    expect(passes("todo-tracked-refactor", e)).toBe(false);
    e.toolNames = ["write_file", "todo_write", "todo_read"];
    expect(criterion("todo-tracked-refactor", e, "used-todo-update")).toBe(false);
    e.toolNames = ["write_file", "todo_update", "todo_read"];
    expect(criterion("todo-tracked-refactor", e, "used-todo-write")).toBe(false);
    e.toolNames = ["write_file", "todo_write", "todo_update", "todo_read"];
    e.files["src/billing.ts"] = "return invoice.total;";
    expect(criterion("todo-tracked-refactor", e, "billing-call-site-updated")).toBe(false);
    e.files["src/billing.ts"] = renamed["src/billing.ts"];
    e.files["src/invoice.ts"] = "export interface Invoice {\n  id: string;\n  total: number;\n}";
    expect(criterion("todo-tracked-refactor", e, "interface-renamed")).toBe(false);
    expect(passes("todo-tracked-refactor", e)).toBe(false);
  });

  it("run-build-failure-report requires the honest failure and the run_build tool", () => {
    const e = evidence();
    e.files["results/build-report.txt"] =
      "The build could not run: no build configured for this repo.";
    e.toolNames = ["write_file", "run_build"];
    expect(passes("run-build-failure-report", e)).toBe(true);
    e.files["results/build-report.txt"] = "The build could not run: NO BUILD CONFIGURED.";
    expect(passes("run-build-failure-report", e)).toBe(true);
    e.files["results/build-report.txt"] = "The build succeeded.";
    expect(criterion("run-build-failure-report", e, "failure-reported")).toBe(false);
    expect(criterion("run-build-failure-report", e, "no-false-success")).toBe(false);
    e.files["results/build-report.txt"] =
      "The build could not run: no build configured for this repo.";
    e.toolNames = ["write_file", "shell"];
    expect(criterion("run-build-failure-report", e, "used-run-build")).toBe(false);
    expect(passes("run-build-failure-report", e)).toBe(false);
  });

  it("undo-after-bad-patch requires the original contents and apply_patch plus undo_edit", () => {
    const original = {
      "src/types.ts": "export interface Widget {\n  id: string;\n  label: string;\n}",
      "src/render.ts":
        'export function renderWidget(widget: Widget): string {\n  return "[" + widget.id + "] " + widget.label;\n}',
      "src/list.ts":
        "export function listWidgets(widgets: Widget[]): string[] {\n  return widgets.map((widget) => widget.label);\n}",
    };
    const e = { ...evidence(), files: { ...original } };
    e.toolNames = ["write_file", "apply_patch", "undo_edit"];
    expect(passes("undo-after-bad-patch", e)).toBe(true);
    e.toolNames = ["write_file", "apply_patch"];
    expect(criterion("undo-after-bad-patch", e, "used-undo-edit")).toBe(false);
    expect(passes("undo-after-bad-patch", e)).toBe(false);
    e.toolNames = ["write_file", "undo_edit"];
    expect(criterion("undo-after-bad-patch", e, "used-apply-patch")).toBe(false);
    e.toolNames = ["write_file", "apply_patch", "undo_edit"];
    e.files["src/types.ts"] = "export interface Widget {\n  id: string;\n  title: string;\n}";
    expect(criterion("undo-after-bad-patch", e, "original-restored")).toBe(false);
    expect(passes("undo-after-bad-patch", e)).toBe(false);
  });
});

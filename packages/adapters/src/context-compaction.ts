import type { Message } from "@earendil-works/pi-ai";

/**
 * Coding-tool results that carry exact evidence (file contents, matches,
 * diffs, checker output). While a session is short they stay verbatim; once
 * the coding window grows past COMPACT_CODING_KEEP_RECENT, the oldest of them
 * collapse to a compact summary instead of staying whole. History and skill
 * reads are not coding tools and keep their own retention rules.
 */
export const CODING_TOOL_RESULTS: ReadonlySet<string> = new Set([
  "read_file",
  "grep",
  "glob",
  "edit",
  "apply_patch",
  "repo_map",
  "git_diff",
  "git_status",
  "git_commit",
  "run_tests",
  "diagnostics",
  "run_build",
]);

/**
 * How many of the most recent coding-tool results stay verbatim. Matches
 * RECENT_TOOL_RESULTS_TO_KEEP in runtime-context.ts: a session with at most
 * this many coding results is never compacted.
 */
export const COMPACT_CODING_KEEP_RECENT = 8;

const MAX_SUMMARY_PATHS = 3;
const MAX_OUTCOME_CHARS = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

function truncateOutcome(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_OUTCOME_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_OUTCOME_CHARS)}…`;
}

function pathList(paths: string[]): string {
  if (paths.length === 0) return "";
  return `: ${paths.slice(0, MAX_SUMMARY_PATHS).join(", ")}`;
}

/**
 * Deterministic, offline summary of one coding-tool result: counts, file
 * paths, and an outcome line — never the full text. Structured results
 * (read_file, grep, run_tests, diagnostics, repo_map, ...) are summarized
 * from their fields; anything else falls back to its first line plus a line
 * count. The full body (file contents, matches, diffs, raw output) is never
 * copied into the summary.
 */
export function summariseCodingToolResult(toolName: string, content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed)) {
      const details: string[] = [];
      if (typeof parsed.path === "string" && parsed.path) details.push(parsed.path);
      if (typeof parsed.totalLines === "number") {
        details.push(plural(parsed.totalLines, "line"));
      } else if (typeof parsed.content === "string") {
        const lines = parsed.content === "" ? 0 : parsed.content.split("\n").length;
        details.push(plural(lines, "line"));
      }
      if (Array.isArray(parsed.matches)) {
        const paths = [
          ...new Set(
            parsed.matches.map((match) =>
              isRecord(match) && typeof match.path === "string" ? match.path : "",
            ),
          ),
        ].filter(Boolean);
        details.push(
          `${plural(parsed.matches.length, "match", "matches")} in ${plural(paths.length, "file")}${pathList(paths)}`,
        );
      }
      if (Array.isArray(parsed.diagnostics)) {
        const errors = parsed.diagnostics.filter(
          (diagnostic) => isRecord(diagnostic) && diagnostic.severity === "error",
        ).length;
        details.push(
          `${plural(parsed.diagnostics.length, "diagnostic")} (${errors} error${errors === 1 ? "" : "s"})`,
        );
      }
      if (Array.isArray(parsed.failed)) {
        details.push(plural(parsed.failed.length, "failure"));
      }
      if (typeof parsed.files === "number") {
        details.push(plural(parsed.files, "file"));
      } else if (Array.isArray(parsed.files)) {
        const paths = parsed.files
          .map((file) =>
            typeof file === "string"
              ? file
              : isRecord(file) && typeof file.path === "string"
                ? file.path
                : "",
          )
          .filter(Boolean);
        details.push(`${plural(paths.length, "file")}${pathList(paths)}`);
      }
      if (Array.isArray(parsed.symbols)) details.push(plural(parsed.symbols.length, "symbol"));
      if (typeof parsed.replacements === "number") {
        details.push(plural(parsed.replacements, "replacement"));
      }
      let outcome = "";
      if (typeof parsed.summary === "string" && parsed.summary) {
        outcome = truncateOutcome(parsed.summary);
      } else if (typeof parsed.error === "string" && parsed.error) {
        outcome = `error: ${truncateOutcome(parsed.error)}`;
      } else if (parsed.ok === true) {
        outcome = "ok";
      } else if (parsed.ok === false) {
        outcome = "failed";
      } else if (parsed.truncated === true) {
        outcome = "truncated";
      }
      return `[compacted ${toolName}${details.length ? `: ${details.join("; ")}` : ""}${outcome ? ` — ${outcome}` : ""}]`;
    }
  } catch {
    // Not JSON; fall through to the first-line summary below.
  }
  const lines = content.split("\n");
  const first = lines.find((line) => line.trim())?.trim() ?? "";
  if (!first) return `[compacted ${toolName}: empty result]`;
  return `[compacted ${toolName}: ${truncateOutcome(first)} (${plural(lines.length, "line")})]`;
}

function toolResultText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Replace one coding-tool result's body with its compact summary, keeping the
 * role, toolCallId, toolName, and any image parts. Never grows the message:
 * a result whose summary would be longer than the original is returned
 * unchanged.
 */
export function compactCodingToolResultMessage(message: Message): Message {
  if (message.role !== "toolResult") return message;
  const source = toolResultText(message);
  const summary = summariseCodingToolResult(message.toolName ?? "tool", source);
  if (summary.length >= source.length) return message;
  return {
    ...message,
    content: [
      { type: "text" as const, text: summary },
      ...message.content.filter((part) => part.type === "image"),
    ],
  };
}

/**
 * Compact the oldest coding-tool results in `messages`, keeping the most
 * recent `keepRecent` verbatim. A short session (at most `keepRecent` coding
 * results) is returned with its messages untouched. Deterministic and offline;
 * the most recent results are never compacted.
 */
export function compactOldCodingToolResults(
  messages: readonly Message[],
  keepRecent: number = COMPACT_CODING_KEEP_RECENT,
): Message[] {
  const codingIndexes = messages.flatMap((message, index) =>
    message.role === "toolResult" &&
    message.toolName !== undefined &&
    CODING_TOOL_RESULTS.has(message.toolName)
      ? [index]
      : [],
  );
  if (codingIndexes.length <= keepRecent) return [...messages];
  const compact = new Set(codingIndexes.slice(0, Math.max(0, codingIndexes.length - keepRecent)));
  return messages.map((message, index) =>
    compact.has(index) ? compactCodingToolResultMessage(message) : message,
  );
}

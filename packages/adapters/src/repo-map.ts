import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { resolveBotWorkspacePath } from "./computer-support.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import type { RunWorkspace } from "./workspace-file-tools.js";

/** Directories never walked, whatever the workspace holds. */
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  "coverage",
  ".venv",
  "__pycache__",
]);

const MAX_TREE_LINES = 200;
const MAX_SYMBOLS = 300;
const MAX_FILE_BYTES = 250_000;
const REPO_MAP_CACHE_TTL_MS = 60_000;
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go"]);

export interface RepoMapSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
}

export interface RepoMap {
  tree: string;
  symbols: RepoMapSymbol[];
  files: number;
  truncated: boolean;
}

/**
 * Compact repo map for a system prompt: the tree plus the first symbols,
 * bounded so the map stays a hint rather than a dump. Use grep, glob, and
 * read_file for the details behind any entry here.
 */
export function formatRepoMapForPrompt(map: RepoMap, maxChars = 6000): string {
  const lines = [
    "Repository map (cached tree and symbols; use grep, glob, and read_file for details):",
    map.tree,
  ];
  if (map.symbols.length > 0) {
    lines.push(
      "Symbols:",
      ...map.symbols
        .slice(0, 100)
        .map((symbol) => `${symbol.name} (${symbol.kind}) — ${symbol.path}:${symbol.line}`),
    );
  }
  if (map.truncated) lines.push("(map truncated; more files and symbols exist)");
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n(map truncated)` : text;
}

const repoMapCache = new Map<string, { at: number; map: RepoMap }>();

interface GitignoreRule {
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

function gitignoreRegex(pattern: string): RegExp {
  let out = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          out += "(?:.*/)?";
          index += 2;
        } else {
          out += ".*";
          index += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** Blank lines and comments are ignored; `!` negation is not supported. */
function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of content.split("\n")) {
    let pattern = rawLine.trim();
    if (!pattern || pattern.startsWith("#")) continue;
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    let anchored = false;
    if (pattern.startsWith("/")) {
      anchored = true;
      pattern = pattern.slice(1);
    }
    if (!pattern) continue;
    // A slash anywhere else anchors the pattern to the workspace root.
    if (pattern.includes("/")) anchored = true;
    rules.push({ dirOnly, anchored, regex: gitignoreRegex(pattern) });
  }
  return rules;
}

/** True when the path, or one of its ancestor directories, matches a rule. */
function matchesGitignore(rules: GitignoreRule[], relPath: string, isDir: boolean): boolean {
  const segments = relPath.split("/");
  for (let end = 1; end <= segments.length; end++) {
    const candidate = segments.slice(0, end).join("/");
    const candidateIsDir = end < segments.length || isDir;
    for (const rule of rules) {
      if (rule.dirOnly && !candidateIsDir) continue;
      if (rule.anchored ? rule.regex.test(candidate) : rule.regex.test(segments[end - 1]!))
        return true;
    }
  }
  return false;
}

async function loadGitignore(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  root: string,
  workspace: RunWorkspace,
): Promise<GitignoreRule[]> {
  try {
    const bytes = await sandbox.readFile(
      computer,
      root ? `${root}/.gitignore` : ".gitignore",
      workspace.context,
    );
    return parseGitignore(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // No .gitignore at the root, or it is unreadable: walk without it.
    return [];
  }
}

function relativePath(root: string, storedPath: string): string {
  if (!root) return storedPath;
  if (storedPath === root) return "";
  return storedPath.startsWith(`${root}/`) ? storedPath.slice(root.length + 1) : storedPath;
}

function isCodeFile(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  return dot >= 0 && CODE_EXTENSIONS.has(relPath.slice(dot));
}

async function readTextFile(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  storedPath: string,
  workspace: RunWorkspace,
): Promise<string | undefined> {
  try {
    const bytes = await sandbox.readFile(computer, storedPath, workspace.context, {
      maxBytes: MAX_FILE_BYTES,
    });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Binary content that happens to decode is not source to scan.
    if (text.includes("\0")) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

const TS_PATTERNS: Array<{ regex: RegExp; kind: string }> = [
  {
    regex: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    kind: "function",
  },
  {
    regex: /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: "class",
  },
  { regex: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { regex: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { regex: /^\s*export\s+const\s+([A-Za-z_$][\w$]*)/, kind: "const" },
  { regex: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { regex: /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
];
const PY_PATTERNS: Array<{ regex: RegExp; kind: string }> = [
  { regex: /^\s*def\s+([A-Za-z_]\w*)\s*\(/, kind: "function" },
  { regex: /^\s*class\s+([A-Za-z_]\w*)\s*[(:]/, kind: "class" },
];
const GO_PATTERNS: Array<{ regex: RegExp; kind: string }> = [
  { regex: /^\s*func\s*\(\s*[A-Za-z_]\w*\s+[^)]*\)\s*([A-Za-z_]\w*)\s*\(/, kind: "function" },
  { regex: /^\s*func\s+([A-Za-z_]\w*)\s*\(/, kind: "function" },
];

function patternsFor(relPath: string): Array<{ regex: RegExp; kind: string }> | undefined {
  if (relPath.endsWith(".py")) return PY_PATTERNS;
  if (relPath.endsWith(".go")) return GO_PATTERNS;
  return TS_PATTERNS;
}

/** One symbol per line at most. Returns false when the symbol cap was hit. */
function scanSymbols(relPath: string, content: string, symbols: RepoMapSymbol[]): boolean {
  const patterns = patternsFor(relPath);
  if (!patterns) return true;
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    for (const { regex, kind } of patterns) {
      const match = regex.exec(lines[index]!);
      if (!match) continue;
      if (symbols.length >= MAX_SYMBOLS) return false;
      symbols.push({ name: match[1]!, kind, path: relPath, line: index + 1 });
      break;
    }
  }
  return true;
}

/**
 * The workspace tree plus top-level symbols, cached for 60 seconds per bot.
 * `refresh` bypasses the cache. The tree is capped at 200 lines and symbols at
 * 300; either cap sets `truncated`.
 */
export async function buildRepoMap(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  opts: { refresh?: boolean } = {},
): Promise<RepoMap> {
  const cacheKey = `${workspace.botId}:${workspace.computerMode}`;
  if (!opts.refresh) {
    const cached = repoMapCache.get(cacheKey);
    if (cached && Date.now() - cached.at < REPO_MAP_CACHE_TTL_MS) return cached.map;
  }
  const computer = await workspace.computer();
  const root = resolveBotWorkspacePath(workspace.computerMode, workspace.botId, "");
  const rules = await loadGitignore(sandbox, computer, root, workspace);
  const lines: string[] = [];
  const symbols: RepoMapSymbol[] = [];
  let files = 0;
  let truncated = false;
  let symbolCapHit = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = [...(await sandbox.listFiles(computer, dir, workspace.context))].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    for (const entry of entries) {
      const rel = relativePath(root, entry.path);
      if (!rel) continue;
      const name = rel.split("/").pop()!;
      if (entry.kind === "dir") {
        if (IGNORED_DIRECTORIES.has(name) || matchesGitignore(rules, rel, true)) continue;
        lines.push(`${"  ".repeat(depth)}${name}/`);
        await walk(entry.path, depth + 1);
      } else {
        if (rel.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment))) continue;
        if (matchesGitignore(rules, rel, false)) continue;
        files += 1;
        lines.push(`${"  ".repeat(depth)}${name}`);
        if (!symbolCapHit && isCodeFile(rel) && entry.size <= MAX_FILE_BYTES) {
          const content = await readTextFile(sandbox, computer, entry.path, workspace);
          if (content !== undefined && !scanSymbols(rel, content, symbols)) {
            symbolCapHit = true;
            truncated = true;
          }
        }
      }
    }
  };
  await walk(root, 0);
  if (lines.length > MAX_TREE_LINES) truncated = true;
  const map: RepoMap = {
    tree: redactSecrets(lines.slice(0, MAX_TREE_LINES).join("\n"), workspace.runSecrets),
    symbols: symbols.map((symbol) => ({
      ...symbol,
      name: redactSecrets(symbol.name, workspace.runSecrets),
      path: redactSecrets(symbol.path, workspace.runSecrets),
    })),
    files,
    truncated,
  };
  repoMapCache.set(cacheKey, { at: Date.now(), map });
  return map;
}

/** Cheap heuristic for whether a message is about code work. */
export function isCodeRelated(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\.(ts|tsx|js|jsx|py|go)\b/.test(lower)) return true;
  if (lower.includes("stack trace")) return true;
  return /\b(code|file|function|test|tests|testing|error|errors|grep|edit|patch|repo|commit)\b/.test(
    lower,
  );
}

function runWorkspace(ctx: RunContext, call: ToolCall): RunWorkspace {
  return {
    botId: ctx.bot.id,
    computerMode: ctx.computer.mode,
    computer: () => ctx.computer.get("tool", call.name),
    markDirty: () => ctx.computer.checkpoint.markDirty(),
    context: ctx.context,
    runSecrets: ctx.secrets,
  };
}

/** Read-only repo map tool; the model calls it with no arguments (or refresh). */
export const repoMapTools: ToolHandlers = {
  async repo_map(ctx, call) {
    const workspace = runWorkspace(ctx, call);
    return buildRepoMap(ctx.deps.sandbox, workspace, { refresh: call.args.refresh === true });
  },
};

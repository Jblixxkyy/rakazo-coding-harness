import { createHash } from "node:crypto";
import path from "node:path";
import type { ComputerAction, ComputerObservation, ComputerRef } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";

export function toComputerRef(computer: {
  homeKey: string;
  kind: string;
  providerRef: string | null;
}): ComputerRef {
  if (!computer.providerRef) throw new Error("computer provider reference is missing");
  return {
    id: computer.providerRef,
    botId: computer.homeKey,
    kind: computer.kind as ComputerRef["kind"],
    providerRef: computer.providerRef,
  };
}

const EMPTY_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

export function computerObservation(
  image: Uint8Array,
  input: Omit<ComputerObservation, "frameId" | "capturedAt" | "image">,
): ComputerObservation {
  return {
    ...input,
    image,
    frameId: createHash("sha256").update(image).digest("hex"),
    capturedAt: new Date().toISOString(),
  };
}

export function placeholderObservation(label = "ready"): ComputerObservation {
  return computerObservation(EMPTY_PNG, {
    mimeType: "image/png",
    width: 1,
    height: 1,
    activeWindow: { id: "placeholder", title: label },
  });
}

export function applyPlaceholderAction(box: { screen: string }, action: ComputerAction): void {
  if (action.kind === "clipboard") box.screen = action.text;
  else if (action.kind === "open") box.screen = `opened ${action.path}`;
  else if (action.kind === "launch") box.screen = `launched ${action.application}`;
  else if (action.kind === "focus") box.screen = `focused ${action.application}`;
  else box.screen = action.kind;
}

export function boundedComputerActions(actions: readonly ComputerAction[]): ComputerAction[] {
  if (actions.length > 24) throw new Error("computer action batch exceeds 24 actions");
  return [...actions];
}

export function clampRounded(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

export function normalizeWorkspacePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Path escapes the computer workspace");
  }
  return segments.join("/");
}

export function workspacePath(root: string, relative: string): string {
  const normalized = normalizeWorkspacePath(relative);
  return normalized ? path.posix.join(root, normalized) : root;
}

export function teamBotWorkspaceDirectory(botId: string): string {
  return path.posix.join("bots", normalizeWorkspacePath(botId));
}

/** Namespace prefix marking a subagent run as isolated (see isolationRootForExecutionId). */
export const ISOLATED_SUBAGENT_NAMESPACE_PREFIX = "isolated:";

/**
 * The workspace folder an isolated subagent writes under, so parallel
 * helpers never race on the same files. The id is the run_subagent call's
 * executionId, unique per subagent run; anything outside letters, digits,
 * `-` and `_` is flattened so it stays one path segment.
 */
export function isolatedSubagentWorkspace(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "helper";
  return `subagents/${safe}`;
}

/** Clear refusal for a path that addresses outside an isolated subagent's folder. */
export function isolatedWorkspaceRefusal(isolationRoot: string): string {
  return `Path is outside the isolated subagent workspace ${isolationRoot}/`;
}

export function isIsolatedWorkspaceRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Path is outside the isolated subagent workspace ")
  );
}

/**
 * Decode only the exact backend Pi namespace shape, never an arbitrary
 * provider ID. Mirrors piToolExecution in run-effects.ts; kept local so this
 * low-level module does not import the executor's effect layer.
 */
function piToolExecutionAgent(executionId: string): string | undefined {
  try {
    const value: unknown = JSON.parse(executionId);
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === "pi-tool" &&
      typeof value[1] === "string" &&
      value[1].length > 0 &&
      typeof value[2] === "string" &&
      value[2].length > 0
    )
      return value[1];
  } catch {
    // Other runtimes keep their existing opaque execution IDs.
  }
  return undefined;
}

/**
 * The isolation root for a tool call made by an isolated subagent, or null
 * for the parent run and non-isolated helpers. An isolated subagent's
 * namespace is `isolated:<run_subagent executionId>`, so the root travels
 * with the call's executionId: no shared state, and parallel subagents
 * (distinct executionIds) get distinct roots.
 */
export function isolationRootForExecutionId(executionId: string): string | null {
  const agent = piToolExecutionAgent(executionId);
  if (!agent?.startsWith(ISOLATED_SUBAGENT_NAMESPACE_PREFIX)) return null;
  return isolatedSubagentWorkspace(agent.slice(ISOLATED_SUBAGENT_NAMESPACE_PREFIX.length));
}

export function resolveBotWorkspacePath(
  scope: ComputerMode,
  botId: string,
  rawPath: string,
  isolationRoot?: string | null,
): string {
  const requestedPath = expandHomePrefix(rawPath);
  if (scope !== "team" && !isolationRoot) return requestedPath;
  if (isolationRoot) {
    return resolveIsolatedBotWorkspacePath(scope, botId, rawPath, requestedPath, isolationRoot);
  }
  const explicitRootPath = stripVirtualWorkspaceRoot(requestedPath);
  const normalized = normalizeWorkspacePath(explicitRootPath ?? requestedPath);
  if (explicitRootPath !== null || isTeamRootPath(normalized)) return normalized;
  return path.posix.join(teamBotWorkspaceDirectory(botId), normalized);
}

/**
 * Resolve a path for an isolated subagent: the isolation root is the
 * subagent's effective workspace root. Relative paths land under it (a
 * leading isolation-root prefix is de-duplicated, so both `notes.txt` and
 * `subagents/<id>/notes.txt` address the same file); `~` and `/home/rakazo`
 * mean the isolated home. Team-root addressing (`shared/`, `bots/…`, a bare
 * leading `/…` in team mode) is allowed only when it already addresses
 * inside the subtree; anything else is refused. `..` still throws from
 * normalizeWorkspacePath.
 */
function resolveIsolatedBotWorkspacePath(
  scope: ComputerMode,
  botId: string,
  rawPath: string,
  requestedPath: string,
  isolationRoot: string,
): string {
  const storedRoot =
    scope === "team"
      ? path.posix.join(teamBotWorkspaceDirectory(botId), isolationRoot)
      : isolationRoot;
  const homePrefixed = /^(?:~|[\\/]home[\\/]rakazo)([\\/]|$)/.test(rawPath);
  const explicitRootPath = stripVirtualWorkspaceRoot(requestedPath);
  const normalized = normalizeWorkspacePath(explicitRootPath ?? requestedPath);
  const absolute = explicitRootPath !== null;
  if (scope === "team" && !homePrefixed && (absolute || isTeamRootPath(normalized))) {
    if (normalized === storedRoot || normalized.startsWith(`${storedRoot}/`)) {
      return normalized;
    }
    throw new Error(isolatedWorkspaceRefusal(isolationRoot));
  }
  const relative = stripIsolationRootPrefix(normalized, isolationRoot);
  const joined = relative ? path.posix.join(storedRoot, relative) : storedRoot;
  // Dedicated mode keeps the input's absolute form: a leading `/` (or `~`)
  // addresses the workspace root, so the isolated path keeps its slash.
  return scope === "team" || !absolute ? joined : `/${joined}`;
}

/** Drop one leading isolation-root prefix so the subagent's own folder is not nested. */
function stripIsolationRootPrefix(normalized: string, isolationRoot: string): string {
  if (normalized === isolationRoot) return "";
  return normalized.startsWith(`${isolationRoot}/`)
    ? normalized.slice(isolationRoot.length + 1)
    : normalized;
}

/**
 * A stored workspace path relative to the root a shell runs in: the bot
 * folder, or the isolation folder for an isolated subagent. Used for argv
 * paths (sed/awk) that run with that root as their cwd.
 */
export function workspaceRelativePath(
  scope: ComputerMode,
  botId: string,
  storedPath: string,
  isolationRoot?: string | null,
): string {
  const root =
    scope === "team"
      ? isolationRoot
        ? path.posix.join(teamBotWorkspaceDirectory(botId), isolationRoot)
        : teamBotWorkspaceDirectory(botId)
      : (isolationRoot ?? "");
  const normalized = normalizeWorkspacePath(storedPath);
  if (!root) return normalized;
  if (normalized === root) return "";
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

export function resolveBotWorkspaceCwd(
  scope: ComputerMode,
  botId: string,
  requestedCwd: string | undefined,
  isolationRoot?: string | null,
): string | undefined {
  if (isolationRoot) {
    if (!requestedCwd || requestedCwd === ".") {
      return scope === "team"
        ? path.posix.join(teamBotWorkspaceDirectory(botId), isolationRoot)
        : isolationRoot;
    }
    if (path.win32.isAbsolute(requestedCwd)) {
      // A drive-letter or UNC working directory cannot live under the isolated root.
      throw new Error(isolatedWorkspaceRefusal(isolationRoot));
    }
    return resolveBotWorkspacePath(scope, botId, requestedCwd, isolationRoot);
  }
  if (scope !== "team") return requestedCwd;
  if (!requestedCwd || requestedCwd === ".") return teamBotWorkspaceDirectory(botId);
  if (path.posix.isAbsolute(requestedCwd) || path.win32.isAbsolute(requestedCwd))
    return requestedCwd;
  return resolveBotWorkspacePath(scope, botId, requestedCwd);
}

/** Paths a user may write while controlling this bot: its home, or shared/. */
export function resolveBotUploadPath(
  scope: ComputerMode,
  botId: string,
  requestedPath: string,
): string {
  const stored = resolveBotWorkspacePath(scope, botId, requestedPath);
  if (scope !== "team") return normalizeWorkspacePath(stored);
  const normalized = normalizeWorkspacePath(stored);
  const botDirectory = teamBotWorkspaceDirectory(botId);
  if (
    normalized === botDirectory ||
    normalized.startsWith(`${botDirectory}/`) ||
    normalized === "shared" ||
    normalized.startsWith("shared/")
  ) {
    return normalized;
  }
  throw new Error("Path escapes the bot workspace");
}

export function displayBotWorkspacePath(
  scope: ComputerMode,
  botId: string,
  requestedPath: string,
  storedPath: string,
  isolationRoot?: string | null,
): string {
  if (isolationRoot) {
    // An isolated subagent sees its own folder as its workspace root.
    const normalized = normalizeWorkspacePath(storedPath);
    const root =
      scope === "team"
        ? path.posix.join(teamBotWorkspaceDirectory(botId), isolationRoot)
        : isolationRoot;
    if (normalized === root) return "";
    return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
  }
  if (scope !== "team" || !isBotRelativeRequest(requestedPath)) return storedPath;
  const normalized = normalizeWorkspacePath(storedPath);
  const botDirectory = teamBotWorkspaceDirectory(botId);
  if (normalized === botDirectory) return "";
  return normalized.startsWith(`${botDirectory}/`)
    ? normalized.slice(botDirectory.length + 1)
    : normalized;
}

function isBotRelativeRequest(value: string): boolean {
  if (stripVirtualWorkspaceRoot(expandHomePrefix(value)) !== null) return false;
  return !isTeamRootPath(normalizeWorkspacePath(value));
}

function isTeamRootPath(value: string): boolean {
  return (
    value === "shared" ||
    value.startsWith("shared/") ||
    value === "bots" ||
    value.startsWith("bots/")
  );
}

// A leading ~ or /home/rakazo means the workspace root, the same as a leading /.
function expandHomePrefix(value: string): string {
  return value.replace(
    /^(?:~|[\\/]home[\\/]rakazo)([\\/]|$)/,
    (_, separator: string) => separator || "/",
  );
}

function stripVirtualWorkspaceRoot(value: string): string | null {
  const portable = value.replace(/\\/g, "/");
  if (portable === "/") return "";
  return portable.startsWith("/") ? portable.slice(1) : null;
}

export { shellQuote } from "@rakazo/core/node/desktop-runtime";

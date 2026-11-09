# Rakazo Coding Harness Plan

Status: implemented and verified on VM (2026-11-08) — P0–P3 complete, plus Round 2
below. Server sync is UNVERIFIED: SSH to the server timed out repeatedly on
2026-11-08, so the work is confirmed only on the VM copy. Never pushed to origin.
Target repo: `/home/jblixxkyy/project/rakazo-coding-harness` (clone of `github.com/elie222/rakazo`, Apache-2.0)
Baseline commit at clone time: `73c719d7`

This file is the source of truth for the coding-harness work. Update it as phases land.

## Goal

Make Rakazo competitive for coding tasks by extending its tool surface, feedback loop,
context handling, and evaluation — without changing existing features, the Pi runtime,
or provider neutrality.

## Non-goals

- No rewrite of the Pi runtime, `SandboxProvider`, or the executor.
- No new hosted vendor or vendor SDK in core.
- No renames or behavior changes to existing tools.
- No UI redesign; at most concise tool descriptions.

## Where the work lives

- Clone: `/home/jblixxkyy/project/rakazo-coding-harness`
- `origin` points at `https://github.com/elie222/rakazo.git` for rebasing.
- Add your own fork remote before pushing:
  `git remote add fork git@github.com:<you>/rakazo.git`
- Branch per phase:
  - `feat/coding-harness-p0` (tools)
  - `feat/coding-harness-p1` (feedback)
  - `feat/coding-harness-p2` (context)
  - `feat/coding-harness-p3` (routing/isolation)
- Merge order: P0 → evals → P1 → P2 → P3.

## Architecture constraints (from AGENTS.md)

- Implement tools in `packages/adapters/src/` over existing sandbox primitives
  (`readFile`, `writeFile`, `listFiles`, `shell`). Do not extend `SandboxProvider` for
  every provider (12+ implementations).
- Keep everything provider-neutral. No vendor calls outside adapters.
- Tests must be deterministic and offline by default. Judge calls stay opt-in.
- Use top-level `import type`; dynamic `import()` only for real deferred loading.
- Reuse existing primitives; no speculative abstractions.
- Migrations (if any) must be backward compatible. This plan expects no migrations.
- Public repo: no secrets, personal data, or production values in files, commits, or PR text.

## Baseline: where Rakazo lacks for coding (evidence)

| Gap | Evidence |
| --- | --- |
| Only `list_files`, `read_file`, `write_file`, `shell` | `packages/adapters/src/builtin-tools.ts:383-429` |
| `list_files` is shallow, non-recursive, skips symlinks | `infra/sandboxes/supervisor/src/index.ts:744-800` |
| `read_file` is whole-file, no offset/limit/line numbers, 250 KB cap | `packages/adapters/src/workspace-file-tools.ts:30,60-90` |
| `write_file` overwrites the whole file | `packages/adapters/src/run-tools-files.ts:104-130` |
| No grep, glob, edit, apply_patch, LSP, or git tools | tool list in `builtin-tools.ts` |
| Shell guard refuses heredocs and other idioms | `packages/adapters/src/desktop-command-guard.ts:619-622` |
| Only the 3 most recent tool results stay verbatim | `packages/adapters/src/runtime-context.ts:20,484-490` |
| No coding evals (file/CRM/inbox/release cases only) | `packages/testkit/src/evals/cases.ts:130-160` |
| Default model is vision-oriented | `PI_DEFAULT_MODEL` in `.env.example` |
| Shell output keeps only the tail | `packages/adapters/src/run-tools-computer.ts:315` |
| Subagents have no isolated computer | `packages/adapters/src/pi-runtime-subagent.ts:237-247` |

## Phase P0 — Core coding loop

### Tools to add

1. `grep`
   - Inputs: `pattern` (regex), `include` (glob, optional), `path` (optional), `limit`
     (default 100, max 500), `caseSensitive` (default true).
   - Output: `{ matches: [{ path, line, text }], truncated }`.
   - Implementation: run `grep -rn`/`rg` inside the sandbox when available; fall back to a
     `listFiles` walk + `readFile` scan when the provider has no shell. Never read
     outside the bot workspace.
2. `glob`
   - Inputs: `pattern`, `path` (optional), `limit` (default 200).
   - Output: `{ paths: string[], truncated }`.
   - Implementation: `find` in the sandbox with a translated pattern; fallback to a
     `listFiles` walk.
3. `read_file` paging (extend the existing tool, keep old behavior when no options given)
   - New optional inputs: `offset` (1-based line), `limit` (lines), `lineNumbers`
     (default false).
   - Output adds `totalLines`, `startLine`, `endLine`, `truncated`.
   - Keep the 250 KB cap; return a paged slice instead of failing when the caller gives
     `offset`/`limit`.
4. `edit`
   - Inputs: `path`, `oldString`, `newString`, `replaceAll` (default false).
   - Exact match first; allow whitespace-tolerant match only when unambiguous.
   - Fail with a clear error when `oldString` is missing or matches more than once and
     `replaceAll` is false.
5. `apply_patch`
   - Inputs: `patchText` (unified diff supporting add/update/delete).
   - Apply sequentially; abort on the first failure; return per-file results.

### Files

- New: `packages/adapters/src/search-tools.ts` (grep, glob)
- New: `packages/adapters/src/edit-tools.ts` (edit, apply_patch)
- Edit: `packages/adapters/src/builtin-tools.ts` (definitions and descriptions)
- Edit: `packages/adapters/src/run-tools.ts` (register handlers)
- Edit: `packages/adapters/src/run-tools-files.ts` (wire read paging and edit handlers)
- Edit: `packages/adapters/src/workspace-file-tools.ts` (paged read)
- Tests: `packages/adapters/src/search-tools.test.ts`, `edit-tools.test.ts`,
  `workspace-file-tools.test.ts`

### Safety

- Resolve every path through `resolveBotWorkspacePath`; reject traversal and absolute
  paths outside the workspace.
- `grep`/`glob`/`read_file` stay approval-exempt.
- `edit`/`apply_patch` follow the current `write_file` policy (exempt by default) and
  record a computer action for audit.
- Redact run secrets from returned text, as the existing file tools do.

### Evals (P0 gate)

Add to `packages/testkit/src/evals/cases.ts`:

- `locate-symbol` — find the definition of a named function across a seeded repo.
- `multi-file-edit` — change an interface and both call sites.
- `fix-failing-test` — run a seeded test, patch the bug, re-run until green.

## Phase P1 — Feedback and verification

- `git_status` and `git_diff` (read-only, path-scoped). Optional `git_commit` behind
  explicit approval.
- `run_tests` — detect the project runner (`package.json` script, pytest, go test) and
  return structured `{ ok, failed: [...], summary }`; keep raw output capped.
- `diagnostics` — run the project's configured checker (`tsc --noEmit`, `eslint`,
  `ruff`, `go vet`) and parse errors into `{ path, line, column, severity, message }`.
- Shell truncation: keep head and tail, not only the tail, with an explicit
  `[output truncated: N chars]` marker.
- Evals: `run-tests-and-report`, `diagnose-type-error`.

## Phase P2 — Context and navigation

- Repo map: cached tree plus symbol list built from `list_files`/`grep`, injected only
  when the task looks code-related (progressive disclosure).
- Keep recent `read_file`/`grep`/`edit` results verbatim longer than 3 turns; extend
  `UNSHORTENED_TOOL_RESULTS` for the coding tools.
- Honor `.gitignore` and common ignore dirs (`node_modules`, `.git`, `dist`) in
  grep/glob.
- Evals: `large-repo-navigation`, `context-retention-after-many-tools`.

## Phase P3 — Routing and isolation

- Coding-oriented default model and fallback through the existing connection settings;
  no new env vars, no provider-specific keys.
- Optional isolated workspace for `run_subagent` so parallel exploration does not race
  on one home.
- Evals: `parallel-exploration`.

## Parallel workstreams (AI agents)

Run these in separate worktrees/branches; do not let two agents edit the same file.

| Stream | Owns | Depends on |
| --- | --- | --- |
| A. Search | `search-tools.ts`, its tests, `builtin-tools.ts` grep/glob entries | — |
| B. Edit | `edit-tools.ts`, `workspace-file-tools.ts` paging, its tests | — |
| C. Feedback | git/test/diagnostics tools, shell truncation | A, B (tool registration order) |
| D. Evals | `packages/testkit/src/evals/*` | A, B |
| E. Context | `runtime-context.ts`, repo map | A |
| F. Docs | this file, README/AGENTS notes | all |

Integration rule: one agent owns `run-tools.ts` at a time; others rebase before touching it.

## Verification matrix

Run from the repo root:

```bash
pnpm install
pnpm db:generate
pnpm lint
pnpm check
pnpm test
pnpm test:integration      # needs Docker
pnpm test:pi               # real Pi against local model fixture, no keys
pnpm test:computer-replay  # needs the computer image, no keys
pnpm test:evals --list
```

Not run locally: `pnpm --filter @rakazo/desktop test:e2e` (opens real Electron windows and
steals focus; CI covers it).

Definition of done for each phase:

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- New unit tests cover success, limits, and path-traversal refusal.
- New eval cases pass offline.
- No new dependencies unless unavoidable and justified in the PR description.
- PR description follows AGENTS.md (`## What`, `## Why`, `## Changes`, `## Tested`).

## Risks

- Tool descriptions consume context; keep them one or two sentences.
- `edit`/`apply_patch` are destructive; wrong fuzzy matching can corrupt files. Prefer
  exact matches and fail loudly.
- Some providers may lack a shell; grep/glob fallbacks must work through `listFiles`.
- The desktop guard may refuse commands the tools construct; tools call the sandbox
  directly, but document the difference.
- Grep over large trees can be slow; cap results and skip ignored dirs.
- Coding evals are nondeterministic if they depend on a live model; use the scripted
  runtime and observable effects, and keep live-model judging opt-in.

## Resume checklist

1. Read this file.
2. `cd /home/jblixxkyy/project/rakazo-coding-harness`
3. `pnpm install && pnpm db:generate`
4. `git status` and `git log --oneline -5` to see which phase branch is current.
5. Continue at the first unchecked phase below.

## Progress

- [x] P0 tools (grep, glob, paged read, edit, apply_patch)
- [x] P0 evals
- [x] P1 feedback (git, tests, diagnostics, truncation)
- [x] P2 context and navigation
- [x] P3 routing and isolation

## Verification (2026-11-08, VM copy at `~/workspace/rakazo-coding-harness`)

- `pnpm lint` — exit 0 (21 warnings + 21 infos remain, all pre-existing in untouched files).
- `pnpm check` — all packages pass except `apps/mobile`, whose check runs
  `expo install --check` and fails on network access (TLS EPROTO via the VM proxy);
  mobile `tsc --noEmit` on its own passes. Untouched package, environment issue.
- Targeted unit tests: 156 (A/B/C/E streams) + 48 (P3) + 45 (evals) — all green.
- Real-coding E2E (script kept with the coordinator notes; real on-disk repo,
  real node/git/tsc): 16/16 — failing suite → grep → paged read →
  edit fix → green; apply_patch 3-file rename; git_status/git_diff; diagnostics
  finds a real tsc error → fix → clean; glob/repo_map; traversal refused.
- `pnpm test` (full suite, 25 min): 19,276 passed, 73 failed across 15 files.
  Baseline check (`git stash`, same 15 files): 67 failed — all 67 are
  pre-existing environment failures on this VM (computer idle/recovery/
  workspace/home-store suites, DNS egress probe, compose smoke scripts,
  Electron binary download). The 6 failures the new code introduced
  (tool-name registry, run_subagent wire schema, two hardcoded eval counts,
  file-tool instruction roster, context-window test) were fixed; re-running
  the 15 files gives exactly the baseline set (67 failed, 583 passed) —
  zero regressions.
- `pnpm test:pi` — 21/21 pass. `pnpm test:computer-replay` — cannot run here
  (needs Docker; `spawnSync docker ENOENT`). `pnpm test:integration` — not
  run (no Docker on this VM). `pnpm test:evals --list` — 24 cases including
  the 8 new ones; full run needs `--live` by design (no live model here),
  and the grade functions are covered offline (45/45 eval tests pass).

## Round 2 — make it a full coding harness (2026-11-08, VM copy)

Fix every Round-1 known limitation for real, then audit against top coding
harnesses (Claude Code / Codex-style) and fill the gaps.

### What changed

- **Real delete.** `apply_patch` delete now removes the file instead of
  emptying it. `SandboxProvider` has no delete/remove method, so the delete
  goes through the sandbox shell (`rm` via `execute`, in
  `packages/adapters/src/sandbox-delete.ts`) — the same way the supervisor
  already deletes files. Path resolved through `resolveBotWorkspacePath`,
  approval-gated like `write_file`, recorded as a computer action, traversal
  refused, directories refused.
- **Atomic patches + undo.** `apply_patch` validates every hunk first, then
  applies; any mid-apply failure rolls already-changed files back to their
  snapshots. New `undo_edit` tool restores the most recent successful
  edit/apply_patch batch (single level; snapshots capped, per-run store
  keyed by run id + isolation root, evicted past 64 runs).
- **Shell fast path for grep/glob.** One probe per (sandbox, computer)
  detects `rg`/`grep`/`find` (cached); the fast path runs argv-only
  commands, and any failure falls back to the listFiles walk — a search
  never fails for lack of a shell. Ignore rules are enforced by an
  authoritative JS post-filter on both paths, so results match the walk.
- **Real isolated subagents.** The isolation root travels with the run in
  the executionId namespace (`isolated:<executionId>`) and is enforced in
  workspace-path resolution (`computer-support.ts`): file, shell, git, and
  search tools for an isolated subagent resolve under
  `subagents/<id>/` and refuse anything outside it. Parallel isolated
  subagents get distinct roots. Round-2 integration also fixed
  `prepareArguments` in `pi-runtime-tools.ts`, which was dropping the
  `isolated` flag from `run_subagent` calls before the handler saw it.
- **Real coding-model selection.** Settings → Models now has a "Coding
  model" section (web + mobile, same picker/backups flow as main/approval,
  stored in the existing per-role tables). Resolution precedence: bot
  override > coding (if runnable) > main (if runnable) > deployment main.
  Also fixed the old fallback, which skipped the member's main model when
  a configured coding connection was gone.
- **Bounded paged reads.** Paged reads go through `sed`/`awk` in the
  sandbox shell, so only the requested lines enter memory. Without a
  working shell they fall back to the 250 KB-capped `readFile` — a
  >250 KB paged read on a shell-less provider now reports "file is too
  large" instead of loading a 1 MB slice (deliberate trade-off: no paged
  read ever materializes more than 250 KB through `readFile`).
- **Symbol navigation.** New `find_definition` / `find_references` tools
  (TS/JS, Python, Go, Rust patterns, built on grep + repo-map machinery;
  definitions only — mentions belong to references).
- **Todo tracker.** New `todo_write` / `todo_read` / `todo_update` tools;
  the plan lives in the run only (per-run `WeakMap` keyed by `RunContext`),
  never written to the repo.
- **Build as a first-class check.** New `run_build` tool (build script,
  then `tsc --noEmit`, then `go build`, then `cargo build`), structured
  failures like diagnostics; diagnostics parsing now covers Cargo spans.
- **Shell guard.** Bare `$(date)` / `$(pwd)` / `$(whoami)` / `$(hostname)` /
  `$(uname)` / `$(id)` are now allowed; anything else in `$(…)` (arguments,
  pipes, other commands, nesting, backticks, subshells, interpreter
  heredocs) is still refused, as are all previously blocked destructive
  forms.
- **Repo-map freshness.** Writes invalidate the cached map (O(1) version
  bump in `edit`, `apply_patch`, `write_file`, delete); the next read
  rebuilds.
- **Context compaction.** Deterministic, offline summarise step: once the
  coding-tool window exceeds 8 results, older ones become compact
  summaries (counts + paths + outcomes) while the newest 8 stay verbatim.
- **Evals.** 5 new offline cases (`find-definition`, `find-references`,
  `todo-tracked-refactor`, `run-build-failure-report`,
  `undo-after-bad-patch`); 29 cases total.

### Verification (Round 2, VM copy)

- `pnpm lint` — exit 0 (21 warnings + 21 infos, same pre-existing set as
  Round 1).
- `pnpm check` — all packages pass except `apps/mobile`, whose check runs
  `expo install --check` and fails on network access (TLS EPROTO via the
  VM proxy); same pre-existing/environmental failure as Round 1.
- Targeted unit tests: edit 52 + workspace-file + search 40 + symbol 35 +
  todo 15 + feedback 198-file set + model-roles 79 + executor 152 +
  isolation 28 — all green; adapters/contracts/testkit/core `tsc --noEmit`
  clean.
- Real-coding E2E (extended script, real on-disk repo, real node/git/tsc):
  **47/47** (16 Round-1 cases preserved + 31 new: delete-via-patch,
  shell-fast-path grep on a 120-file tree, parallel isolated subagents,
  refactor with rollback, long session with repo-map + todos, coding-model
  selection logic, run_build, symbol navigation). Re-confirmed by the
  coordinator.
- `pnpm test:pi` — 21/21 pass. `pnpm test:evals --list` — 29 cases.
- Full `pnpm test` — 19,406 passed, 68 failed across 11 files (1,252 files,
  20,111 tests). Baseline check (`git stash` to the Round-1 commit, same
  11 files): 67 failed / 381 passed. The one extra Round-2 failure was a
  real regression the comparison caught: the new "Coding model" section
  added `t("Coding model")` to mobile Settings without translations, so
  the mobile i18n coverage test failed. Fixed by adding the string to
  all six non-English catalogs (de/ja/nl/ru/zh-TW/zh); re-running the
  11 files then gives exactly the baseline set (67 failed / 381 passed,
  failure sets identical) — zero regressions. The 67 are the same
  pre-existing environment failures as Round 1 (computer idle/recovery/
  workspace/home-store suites, DNS egress probe, compose smoke scripts,
  Electron binary download, desktop auto-update). The full suite was
  not re-run end-to-end after the locale-only fix; the affected file
  (`apps/mobile/lib/i18n.test.ts`) passes 15/15 in the re-run.
- Round 2 committed as `19c391ff` on `feat/coding-harness-p0` (52 files,
  5682 insertions, 156 deletions). This plan file stays untracked.

### Known limitations (updated)

- `apply_patch` delete goes through the sandbox shell (`rm`); a provider
  whose `execute` cannot run `rm` cannot delete (the walk/fallback path
  has no delete). No delete primitive exists in `SandboxProvider`.
- The grep fast path does not apply the walk's 2000-file scan cap, and the
  250 KB file cap is honoured on the `rg` path (`--max-filesize`) but not
  on the `grep` path.
- Todo plans do not survive a resumed attempt (fresh `RunContext` after an
  approval pause or crash); persisting them needs a `todos` field on
  `RunState` restored from the turn checkpoint.
- `find_definition` does not recognise bare `name() {}` methods or Go
  `var (...)` grouped declarations (matching them would create false
  definitions).
- The coding section in Settings has no thinking-level control (main is
  the only section with one); a coding `thinkingLevel` set via API is
  still honoured at selection time.
- Paged reads above 250 KB on a shell-less provider report "file is too
  large" instead of returning lines (see above).
- The `run-build-failure-report` eval grades the tool's own "no build
  configured" failure, because the eval sandbox echoes shell commands and
  a real tsc failure is unobservable there; `undo-after-bad-patch` cannot
  distinguish an agent that attempted the bad patch from one that skipped
  it.
- `pnpm test:integration` / `pnpm test:computer-replay` still cannot run
  here (no Docker on this VM). Desktop e2e not run per plan (CI covers it).

## Known limitations (Round 1, all fixed in Round 2 — kept for history)

- `apply_patch` delete writes an empty file instead of removing it (no delete
  primitive in `SandboxProvider`). → Fixed: shell `rm` delete path.
- grep/glob run via listFiles walk + readFile scan (provider-neutral); no shell
  fast path, since FakeSandbox `execute()` is echo/cat only. → Fixed: shell
  fast path with walk fallback.
- `run_subagent` `isolated` is a no-clobber convention enforced by instruction,
  not tool-layer workspace routing. → Fixed: tool-layer routing via
  executionId namespace + path resolution.
- The `coding` model role falls back to the deployment main model; no
  coding-specific model id was invented (none exists in this codebase).
  → Fixed: configurable coding model in Settings → Models.
- Paged reads above 250 KB read up to 1 MB internally; only the requested
  lines reach the model. → Fixed: sed/awk windowed reads, 250 KB cap.

## Round 3 — runner detection in subfolders (2026-11-08, live bug)

- What was wrong: jblixky ran the test prompt live on the deployed image and
  the bot created its project in a subfolder (`add-demo/`). `run_tests`,
  `diagnostics`, and `run_build` all read `package.json` / `tsconfig.json` /
  `go.mod` only at the workspace root, so all three reported "no runner /
  checker / build configured" and the bot verified with plain `node`
  commands instead. Root cause confirmed by reproduction tests before the
  fix (all 6 new tests failed with the exact live errors).
- Fix (`packages/adapters/src/feedback-tools.ts`): detection now discovers
  project folders — the workspace root plus immediate subfolders (max 20,
  ignored dirs skipped) — and runs each command in the folder that owns the
  runner, via the existing `runSandboxCommand` cwd support. `detectTestRunner`
  / `detectChecker` / `detectBuild` now return `{ argv, cwd? }` (root
  results unchanged, no `cwd` key). Added a plain-Node fallback: test files
  with no package.json script run `node --test`; JS files with no configured
  checker get `node --check` per file, with `SyntaxError` output parsed into
  structured diagnostics. `tsc` now triggers on a `tsconfig.json` alone
  (package.json no longer required). Preference order unchanged (Node, then
  pytest, then Go).
- Verification: feedback-tools tests 38/38 (6 new: subfolder test/build/
  tsconfig detection, plain-Node `node --test`, `node --check` pass and
  syntax-error diagnostic); neighbouring files 125/125; `pnpm lint` exit 0
  (21 warnings + 21 infos, pre-existing); `pnpm check` only the pre-existing
  `apps/mobile` expo network failure; `pnpm test:pi` 21/21; real-coding E2E
  47/47. Full `pnpm test` not re-run (change is confined to
  feedback-tools; the targeted + neighbouring + E2E runs cover it).
- Remaining limitation: detection only looks one subfolder deep (plus a
  `test`/`src`/`lib`/`app` peek for files); a project nested two or more
  folders down is still missed. `node --check` only covers plain JS
  (`.js`/`.mjs`/`.cjs`), not TS/JSX.

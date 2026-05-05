# v2.9.0 Windows Dogfood Bundle — Topology Cleanup + Targeted Fixes

**Target version:** v2.9.0 — Cross-platform & Install
**Cross-cutting reference:** [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) (event-sourcing integrity, MCP parity, basileus-forward)
**Closes:** #1201, #1203, #1204, #1205, #1206, #1207 (partial), #1208 (verify), #1209, #1210, #1211, #1212
**Defers:** #1207 auto-rebase → #1119 (v2.11.0)
**Related housekeeping (separate):** #1119 scope update post #1193 merge
**Source reports:** `exarchos-issues-2026-04-30-agency-csl-auto-pr-wave1.md`, `exarchos-issue-check_task_decomposition-parser-false-positives.md`

## Overview

The 2026-04-30 Windows dogfood of `agency-csl-auto-pr` (33-task plan, GitHub Copilot CLI) surfaced 11 issues spanning the delegation surface, the dispatch handlers, the implementer prompt template, and the CLI install pipeline. Filing them as 10 separate issues exposed a shared root cause: **readiness state is computed twice, in two places, against two slightly different inputs** — `prepare_delegation` (handler) does its own plan-artifact check while `delegation_readiness` (view) does another, and the worktree count comes from a global `task.assigned` counter that ignores wave scoping. Both surfaces report different blockers for the same conceptual readiness state.

This design treats the bundle as one topology fix plus a set of targeted cleanups, all framed through the axiom backend-quality dimensions and the #1109 invariants.

### Lens

| Dimension / Constraint | Where it bites |
|---|---|
| **DIM-1 Topology** + #1109 Constraint 1 | Single source of truth for readiness state; output reconstructible from events |
| **DIM-2 Observability** | PASS reports must reflect action actually taken (`#1203`, `#1210`) |
| **DIM-3 Contracts** | Same fact across CLI/MCP must come from the same projection (`#1205`, `#1206`); template-runtime preconditions explicit (`#1204`); parser regexes match real planning output (`#1211`) |
| **DIM-4 Test Fidelity** | Tests exercise real production fixtures, not stripped-down synthetic ones (`#1211`) |
| **DIM-5 Hygiene** | Documented surfaces are wired (`#1201`); no duplicate readiness logic (`#1205`) |
| **DIM-7 Resilience** | Recovery paths exist where realistic operating conditions need them (`#1207` runbook for v2.9.0; full auto-rebase deferred to #1119) |
| **#1109 Constraint 2 (MCP parity)** | CLI and MCP facades return identical envelopes — not separately validated |
| **#1109 Constraint 3 (basileus-forward)** | Templates work across all runtimes (`#1204`) without hidden cwd assumptions |

## Verification of #1208 (likely already fixed)

PR #1193 (merged 2026-04-28) shipped the `merge-pending` HSM substate, the `mergePendingEntry` guard checking `data.worktree` / `data.worktreePath` on the latest `task.completed`, and the `merge_orchestrate` next_action verb emission (`hsm-definitions.ts:71-101`, `next-actions-computer.ts:100-124`). The dogfood ran on an installed v2.8.x build that pre-dated this code.

**Plan:** as the first verification step, run a workflow with `task.completed` carrying `data.worktreePath` against current HEAD and confirm `next_actions` surfaces `merge_orchestrate`. If confirmed, close #1208 as fixed-in-#1193 with a comment citing the build the dogfood ran against. If a residual bug is found (e.g., projection ordering, edge case the guard misses), patch it in this PR and document the residual in the issue.

This verification gates the inclusion of any code change for #1208 — we're not patching code that's already correct.

## DR-T: Topology Fix — readiness projection consolidation (#1205, #1206, #1212-state-desync)

The core change. Today, the `delegation-readiness-view.ts` projection tracks plan approval, task count (incremented per `task.assigned`), worktree expected/ready counts, and worktree failures. The `prepare_delegation` handler then *also* checks `Boolean(workflowState.artifacts?.plan)` as a side-blocker not present in the view, and computes its own `taskCount` from `args.tasks?.length ?? readiness.plan.taskCount`. Two surfaces, two contracts.

### DR-T-1: Plan-artifact check moves into the projection (#1205)

The projection folds `state.patched` events whose patch sets `artifacts.plan` (or the dot-path equivalent), and tracks `plan.artifactPresent: boolean` alongside `plan.approved` and `plan.taskCount`. The `computeBlockers` helper emits a `Plan artifact is missing` blocker when `plan.artifactPresent === false`. `prepare-delegation.ts:444-449` deletes the local supplementary check entirely.

Result: both `exarchos_orchestrate prepare_delegation` and `exarchos_view delegation_readiness` return the identical blocker for the identical workflow state. Single source of truth. DIM-1 ✓, DIM-3 ✓, Constraint 2 ✓.

### DR-T-2: Wave scoping via projection-side task ID set (#1206)

The projection currently tracks `worktrees.expected` as a monotonic counter. It will instead track `assignedTaskIds: Set<string>` and `readyTaskIds: Set<string>`. When `prepare_delegation` is called with a `tasks` arg, the handler computes:

```ts
const expected = args.tasks
  ? args.tasks.filter(t => state.assignedTaskIds.has(t.id)).length
  : state.assignedTaskIds.size;
const ready = args.tasks
  ? args.tasks.filter(t => state.readyTaskIds.has(t.id)).length
  : state.readyTaskIds.size;
const pendingWorktrees = expected - ready;
```

The blocker `${pendingWorktrees} worktrees pending` is then accurate to the wave being prepared. When `tasks` is omitted, behavior matches today (all tasks).

The view continues to expose the per-task ID sets (not just counts) so downstream consumers can do their own wave scoping. `delegation_readiness` view output gains `assignedTaskIds` and `readyTaskIds` arrays (alongside the legacy `worktrees.expected`/`worktrees.ready` counts kept for back-compat).

No event schema change. "Wave" remains an orchestrator-time grouping, not a domain event. The projection answers "is the subset ready?" rather than mutating its accumulator semantics.

### DR-T-3: State-vs-plan desync diagnostic (#1212-state-desync)

The projection compares `plan.taskCount` (incremented by `task.assigned` events) against the workflow state's `tasks.length`. When they diverge after a plan revision, `computeBlockers` adds:

> `state-vs-plan desync: workflow.tasks has N entries but plan.taskCount is M (likely stale state after plan-review revision)`

The blocker fires when `state.tasks.length !== plan.taskCount && plan.taskCount > 0`. Doesn't gate readiness on its own (`ready` stays computed off worktree state), but surfaces the drift loudly so an operator notices before delegating against stale state. DIM-2 ✓.

### Files changed by DR-T

- `servers/exarchos-mcp/src/views/delegation-readiness-view.ts` — projection state, event handlers, blocker computation
- `servers/exarchos-mcp/src/views/delegation-readiness-view.test.ts` — projection tests for new state, wave scoping, desync diagnostic
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts` — delete the supplementary plan-artifact check; thread `tasks` arg into projection-driven scoping
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts` — wave-scoping integration tests
- `skills-src/delegation/SKILL.md` — document the projection contract once, point both `prepare_delegation` and `delegation_readiness` at it

## Targeted fixes — one DR each

### DR-1: setup_worktree gitignore PASS reflects action actually taken (#1203)

`servers/exarchos-mcp/src/orchestrate/setup-worktree.ts:85-115` (`ensureGitignored`) replaces `git check-ignore` with a direct read of the repo's `.gitignore`. The function:

1. Reads `<repoRoot>/.gitignore` if it exists; checks for a line matching `^.worktrees/?$`.
2. If found, returns `{ status: 'pass', detail: 'already present' }`.
3. If not found, appends `.worktrees/\n` and returns `{ status: 'pass', detail: 'added' }`.
4. If `.gitignore` doesn't exist, creates it with `.worktrees/\n` and returns `{ status: 'pass', detail: 'created with entry' }`.
5. On any I/O error, returns `{ status: 'fail', detail: <error> }`.

The PASS message always reflects the path taken. `git check-ignore` is never called — the contract is "the repo's `.gitignore` lists `.worktrees/`," not "any ignore source matches `.worktrees/`." DIM-2 ✓, DIM-3 ✓.

### DR-2: implementer-prompt template includes explicit cd-into-worktree (#1204)

`skills-src/delegation/references/implementer-prompt.md:19-33` and the compiled IMPLEMENTER spec in `servers/exarchos-mcp/src/agents/definitions.ts` add a recovery step before verification:

```markdown
## Working Directory Setup (MANDATORY)

Your shell may have started in the parent repo cwd, depending on the runtime. Your FIRST command must be:

  cd "<absolute worktree path>"             # bash / zsh / sh
  Set-Location "<absolute worktree path>"   # PowerShell

After that, the verification block below confirms you landed correctly.
```

The existing verification block (`pwd | grep -q "\.worktrees" || abort`) becomes a safety check rather than the entry point. Native-isolation runtimes (Claude Code) are unaffected because `cd` to an already-current directory is a no-op. Non-native runtimes (Copilot CLI, Cursor at the time of writing) get a working entry path. DIM-3 ✓, Constraint 3 ✓.

After editing the source, `npm run build:skills` regenerates `skills/<runtime>/delegation/references/implementer-prompt.md` for every runtime variant.

### DR-3: setup_worktree honors planned branch name (#1209)

`servers/exarchos-mcp/src/orchestrate/setup-worktree.ts:275-277` reads from workflow state when present:

```ts
// Pseudocode
const plannedBranch = workflowState?.tasks?.find(t => t.id === args.taskId)?.branch;
const branchName = args.branch ?? plannedBranch ?? `feature/${args.taskId}-${args.taskName}`;
```

`SetupWorktreeArgs` gains an optional `branch?: string` field. When neither the arg nor workflow state supplies a branch, the legacy default applies. Reading workflow state requires threading `stateDir` (or the materialized state) into the handler — a small DI extension that mirrors how `prepare-delegation.ts` already takes `stateDir` + `ctx`. DIM-1 ✓.

### DR-4: check_static_analysis SKIP for unsupported toolchains (#1210)

`servers/exarchos-mcp/src/orchestrate/pure/static-analysis.ts:308-330` returns `status: 'skip'` (new variant in the discriminated union) when `detectProjectType` returns `undefined`. The `StaticAnalysisResult.status` enum extends from `'pass' | 'fail' | 'error'` to `'pass' | 'fail' | 'error' | 'skip'`. The handler at `static-analysis.ts:62-134` maps `skip` to a `gate.executed` event with `passed: false, skipped: true, skipReason: 'no-toolchain'`.

The convergence view (`view convergence`) treats skipped gates as inconclusive — explicitly rendered as `SKIP` rather than green. D2 dimension reports "skipped (no toolchain)" instead of falsely reporting pass. DIM-2 ✓, DIM-4 ✓.

### DR-5: check_task_decomposition parser fixes + characterization fixtures (#1211)

Three regex-level fixes in `servers/exarchos-mcp/src/orchestrate/task-decomposition.ts`:

1. **Description detection** (lines 132-160): replace literal `**Description:**` matching with "everything between the task heading and the next field-header (`**...**:`) or section header (`### `)". Drops the `inDesc` state machine; counts words in the captured block.
2. **Dependency parser** (lines 331-349): match both `T-\d+` and `T\d+` formats (case-insensitive, leading word boundary, trailing non-letter boundary). Remove the greedy `/[0-9]+/g` fallback entirely — if the dep line has no `T<id>` or `T-<id>` references, return `[]` rather than scraping every digit-run.
3. **File-conflict detector** (lines 366-376): require a known file extension (regex anchored at end: `\.(ts|tsx|js|jsx|json|md|yml|yaml|sh|ps1|sql|kql|bicep|cs|csproj)$`). Tighten the character class to exclude PascalCase / camelCase identifier patterns. Optionally: prefer files listed under an explicit `**Files:**` section when present (don't infer from narrative when the section exists).

**Test fidelity (DIM-4):** add `task-decomposition.fixtures.test.ts` that runs the full parser against a real plan generated by `@skills/implementation-planning` (committed under `servers/exarchos-mcp/src/orchestrate/fixtures/plans/agency-csl-auto-pr.md` — captured from the dogfood report). Assertions:

- `wellDecomposed === totalTasks` (no false rework finding)
- `dagValid === true` (no false cycle)
- `parallelSafe === true` (no false conflict on `imageProvenance.isFirstParty` etc.)
- Dependency extraction returns the canonical T-IDs the plan declares, and nothing else.

The fixture is the test-production parity fix the issue body asks for.

### DR-6: merge_orchestrate ancestry error message links runbook (#1207, partial)

`servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.ts` (and/or where `validateBranchAncestry`'s blocker text is composed in `merge-orchestrate.ts`) extends the failure message to include a remediation hint:

> `ancestry missing: <integrationBranch>. The integration branch advanced past this source branch's branchpoint. Run \`git fetch && git rebase ${integrationBranch} && git push --force-with-lease\` from the worktree, or see <runbook URL> for the full procedure.`

The runbook URL points at a new section in `skills-src/delegation/SKILL.md` § "When integration advances mid-wave" that documents the manual rebase procedure plus rollback advice. No auto-rebase code in this PR; that work is reserved for #1119 (v2.11.0). DIM-2 ✓ (better failure context), DIM-7 partial (manual recovery documented).

### DR-7: CLI install-skills wired (#1201, separate commit)

`servers/exarchos-mcp/src/adapters/cli.ts` (or wherever the CLI subcommand registry lives) wires the `install-skills` verb that's already documented. Implementation calls into the existing skills-installation logic (whatever `install-rewrite` from #1176 left in place); the CLI subcommand is a thin presentation wrapper.

**MCP parity is intentionally not added.** `install-skills` writes to the local filesystem; remote MCP wouldn't be a meaningful surface (the remote server isn't where the user wants their skills installed). Document the CLI-only nature in the subcommand help text and in a `cli-only` annotation in the dispatch registry.

This lands as a single isolated commit — easy to revert if it grows beyond expected scope. Standalone from the topology cleanup.

### DR-8: Small docs/hint fixes (#1212)

Three sub-fixes, mostly content edits:

- **(a) install SKIP message link** — extend `resolved.remediation` in `servers/exarchos-mcp/src/config/test-runtime-resolver.ts` to include a one-line example and a doc-section anchor.
- **(b) `task.assigned` event hint includes `branch`** — update the event-emission catalog (wherever `requiredFields` for `task.assigned` is declared, `event-store/schemas.ts` or the emission-guide source) to list `branch` as an optional field. Keeps two sources of truth aligned: workflow state and event payload.
- **(c) `exarchos_workflow set updates` array-insertion syntax documented** — `skills-src/workflow-state/SKILL.md` gains a worked example for adding new entries to `tasks[]` (the supported syntax — verify against the parser before documenting, then assert with a unit test).

The state-vs-plan desync diagnostic (originally bundled here) folds into DR-T-3 above.

## Test plan

- [ ] **#1208 verification first.** Run a feature workflow against current HEAD with `task.completed` carrying `data.worktreePath`. Confirm `next_actions` surfaces `merge_orchestrate`. Document the result; if green, post the verification trace as a comment on #1208 and close as fixed-in-#1193.
- [ ] `cd servers/exarchos-mcp && npm run test:run` — full MCP suite passes.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run build` — root build clean (rendered skills regenerated for every runtime).
- [ ] `npm run skills:guard` — no drift between `skills-src/` and rendered `skills/`.
- [ ] DR-T tests: projection unit tests cover plan-artifact fold, wave scoping, desync diagnostic.
- [ ] DR-T parity test: the same workflow state produces identical blockers from `prepare_delegation` (handler) and `delegation_readiness` (view).
- [ ] DR-1 tests: gitignore round-trip — empty `.gitignore`, missing `.gitignore`, already-present, parent-glob (must NOT lie about action), non-readable file → fail.
- [ ] DR-2 manual: dispatch an implementer agent on a non-Claude-Code runtime equivalent (test harness if available; else document manual repro on Copilot CLI).
- [ ] DR-3 tests: branch resolution priority — arg > planned > default.
- [ ] DR-4 tests: SKIP path emits gate event with `skipped: true`; convergence view renders SKIP not PASS.
- [ ] DR-5 fixture test: parser passes on the agency-csl-auto-pr fixture (`wellDecomposed === totalTasks`, no cycle, no false conflicts).
- [ ] DR-5 unit tests: the three regex fixes (description span, T<id>/T-<id> dependency match, file-extension filter).
- [ ] DR-6: failed merge_orchestrate emits the new ancestry error text including the runbook link; ancestry happy path unchanged.
- [ ] DR-7: `exarchos install-skills` runs end-to-end from a local checkout against a temp `$HOME`. Help text says "CLI only."
- [ ] DR-8: docs-only verification (manual) plus a unit test for the documented array-insertion syntax in `workflow_set`.

## Out of scope (and where they live)

| Concern | Why deferred | Tracking |
|---|---|---|
| Auto-rebase / autonomous ancestry recovery | Touches subagent worktree branches; needs independent risk analysis. Already on the v2.11.0 roadmap. | #1119 (scope update needed; see housekeeping below) |
| Vitest-on-bun migration / drop `better-sqlite3` shim | Orthogonal CI surface, separate risk profile (vitest-on-bun edge cases on Windows runners). DR-5's parser fixtures don't hit storage so #1198 is not a blocker for this PR. | #1198 |
| Convergence view UX rendering for SKIP gates | DR-4 emits the right event data; the rendering polish (e.g., yellow vs green) can land in a follow-up if reviewer feedback requests it. | n/a (in-PR adjustable) |

## Housekeeping (separate from this PR)

After this PR merges (or in parallel), post a comment on #1119 noting that PR #1193 has shipped the merge-orchestrator skeleton (state machine, preflight composer, executor, rollback, `next_actions` verb). #1119's remaining scope shrinks to the **autonomous** parts: auto-rebase, conflict resolution, drift self-recovery. The body's "Builds on #1181, #1185" note should be updated to reference #1193 explicitly. This is a 5-minute issue-housekeeping action; not part of this PR.

## #1109 verification

- [x] **Event-sourcing**: DR-T projection reads `state.patched` (plan-artifact), `task.assigned` (assignedTaskIds), `worktree.created` (readyTaskIds), `gate.executed` (existing). No new events emitted by DR-T. DR-4 modifies an existing event payload (`gate.executed` for static-analysis). No projection-only state.
- [x] **MCP parity**: DR-T explicitly produces identical blockers across `prepare_delegation` (handler/MCP) and `delegation_readiness` (view/MCP & CLI). The new parity test (`servers/exarchos-mcp/src/orchestrate/prepare-delegation.parity.test.ts` if not already present) asserts byte-equivalence at the relevant fields.
- [x] **Basileus-forward**: DR-2 explicitly removes a hidden cwd assumption that broke non-Claude-Code runtimes. DR-7's CLI-only annotation is documented, not assumed.
- [x] **Capability resolution**: no reads of yaml capability fields at runtime in any DR; runtime resolution stays through the existing resolver chain.

## Auto-chain note

After plan approval, this design auto-continues into `/exarchos:plan` to produce the TDD task plan. The plan will decompose the DRs into testable tasks (likely ~12-15 tasks given the topology cleanup is the largest piece).

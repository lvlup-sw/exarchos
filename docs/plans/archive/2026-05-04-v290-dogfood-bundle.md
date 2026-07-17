# v2.9.0 Dogfood Bundle — TDD Implementation Plan

**Design:** [`docs/designs/2026-05-04-v290-dogfood-bundle.md`](../designs/2026-05-04-v290-dogfood-bundle.md)
**Workflow:** `v290-dogfood-bundle`
**Total tasks:** 17 (one verification gate + 16 implementation tasks)
**Cross-cutting:** [#1109](https://github.com/lvlup-sw/exarchos/issues/1109)

## Iron Law

> NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

Every task has explicit RED → GREEN → REFACTOR phases. Tests use `Method_Scenario_Outcome` naming.

## Dependency graph

```
T-01 (verify #1208)  ──┐
                       ├──► T-02 → T-03   (DR-T-1: plan-artifact)
                       ├──► T-04 → T-05 → T-06   (DR-T-2 + DR-T-3: wave scoping + desync)
                       ├──► T-07   (DR-1: gitignore)        ┐
                       ├──► T-08   (DR-2: prompt template)  │
                       ├──► T-09   (DR-3: branch override)  │ all independent,
                       ├──► T-10   (DR-4: static-analysis)  │ parallel-safe
                       ├──► T-11 → T-12 → T-13 → T-14   (DR-5: parser fixes via fixture-driven RED)
                       ├──► T-15   (DR-6: ancestry message) │
                       ├──► T-16   (DR-7: CLI install)      │ ← SEPARATE COMMIT
                       └──► T-17   (DR-8: docs/hints)       ┘
```

T-01 gates everything (it may collapse #1208 work entirely). After T-01 the implementation tasks split into 8 independent tracks with internal sequential chains.

---

### Task T-01: Verify #1208 against current HEAD

**Goal:** Run a feature workflow against current HEAD with `task.completed` carrying `data.worktreePath` and confirm `next_actions` surfaces the `merge_orchestrate` verb. PR #1193 shipped the HSM detour and the next_action verb (`hsm-definitions.ts:71-101`, `next-actions-computer.ts:100-124`); the dogfood ran on a v2.8.x build that pre-dated this. Either close as fixed-in-#1193 or document the residual bug for inclusion in this PR.

**Files:**
- (read-only) `servers/exarchos-mcp/src/workflow/hsm-definitions.ts`
- (read-only) `servers/exarchos-mcp/src/next-actions-computer.ts`
- (read-only) `servers/exarchos-mcp/src/views/next-action-projection.ts` (or wherever the projection lives)

1. [RED] Write test: `mergePendingDetour_TaskCompletedWithWorktreePath_SurfacesMergeOrchestrateVerb`
   - File: `servers/exarchos-mcp/src/next-actions-computer.test.ts` (new test in existing file)
   - Set up workflow state in `delegate` phase, append a `task.completed` event with `data: { worktreePath: '...' }`, materialize next-action projection, assert verb is `merge_orchestrate`.
   - Expected: PASS at HEAD (verifying existing PR #1193 wiring). If FAIL, document the failure mode.

2. [GREEN] Only if RED revealed a bug — patch it. Otherwise no production code change.

3. [REFACTOR] N/A.

**Acceptance criteria:**
- New characterization test passes against current HEAD.
- Comment posted on #1208 with the test reference and verdict (fixed-in-#1193 or residual bug).
- If residual: a follow-up task added to this plan; otherwise close #1208.

**Dependencies:** None
**Parallelizable:** No (gates all subsequent work — outcome decides whether #1208 needs implementation work)

---

### Task T-02: Plan-artifact field in delegation-readiness projection

**Goal:** Fold `state.patched` events whose patch sets `artifacts.plan` (nested or dot-path form) into a new projection field `plan.artifactPresent: boolean`. Emit `Plan artifact is missing` blocker when false.

**Files:**
- `servers/exarchos-mcp/src/views/delegation-readiness-view.ts`
- `servers/exarchos-mcp/src/views/delegation-readiness-view.test.ts`

1. [RED] Write test: `delegationReadiness_StatePatchedWithArtifactsPlan_FlipsArtifactPresent`
   - Apply `state.patched` event with `data.patch.artifacts.plan = "docs/plans/foo.md"`; assert `plan.artifactPresent === true`.
   - Apply with dot-path form `data.patch["artifacts.plan"] = "..."`; same assertion.
   - Init state asserts `plan.artifactPresent === false` and blocker `Plan artifact is missing` present.

2. [GREEN] Extend `DelegationReadinessState.plan` with `artifactPresent: boolean`. Extend `handleStatePatched` to resolve `artifacts.plan` (nested + dot-path), mirroring the existing `planReview.approved` resolution. Extend `computeBlockers` to push the blocker when `!plan.artifactPresent`.

3. [REFACTOR] If the nested/dot-path resolution duplicates `handleStatePatched`'s existing pattern, extract a `resolvePatchPath<T>(patch, path)` helper.

**Acceptance criteria:**
- Three new projection tests pass.
- Existing tests still pass.
- `init()` blocker list now contains `Plan artifact is missing` alongside the existing two.

**Dependencies:** T-01
**Parallelizable:** No (T-03 follows directly)

---

### Task T-03: Remove handler-side plan-artifact check + parity guard

**Goal:** Delete the supplementary `Boolean(workflowState.artifacts?.plan)` check from `prepare-delegation.ts`. Add a regression test asserting `prepare_delegation` and `delegation_readiness` view produce the **identical** blocker list for the same workflow state.

**Files:**
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts`

1. [RED] Write test: `prepareDelegation_BlockerList_MatchesDelegationReadinessView`
   - Construct workflow state with no plan artifact set; call `handlePrepareDelegation` and `delegationReadinessProjection.materialize()` against the same event stream; assert blockers arrays are equal.
   - Repeat with plan artifact set: both surfaces omit the blocker.

2. [GREEN] Delete `prepare-delegation.ts:444-449` (the `hasPlanArtifact` block and the `additionalBlockers` merge). Use `readiness.blockers` directly.

3. [REFACTOR] If `additionalBlockers` is now empty everywhere, remove the variable.

**Acceptance criteria:**
- Parity test passes.
- No surface-specific blocker emission for plan-artifact in the handler.
- Existing prepare-delegation tests pass.

**Dependencies:** T-02
**Parallelizable:** No

---

### Task T-04: Projection tracks task ID sets, not counters

**Goal:** Replace `worktrees.expected: number` and `worktrees.ready: number` with `assignedTaskIds: ReadonlySet<string>` and `readyTaskIds: ReadonlySet<string>`. Keep the count fields exposed at the view boundary for back-compat, derived from the sets.

**Files:**
- `servers/exarchos-mcp/src/views/delegation-readiness-view.ts`
- `servers/exarchos-mcp/src/views/delegation-readiness-view.test.ts`

1. [RED] Write tests:
   - `delegationReadiness_TaskAssignedTwice_AccumulatesAssignedTaskIds` — two events with `taskId: "001"` and `"002"` produce `assignedTaskIds = Set(["001", "002"])`.
   - `delegationReadiness_DuplicateTaskAssigned_DeduplicatesByTaskId` — two events with same `taskId: "001"` produce a Set of size 1.
   - `delegationReadiness_WorktreeCreatedWithTaskId_AddsToReadyTaskIds` — `worktree.created` event with `data.taskId: "001"` adds "001" to `readyTaskIds`. (Confirm event payload format from the emission catalog before writing.)
   - `delegationReadiness_LegacyExpectedCount_DerivedFromSet` — view exposes `worktrees.expected === assignedTaskIds.size` for back-compat.

2. [GREEN] Update `DelegationReadinessState` shape. `handleTaskAssigned` adds to set. `handleWorktreeCreated` adds to ready set (requires the event to carry `taskId` — verify and document if the projection has to fall back to a non-keyed counter when `taskId` is absent). Derive `worktrees.expected`/`worktrees.ready` from `.size` for back-compat consumers.

3. [REFACTOR] Extract a `withTaskAdded(state, taskId, key)` helper if `handleTaskAssigned` and `handleWorktreeCreated` end up with parallel structure.

**Acceptance criteria:**
- New set-based projection tests pass.
- Existing tests still pass (back-compat counts derived correctly).
- View output shape includes `assignedTaskIds`/`readyTaskIds` arrays alongside legacy counts.

**Dependencies:** T-03
**Parallelizable:** No (T-05 follows)

---

### Task T-05: Wave-scoped worktree readiness in prepare_delegation

**Goal:** When `prepare_delegation` is called with a `tasks` arg, scope the worktree-pending blocker to the named subset using the per-task ID sets from T-04. When `tasks` is omitted, behavior matches today.

**Files:**
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts`

1. [RED] Write tests:
   - `prepareDelegation_TasksArgSubsetReady_NoBlocker` — projection has 33 assignedTaskIds and 3 readyTaskIds; `tasks` arg lists the same 3 IDs as ready; blockers do not include `worktrees pending`.
   - `prepareDelegation_TasksArgSubsetPending_ExactPendingCountInBlocker` — same as above but `tasks` arg lists 3 unready IDs; blocker says `3 worktrees pending` (not 30).
   - `prepareDelegation_NoTasksArg_AllAssignedConsidered` — without `tasks` arg, blocker reports global pending count.

2. [GREEN] In `handlePrepareDelegation`, when `args.tasks` is present, compute scoped expected/ready by intersecting against the projection's sets. Replace the readiness `blockers` re-computation accordingly. Keep `nativeIsolation` short-circuit semantics intact.

3. [REFACTOR] Pull the wave-scoping computation into a pure helper `computeScopedWorktrees(readiness, tasksFilter)` that returns `{expected, ready, pending}` — easier to unit test.

**Acceptance criteria:**
- All three wave-scoping tests pass.
- `nativeIsolation` test still passes.
- The `33 worktrees pending` regression that #1206 reports is the explicit RED for the second test; it goes green after this task.

**Dependencies:** T-04
**Parallelizable:** No (T-06 follows)

---

### Task T-06: State-vs-plan desync diagnostic blocker

**Goal:** When `plan.taskCount` (incremented by `task.assigned` events) diverges from `workflow.tasks.length`, emit a diagnostic blocker. Doesn't gate `ready` on its own — surfaces the drift loudly.

**Files:**
- `servers/exarchos-mcp/src/views/delegation-readiness-view.ts`
- `servers/exarchos-mcp/src/views/delegation-readiness-view.test.ts`
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts` (thread workflowState.tasks.length into the readiness assembly so the projection can compare)

1. [RED] Write test: `delegationReadiness_PlanTaskCountDiffersFromStateTasks_AddsDesyncBlocker`
   - Set up state with `plan.taskCount === 33` (33 task.assigned events) and `workflow.tasks.length === 31`; expect blocker text matching the design pattern.
   - Test reverse direction: `state.tasks.length > plan.taskCount`.
   - Test no-desync case: equal counts produce no blocker.

2. [GREEN] Either (a) thread `state.tasks.length` into `computeBlockers` via the handler (projection stays pure), or (b) extend the projection to fold `workflow.transition`/`state.patched` events that mutate `tasks`. Prefer (a) — keeps the projection focused on stream events.

3. [REFACTOR] If (a), document the cross-cutting input on the projection's `materialize` signature.

**Acceptance criteria:**
- Three desync tests pass.
- Blocker fires when counts diverge and `plan.taskCount > 0` (no false-positive at init).

**Dependencies:** T-05
**Parallelizable:** No

---

### Task T-07: setup_worktree gitignore — direct read, honest PASS

**Goal:** Replace `git check-ignore` with direct read of repo `.gitignore`. PASS message reflects exactly which path was taken (`already present`, `added`, or `created with entry`).

**Files:**
- `servers/exarchos-mcp/src/orchestrate/setup-worktree.ts`
- `servers/exarchos-mcp/src/orchestrate/setup-worktree.test.ts`

1. [RED] Write tests:
   - `ensureGitignored_AlreadyPresent_ReportsAlreadyPresent` — `.gitignore` containing `.worktrees/` returns PASS with detail `'already present'`.
   - `ensureGitignored_NotPresent_AppendsAndReportsAdded` — `.gitignore` lacks the entry; function appends and returns PASS with detail `'added'`.
   - `ensureGitignored_FileMissing_CreatesWithEntry` — no `.gitignore`; function creates it and returns PASS with detail `'created with entry'`.
   - `ensureGitignored_GlobalIgnoreOnlyMatch_StillReportsHonestState` — match comes from `.git/info/exclude` not repo `.gitignore`; function still appends to repo `.gitignore`.
   - `ensureGitignored_ReadFails_ReturnsFail` — simulate I/O error; returns FAIL with detail.

2. [GREEN] Rewrite `ensureGitignored`. Read file with `readFileSync`, scan for `^.worktrees/?$`, branch on outcome, append/create as needed. Remove `execFileSync('git', ['check-ignore', ...])` calls entirely.

3. [REFACTOR] Extract `readGitignoreLines(repoRoot)` helper if useful.

**Acceptance criteria:**
- All five tests pass.
- No `check-ignore` invocation remaining in the function.
- Behavior is platform-agnostic (no Windows path-separator surprises).

**Dependencies:** T-01
**Parallelizable:** Yes

---

### Task T-08: implementer-prompt template adds explicit cd-into-worktree

**Goal:** Add a "Working Directory Setup (MANDATORY)" section before the verification block in the source template. Render via `npm run build:skills`. Update the compiled IMPLEMENTER spec in `agents/definitions.ts`.

**Files:**
- `skills-src/delegation/references/implementer-prompt.md`
- `servers/exarchos-mcp/src/agents/definitions.ts`
- `servers/exarchos-mcp/src/agents/definitions.test.ts`
- `skills/<runtime>/delegation/references/implementer-prompt.md` (regenerated by build)

1. [RED] Write test: `implementerSpec_PromptBody_IncludesCdIntoWorktreeBeforeVerification`
   - Asserts the rendered/compiled prompt contains a section header matching `## Working Directory Setup` AND that this section appears before the `## CRITICAL: Worktree Verification` block.
   - Asserts both bash (`cd "..."`) and PowerShell (`Set-Location "..."`) examples are present.

2. [GREEN] Edit `skills-src/delegation/references/implementer-prompt.md` to insert the new section. Update `agents/definitions.ts` IMPLEMENTER spec to include the same instruction in the embedded prompt body. Run `npm run build:skills`.

3. [REFACTOR] If the cd snippet is duplicated between `definitions.ts` and the markdown, document where the canonical text lives.

**Acceptance criteria:**
- Rendering test passes against both source markdown and compiled spec.
- `npm run skills:guard` passes (no drift between `skills-src/` and `skills/`).
- Visual review: the new section is the first action the agent is told to take.

**Dependencies:** T-01
**Parallelizable:** Yes

---

### Task T-09: setup_worktree honors planned branch from workflow state

**Goal:** `SetupWorktreeArgs` gains optional `branch?: string`. When neither arg nor workflow state supplies a branch, fall back to the legacy `feature/<id>-<name>` default. Resolution priority: `args.branch > workflow.tasks[id=<taskId>].branch > default`.

**Files:**
- `servers/exarchos-mcp/src/orchestrate/setup-worktree.ts`
- `servers/exarchos-mcp/src/orchestrate/setup-worktree.test.ts`

1. [RED] Write tests:
   - `setupWorktree_WorkflowTasksHasBranch_UsesItOverDefault` — workflow state has `tasks[id="001"].branch = "feature/foo/t001"`; result branch matches.
   - `setupWorktree_ArgBranchOverridesWorkflowState` — both arg and state set; arg wins.
   - `setupWorktree_NoBranchAnywhere_UsesLegacyDefault` — current behavior preserved.

2. [GREEN] Extend `SetupWorktreeArgs` schema. Thread `stateDir` (or pre-loaded workflow state) into `handleSetupWorktree` — mirror how `prepare-delegation.ts` already consumes `stateDir + ctx`. Resolve branch in the documented priority.

3. [REFACTOR] Extract `resolveBranchName(args, workflowState)` pure helper.

**Acceptance criteria:**
- Three tests pass.
- Existing setup-worktree tests pass with unchanged default behavior.
- The `Branch created` check report includes which source the branch came from (e.g., `from workflow state`, `from arg`, `default`).

**Dependencies:** T-01
**Parallelizable:** Yes

---

### Task T-10: check_static_analysis SKIP for unsupported toolchains

**Goal:** Extend `StaticAnalysisResult.status` from `'pass' | 'fail' | 'error'` to include `'skip'`. The "no toolchain detected" path returns `'skip'`. Handler emits `gate.executed` event with `passed: false, skipped: true, skipReason: 'no-toolchain'`. Convergence view treats skip as inconclusive.

**Files:**
- `servers/exarchos-mcp/src/orchestrate/pure/static-analysis.ts`
- `servers/exarchos-mcp/src/orchestrate/pure/static-analysis.test.ts`
- `servers/exarchos-mcp/src/orchestrate/static-analysis.ts`
- `servers/exarchos-mcp/src/orchestrate/static-analysis.test.ts`
- `servers/exarchos-mcp/src/views/convergence-view.ts` (or wherever D2 rendering lives)
- `servers/exarchos-mcp/src/views/convergence-view.test.ts`

1. [RED] Write tests:
   - `runStaticAnalysis_NoToolchainDetected_ReturnsSkipStatus` — pure function returns `status: 'skip'`.
   - `handleStaticAnalysis_SkipStatus_EmitsEventWithSkippedTrue` — handler emits `gate.executed` with `passed: false, skipped: true, skipReason: 'no-toolchain'`.
   - `convergenceView_D2GateSkipped_RendersAsSkipNotPass` — D2 dimension reports SKIP / inconclusive.

2. [GREEN] Update `StaticAnalysisResult` discriminated union. Update the no-toolchain branch to return `'skip'`. Update the handler to map `'skip'` to the augmented event payload. Update the convergence view to render skipped gates distinctly from passed ones.

3. [REFACTOR] If `'skip'` semantics propagate to other gates later, document the convention.

**Acceptance criteria:**
- Three tests pass.
- Existing static-analysis tests pass (pass / fail / error paths unchanged).
- D2 dimension in convergence view no longer falsely greens for repos without a recognized toolchain.

**Dependencies:** T-01
**Parallelizable:** Yes

---

### Task T-11: Capture agency-csl-auto-pr fixture + characterization RED gate

**Goal:** Commit a real plan generated by `@skills/implementation-planning` as a test fixture. Write the integration test that runs `check_task_decomposition` against it and asserts the parser DOES NOT produce false positives. This test fails on current code (RED) and goes green incrementally as T-12, T-13, T-14 fix each parser bug.

**Files:**
- `servers/exarchos-mcp/src/orchestrate/fixtures/plans/agency-csl-auto-pr.md` (new)
- `servers/exarchos-mcp/src/orchestrate/task-decomposition.fixtures.test.ts` (new)

1. [RED] Capture and commit the fixture. Write tests:
   - `taskDecomposition_AgencyCslAutoPr_AllTasksWellDecomposed` — `wellDecomposed === totalTasks`.
   - `taskDecomposition_AgencyCslAutoPr_NoCycleDetected` — `dagValid === true`, no `Unresolved dependency: ... unknown 24` style errors.
   - `taskDecomposition_AgencyCslAutoPr_NoFalseFileConflicts` — `parallelSafe === true`, no conflicts on dotted-identifier tokens.

2. [GREEN] None — this task is the failing-test capture. The three sub-bug fixes (T-12, T-13, T-14) make it pass incrementally.

3. [REFACTOR] N/A.

**Acceptance criteria:**
- Fixture committed (capture from the dogfood report; trim to a representative subset if the full 33-task plan is too large).
- All three fixture tests fail on current code, with failure modes matching the dogfood report (Description = 0 words, dependency-on-unknown-24, file-conflict on `imageProvenance.isFirstParty`).
- Document the failures in the test file's leading comment.

**Dependencies:** T-01
**Parallelizable:** No (T-12, T-13, T-14 follow)

---

### Task T-12: Fix Description span parsing

**Goal:** Replace literal `**Description:**` matching with "everything between the task heading and the next field-header (`**...**:`) or section header (`### `)". Description word count reflects the actual prose under the task heading.

**Files:**
- `servers/exarchos-mcp/src/orchestrate/task-decomposition.ts`
- `servers/exarchos-mcp/src/orchestrate/task-decomposition.test.ts`

1. [RED] Write tests:
   - `validateTaskStructure_TaskWithGoalSection_CountsGoalProseAsDescription` — block with `**Goal:**` followed by 50 words of prose; `descriptionWordCount > 10`, `hasDescription === true`.
   - `validateTaskStructure_TaskWithMultipleSections_DescriptionStopsAtNextFieldHeader` — block with `Goal: ...\n\n**Acceptance criteria:**`; description includes Goal text only.
   - `validateTaskStructure_NoFieldHeaders_FullBodyCounted` — block with naked prose under task heading; full body counts.
   - One additional fixture-level assertion in `task-decomposition.fixtures.test.ts` should now go green (or partially green).

2. [GREEN] Replace the description-extraction block in `validateTaskStructure` (`task-decomposition.ts:132-160`). New algorithm: skip the heading line; capture lines until `^### ` or `^\*\*\w+:\*\*` (exclusive). Count words.

3. [REFACTOR] Extract `extractDescriptionSpan(lines)` pure helper.

**Acceptance criteria:**
- Three new tests pass.
- The fixture test for `wellDecomposed === totalTasks` passes after this task lands (assuming the other parser bugs don't independently fail tasks — which they don't, since description failure is sufficient on its own to fail the task structure check).
- Existing description-related tests still pass; if any test was specifically for the literal `**Description:**` form, update it to match the new contract or remove if unreachable.

**Dependencies:** T-11
**Parallelizable:** No (T-13 follows)

---

### Task T-13: Fix T-id dependency parser

**Goal:** Match both `T-XX` and `TXX` formats. Anchor strictly to the `**Dependencies:**` line. Remove the greedy `/[0-9]+/g` fallback — if no `T<id>`/`T-<id>` present, return `[]`.

**Files:**
- `servers/exarchos-mcp/src/orchestrate/task-decomposition.ts`
- `servers/exarchos-mcp/src/orchestrate/task-decomposition.test.ts`

1. [RED] Write tests:
   - `extractDependencies_ThyphenIdFormat_ReturnsTIds` — line `**Dependencies:** T-001, T-002` → `["T-001", "T-002"]`.
   - `extractDependencies_NoHyphenIdFormat_ReturnsTIds` — line `**Dependencies:** T001, T002` → `["T001", "T002"]` (or normalized to T-001/T-002 — pick one and document).
   - `extractDependencies_NarrativeContainsRollup24h_DoesNotExtract24` — line `**Dependencies:** T002 (\`GetCslSloRollup24h\` exposes ...)` → `["T002"]`, NOT `["T002", "24"]`.
   - `extractDependencies_NoTIdsAtAll_ReturnsEmptyArray` — line `**Dependencies:** none` → `[]`.
   - `extractDependencies_DigitsInOtherLines_NotExtracted` — `**Dependencies:**` line absent or empty; never falls back to digit-scraping the whole block.

2. [GREEN] Rewrite `extractDependencies` (`task-decomposition.ts:331-349`). Single regex matching `\b(T-?\d+)\b` (with leading word boundary, trailing non-word boundary). No fallback to plain digits.

3. [REFACTOR] If T-XX vs TXX normalization is decided, document it (comment or test). Otherwise leave both forms as-is.

**Acceptance criteria:**
- Five new tests pass.
- The fixture-level "no false cycle" assertion (`taskDecomposition_AgencyCslAutoPr_NoCycleDetected`) goes green.
- Existing dependency-extraction tests pass; update any whose expectations relied on the greedy fallback.

**Dependencies:** T-12
**Parallelizable:** No (T-14 follows)

---

### Task T-14: Fix file-conflict detection extension filter

**Goal:** Tighten file-path regex to require a known file extension. Tokens like `imageProvenance.isFirstParty` no longer match. Optionally prefer files declared under an explicit `**Files:**` section when present.

**Files:**
- `servers/exarchos-mcp/src/orchestrate/task-decomposition.ts`
- `servers/exarchos-mcp/src/orchestrate/task-decomposition.test.ts`

1. [RED] Write tests:
   - `extractFiles_DottedIdentifierLikeFieldName_NotMatched` — `\`imageProvenance.isFirstParty\`` → not in extracted files.
   - `extractFiles_KnownExtension_Matched` — `\`src/foo.ts\``, `\`config.json\``, `\`README.md\`` → all matched.
   - `extractFiles_UnknownExtension_NotMatched` — `\`some.unknownext\`` → not matched (or document the allowed-list behavior).
   - `checkParallelSafety_AgencyCslLikeNarrative_NoFalseConflicts` — two parallel tasks with overlapping field-name references but no overlapping file paths → `safe === true`.

2. [GREEN] Tighten `filePattern` in both `extractFiles` and the inline pattern in `validateTaskStructure`. Allowed extensions: `ts | tsx | js | jsx | mjs | cjs | json | md | yml | yaml | sh | ps1 | sql | kql | bicep | cs | csproj | sln | go | rs | toml`. (Confirm the list against the project's actual file inventory before locking.) Optional: if a `**Files:**` section is present in the task block, prefer those over inferred files.

3. [REFACTOR] Centralize the extension allowlist as a module-level constant `FILE_EXTENSION_ALLOWLIST` shared by `extractFiles` and `validateTaskStructure`.

**Acceptance criteria:**
- Four new tests pass.
- Fixture-level "no false file conflicts" assertion goes green.
- Genuine file conflicts in synthetic tests still detected (regression guard).

**Dependencies:** T-13
**Parallelizable:** No

---

### Task T-15: merge_orchestrate ancestry error message links runbook

**Goal:** Failed ancestry preflight emits a message that includes the manual remediation command and a link to the runbook section. Add the runbook section to `skills-src/delegation/SKILL.md`.

**Files:**
- `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.ts` (or wherever the ancestry blocker text composes)
- `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.test.ts`
- `skills-src/delegation/SKILL.md`

1. [RED] Write test: `mergePreflight_AncestryFails_MessageIncludesRebaseInstructionAndRunbookLink`
   - Run preflight with a non-descendant source branch; assert the failure result includes `git rebase` instruction and a link to `skills-src/delegation/SKILL.md#when-integration-advances-mid-wave` (or the deployed equivalent).

2. [GREEN] Extend the failure message composition. Add the runbook section to `SKILL.md` with the manual rebase + rollback procedure. Run `npm run build:skills`.

3. [REFACTOR] If multiple preflight failures use similar pattern, extract a `formatRemediation(failure)` helper.

**Acceptance criteria:**
- Test passes.
- `npm run skills:guard` passes (rendered SKILL files match source).
- The runbook section is discoverable from the failure message and reads as a complete procedure.
- No auto-rebase code introduced (deferred to #1119).

**Dependencies:** T-01
**Parallelizable:** Yes

---

### Task T-16: CLI install-skills wired (#1201) — separate commit

**Goal:** Wire the documented `install-skills` subcommand into the CLI. CLI-only (no MCP parity — install writes to local filesystem). Help text annotated `cli-only`.

**Files:**
- `servers/exarchos-mcp/src/adapters/cli.ts`
- `servers/exarchos-mcp/src/adapters/cli.test.ts`
- (consumes existing skills-installation logic from #1176 install-rewrite)

1. [RED] Write tests:
   - `cli_InstallSkillsSubcommand_RegisteredInRegistry` — `exarchos install-skills --help` exits 0 and the help text mentions skills.
   - `cli_InstallSkills_HelpTextSaysCliOnly` — help text contains `cli-only` annotation explicitly.
   - Integration smoke (if feasible): `exarchos install-skills` against a tempdir `$HOME` writes the expected skill files.

2. [GREEN] Add the subcommand definition. Wire it to call into the existing skills-installation function. Add the `cli-only` annotation. If a subcommand registry exists with a `mcpVisible` flag (or similar), set it to false.

3. [REFACTOR] If the install logic from #1176 lives in a function that can be reused without duplication, prefer reuse. Otherwise document why a new wrapper is needed.

**Acceptance criteria:**
- Three tests pass.
- Lands as a single isolated commit titled `feat(cli)(#1201): wire install-skills subcommand`. Easy to revert if it grows beyond expected scope.
- `exarchos install-skills` runs end-to-end from a local checkout against a temp `$HOME`.

**Dependencies:** T-01
**Parallelizable:** Yes

---

### Task T-17: Small docs/hint fixes (#1212)

**Goal:** Three sub-edits — install SKIP message link, `task.assigned` event hint includes `branch`, `workflow_set` array-insertion syntax documented.

**Files:**
- `servers/exarchos-mcp/src/config/test-runtime-resolver.ts`
- `servers/exarchos-mcp/src/config/test-runtime-resolver.test.ts`
- `servers/exarchos-mcp/src/event-store/schemas.ts` (or the emission-guide source for `task.assigned` hint)
- `servers/exarchos-mcp/src/event-store/schemas.test.ts`
- `servers/exarchos-mcp/src/workflow/state-store.ts` (or the workflow_set parser)
- `servers/exarchos-mcp/src/workflow/state-store.test.ts`
- `skills-src/workflow-state/SKILL.md`

1. [RED] Write tests:
   - `testRuntimeResolver_RemediationMessage_IncludesDocLinkOrExample` — resolver remediation contains either a doc URL or an inline example fragment.
   - `eventEmissionCatalog_TaskAssigned_OptionalBranchField` — `task.assigned` schema/hint includes `branch` as an optional field.
   - `workflowSetParser_ArrayInsertionSyntax_AppendsNewEntry` — verify the supported array-insert syntax (e.g., `tasks[append]: {entry}` or `tasks[id=NEW]: {entry}` — confirm against the parser's actual implementation before writing the test).

2. [GREEN] Each sub-edit:
   - Extend `resolved.remediation` with link/example.
   - Add `branch?: string` to the `task.assigned` event hint catalog. Document in the emission guide source.
   - Either confirm the parser already supports an insertion syntax (then document it in `skills-src/workflow-state/SKILL.md` with worked example), or implement minimal support if missing.

3. [REFACTOR] N/A.

**Acceptance criteria:**
- Three tests pass.
- `skills-src/workflow-state/SKILL.md` gains a worked example for adding new tasks array entries.
- `npm run skills:guard` passes.

**Dependencies:** T-01
**Parallelizable:** Yes

---

## Parallelization summary

After T-01 verification gates the rest:

- **Sequential chain A** (DR-T topology): T-02 → T-03 → T-04 → T-05 → T-06 (one worktree, ~5 sequential cycles)
- **Sequential chain B** (DR-5 parser): T-11 → T-12 → T-13 → T-14 (one worktree, ~4 sequential cycles)
- **Independent tasks** (each in its own worktree, all parallel): T-07, T-08, T-09, T-10, T-15, T-16, T-17

**Recommended dispatch waves:**

- Wave 0: T-01 (verification, blocking)
- Wave 1 (parallel): T-02, T-07, T-08, T-09, T-10, T-11, T-15, T-16, T-17 — 9 worktrees
- Wave 2 (sequential within chains): T-03 (after T-02), T-12 (after T-11)
- Wave 3: T-04 (after T-03), T-13 (after T-12)
- Wave 4: T-05 (after T-04), T-14 (after T-13)
- Wave 5: T-06 (after T-05) — terminal in chain A

Or, simpler: Wave 0 = T-01; Wave 1 = all chain-heads + all independents in parallel; Wave 2-N = chain successors as predecessors complete.

---

## Out of scope (per design)

- #1207 auto-rebase recovery (deferred to #1119)
- #1198 vitest-on-bun migration (orthogonal; separate PR)
- Convergence view UX polish for SKIP rendering (in-PR adjustable based on review)

## #1109 invariant verification (in PR description)

- [ ] Event-sourcing: events read/written documented per DR
- [ ] MCP parity: T-03 parity test asserts byte-equivalent blockers across surfaces
- [ ] Basileus-forward: T-08 explicitly removes a hidden cwd assumption
- [ ] Capability resolution: no yaml capability fields read at runtime

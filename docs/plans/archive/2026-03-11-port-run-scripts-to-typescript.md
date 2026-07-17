# Implementation Plan: Port run_script Bash Scripts to TypeScript

## Source Design
Link: `docs/designs/2026-03-11-port-run-scripts-to-typescript.md`

## Scope
**Target:** Full design — all 4 DRs
**Excluded:** None

## Summary
- Total tasks: 23 (21 ports + 1 integration + 1 content migration)
- Parallel groups: 3 batches (4 + 10 + 7) + 2 sequential
- Estimated test count: ~84 (4 tests per handler average)
- Design coverage: 4 of 4 DRs covered

## Spec Traceability

| Design Section | Tasks | Status |
|----------------|-------|--------|
| DR-1 Batch 1 (Simple Utilities) | 001-004 | Planned |
| DR-1 Batch 2 (Medium Validators) | 005-014 | Planned |
| DR-1 Batch 3 (Complex Orchestration) | 015-021 | Planned |
| DR-2 (Register in Orchestrate System) | 022 | Planned |
| DR-3 (Update Playbook References) | 022 | Planned |
| DR-4 (Remove run_script + content migration) | 022, 023 | Planned |

## Task Breakdown

---

### Task 001: Port `extract-task.sh` → `extract-task.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleExtractTask_ValidPlanAndTaskId_ReturnsTaskSection`
   - File: `servers/exarchos-mcp/src/orchestrate/extract-task.test.ts`
   - Tests: missing featureId returns error, valid plan+taskId returns markdown section, task not found returns error with available tasks, pattern matching handles `### Task 001:`, `### Task A1`, `## Task 1`
   - Expected failure: `handleExtractTask` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/extract-task.ts`
   - Args: `{ planPath: string, taskId: string }`
   - Logic: Read plan file, regex-match task header `^##+ *Task *{taskId}([: ]|$)`, extract until next task/section header
   - Return: `{ success: true, data: { taskContent: string } }`

3. **[REFACTOR]** Clean up, ensure consistent error handling

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 002: Port `review-diff.sh` → `review-diff.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleReviewDiff_ValidWorktree_ReturnsFormattedDiff`
   - File: `servers/exarchos-mcp/src/orchestrate/review-diff.test.ts`
   - Tests: valid worktree returns markdown-wrapped diff, missing worktree path returns error, empty diff returns "no changes" message, git failure returns error
   - Expected failure: `handleReviewDiff` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/review-diff.ts`
   - Args: `{ worktreePath: string, baseBranch?: string }`
   - Logic: Run `git diff` (three-dot with fallback to two-dot), wrap in markdown code block
   - Return: `{ success: true, data: { diff: string, filesChanged: number } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 003: Port `verify-worktree.sh` → `verify-worktree.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleVerifyWorktree_InsideWorktree_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/verify-worktree.test.ts`
   - Tests: path containing `.worktrees/` returns passed, path without `.worktrees/` returns failed, non-existent directory returns error, defaults to cwd when no path given
   - Expected failure: `handleVerifyWorktree` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/verify-worktree.ts`
   - Args: `{ cwd?: string }`
   - Logic: Resolve path, check if contains `.worktrees/` segment
   - Return: `{ success: true, data: { passed: boolean, path: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 004: Port `select-debug-track.sh` → `select-debug-track.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleSelectDebugTrack_HighUrgencyKnownCause_ReturnsHotfix`
   - File: `servers/exarchos-mcp/src/orchestrate/select-debug-track.test.ts`
   - Tests: high urgency + known cause → HOTFIX, high urgency + unknown cause → HOTFIX, low urgency + known cause → HOTFIX, low urgency + unknown cause → THOROUGH, reads from state file when `--state-file` provided, missing required args returns error
   - Expected failure: `handleSelectDebugTrack` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/select-debug-track.ts`
   - Args: `{ urgency?: string, rootCauseKnown?: boolean, stateFile?: string }`
   - Logic: 2×2 decision matrix, read state file for args if provided
   - Return: `{ success: true, data: { track: 'hotfix' | 'thorough', rationale: string, report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 005: Port `investigation-timer.sh` → `investigation-timer.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleInvestigationTimer_WithinBudget_ReturnsContinue`
   - File: `servers/exarchos-mcp/src/orchestrate/investigation-timer.test.ts`
   - Tests: within budget returns continue, exceeded budget returns escalate, reads startedAt from state file, handles ISO8601 timestamps, default budget is 15 minutes
   - Expected failure: `handleInvestigationTimer` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/investigation-timer.ts`
   - Args: `{ startedAt?: string, stateFile?: string, budgetMinutes?: number }`
   - Logic: Parse timestamp, calculate elapsed, compare to budget
   - Return: `{ success: true, data: { action: 'continue' | 'escalate', elapsedMinutes: number, remainingMinutes: number, report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 006: Port `check-coverage-thresholds.sh` → `check-coverage-thresholds.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleCheckCoverageThresholds_AllAbove_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/check-coverage-thresholds.test.ts`
   - Tests: all thresholds met → passed, line threshold missed → failed with details, missing coverage file → error, invalid JSON → error, report contains markdown table
   - Expected failure: `handleCheckCoverageThresholds` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/check-coverage-thresholds.ts`
   - Args: `{ coverageFile: string, lineThreshold?: number, branchThreshold?: number, functionThreshold?: number }`
   - Logic: Parse coverage-summary.json, compare percentages to thresholds
   - Return: `{ success: true, data: { passed: boolean, report: string, coverage: { lines: number, branches: number, functions: number } } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 007: Port `assess-refactor-scope.sh` → `assess-refactor-scope.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleAssessRefactorScope_FewFiles_RecommendPolish`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-refactor-scope.test.ts`
   - Tests: ≤5 files single module → polish, >5 files → overhaul, cross-module → overhaul, reads files from state file, report contains scope assessment
   - Expected failure: `handleAssessRefactorScope` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/assess-refactor-scope.ts`
   - Args: `{ files?: string[], stateFile?: string }`
   - Logic: Count files, extract module names (first path segment), check single vs cross-module
   - Return: `{ success: true, data: { passed: boolean, recommendedTrack: 'polish' | 'overhaul', filesCount: number, modulesCount: number, report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 008: Port `check-pr-comments.sh` → `check-pr-comments.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleCheckPrComments_NoUnresolved_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/check-pr-comments.test.ts`
   - Tests: no comments → passed, unresolved threads → failed, resolved threads → passed, gh CLI failure → error, report contains comment analysis
   - Expected failure: `handleCheckPrComments` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/check-pr-comments.ts`
   - Args: `{ pr: number, repo?: string }`
   - Logic: Call `gh api` to fetch PR comments, analyze threads for unresolved discussions
   - Return: `{ success: true, data: { passed: boolean, totalComments: number, unresolvedThreads: number, report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 009: Port `validate-pr-body.sh` → `validate-pr-body.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleValidatePrBody_AllSections_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/validate-pr-body.test.ts`
   - Tests: body with all required sections → passed, missing section → failed, reads from PR number via gh, reads from body file, template validation
   - Expected failure: `handleValidatePrBody` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/validate-pr-body.ts`
   - Args: `{ pr?: number, bodyFile?: string, template?: string }`
   - Logic: Fetch PR body, regex-match required sections (## Summary, ## Test plan, etc.)
   - Return: `{ success: true, data: { passed: boolean, missingSections: string[], report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 010: Port `validate-pr-stack.sh` → `validate-pr-stack.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleValidatePrStack_LinearChain_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/validate-pr-stack.test.ts`
   - Tests: linear chain → passed, fork in chain → failed, gap in chain → failed, single PR → passed, gh CLI failure → error
   - Expected failure: `handleValidatePrStack` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/validate-pr-stack.ts`
   - Args: `{ baseBranch: string }`
   - Logic: Call `gh pr list`, validate linear chain structure (one root, no forks, no gaps)
   - Return: `{ success: true, data: { passed: boolean, prCount: number, report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 011: Port `debug-review-gate.sh` → `debug-review-gate.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleDebugReviewGate_AllChecksPass_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/debug-review-gate.test.ts`
   - Tests: all checks pass → passed, test failures → failed, typecheck errors → failed, skip-run mode skips tests, report contains check results
   - Expected failure: `handleDebugReviewGate` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/debug-review-gate.ts`
   - Args: `{ repoRoot?: string, baseBranch?: string, skipRun?: boolean }`
   - Logic: Run npm test, typecheck, diff analysis; collect check results
   - Return: `{ success: true, data: { passed: boolean, checksPass: number, checksFail: number, report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 012: Port `extract-fix-tasks.sh` → `extract-fix-tasks.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleExtractFixTasks_WithFindings_ReturnsTaskArray`
   - File: `servers/exarchos-mcp/src/orchestrate/extract-fix-tasks.test.ts`
   - Tests: findings in state → task array, no findings → empty array, maps findings to worktrees, missing state file → error
   - Expected failure: `handleExtractFixTasks` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/extract-fix-tasks.ts`
   - Args: `{ stateFile: string, reviewReport?: string, repoRoot?: string }`
   - Logic: Read state JSON, extract review findings, transform to fix task objects with worktree mapping
   - Return: `{ success: true, data: { tasks: FixTask[], count: number } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 013: Port `generate-traceability.sh` → `generate-traceability.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleGenerateTraceability_ValidFiles_ReturnsMatrix`
   - File: `servers/exarchos-mcp/src/orchestrate/generate-traceability.test.ts`
   - Tests: valid design+plan → traceability table, missing design → error, missing plan → error, handles nested sections, output file written when specified
   - Expected failure: `handleGenerateTraceability` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/generate-traceability.ts`
   - Args: `{ designFile: string, planFile: string, output?: string }`
   - Logic: Parse design sections (## and ###), parse plan tasks, grep-match for traceability, build markdown table
   - Return: `{ success: true, data: { passed: boolean, matrix: string, designSections: number, planTasks: number } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 014: Port `spec-coverage-check.sh` → `spec-coverage-check.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleSpecCoverageCheck_AllTestsPass_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/spec-coverage-check.test.ts`
   - Tests: all test files found and pass → passed, missing test files → failed, test failures → failed with details, skip-run mode only checks file existence, report contains coverage matrix
   - Expected failure: `handleSpecCoverageCheck` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/spec-coverage-check.ts`
   - Args: `{ planFile: string, repoRoot?: string, threshold?: number, skipRun?: boolean }`
   - Logic: Extract test file paths from plan (regex: ``**Test file:** `path` ``), check existence, optionally run vitest per file
   - Return: `{ success: true, data: { passed: boolean, coveragePercent: number, testsFound: number, testsTotal: number, report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 015: Port `verify-worktree-baseline.sh` → `verify-worktree-baseline.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleVerifyWorktreeBaseline_NodeProject_RunsNpmTest`
   - File: `servers/exarchos-mcp/src/orchestrate/verify-worktree-baseline.test.ts`
   - Tests: Node.js project detected → runs npm test, .NET project → runs dotnet test, Rust project → runs cargo test, no test framework → skips, baseline failure → failed with output, report contains test results
   - Expected failure: `handleVerifyWorktreeBaseline` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/verify-worktree-baseline.ts`
   - Args: `{ worktreePath: string }`
   - Logic: Auto-detect project type (package.json → Node, *.csproj → .NET, Cargo.toml → Rust), run appropriate test command
   - Return: `{ success: true, data: { passed: boolean, projectType: string, report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 016: Port `setup-worktree.sh` → `setup-worktree.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleSetupWorktree_ValidArgs_CreatesWorktree`
   - File: `servers/exarchos-mcp/src/orchestrate/setup-worktree.test.ts`
   - Tests: valid args → creates worktree with branch, .gitignore check, npm install runs, baseline tests run, skip-tests flag skips tests, report contains 5 sequential checks
   - Expected failure: `handleSetupWorktree` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/setup-worktree.ts`
   - Args: `{ repoRoot: string, taskId: string, taskName: string, baseBranch?: string, skipTests?: boolean }`
   - Logic: 5 sequential steps: gitignore check, branch creation, worktree add, npm install, baseline tests
   - Return: `{ success: true, data: { passed: boolean, worktreePath: string, branch: string, checksPass: number, checksFail: number, report: string } }`

3. **[REFACTOR]** Extract shared check-tracking utility if pattern duplicates gate-utils

**Dependencies:** Task 015 (uses verify-worktree-baseline logic)
**Parallelizable:** No (depends on 015)

---

### Task 017: Port `verify-delegation-saga.sh` → `verify-delegation-saga.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleVerifyDelegationSaga_ValidSequence_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/verify-delegation-saga.test.ts`
   - Tests: valid event sequence → passed, missing team.spawned → failed, team.disbanded before team.spawned → ordering violation, task IDs not covered → failed, no events → failed
   - Expected failure: `handleVerifyDelegationSaga` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/verify-delegation-saga.ts`
   - Args: `{ featureId: string, stateDir?: string }`
   - Logic: Query event store for team.* events, validate 4 ordering rules, check task ID coverage
   - Return: `{ success: true, data: { passed: boolean, violations: string[], report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 018: Port `post-delegation-check.sh` → `post-delegation-check.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handlePostDelegationCheck_AllTasksComplete_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/post-delegation-check.test.ts`
   - Tests: all tasks complete → passed, incomplete tasks → failed with status table, per-worktree test failures → failed, skip-tests flag, report contains task summary, gate event emitted
   - Expected failure: `handlePostDelegationCheck` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/post-delegation-check.ts`
   - Args: `{ stateFile: string, repoRoot?: string, skipTests?: boolean }`
   - Logic: Read state JSON tasks array, check all status=complete, run per-worktree tests, emit gate.executed event
   - Return: `{ success: true, data: { passed: boolean, tasksComplete: number, tasksTotal: number, report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None (can use verify-delegation-saga independently)
**Parallelizable:** Yes

---

### Task 019: Port `reconcile-state.sh` → `reconcile-state.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleReconcileState_ConsistentState_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/reconcile-state.test.ts`
   - Tests: consistent state → passed, invalid phase for workflow type → failed, task branch missing → failed, worktree missing → failed, task status inconsistency → failed, report contains 5 checks
   - Expected failure: `handleReconcileState` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/reconcile-state.ts`
   - Args: `{ stateFile: string, repoRoot?: string }`
   - Logic: Read state, validate: phase valid for workflow type, task branches exist in git, worktrees exist on disk, task statuses consistent with events
   - Return: `{ success: true, data: { passed: boolean, checksPass: number, checksFail: number, report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 020: Port `pre-synthesis-check.sh` → `pre-synthesis-check.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handlePreSynthesisCheck_AllChecksPass_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/pre-synthesis-check.test.ts`
   - Tests: all 7 checks pass → passed, test failure → failed, typecheck failure → failed, phase graph validation per workflow type (feature/debug/refactor), skip-tests and skip-stack flags, report contains phase-specific graph, gate event emitted
   - Expected failure: `handlePreSynthesisCheck` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/pre-synthesis-check.ts`
   - Args: `{ stateFile: string, repoRoot?: string, skipTests?: boolean, skipStack?: boolean }`
   - Logic: 7 checks (state file validity, phase sequence, tests pass, typecheck, lint, stack validation, branch existence), workflow-type-specific phase graphs
   - Return: `{ success: true, data: { passed: boolean, checksPass: number, checksFail: number, checksSkip: number, report: string } }`

3. **[REFACTOR]** Extract workflow phase graph definitions as shared constants

**Dependencies:** None (standalone, but most complex)
**Parallelizable:** Yes

---

### Task 021: Port `new-project.sh` → `new-project.ts`
**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleNewProject_TypeScript_CreatesProjectStructure`
   - File: `servers/exarchos-mcp/src/orchestrate/new-project.test.ts`
   - Tests: TypeScript template → creates CLAUDE.md with TS config, C# template → creates with .NET config, minimal flag skips optional files, existing directory → error, report contains setup log
   - Expected failure: `handleNewProject` does not exist

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/new-project.ts`
   - Args: `{ projectPath?: string, language?: 'typescript' | 'csharp', minimal?: boolean }`
   - Logic: Create directory, copy CLAUDE.md template, substitute language-specific values
   - Return: `{ success: true, data: { projectPath: string, language: string, report: string } }`

3. **[REFACTOR]** Clean up

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 022: Integration — Register Handlers, Remove `run_script`, Clean Up
**Implements:** DR-2, DR-3, DR-4
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `compositeSync_AllNewHandlers_RegisteredInActionHandlers`
   - File: `servers/exarchos-mcp/src/orchestrate/composite.test.ts` (extend existing)
   - Tests: all 21 new action names exist in ACTION_HANDLERS, registry has matching Zod schemas for each, playbook validationScripts reference action names (not .sh paths), `run_script` does NOT exist in ACTION_HANDLERS or registry
   - Expected failure: new handler names not in ACTION_HANDLERS

2. **[GREEN]** Implement registration and removal
   - Files: `servers/exarchos-mcp/src/orchestrate/composite.ts`, `servers/exarchos-mcp/src/registry.ts`, `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Add imports and ACTION_HANDLERS entries for all 21 handlers
   - Add Zod schemas for each action in registry
   - Update `validationScripts` in playbooks to reference action names
   - Remove `run_script` from ACTION_HANDLERS, registry schema, and action enum
   - Delete `servers/exarchos-mcp/src/orchestrate/run-script.ts`
   - Remove `resolveScript()` utility and script-resolution infrastructure

3. **[REFACTOR]** Delete all 21 ported `.sh` files and their `.test.sh` files from `scripts/`

**Dependencies:** Tasks 001-021 (all ports complete)
**Parallelizable:** No (final integration)

---

### Task 023: Content Layer Migration — Update All `run_script` References in Skills
**Implements:** DR-4
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `noRunScriptReferences_SkillsContent_ZeroMatches`
   - File: `scripts/validate-no-run-script.test.ts` (temporary validation)
   - Test: grep all `.md` files under `skills/`, `commands/`, `rules/` for `run_script` — assert zero matches
   - Expected failure: ~40 references remain

2. **[GREEN]** Update all skill references
   - ~15 files across skills: implementation-planning, synthesis, delegation, debug, refactor, spec-review, quality-review, git-worktrees, shared prompts, workflow-state
   - Replace each `exarchos_orchestrate({ action: "run_script", script: "<name>.sh", args: [...] })` with the corresponding new action name and direct args
   - Example: `action: "run_script", script: "review-diff.sh", args: ["<path>"]` → `action: "review_diff", worktreePath: "<path>"`

3. **[REFACTOR]** Verify no `run_script` references remain anywhere in the codebase

**Dependencies:** Task 022 (action names finalized)
**Parallelizable:** No (must follow 022)

---

---

## Parallelization Strategy

### Wave 1: Simple Utilities (4 parallel tasks)
Tasks 001, 002, 003, 004 — no dependencies, can run in 4 parallel worktrees.

### Wave 2: Medium Validators (10 parallel tasks, in sub-waves of 4-5)
Tasks 005-014 — no cross-dependencies.
- Sub-wave 2a: Tasks 005, 006, 007, 008, 009
- Sub-wave 2b: Tasks 010, 011, 012, 013, 014

### Wave 3: Complex Orchestration (7 tasks, mostly parallel)
Tasks 015-021 — mostly independent except:
- Task 016 depends on Task 015 (setup-worktree uses verify-worktree-baseline)
- Tasks 017, 018, 019, 020, 021 can run in parallel
- Sub-wave 3a: Tasks 015, 017, 018, 019, 020, 021 (6 parallel)
- Sub-wave 3b: Task 016 (after 015 completes)

### Wave 4: Integration (2 sequential tasks)
Task 022 — after all ports complete (register handlers, remove `run_script`, delete scripts).
Task 023 — after 022 (update ~40 `run_script` references across 15 skill files).

## Deferred Items

- **validationScripts field rethinking**: Design mentions potentially introducing `validationActions` field. Deferred — updating existing string references is sufficient for now.

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass (`npm run test:run`)
- [ ] TypeScript checks pass (`npm run typecheck`)
- [ ] All 21 `.sh` scripts deleted
- [ ] All `.test.sh` files deleted
- [ ] Playbook references updated
- [ ] `run_script` fully removed (handler, registry, references)
- [ ] Ready for review

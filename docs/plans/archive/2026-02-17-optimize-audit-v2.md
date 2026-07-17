# Implementation Plan: Optimize Audit v2

**Brief:** Refactor workflow `refactor-optimize-audit-v2`
**Scope:** 25 findings (1 HIGH resolved during exploration — CONTENT-1 refactor refs exist)
**Issues:** Deferred ARCH-1/2/3 → #475

## Traceability Matrix

| Finding | Tasks | Key Requirements |
|---------|-------|------------------|
| ARCH-4: Event metadata | T1-T3 | correlationId defaults to featureId, source populated |
| ARCH-5: Compensation cleanup | T4-T5 | Checkpoint cleared after success, idempotency guards |
| ARCH-6: Guard null safety | T6-T7 | Defensive checks, consistent return types |
| ARCH-7: Phase reconciliation | T8-T9 | state.phase matches last transition event |
| OPS-3: Query pre-filter | T10-T11 | Sequence check before JSON.parse |
| OPS-5: Zod hot path | T12-T13 | Remove safeParse from telemetry projection |
| OPS-6: Idempotency cold-start | T14-T15 | Pre-filter lines before JSON.parse |
| OPS-7: Double validation | T16-T17 | Skip write-time validation when read-validated |
| TOKEN-3: View bounds | T18-T21 | Cap unbounded arrays in timeline + pipeline views |
| TOKEN-1: Delegation budget | T22-T24 | Extract saga/orchestration to references, body <1,300 words |
| TOKEN-2: Commands inline | T25 | Trim review.md, defer to @skills/ references |
| TOKEN-4: Event payload caps | T26 | Document field caps in delegation events |
| TOKEN-5: Coding standards size | T27-T28 | Extract language sections to skill references |
| WFX-1: Review output format | T29-T30 | JSON output schema for spec-review + quality-review |
| WFX-2: Auto-chain validation | T31-T33 | Pre-skill state validation gates |
| WFX-3: Delegation/synthesis gates | T34-T35 | Step 1→2 gate, mandatory stack verification |
| WFX-4: Trigger discrimination | T36-T37 | Disambiguate spec-review vs quality-review |
| WFX-5: Refactor trigger guard | T38 | Exclude debug/feature work from triggers |
| WFX-6: Brainstorming terminus | T39 | Phase 2 quality gate |
| WFX-7: Debug hotfix timer | T40 | Timer checkpoint enforcement |
| WFX-8: Quality severity rules | T41 | Objective priority classification |
| WFX-9: Plan revision guard | T42 | Max 3 revisions before escalation |
| WFX-10: Worktree validation | T43 | Pre-dispatch verification step |
| WFX-11: Cross-task review | T44-T45 | Integration issue handling in review skills |
| CONTENT-2: sync-schemas | T46 | Project detection + fallback |

## Dispatch Strategy

Three parallel worktrees, no cross-worktree dependencies during development:

```
Worktree: mcp-arch-hardening    Tasks: T1-T9    Findings: ARCH-4/5/6/7
Worktree: mcp-perf-views        Tasks: T10-T21  Findings: OPS-3/5/6/7, TOKEN-3
Worktree: content-hardening     Tasks: T22-T46  Findings: TOKEN-1/2/4/5, WFX-1-11, CONTENT-2
```

**Dependency:** All worktrees must rebase on `main` after `verification-mcp-hardening-telemetry` merges.

---

## Worktree 1: mcp-arch-hardening

### Review Unit 1: Event Metadata (ARCH-4)

#### Task T1: Populate metadata on handleInit event append
**Phase:** RED → GREEN

1. **[RED]** Write test in `workflow/tools.test.ts`:
   - `HandleInit_AppendedEvent_HasCorrelationIdDefaultingToFeatureId` — verify `workflow.started` event includes `correlationId` equal to `featureId`
   - `HandleInit_AppendedEvent_HasSourceWorkflow` — verify event has `source: 'workflow'`
   - Expected failure: event appended without metadata fields

2. **[GREEN]** Modify `handleInit()` in `workflow/tools.ts` (lines 108-127):
   - Add `correlationId: input.featureId` and `source: 'workflow'` to the event append call

**Dependencies:** None
**Files:** `workflow/tools.ts`, `workflow/tools.test.ts`

#### Task T2: Populate metadata on handleSet transition events
**Phase:** RED → GREEN

1. **[RED]** Write test in `workflow/tools.test.ts`:
   - `HandleSet_TransitionEvent_HasCorrelationId` — verify `workflow.transition` event includes `correlationId` equal to `featureId`
   - `HandleSet_TransitionEvent_HasSource` — verify event has `source: 'workflow'`
   - Expected failure: transition events lack metadata

2. **[GREEN]** Modify event append in `handleSet()` (lines 422-450):
   - Pass `correlationId: input.featureId` and `source: 'workflow'` to `emitTransitionEvents()`

**Dependencies:** T1
**Files:** `workflow/tools.ts`, `workflow/tools.test.ts`

#### Task T3: Populate metadata on handleCheckpoint event append
**Phase:** RED → GREEN

1. **[RED]** Write test in `workflow/tools.test.ts`:
   - `HandleCheckpoint_Event_HasCorrelationIdAndSource` — verify `workflow.checkpoint` event includes metadata
   - Expected failure: checkpoint event lacks metadata

2. **[GREEN]** Modify `handleCheckpoint()` (lines 539-546):
   - Add `correlationId: featureId` and `source: 'workflow'` to event append

**Dependencies:** T1
**Files:** `workflow/tools.ts`, `workflow/tools.test.ts`

### Review Unit 2: Compensation Cleanup (ARCH-5)

#### Task T4: Clear compensation checkpoint after successful completion
**Phase:** RED → GREEN

1. **[RED]** Write test in `workflow/compensation.test.ts`:
   - `ExecuteCompensation_AllActionsSucceed_ReturnsNullCheckpoint` — after all actions succeed, returned checkpoint is `null` (not the accumulated checkpoint)
   - Expected failure: checkpoint returned with completedActions populated

2. **[GREEN]** Modify `executeCompensation()` in `compensation.ts`:
   - After all actions complete successfully (no failures), return `checkpoint: null` instead of the accumulated checkpoint
   - This signals to the caller that no resume is needed

**Dependencies:** None
**Files:** `workflow/compensation.ts`, `workflow/compensation.test.ts`

#### Task T5: Clean _compensationCheckpoint from state after successful cancel
**Phase:** RED → GREEN

1. **[RED]** Write test in `workflow/tools.test.ts`:
   - `HandleCancel_SuccessfulCompensation_ClearsCheckpointFromState` — after cancel with all actions succeeding, `_compensationCheckpoint` is removed from state file
   - Expected failure: checkpoint persists in state

2. **[GREEN]** In `handleCancel()`, after successful compensation, set `_compensationCheckpoint: null` in the state update

**Dependencies:** T4
**Files:** `workflow/tools.ts`, `workflow/tools.test.ts`

### Review Unit 3: Guard Null Safety (ARCH-6)

#### Task T6: Guards handle deeply missing nested fields
**Phase:** RED → GREEN

1. **[RED]** Write tests in `workflow/guards.test.ts`:
   - `AllTasksComplete_UndefinedTasks_ReturnsTrue` — already works (returns true for empty/undefined)
   - `AllReviewsPassed_NullReviews_ReturnsFalseWithReason` — `reviews: null` returns `{passed: false, reason}` not crash
   - `MergeVerified_MissingCleanup_ReturnsFalseWithReason` — `_cleanup: undefined` returns clean failure
   - Expected failure: some guards may not handle all edge cases

2. **[GREEN]** Add defensive checks where needed:
   - Use optional chaining: `state?.reviews?.overhaul?.status`
   - Ensure all guards return `GuardResult`, never throw

**Dependencies:** None
**Files:** `workflow/guards.ts`, `workflow/guards.test.ts`

#### Task T7: Guards return consistent GuardResult types
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test in `workflow/guards.test.ts`:
   - `AllGuards_OnFailure_ReturnObjectWithReason` — iterate all guards with invalid state; verify failures return `{ passed: false, reason: string }` not bare `false`
   - Expected failure: some guards return bare `false`

2. **[GREEN]** Update any guards that return bare `false` to return `{ passed: false, reason: '<guard-id> not satisfied' }`

3. **[REFACTOR]** Ensure all guard `description` fields match their `reason` strings

**Dependencies:** T6
**Files:** `workflow/guards.ts`, `workflow/guards.test.ts`

### Review Unit 4: Phase Reconciliation (ARCH-7)

#### Task T8: reconcileFromEvents verifies phase consistency
**Phase:** RED → GREEN

1. **[RED]** Write test in `workflow/state-store.test.ts`:
   - `ReconcileFromEvents_PhaseMismatch_LogsWarning` — when state.phase differs from last `workflow.transition` event's `to` field, log a warning and use event-derived phase
   - `ReconcileFromEvents_PhaseMatch_NoWarning` — no warning when consistent
   - Expected failure: no phase consistency check exists

2. **[GREEN]** In `reconcileFromEvents()` (lines 536-544), after applying events:
   - Find last `workflow.transition` event
   - Compare `state.phase` with `lastTransition.data.to`
   - If mismatch: log warning, set state.phase to event-derived value

**Dependencies:** None
**Files:** `workflow/state-store.ts`, `workflow/state-store.test.ts`

#### Task T9: applyEventToState handles phase from transition events
**Phase:** RED → GREEN

1. **[RED]** Write test in `workflow/state-store.test.ts`:
   - `ApplyEventToState_WorkflowTransition_SetsPhaseFromTo` — verify `workflow.transition` event sets `state.phase` to `event.data.to`
   - Expected: should already work (verify existing behavior)

2. **[GREEN]** Verify `applyEventToState()` correctly maps `workflow.transition` → `state.phase = event.data.to` (confidence check)

**Dependencies:** T8
**Files:** `workflow/state-store.test.ts`

---

## Worktree 2: mcp-perf-views

### Review Unit 1: Query Pre-filter (OPS-3)

#### Task T10: Pre-filter by sequence before JSON.parse in combined queries
**Phase:** RED → GREEN

1. **[RED]** Write test in `event-store/store.test.ts`:
   - `Query_WithSinceSequenceAndTypeFilter_SkipsEarlyLines` — verify events before `sinceSequence` are not fully parsed (measure by ensuring correct results with fewer parse operations)
   - `Query_WithSinceSequenceAndTypeFilter_ReturnsCorrectResults` — combined filter returns correct events
   - Expected failure: currently parses all lines when type filter is present alongside sinceSequence

2. **[GREEN]** Modify `query()` in `store.ts` (lines 288-310):
   - Before JSON.parse (line 299), extract sequence via regex: `/"sequence":(\d+)/`
   - If `sinceSequence` set and extracted sequence <= sinceSequence, skip line
   - Fall through to JSON.parse + remaining filters for lines past the threshold

**Dependencies:** None
**Files:** `event-store/store.ts`, `event-store/store.test.ts`

#### Task T11: Validate sequence regex extraction handles edge cases
**Phase:** RED → GREEN

1. **[RED]** Write tests in `event-store/store.test.ts`:
   - `Query_SequenceRegex_HandlesMultiDigitSequences` — sequence 1000+ extracted correctly
   - `Query_SequenceRegex_MalformedLine_FallsBackToFullParse` — if regex fails, still parses normally
   - Expected failure: no regex extraction yet

2. **[GREEN]** Add fallback: if regex returns NaN, proceed to JSON.parse

**Dependencies:** T10
**Files:** `event-store/store.ts`, `event-store/store.test.ts`

### Review Unit 2: Telemetry Zod Removal (OPS-5)

#### Task T12: Remove Zod safeParse from tool.completed handler
**Phase:** RED → GREEN

1. **[RED]** Write test in `telemetry/telemetry-projection.test.ts`:
   - `Apply_ToolCompleted_ValidData_UpdatesMetrics` — verify existing behavior preserved without Zod
   - `Apply_ToolCompleted_MissingFields_ReturnsViewUnchanged` — malformed data handled via guard check, not Zod
   - Expected failure: tests should pass (behavior preservation)

2. **[GREEN]** Replace `ToolCompletedData.safeParse(event.data)` (line 86) with type assertion + guard:
   ```typescript
   const data = event.data as { tool?: string; durationMs?: number; responseBytes?: number; tokenEstimate?: number } | undefined;
   if (!data?.tool || typeof data.durationMs !== 'number') return view;
   ```

**Dependencies:** None
**Files:** `telemetry/telemetry-projection.ts`, `telemetry/telemetry-projection.test.ts`

#### Task T13: Remove Zod safeParse from tool.errored handler
**Phase:** RED → GREEN

1. **[RED]** Write test in `telemetry/telemetry-projection.test.ts`:
   - `Apply_ToolErrored_ValidData_UpdatesMetrics` — behavior preserved
   - `Apply_ToolErrored_MissingFields_ReturnsViewUnchanged` — guard handles bad data
   - Expected failure: tests should pass (behavior preservation)

2. **[GREEN]** Replace `ToolErroredData.safeParse(event.data)` (line 123) with type assertion + guard

**Dependencies:** T12
**Files:** `telemetry/telemetry-projection.ts`, `telemetry/telemetry-projection.test.ts`

### Review Unit 3: Idempotency Cold-Start (OPS-6)

#### Task T14: Pre-filter lines in rebuildIdempotencyCache
**Phase:** RED → GREEN

1. **[RED]** Write test in `event-store/store.test.ts`:
   - `RebuildIdempotencyCache_SkipsLinesWithoutIdempotencyKey` — lines not containing `"idempotencyKey"` string are not JSON.parsed
   - `RebuildIdempotencyCache_ReturnsCorrectCacheEntries` — functional behavior preserved
   - Expected failure: all lines currently parsed

2. **[GREEN]** Modify `rebuildIdempotencyCache()` (line 351):
   - Before `JSON.parse(line)`, check `if (!line.includes('"idempotencyKey"')) continue;`
   - This skips the vast majority of events (only workflow transitions have idempotency keys)

**Dependencies:** None
**Files:** `event-store/store.ts`, `event-store/store.test.ts`

#### Task T15: Validate pre-filter doesn't miss valid keys
**Phase:** RED → GREEN

1. **[RED]** Write test in `event-store/store.test.ts`:
   - `RebuildIdempotencyCache_AllKeyedEvents_FoundAfterPrefilter` — write events with and without keys, verify all keyed events are cached
   - Expected failure: should pass (confidence test)

2. **[GREEN]** Verify the string check `'"idempotencyKey"'` matches all JSON encodings (it will, since JSON keys are always double-quoted)

**Dependencies:** T14
**Files:** `event-store/store.test.ts`

### Review Unit 4: Double Validation (OPS-7)

#### Task T16: Add skipValidation option to writeStateFile
**Phase:** RED → GREEN

1. **[RED]** Write test in `workflow/state-store.test.ts`:
   - `WriteStateFile_SkipValidation_WritesWithoutZodParse` — when `skipValidation: true`, no safeParse call
   - `WriteStateFile_SkipValidation_StillPerformsCAS` — CAS check still works
   - Expected failure: no skipValidation option exists

2. **[GREEN]** Add optional `skipValidation?: boolean` to `writeStateFile` options:
   - When true, skip lines 224-230 (Zod validation)
   - Keep CAS check (lines 202-215) and atomic write (lines 232-247)

**Dependencies:** None
**Files:** `workflow/state-store.ts`, `workflow/state-store.test.ts`

#### Task T17: Use skipValidation in handleSet after read-validated state
**Phase:** RED → GREEN

1. **[RED]** Write test in `workflow/tools.test.ts`:
   - `HandleSet_WritesWithSkipValidation` — verify handleSet passes `skipValidation: true` when writing (state was already validated on read)
   - Expected failure: handleSet doesn't pass skipValidation

2. **[GREEN]** Modify `handleSet()` write call (line ~472) to pass `{ skipValidation: true }` since state was read+validated at line 324

**Dependencies:** T16
**Files:** `workflow/tools.ts`, `workflow/tools.test.ts`

### Review Unit 5: View Bounds (TOKEN-3)

#### Task T18: Cap delegation timeline tasks array
**Phase:** RED → GREEN

1. **[RED]** Write test in `views/delegation-timeline-view.test.ts`:
   - `Apply_TeamTaskAssigned_ExceedsMaxTasks_EvictsOldest` — when `tasks.length > MAX_TIMELINE_TASKS` (200), oldest task is evicted
   - Expected failure: no cap on tasks array

2. **[GREEN]** In `delegation-timeline-view.ts`, after appending task (line 97):
   - Add `const MAX_TIMELINE_TASKS = 200;`
   - If `tasks.length > MAX_TIMELINE_TASKS`, slice to keep last 200

**Dependencies:** None
**Files:** `views/delegation-timeline-view.ts`, `views/delegation-timeline-view.test.ts`

#### Task T19: Cap pipeline stackPositions array
**Phase:** RED → GREEN

1. **[RED]** Write test in `views/pipeline-view.test.ts`:
   - `Apply_StackPositionFilled_ExceedsMax_EvictsOldest` — when `stackPositions.length > MAX_STACK_POSITIONS` (100), oldest evicted
   - Expected failure: no cap on stackPositions

2. **[GREEN]** In `pipeline-view.ts`, after appending position (lines 96-105):
   - Add `const MAX_STACK_POSITIONS = 100;`
   - Slice if over limit

**Dependencies:** None
**Files:** `views/pipeline-view.ts`, `views/pipeline-view.test.ts`

#### Task T20: Add hasMore indicator to delegation timeline view
**Phase:** RED → GREEN

1. **[RED]** Write test in `views/delegation-timeline-view.test.ts`:
   - `ViewState_HasEvicted_HasMoreIsTrue` — when tasks were capped, `hasMore: true`
   - `ViewState_BelowCap_HasMoreIsFalse` — when tasks below cap, `hasMore: false`
   - Expected failure: no `hasMore` field

2. **[GREEN]** Add `hasMore: boolean` to `DelegationTimelineViewState` interface; set based on eviction

**Dependencies:** T18
**Files:** `views/delegation-timeline-view.ts`, `views/delegation-timeline-view.test.ts`

#### Task T21: Add hasMore indicator to pipeline view
**Phase:** RED → GREEN

1. **[RED]** Write test in `views/pipeline-view.test.ts`:
   - `ViewState_HasEvicted_HasMoreIsTrue` — analogous to T20
   - Expected failure: no `hasMore` field

2. **[GREEN]** Add `hasMore: boolean` to `PipelineViewState`; set based on eviction

**Dependencies:** T19
**Files:** `views/pipeline-view.ts`, `views/pipeline-view.test.ts`

---

## Worktree 3: content-hardening

All tasks in this worktree are content-only (markdown edits). No TDD required.

### Review Unit 1: Delegation SKILL Budget (TOKEN-1)

#### Task T22: Extract Agent Teams saga to references
**Phase:** Content

1. Extract the 6-step delegation saga (currently inline in SKILL.md) to `skills/delegation/references/agent-teams-saga.md`
2. Replace inline content with: "For detailed Agent Teams saga steps, see `references/agent-teams-saga.md`."

**Dependencies:** None
**Files:** `skills/delegation/SKILL.md`, `skills/delegation/references/agent-teams-saga.md`

#### Task T23: Extract Adaptive Orchestration to references
**Phase:** Content

1. Extract Adaptive Orchestration section to `skills/delegation/references/adaptive-orchestration.md`
2. Replace with reference link

**Dependencies:** T22
**Files:** `skills/delegation/SKILL.md`, `skills/delegation/references/adaptive-orchestration.md`

#### Task T24: Verify delegation SKILL.md under 1,300 words
**Phase:** Content

1. After T22-T23, verify word count is under 1,300
2. If still over, extract additional sections (Exarchos Integration, Saga Compensation) to references
3. Final body should contain: Overview, Triggers, Delegation Modes table, Controller Responsibilities, State Management, Completion Criteria, Transition

**Dependencies:** T23
**Files:** `skills/delegation/SKILL.md`

### Review Unit 2: Command Trimming (TOKEN-2)

#### Task T25: Trim commands/review.md to routing-only
**Phase:** Content

1. Remove inline "Two-Stage Process" detail (duplicates spec-review + quality-review skills)
2. Remove inline checklist content
3. Keep: command header, skill reference (`@skills/spec-review/SKILL.md`, `@skills/quality-review/SKILL.md`), state management, auto-chain logic
4. Target: ~250 words

**Dependencies:** None
**Files:** `commands/review.md`

### Review Unit 3: Event Payload Documentation (TOKEN-4)

#### Task T26: Document event payload field caps in delegation skill
**Phase:** Content

1. In `skills/delegation/references/agent-teams-saga.md` (or existing event reference), document:
   - `team.task.completed`: use `fileCount: number` instead of `filesChanged: string[]`
   - `team.task.failed`: use `gateNames: string[]` (max 10) instead of `gateResults: Record<string, unknown>`
   - `failureReason`: max 200 chars
2. These are documentation-only caps — actual enforcement is in event append validation

**Dependencies:** T22
**Files:** `skills/delegation/references/agent-teams-saga.md`

### Review Unit 4: Coding Standards Extraction (TOKEN-5)

#### Task T27: Extract TypeScript standards to quality-review reference
**Phase:** Content

1. Move TypeScript-specific sections (File Organization, Type Design, Modern TypeScript) from `rules/coding-standards.md` to `skills/quality-review/references/typescript-standards.md`
2. Keep shared SOLID, Control Flow, Error Handling, DRY in the rule file

**Dependencies:** None
**Files:** `rules/coding-standards.md`, `skills/quality-review/references/typescript-standards.md`

#### Task T28: Extract C# standards to dotnet-standards reference
**Phase:** Content

1. Move C#-specific sections from `rules/coding-standards.md` to `skills/dotnet-standards/references/csharp-standards.md`
2. Rule file retains only shared cross-language principles (~400 words)

**Dependencies:** T27
**Files:** `rules/coding-standards.md`, `skills/dotnet-standards/references/csharp-standards.md`

### Review Unit 5: Review Output Format (WFX-1)

#### Task T29: Add required JSON output schema to spec-review
**Phase:** Content

1. Add "Required Output Format" section to `skills/spec-review/SKILL.md`:
   ```json
   {
     "verdict": "pass | fail | blocked",
     "summary": "1-2 sentence summary",
     "issues": [{ "severity": "HIGH|MEDIUM|LOW", "category": "spec|tdd|coverage", "file": "path", "line": 123, "description": "...", "required_fix": "..." }],
     "test_results": { "passed": 0, "failed": 0, "coverage_percent": 0 }
   }
   ```
2. Document that orchestrator parses this JSON to populate state

**Dependencies:** None
**Files:** `skills/spec-review/SKILL.md`

#### Task T30: Add required JSON output schema to quality-review
**Phase:** Content

1. Add analogous "Required Output Format" section to `skills/quality-review/SKILL.md`
2. Same schema with `category` extended to include `security|solid|dry|perf|other`

**Dependencies:** T29
**Files:** `skills/quality-review/SKILL.md`

### Review Unit 6: Auto-Chain Validation (WFX-2)

#### Task T31: Add pre-skill validation to brainstorming→plan transition
**Phase:** Content

1. In `skills/brainstorming/SKILL.md` auto-chain section, add:
   - Before invoking `/plan`: verify `artifacts.design` exists in state AND file exists on disk
   - If missing: error "Design artifact not found, cannot auto-chain to /plan"

**Dependencies:** None
**Files:** `skills/brainstorming/SKILL.md`

#### Task T32: Add pre-skill validation to delegation→review transition
**Phase:** Content

1. In `skills/delegation/SKILL.md` transition section, add:
   - Before invoking `/review`: verify all `tasks[].status === 'complete'` in state
   - If incomplete tasks: error "Not all tasks complete, cannot proceed to review"

**Dependencies:** None
**Files:** `skills/delegation/SKILL.md`

#### Task T33: Add pre-skill validation to spec-review→quality-review transition
**Phase:** Content

1. In `skills/spec-review/SKILL.md` transition section, add:
   - Before invoking quality-review: verify spec-review verdict is `"pass"` in state
   - If not: error "Spec review did not pass, cannot proceed to quality review"

**Dependencies:** None
**Files:** `skills/spec-review/SKILL.md`

### Review Unit 7: Delegation/Synthesis Gates (WFX-3)

#### Task T34: Add explicit Step 1→2 gate in delegation saga
**Phase:** Content

1. In the delegation saga (post-extraction, in `references/agent-teams-saga.md`):
   - After Step 1 (Team Creation), add gate: "Verify team config exists and has valid members array before proceeding to Step 2"
   - If gate fails: emit `team.creation.failed` event, abort delegation

**Dependencies:** T22
**Files:** `skills/delegation/references/agent-teams-saga.md`

#### Task T35: Make reconstruct-stack.sh mandatory in synthesis
**Phase:** Content

1. In `skills/synthesis/SKILL.md` pre-synthesis section:
   - Change `reconstruct-stack.sh` from optional to mandatory
   - Add: "REQUIRED: Run `scripts/reconstruct-stack.sh` before PR creation. If exit 1: stop and report error."
   - Update completion criteria to include stack verification

**Dependencies:** None
**Files:** `skills/synthesis/SKILL.md`

### Review Unit 8: Trigger Discrimination (WFX-4/5)

#### Task T36: Update spec-review frontmatter triggers
**Phase:** Content

1. Update `skills/spec-review/SKILL.md` description to:
   - Add: "Use when verifying implementation matches design spec"
   - Add anti-trigger: "Do NOT use for code quality checks (use quality-review)"
   - Clarify: "This is stage 1 of the two-stage /review command"

**Dependencies:** None
**Files:** `skills/spec-review/SKILL.md`

#### Task T37: Update quality-review frontmatter triggers
**Phase:** Content

1. Update `skills/quality-review/SKILL.md` description to:
   - Replace "review code" with "quality review", "check code quality"
   - Add prerequisite: "Requires spec-review to have passed (stage 2 of /review)"
   - Add anti-trigger: "Do NOT use for spec compliance checks (use spec-review)"

**Dependencies:** T36
**Files:** `skills/quality-review/SKILL.md`

#### Task T38: Add guard clause to refactor triggers
**Phase:** Content

1. Update `skills/refactor/SKILL.md` description to:
   - Add anti-triggers: "Do NOT use for bug fixes (use /debug) or new features (use /ideate)"
   - Clarify: "Applies to existing code only — no new features"

**Dependencies:** None
**Files:** `skills/refactor/SKILL.md`

### Review Unit 9: Pattern Adherence (WFX-6/7/8)

#### Task T39: Add Phase 2 quality gate to brainstorming
**Phase:** Content

1. In `skills/brainstorming/SKILL.md` Phase 2 section, add "Exploration Quality Gate":
   - Exactly 2-3 approaches documented
   - Each answers all design questions from Phase 1
   - Approaches differ in at least 2 of: {data structure, API design, implementation complexity}
   - One approach recommended with clear rationale

**Dependencies:** None
**Files:** `skills/brainstorming/SKILL.md`

#### Task T40: Add timer checkpoint to debug hotfix track
**Phase:** Content

1. In `skills/debug/SKILL.md` hotfix track section, add:
   - On hotfix selection: record `investigation.startedAt` in state
   - After each major finding: check elapsed time
   - At 15 min: emit `investigation.timeout` event, pause for user confirmation to switch tracks

**Dependencies:** None
**Files:** `skills/debug/SKILL.md`

#### Task T41: Add objective priority classification to quality review
**Phase:** Content

1. In `skills/quality-review/SKILL.md`, add "Priority Classification Rules" section:
   - HIGH: security vulnerabilities, data loss risk, API contract breaks, uncaught exceptions
   - MEDIUM: SOLID violations (LSP, ISP), complexity >15, test coverage <70%
   - LOW: naming, style, comments, non-impactful performance

**Dependencies:** None
**Files:** `skills/quality-review/SKILL.md`

### Review Unit 10: Session Consistency (WFX-9/10/11)

#### Task T42: Add max-iterations guard to plan revision loop
**Phase:** Content

1. In `skills/implementation-planning/SKILL.md` revision section, add:
   - Max 3 revisions per plan
   - After 3 failed revisions: set `planReview.revisionsExhausted = true`, escalate to user
   - Message: "Plan revision failed after 3 attempts. Gaps indicate design is incomplete."

**Dependencies:** None
**Files:** `skills/implementation-planning/SKILL.md`

#### Task T43: Add worktree validation pre-dispatch step
**Phase:** Content

1. In `skills/delegation/SKILL.md` (or `references/workflow-steps.md`), add:
   - Before dispatching to each worktree: run `scripts/verify-worktree.sh --cwd <path>`
   - If exit 1: stop dispatch, report invalid worktree
   - Add to completion criteria: "All worktrees validated via verify-worktree.sh"

**Dependencies:** None
**Files:** `skills/delegation/SKILL.md`

#### Task T44: Add cross-task integration handling to spec-review
**Phase:** Content

1. In `skills/spec-review/SKILL.md`, add "Cross-Task Integration Issues" section:
   - If issue spans multiple tasks: classify as "cross-task integration"
   - Create fix task specifying ALL affected tasks
   - Mark original tasks as blocked until cross-task fix completes

**Dependencies:** None
**Files:** `skills/spec-review/SKILL.md`

#### Task T45: Add cross-task integration handling to quality-review
**Phase:** Content

1. Same section as T44 but in `skills/quality-review/SKILL.md`

**Dependencies:** T44
**Files:** `skills/quality-review/SKILL.md`

### Review Unit 11: Project Detection (CONTENT-2)

#### Task T46: Add project detection and fallback to sync-schemas
**Phase:** Content

1. In `skills/sync-schemas/SKILL.md`:
   - Update frontmatter description: add "Monorepo-specific to ares-elite-platform"
   - Add "Project Requirement" section at top of body:
     - Check for `azure.yaml` and `apps/` directory
     - If not found: report "This skill requires the ares-elite-platform monorepo"
   - Move hardcoded paths to a "Configuration" section with comment that these are project-specific

**Dependencies:** None
**Files:** `skills/sync-schemas/SKILL.md`

---

## Task Summary

| ID | Title | Finding | Worktree | Dependencies |
|----|-------|---------|----------|--------------|
| T1 | handleInit event metadata | ARCH-4 | mcp-arch-hardening | — |
| T2 | handleSet event metadata | ARCH-4 | mcp-arch-hardening | T1 |
| T3 | handleCheckpoint event metadata | ARCH-4 | mcp-arch-hardening | T1 |
| T4 | Compensation checkpoint cleanup return | ARCH-5 | mcp-arch-hardening | — |
| T5 | Clean _compensationCheckpoint from state | ARCH-5 | mcp-arch-hardening | T4 |
| T6 | Guard null safety edge cases | ARCH-6 | mcp-arch-hardening | — |
| T7 | Guard consistent return types | ARCH-6 | mcp-arch-hardening | T6 |
| T8 | Phase reconciliation check | ARCH-7 | mcp-arch-hardening | — |
| T9 | applyEventToState phase mapping | ARCH-7 | mcp-arch-hardening | T8 |
| T10 | Query pre-filter by sequence | OPS-3 | mcp-perf-views | — |
| T11 | Sequence regex edge cases | OPS-3 | mcp-perf-views | T10 |
| T12 | Remove Zod from tool.completed | OPS-5 | mcp-perf-views | — |
| T13 | Remove Zod from tool.errored | OPS-5 | mcp-perf-views | T12 |
| T14 | Idempotency cache pre-filter | OPS-6 | mcp-perf-views | — |
| T15 | Pre-filter confidence test | OPS-6 | mcp-perf-views | T14 |
| T16 | writeStateFile skipValidation | OPS-7 | mcp-perf-views | — |
| T17 | handleSet uses skipValidation | OPS-7 | mcp-perf-views | T16 |
| T18 | Cap timeline tasks array | TOKEN-3 | mcp-perf-views | — |
| T19 | Cap pipeline stackPositions | TOKEN-3 | mcp-perf-views | — |
| T20 | Timeline hasMore indicator | TOKEN-3 | mcp-perf-views | T18 |
| T21 | Pipeline hasMore indicator | TOKEN-3 | mcp-perf-views | T19 |
| T22 | Extract delegation saga | TOKEN-1 | content-hardening | — |
| T23 | Extract adaptive orchestration | TOKEN-1 | content-hardening | T22 |
| T24 | Verify delegation word count | TOKEN-1 | content-hardening | T23 |
| T25 | Trim review command | TOKEN-2 | content-hardening | — |
| T26 | Document event payload caps | TOKEN-4 | content-hardening | T22 |
| T27 | Extract TS standards | TOKEN-5 | content-hardening | — |
| T28 | Extract C# standards | TOKEN-5 | content-hardening | T27 |
| T29 | Spec-review output schema | WFX-1 | content-hardening | — |
| T30 | Quality-review output schema | WFX-1 | content-hardening | T29 |
| T31 | Brainstorming→plan validation | WFX-2 | content-hardening | — |
| T32 | Delegation→review validation | WFX-2 | content-hardening | — |
| T33 | Spec→quality validation | WFX-2 | content-hardening | — |
| T34 | Delegation saga Step 1→2 gate | WFX-3 | content-hardening | T22 |
| T35 | Synthesis mandatory stack check | WFX-3 | content-hardening | — |
| T36 | Spec-review trigger update | WFX-4 | content-hardening | — |
| T37 | Quality-review trigger update | WFX-4 | content-hardening | T36 |
| T38 | Refactor trigger guard | WFX-5 | content-hardening | — |
| T39 | Brainstorming Phase 2 gate | WFX-6 | content-hardening | — |
| T40 | Debug hotfix timer | WFX-7 | content-hardening | — |
| T41 | Quality priority rules | WFX-8 | content-hardening | — |
| T42 | Plan revision loop guard | WFX-9 | content-hardening | — |
| T43 | Worktree validation pre-dispatch | WFX-10 | content-hardening | — |
| T44 | Cross-task review (spec) | WFX-11 | content-hardening | — |
| T45 | Cross-task review (quality) | WFX-11 | content-hardening | T44 |
| T46 | sync-schemas project detection | CONTENT-2 | content-hardening | — |

## Parallel Execution

**mcp-arch-hardening** (4 parallel chains):
- Chain 1: T1 → T2, T3 (metadata)
- Chain 2: T4 → T5 (compensation)
- Chain 3: T6 → T7 (guards)
- Chain 4: T8 → T9 (reconciliation)

**mcp-perf-views** (5 parallel chains):
- Chain 1: T10 → T11 (query pre-filter)
- Chain 2: T12 → T13 (Zod removal)
- Chain 3: T14 → T15 (idempotency)
- Chain 4: T16 → T17 (double validation)
- Chain 5: T18 → T20 ∥ T19 → T21 (view bounds)

**content-hardening** (mostly parallel, some chains):
- Chain 1: T22 → T23 → T24 → T26 → T34 (delegation extraction + deps)
- Chain 2: T27 → T28 (standards extraction)
- Chain 3: T29 → T30 (review output)
- Chain 4: T36 → T37 (trigger updates)
- Chain 5: T44 → T45 (cross-task review)
- Independent: T25, T31, T32, T33, T35, T38, T39, T40, T41, T42, T43, T46

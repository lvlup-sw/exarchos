# Implementation Plan: Context Reload Command

## Source Design
Link: `docs/designs/2026-02-18-context-reload.md`

## Scope
**Target:** Full design — all 5 components (Context Assembly Engine, Enhanced PreCompact, Enhanced SessionStart, /reload command + hooks config, Installer auto-compact config)
**Excluded:** None

## Summary
- Total tasks: 5
- Parallel groups: 2 (Tasks 1+4 parallel, then Tasks 2+3 parallel after Task 1, Task 5 after all)
- Estimated test count: ~28
- Design coverage: 8 of 8 sections covered

## Spec Traceability

### Scope Declaration
**Target:** Full design
**Excluded:** None

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Component 1: Context Assembly Engine | - Compose CQRS views (`handleViewWorkflowStatus`, `handleViewTasks`)<br>- Query events via `EventStore.query()`<br>- Async git via `execFile`<br>- Phase-aware context tuning<br>- 8,000 char hard cap with truncation<br>- Git fault tolerance | 001 | Covered |
| Component 2: Enhanced PreCompact | - Generate context.md alongside checkpoint<br>- Add `contextFile` to CheckpointData<br>- Trigger-aware: auto → `continue: false`, manual → `continue: true` | 002 | Covered |
| Component 3: Enhanced SessionStart | - Read pre-computed context.md (no inline assembly)<br>- Include `contextDocument` in response<br>- Delete context.md after read (at-most-once) | 003 | Covered |
| Component 4: /reload Command | - `commands/reload.md` content<br>- Auto-discovered by installer | 004 | Covered |
| Component 5: Installer auto-compact | - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90` in settings env | 004 | Covered |
| Integration Points > hooks.json | - PreCompact matcher: `""`<br>- SessionStart matcher: `startup\|resume\|compact\|clear` | 004 | Covered |
| Integration Points > cli.ts | - Register `assemble-context` command handler | 001 | Covered |
| Testing Strategy | - Unit tests for all components<br>- Integration test for full reload cycle | 005 | Covered |

## Task Breakdown

---

### Task 001: Context Assembly Engine

**Phase:** RED → GREEN → REFACTOR

**Files:**
- New: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/assemble-context.ts`
- New: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/assemble-context.test.ts`
- Modify: `plugins/exarchos/servers/exarchos-mcp/src/cli.ts` (register command)

**TDD Steps:**

1. [RED] Write tests for `handleAssembleContext`:
   - `assembleContext_ActiveFeatureWorkflow_ProducesStructuredMarkdown`
     - File: `assemble-context.test.ts`
     - Expected failure: `handleAssembleContext` not found (module doesn't exist)
   - `assembleContext_DelegatePhase_IncludesWorktreeInfo`
   - `assembleContext_ReviewPhase_IncludesReviewFindings`
   - `assembleContext_NoActiveWorkflow_ReturnsEmptyContextDocument`
   - `assembleContext_MissingEventStore_GracefulDegradation`
     - No JSONL file on disk → events section omitted, no crash
   - `assembleContext_MissingArtifactFiles_SkipsSummaries`
   - `assembleContext_GitUnavailable_SkipsGitSection`
     - Run in a tmpdir that is NOT a git repo → git section omitted
   - `assembleContext_IncludesRecentEvents_ViaEventStoreQuery`
     - Verify events come from `EventStore.query()` with `limit`, not raw JSONL
   - `assembleContext_EventsFormattedAsOneLineSummaries`
     - Verify no raw `data` fields in output, only `{HH:MM} {type} {detail}`
   - `assembleContext_IncludesNextAction`
   - `assembleContext_TokenBudget_OutputUnder8000Chars`
     - Create workflow with 25 tasks → verify output ≤ 8,000 chars
   - `assembleContext_TaskTableTruncation_OverflowCount`
     - Create workflow with 15 tasks → verify table shows 10 + overflow line
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [GREEN] Implement `handleAssembleContext`:
   - File: `assemble-context.ts`
   - Export `handleAssembleContext(stdinData, stateDir): Promise<AssembleContextResult>`
   - Import view handlers from `../views/tools.js`:
     - `handleViewWorkflowStatus` → phase, task counts, metadata
     - `handleViewTasks` → task details with filtering
   - Import `EventStore` from `../event-store/store.js` for `query(streamId, { limit: 10 })`
   - Use `promisify(execFile)` for git operations (NOT `execSync`):
     - `git rev-parse --abbrev-ref HEAD` (branch name)
     - `git log --oneline -3` (recent commits)
     - `git status --porcelain` (working tree)
     - Run all three in `Promise.all()` with individual 5s timeouts
   - Wrap ALL git calls in try/catch → skip Git State section on failure
   - Read artifact file first line via `fs.readFile` + `.split('\n')[0]`
   - Compute next action via `computeNextAction()`
   - Format into structured Markdown sections
   - Enforce 8,000 char hard cap with truncation strategy:
     - Task table: max 10 rows, overflow count for remainder
     - Events: last 5, one-line summaries only
     - If still over cap: drop sections in order: events → git → artifacts
   - Register in `cli.ts` as `'assemble-context'` handler
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npm run test:run` — MUST PASS

3. [REFACTOR] Extract formatting helpers:
   - `formatTaskTable`, `formatEventSummary`, `formatGitState`, `formatArtifactRef`
   - `truncateToCharBudget` — applies section-dropping strategy
   - Run: tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements
- [ ] All git operations use async `execFile`, never `execSync`
- [ ] All event reads use `EventStore.query()`, never raw JSONL
- [ ] View data comes from `handleViewWorkflowStatus` / `handleViewTasks`

**Dependencies:** None
**Parallelizable:** Yes (independent new file)

---

### Task 002: Enhanced PreCompact — Context.md Generation + Trigger Awareness

**Phase:** RED → GREEN → REFACTOR

**Files:**
- Modify: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/pre-compact.ts`
- Modify: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/pre-compact.test.ts`

**TDD Steps:**

1. [RED] Write tests:
   - `handlePreCompact_ActiveWorkflow_WritesContextMdFile`
     - File: `pre-compact.test.ts`
     - Expected failure: no `.context.md` file created (current code doesn't generate it)
   - `handlePreCompact_ActiveWorkflow_CheckpointIncludesContextFilePath`
     - Expected failure: `checkpoint.contextFile` is undefined
   - `handlePreCompact_NoActiveWorkflows_NoContextMdWritten`
   - `handlePreCompact_AutoTrigger_ReturnsContinueFalse`
     - Pass `{ trigger: 'auto' }` in stdinData
     - Expected: `result.continue === false`
     - Expected: stopReason contains "Type /clear"
   - `handlePreCompact_ManualTrigger_ReturnsContinueTrue`
     - Pass `{ trigger: 'manual' }` in stdinData
     - Expected failure: current code always returns `continue: false` for active workflows
   - `handlePreCompact_ManualTrigger_StillWritesCheckpointAndContextMd`
     - Manual trigger writes checkpoint files but allows compaction to proceed
   - `handlePreCompact_MultipleWorkflows_WritesContextMdForEach`
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [GREEN] Implement changes:
   - File: `pre-compact.ts`
   - Import `handleAssembleContext` from `./assemble-context.js`
   - Add `contextFile` field to `CheckpointData` interface
   - Extract `trigger` from stdinData (default: `'auto'` if absent)
   - After writing checkpoint JSON, call `handleAssembleContext({ featureId }, stateDir)`
   - Write result as `{featureId}.context.md` in stateDir
   - Store context.md path in checkpoint's `contextFile` field
   - **Trigger-aware return:**
     - If `trigger === 'manual'`: return `{ continue: true }` (allow compaction)
     - Otherwise (auto/absent): return `{ continue: false, stopReason: "..." }`
   - Update auto-trigger stopReason to: `"Context checkpoint saved. Type /clear to reload with fresh context."`
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npm run test:run` — MUST PASS

3. [REFACTOR] Clean up if needed
   - Run: tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Auto trigger: `continue: false` (stops session)
- [ ] Manual trigger: `continue: true` (allows compaction)
- [ ] Both triggers write checkpoint + context.md

**Dependencies:** Task 001 (imports `handleAssembleContext`)
**Parallelizable:** No (depends on Task 001)

---

### Task 003: Enhanced SessionStart — Pre-Computed Context Injection

**Phase:** RED → GREEN → REFACTOR

**Files:**
- Modify: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/session-start.ts`
- Modify: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/session-start.test.ts`

**TDD Steps:**

1. [RED] Write tests:
   - `handleSessionStart_CheckpointWithContextFile_IncludesContextDocument`
     - File: `session-start.test.ts`
     - Setup: write `.checkpoint.json` with `contextFile` field + corresponding `.context.md`
     - Expected failure: `result.contextDocument` is undefined (current code ignores contextFile)
   - `handleSessionStart_CheckpointWithoutContextFile_FallsBackToCurrentBehavior`
     - Checkpoint without contextFile field → response has no contextDocument
   - `handleSessionStart_ContextFileReferencedButMissing_GracefulDegradation`
     - Checkpoint references context.md that doesn't exist on disk → no crash, no contextDocument
   - `handleSessionStart_DeletesContextMdAfterReading`
     - Context.md file should be deleted after successful read (at-most-once delivery)
   - `handleSessionStart_ActiveWorkflowNoCheckpoint_NoContextDocument`
     - No checkpoint, just state file → returns current behavior (no contextDocument)
     - Verifies we do NOT call handleAssembleContext inline (would exceed 10s timeout)
   - `handleSessionStart_MultipleCheckpoints_CombinesContextDocuments`
     - Two checkpoints with context files → contextDocument contains both
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [GREEN] Implement changes:
   - File: `session-start.ts`
   - Add `contextFile?: string` to local `CheckpointData` interface
   - Add `contextDocument?: string` to `SessionStartResult` interface
   - In `readAndDeleteCheckpoints`: after reading checkpoint, if `contextFile` exists:
     - Read the context.md file
     - Delete context.md file (at-most-once: delete before adding content to results)
     - If read fails (file missing), continue without contextDocument
   - Collect all context documents into a single string (separated by `---`)
   - Add `contextDocument` to the result when non-empty
   - No-checkpoint path: unchanged (no inline assembly, no contextDocument)
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npm run test:run` — MUST PASS

3. [REFACTOR] Extract context-reading into helper function
   - Run: tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] SessionStart does NOT import or call handleAssembleContext
- [ ] Context.md deleted before content added to result (at-most-once)
- [ ] Missing context.md does not crash or delay SessionStart

**Dependencies:** None (reads files written by PreCompact, but doesn't import Task 001 code)
**Parallelizable:** Yes (parallel with Task 002)

---

### Task 004: Hook Config + /reload Command + Installer Settings

**Phase:** RED → GREEN → REFACTOR

**Files:**
- Modify: `hooks.json`
- New: `commands/reload.md`
- Modify: `src/operations/settings.ts`
- Modify: `src/operations/settings.test.ts` (if exists) or create test

**TDD Steps:**

1. [RED] Write tests:
   - `hooksJson_PreCompactMatcher_IsEmptyForAllEvents`
     - File: new `hooks-config.test.ts` (or inline in existing test)
     - Read `hooks.json`, verify PreCompact matcher is `""`
     - Expected failure: matcher is currently `"auto"`
   - `hooksJson_SessionStartMatcher_IncludesCompactAndClear`
     - Verify matcher contains `compact` and `clear`
     - Expected failure: matcher is currently `"startup|resume"`
   - `reloadCommand_Exists_InCommandsDirectory`
     - Verify `commands/reload.md` exists and contains expected keywords
     - Expected failure: file doesn't exist
   - `generateSettings_IncludesAutoCompactOverride`
     - Verify generated settings include `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '90'` in env
     - Expected failure: env field doesn't include the override
   - Run: test suite — MUST FAIL

2. [GREEN] Implement changes:
   - File: `hooks.json`
     - Change PreCompact matcher from `"auto"` to `""`
     - Change SessionStart matcher from `"startup|resume"` to `"startup|resume|compact|clear"`
   - File: `commands/reload.md`
     - Create the /reload command Markdown
   - File: `src/operations/settings.ts`
     - In `generateSettings()`, add `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '90'` to the `env` field
   - Run: test suite — MUST PASS

3. [REFACTOR] Review command wording for clarity
   - Run: tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Auto-compact threshold set statically, not via hook response

**Dependencies:** None
**Parallelizable:** Yes (independent config + content files)

---

### Task 005: Integration Tests — Full Reload Cycle

**Phase:** RED → GREEN → REFACTOR

**Files:**
- New: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/context-reload.integration.test.ts`

**TDD Steps:**

1. [RED] Write integration tests:
   - `fullReloadCycle_DelegatePhase_PreCompact_SessionStart_ProducesRichContext`
     - File: `context-reload.integration.test.ts`
     - Setup: write state file in delegate phase with tasks + create event JSONL
     - Call `handlePreCompact({ trigger: 'auto' }, stateDir)` → verify checkpoint + context.md + `continue: false`
     - Call `handleSessionStart({}, stateDir)` → verify `contextDocument` contains task table, events, phase info
     - Expected failure: contextDocument missing (depends on Tasks 001-003)
   - `manualCompact_PreCompact_ReturnsContinueTrue_StillWritesCheckpoint`
     - Call `handlePreCompact({ trigger: 'manual' }, stateDir)` → verify `continue: true` + checkpoint exists
     - Call `handleSessionStart({}, stateDir)` → verify `contextDocument` present
   - `noWorkflow_SessionStart_ReturnsMinimalResponse`
     - Empty stateDir → SessionStart returns no contextDocument
   - `multiWorkflow_BothGetContextDocuments`
     - Two active workflows → both get context.md → both appear in contextDocument
   - `contextBudget_LargeWorkflow_Under8000Chars`
     - Create workflow with 25 tasks + 20 events → verify assembled output ≤ 8,000 chars
   - Run: test suite — MUST FAIL

2. [GREEN] Verify all integration tests pass (no new impl needed — covered by Tasks 001-004)
   - If any fail, debug and fix the integration points
   - Run: test suite — MUST PASS

3. [REFACTOR] Consolidate test helpers if shared across test files
   - Run: tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Full cycle works end-to-end: PreCompact → SessionStart
- [ ] Token budget enforced in integration scenario

**Dependencies:** Tasks 001, 002, 003, 004
**Parallelizable:** No (final verification, depends on all prior tasks)

---

## Parallelization Strategy

```
          ┌─── Task 001 (Assembly Engine) ──┬─── Task 002 (Enhanced PreCompact)
          │                                  │
Start ────┤                                  ├─── Task 003 (Enhanced SessionStart)
          │                                  │
          └─── Task 004 (Config + Command) ──┘
                                             │
                                             └─── Task 005 (Integration Tests)
```

**Group A (parallel, no deps):**
- Task 001: Context Assembly Engine (new file, worktree: `wt-001-assembly`)
- Task 004: Hook Config + /reload Command + Installer (config/content, worktree: `wt-004-config`)

**Group B (parallel, after Task 001):**
- Task 002: Enhanced PreCompact (worktree: `wt-002-precompact`) — depends on Task 001
- Task 003: Enhanced SessionStart (worktree: `wt-003-sessionstart`) — no code dep on Task 001

**Group C (depends on all):**
- Task 005: Integration Tests (worktree: `wt-005-integration`)

**Note on Task 003 parallelism:** Task 003 does NOT import code from Task 001. It only reads `.context.md` files that Task 002 writes. This means Task 003 can run in parallel with Task 002, and both can start as soon as Task 001 completes (Task 002 needs the import; Task 003 only needs the file format contract).

**Branch naming:** `feat/context-reload/{task-id}-{short-name}`

## Audit Findings Addressed

| # | Finding | Resolution |
|---|---------|------------|
| 1.1 | CQRS violation: raw JSONL reads | Assembly engine uses `EventStore.query()` + `handleViewWorkflowStatus` / `handleViewTasks` |
| 1.2 | Reimplemented JSONL tail read | Uses `EventStore.query({ limit })` API |
| 2.1 | No token budget enforcement | 8,000 char hard cap with truncation strategy (events → git → artifacts) |
| 2.2 | Event data fields inflate context | One-line summaries only: `{HH:MM} {type} {detail}`, no raw data |
| 3.1 | `execSync` blocks event loop | All git via `promisify(execFile)` + `Promise.all()` |
| 3.2 | SessionStart 10s timeout risk | SessionStart reads pre-computed context.md only, no inline assembly |
| 3.3 | Git availability assumed | try/catch on all git calls, skip section on failure, tested explicitly |
| 5.1 | `envOverrides` not consumed by CC | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90` set statically in installer settings |
| 5.2 | `continue: false` blocks manual compact | Check `trigger` field: auto → stop, manual → allow (both write checkpoint) |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] `npm run typecheck` passes
- [ ] All git operations async (`execFile`, never `execSync`)
- [ ] All event reads via `EventStore.query()`, never raw JSONL
- [ ] Token budget enforced (output ≤ 8,000 chars)
- [ ] Ready for review

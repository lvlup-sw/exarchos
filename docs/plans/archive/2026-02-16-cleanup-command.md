# Implementation Plan: /cleanup Slash Command

## Source Design
Brief: `~/.claude/workflow-state/refactor-cleanup-command.state.json`
Issue: [#375](https://github.com/lvlup-sw/exarchos/issues/375)

## Scope
**Target:** Full brief — all 6 goals
**Excluded:** None

## Summary
- Total tasks: 7
- Parallel groups: 2 (T1‖T3, T7‖T4-T6)
- Estimated test count: 18
- Brief coverage: 6 of 6 goals covered

## Spec Traceability

| Brief Goal | Tasks | Key Tests |
|---|---|---|
| G1: `cleanup` action in composite tool | T6 | `compositeRoutes_CleanupAction` |
| G2: Guard-free HSM transitions to `completed` | T1, T2 | `mergeVerified_*`, `cleanupTransition_*` |
| G3: Auto-backfill synthesis metadata | T5 | `handleCleanup_BackfillsSynthesis` |
| G4: Force-resolve blocking review statuses | T5 | `handleCleanup_ForceResolvesReviews` |
| G5: /cleanup command and skill | T7 | `SKILL.md.test.sh` |
| G6: Emit events to event store | T5 | `handleCleanup_EmitsCleanupEvent` |

## Task Breakdown

### Task 1: Add `mergeVerified` guard

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `mergeVerified_CleanupFlagTrue_ReturnsTrue`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/state-machine.test.ts`
   - Additional tests:
     - `mergeVerified_CleanupFlagFalse_ReturnsFalseWithReason`
     - `mergeVerified_CleanupFlagMissing_ReturnsFalseWithReason`
   - Expected failure: `guards.mergeVerified` does not exist
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npx vitest run src/__tests__/workflow/state-machine.test.ts` — MUST FAIL

2. [GREEN] Implement the guard
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/guards.ts`
   - Changes: Add `mergeVerified` guard that checks `state._cleanup?.mergeVerified === true`. Returns `GuardResult` with descriptive reason on failure.
   - Run: MUST PASS

**Verification:**
- [ ] Guard checks `_cleanup.mergeVerified` flag on state
- [ ] Returns descriptive `reason` when false/missing
- [ ] Follows existing guard patterns (id, description, evaluate)

**Dependencies:** None
**Parallelizable:** Yes (with T3)

---

### Task 2: Add cleanup transitions to all 3 HSM definitions

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests:
   - `cleanupTransition_FeatureFromReview_TransitionsToCompleted`
   - `cleanupTransition_FeatureFromDelegate_TransitionsToCompleted`
   - `cleanupTransition_DebugFromInvestigate_TransitionsToCompleted`
   - `cleanupTransition_DebugFromSynthesize_TransitionsToCompleted`
   - `cleanupTransition_RefactorFromOverhaulReview_TransitionsToCompleted`
   - `cleanupTransition_RefactorFromOverhaulDelegate_TransitionsToCompleted`
   - `cleanupTransition_FromCompleted_RejectsAsAlreadyFinal`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/state-machine.test.ts`
   - Expected failure: No transition from `review` to `completed` (or similar — only `synthesize → completed` exists)
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npx vitest run src/__tests__/workflow/state-machine.test.ts` — MUST FAIL

2. [GREEN] Add cleanup transitions
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/hsm-definitions.ts`
   - Changes: For each non-terminal, non-synthesize state in all 3 HSMs, add a transition `{ from: <state>, to: 'completed', guard: guards.mergeVerified }`. The existing `synthesize → completed` transition (guarded by `prUrlExists`) remains unchanged. Cleanup transitions provide an alternative path when the orchestrator has verified merge externally.
   - Run: MUST PASS

**Verification:**
- [ ] All non-terminal states in feature HSM can reach `completed` via `mergeVerified`
- [ ] All non-terminal states in debug HSM can reach `completed` via `mergeVerified`
- [ ] All non-terminal states in refactor HSM can reach `completed` via `mergeVerified`
- [ ] Existing `synthesize → completed` (prUrlExists) transitions preserved
- [ ] Final states (`completed`, `cancelled`) cannot transition

**Dependencies:** T1
**Parallelizable:** No (depends on T1)

---

### Task 3: Add event type and input schema

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests:
   - `workflowCleanupEventType_IsValid` — verify `workflow.cleanup` is in `EventTypes`
   - `cleanupInputSchema_ValidInput_Parses` — verify schema accepts valid cleanup input
   - `cleanupInputSchema_MissingFeatureId_Rejects` — verify schema rejects missing featureId
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/schemas.test.ts`
   - Expected failure: `workflow.cleanup` not in EventTypes, `CleanupInputSchema` not exported
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npx vitest run src/__tests__/workflow/schemas.test.ts` — MUST FAIL

2. [GREEN] Add event type and schema
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.ts`
     - Add `'workflow.cleanup'` to `EventTypes` array
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/schemas.ts`
     - Add `CleanupInputSchema`:
       ```typescript
       export const CleanupInputSchema = z.object({
         featureId: FeatureIdSchema,
         mergeVerified: z.boolean(),
         prUrl: z.union([z.string(), z.array(z.string())]).optional(),
         mergedBranches: z.array(z.string()).optional(),
         dryRun: z.boolean().optional(),
       });
       ```
     - Add to `ToolInputSchemas` map
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/types.ts`
     - Add `CleanupInput` type export
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/events.ts`
     - Add `'cleanup': 'workflow.cleanup'` to `mapInternalToExternalType` typeMap
   - Run: MUST PASS

**Verification:**
- [ ] `workflow.cleanup` recognized as valid event type
- [ ] Schema validates `featureId` (required), `mergeVerified` (required), `prUrl` (optional), `mergedBranches` (optional), `dryRun` (optional)
- [ ] Type exported from types.ts

**Dependencies:** None
**Parallelizable:** Yes (with T1)

---

### Task 4: Implement handleCleanup — rejection paths

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests:
   - `handleCleanup_NonExistentFeature_ReturnsStateNotFound`
   - `handleCleanup_AlreadyCompleted_ReturnsAlreadyCompleted`
   - `handleCleanup_AlreadyCancelled_RejectsTerminalState`
   - `handleCleanup_MergeNotVerified_RejectsWithReason`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/cleanup.test.ts` (new file)
   - Expected failure: `handleCleanup` does not exist
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npx vitest run src/__tests__/workflow/cleanup.test.ts` — MUST FAIL

2. [GREEN] Implement rejection paths
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/cleanup.ts` (new file)
   - Changes: Create `handleCleanup(input: CleanupInput, stateDir: string)` following the `handleCancel` pattern:
     1. Read state file (handle STATE_NOT_FOUND)
     2. Check if already completed → return `ALREADY_COMPLETED` error
     3. Check if already cancelled → return `INVALID_TRANSITION` error
     4. Set `_cleanup.mergeVerified` on mutable state copy
     5. If `!input.mergeVerified`, return `GUARD_FAILED` error with descriptive reason
   - Add `ALREADY_COMPLETED` to `ErrorCode` in schemas.ts
   - Run: MUST PASS

**Verification:**
- [ ] Non-existent feature returns STATE_NOT_FOUND
- [ ] Already completed returns ALREADY_COMPLETED
- [ ] Already cancelled returns INVALID_TRANSITION
- [ ] mergeVerified=false returns GUARD_FAILED with descriptive reason

**Dependencies:** T1, T2, T3
**Parallelizable:** No

---

### Task 5: Implement handleCleanup — happy path

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `handleCleanup_FromReview_TransitionsToCompleted` — verify phase becomes `completed`
   - `handleCleanup_BackfillsSynthesis_PopulatesPrUrlAndMergedBranches` — verify synthesis metadata populated
   - `handleCleanup_ForceResolvesReviews_SetsAllToPassed` — verify blocking reviews resolved
   - `handleCleanup_EmitsCleanupEvent_WhenEventStoreConfigured` — verify `workflow.cleanup` event emitted
   - `handleCleanup_DryRun_ReturnsActionsWithoutModifyingState` — verify dryRun mode
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/cleanup.test.ts`
   - Expected failure: handleCleanup doesn't implement happy path yet (returns rejection or crashes)
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npx vitest run src/__tests__/workflow/cleanup.test.ts` — MUST FAIL

2. [GREEN] Implement happy path
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/cleanup.ts`
   - Changes (extend existing rejection-path handler):
     1. **Backfill synthesis metadata:** Set `synthesis.prUrl` from `input.prUrl` and `synthesis.mergedBranches` from `input.mergedBranches` on mutable state
     2. **Force-resolve reviews:** Iterate `state.reviews`, for each entry set `status: 'approved'` (handles flat and nested shapes using `collectReviewStatuses` pattern)
     3. **Set `_cleanup.mergeVerified = true`** on state for guard evaluation
     4. **Execute HSM transition:** Call `executeTransition(hsm, mutableState, 'completed')` — the `mergeVerified` guard will pass since we set the flag
     5. **Emit events:** Append `workflow.cleanup` event to external store (event-first, before state write)
     6. **Apply history updates** from transition result
     7. **Reset checkpoint** counter
     8. **Write state** to disk
     9. **dryRun support:** When `input.dryRun === true`, return what would happen without modifying state
   - Add `configureCleanupEventStore(store)` function (same pattern as cancel.ts)
   - Export `handleCleanup` in tools.ts re-exports
   - Run: MUST PASS

3. [REFACTOR] Extract shared patterns
   - Extract common state-read-check-terminal pattern shared between `handleCancel` and `handleCleanup` if duplication exceeds 10 lines
   - Run: MUST STAY GREEN

**Verification:**
- [ ] Phase transitions to `completed` from any non-terminal phase
- [ ] `synthesis.prUrl` populated from input
- [ ] `synthesis.mergedBranches` populated from input
- [ ] All review statuses set to `approved`
- [ ] `workflow.cleanup` event emitted to event store
- [ ] `workflow.transition` event emitted for the phase change
- [ ] dryRun returns actions without modifying state
- [ ] State file updated with correct timestamp and checkpoint

**Dependencies:** T4
**Parallelizable:** No

---

### Task 6: Register cleanup action in registry and composite

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests:
   - `compositeWorkflow_CleanupAction_RoutesToHandler` — verify composite dispatches to handleCleanup
   - `registry_CleanupAction_ExistsInWorkflowTool` — verify cleanup appears in TOOL_REGISTRY
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/index.test.ts` (add to existing)
   - Expected failure: `cleanup` not in composite switch, not in registry actions
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npx vitest run src/__tests__/workflow/index.test.ts` — MUST FAIL

2. [GREEN] Register and route
   - File: `plugins/exarchos/servers/exarchos-mcp/src/registry.ts`
     - Add cleanup action to `workflowActions` array:
       ```typescript
       {
         name: 'cleanup',
         description: 'Resolve a merged workflow to completed. Verifies merge, backfills synthesis metadata, force-resolves reviews, transitions to completed. Auto-emits workflow.cleanup event',
         schema: z.object({
           featureId: featureIdSchema,
           mergeVerified: z.boolean(),
           prUrl: z.union([z.string(), z.array(z.string())]).optional(),
           mergedBranches: z.array(z.string()).optional(),
           dryRun: z.boolean().optional(),
         }),
         phases: ALL_PHASES,
         roles: ROLE_LEAD,
       }
       ```
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/composite.ts`
     - Import `handleCleanup` from `./cleanup.js`
     - Add `case 'cleanup':` to switch statement routing to `handleCleanup`
   - Update `exarchos_workflow` description in registry to include `cleanup`
   - Run: MUST PASS

**Verification:**
- [ ] `cleanup` appears in `TOOL_REGISTRY` under `exarchos_workflow`
- [ ] Composite handler routes `action: 'cleanup'` to `handleCleanup`
- [ ] Tool description includes cleanup action
- [ ] Unknown actions still return UNKNOWN_ACTION error

**Dependencies:** T5
**Parallelizable:** No

---

### Task 7: Create /cleanup command and skill

**Phase:** Documentation (no TDD — markdown only)

**Steps:**
1. Create `/cleanup` command
   - File: `commands/cleanup.md`
   - Content: YAML frontmatter with description, workflow position diagram, skill reference to `@skills/cleanup/SKILL.md`, prerequisites (workflow must exist, PRs must be merged), process steps, auto-chain behavior

2. Create cleanup skill
   - File: `skills/cleanup/SKILL.md`
   - Content: YAML frontmatter, triggers, process:
     1. Read workflow state to get featureId and current phase
     2. Query GitHub for merged PR status (using GitHub MCP `pull_request_read` or `gh pr view`)
     3. Collect prUrl and mergedBranches from merged PRs
     4. Invoke `exarchos_workflow` with `action: "cleanup"`, passing `mergeVerified: true`, `prUrl`, `mergedBranches`
     5. Run worktree cleanup: `git worktree remove` for each active worktree
     6. Run branch sync: `gt sync --force`
     7. Report completion

3. Create skill references
   - File: `skills/cleanup/references/merge-verification.md`
   - Content: How to verify merge status via GitHub MCP, fallback to gh CLI

4. Update CLAUDE.md
   - Add `cleanup` to the `exarchos_workflow` composite tools table
   - Add `/cleanup` to the workflow type descriptions

**Verification:**
- [ ] Command has YAML frontmatter with description
- [ ] Skill has YAML frontmatter with name, description, metadata
- [ ] Process covers all 6 steps
- [ ] CLAUDE.md updated

**Dependencies:** None (documentation only)
**Parallelizable:** Yes (with T4-T6)

---

## Parallelization Strategy

```
Group 1 (parallel):  T1 ─────┐     T3 ─────┐
                              │              │
Group 2 (sequential):T2 ◄────┘              │
                              │              │
Group 3 (sequential):T4 ◄───────────────────┘
                              │
Group 4 (sequential):T5 ◄────┘
                              │
Group 5 (sequential):T6 ◄────┘

Group 6 (parallel):  T7 ─────── (independent, runs anytime)
```

**Delegation recommendation:**
- **Worker A:** T1 → T2 → T4 → T5 → T6 (core pipeline)
- **Worker B:** T3 (merge into Worker A after completion)
- **Worker C:** T7 (documentation, independent)

Given the tight dependency chain on T1→T2→T4→T5→T6, the most efficient dispatch is:
- **Delegate T1+T3 in parallel** (foundation tasks)
- **Delegate T2 after T1** (HSM transitions)
- **Delegate T4+T5+T6 sequentially** (handler pipeline — one worker)
- **Delegate T7 in parallel** (documentation, anytime)

## Deferred Items

| Item | Rationale |
|---|---|
| Cancelled/abandoned workflow cleanup | Out of scope per brief — separate concern |
| Auto-chain cleanup in session-start hook | Manual invocation only for v1 — can add later |
| GitHub token in MCP server for direct merge verification | Skill handles verification and passes result — cleaner separation |
| Worktree removal automation in MCP server | Orchestrator runs git commands — simpler and more flexible |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] `mergeVerified` guard validates cleanup flag
- [ ] All 3 HSMs support cleanup transitions
- [ ] `handleCleanup` handles rejection and happy paths
- [ ] Cleanup action registered in composite tool
- [ ] `workflow.cleanup` event type recognized
- [ ] /cleanup command and skill created
- [ ] CLAUDE.md updated
- [ ] Code coverage meets standards
- [ ] Ready for review

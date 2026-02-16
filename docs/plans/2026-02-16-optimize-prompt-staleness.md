# Implementation Plan: Optimize Prompt Staleness

## Source Design
Audit prompt: `docs/prompts/optimize.md`
Brief: Captured in workflow state `refactor-optimize-prompt-staleness`

## Scope
**Target:** Partial — Pattern Alignment, Token Economy, Operational Performance
**Excluded:**
- Remote sync wiring (Marten/PostgreSQL not ready)
- HSM or saga compensation refactoring (assessed as well-implemented)
- Adding `compact` parameter to view handlers (future enhancement)
- Workflow effectiveness improvements (skills already have validation scripts)

## Summary
- Total tasks: 6
- Parallel groups: 2 (MCP server + content layer)
- Estimated test count: 8
- Design coverage: 4 of 5 audit categories addressed

## Spec Traceability

### Traceability Matrix

| Audit Section | Key Requirements | Task ID(s) | Status |
|---------------|-----------------|------------|--------|
| 1. CQRS — Task claim inline aggregation | Replace inline event filtering with materialized view query | 001 | Covered |
| 1. Event Sourcing — Metadata optional | Add validation helper for agent-emitted events requiring agentId/source | 002 | Covered |
| 1. Outbox — idempotencyKey lost on drain | Include idempotencyKey in drain event reconstruction | 003 | Covered |
| 1. Outbox — drain never called | Wire sync `now` action to trigger outbox drain | 003 | Covered |
| 3. Token — Skill body size | Extract track guides from refactor/delegation skills to references | 004 | Covered |
| 3. Token — Rule bloat | Convert MCP tool guidance from 1,754w rule to ~200w rule + reference | 005 | Covered |
| 3. Token — Duplication | Consolidate orchestrator constraints; slim delegate command | 006 | Covered |
| 1. CQRS — Team bypass | Team status view already exists and is CQRS-compliant | — | Not needed |
| 1. HSM semantics | Well-implemented; guards are pure functions | — | Deferred: no action needed |
| 1. Saga compensation | Checkpoint persistence works; compensation is idempotent | — | Deferred: no action needed |
| 4. I/O — O(n) query | Pagination exists; materializer caches high-water marks | — | Deferred: acceptable for current scale |
| 4. Memory — LRU eviction | Already implemented in ViewMaterializer | — | Not needed |

## Task Breakdown

### Task 001: Refactor task claim to use materialized view

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `attemptTaskClaim_TaskAlreadyClaimed_ReturnsAlreadyClaimed`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/tasks/tools.test.ts`
   - Test that `handleTaskClaim` returns `ALREADY_CLAIMED` when the task-detail view shows the task is already claimed, using the materializer instead of inline event filtering
   - Expected failure: Test references materializer import that doesn't exist yet in tasks module
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Refactor `attemptTaskClaim` to use CQRS materializer
   - File: `plugins/exarchos/servers/exarchos-mcp/src/tasks/tools.ts`
   - Changes:
     - Import `getOrCreateMaterializer`, `getOrCreateEventStore` from `../views/tools.js`
     - Import `TASK_DETAIL_VIEW`, `TaskDetailViewState` from `../views/task-detail-view.js`
     - Replace inline `store.query()` + `.some()` filter with:
       ```typescript
       const materializer = getOrCreateMaterializer(stateDir);
       const store = getOrCreateEventStore(stateDir);
       await materializer.loadFromSnapshot(args.streamId, TASK_DETAIL_VIEW);
       const events = await store.query(args.streamId);
       const view = materializer.materialize<TaskDetailViewState>(args.streamId, TASK_DETAIL_VIEW, events);
       const task = view.tasks[args.taskId];
       if (task && (task.status === 'claimed' || task.status === 'completed' || task.status === 'failed')) {
         return ALREADY_CLAIMED;
       }
       ```
     - Use `events.length` for `expectedSequence` (same as before)
     - Remove module-level `getStore()` and use shared singleton from views/tools.ts
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Remove redundant module-level EventStore
   - Remove `moduleEventStore` and `getStore()` from tasks/tools.ts since it now uses the shared singleton
   - Update `registerTaskTools` to not inject EventStore (or keep for backward compat)
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements
- [ ] Existing task claim tests still pass

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 002: Add agent event metadata validation helper

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `validateAgentEvent_MissingAgentId_ThrowsValidationError`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Test that a helper function `validateAgentEvent` rejects events of agent types (`task.claimed`, `agent.message`, `agent.handoff`, `task.progressed`) when `agentId` or `source` is missing
   - Test that system events (`workflow.started`, `phase.transitioned`) pass without agentId/source
   - Expected failure: `validateAgentEvent` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement `validateAgentEvent` helper
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.ts`
   - Changes:
     - Define `AGENT_EVENT_TYPES` constant: `['task.claimed', 'task.progressed', 'agent.message', 'agent.handoff']`
     - Export `validateAgentEvent(event: { type: string; agentId?: string; source?: string })` that:
       - Returns `true` for non-agent event types (no validation needed)
       - Throws/returns error if agentId or source is missing for agent event types
     - Do NOT change the base Zod schema (would break existing appends)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Wire validation into task claim handler
   - File: `plugins/exarchos/servers/exarchos-mcp/src/tasks/tools.ts`
   - Call `validateAgentEvent` before `store.append` in `attemptTaskClaim` to ensure `agentId` is always present on `task.claimed` events
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Existing event store tests still pass
- [ ] `agentId` already present in `attemptTaskClaim` call (line 116) — validation confirms contract

**Dependencies:** None (independent of Task 001)
**Parallelizable:** Yes (Group A)

---

### Task 003: Fix outbox idempotencyKey propagation and wire sync now

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `drain_EventWithIdempotencyKey_PropagatesKeyToRemote`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/sync/outbox.test.ts`
   - Test that when draining an event that has an `idempotencyKey`, the key is included in the event sent to the remote client
   - Use a mock `EventSender` to capture the sent event and verify `idempotencyKey` is present
   - Expected failure: Current drain code omits `idempotencyKey` from reconstructed event
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add idempotencyKey to drain reconstruction
   - File: `plugins/exarchos/servers/exarchos-mcp/src/sync/outbox.ts`
   - Changes: In `drain()` method (line ~148-161), add `idempotencyKey` to the event reconstruction:
     ```typescript
     ...(entry.event.idempotencyKey ? { idempotencyKey: entry.event.idempotencyKey } : {}),
     ```
   - Run: `npm run test:run` - MUST PASS

3. [RED] Write test: `handleSyncNow_WithPendingEntries_DrainsThem`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/sync/sync-handler.test.ts`
   - Test that `handleSyncNow()` triggers outbox drain for all discovered streams
   - Expected failure: `handleSyncNow` does not exist
   - Run: `npm run test:run` - MUST FAIL

4. [GREEN] Implement `handleSyncNow` handler
   - File: `plugins/exarchos/servers/exarchos-mcp/src/sync/sync-handler.ts`
   - Changes:
     - Create handler that discovers all streams in stateDir, creates Outbox, calls `drain()` for each
     - Since remote client isn't wired, use a no-op `EventSender` that logs but doesn't send (or return "no remote configured" result)
     - Wire into `exarchos_sync` in `index.ts` (replace the stub)
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Existing outbox tests still pass
- [ ] Sync now no longer returns NOT_IMPLEMENTED

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 004: Restructure oversized skill bodies

**Phase:** Content restructuring (no TypeScript TDD — validate with word count and integration tests)

**Steps:**
1. Extract refactor skill track guides to references
   - Create: `skills/refactor/references/polish-track.md` (~600 words of polish track details)
   - Create: `skills/refactor/references/overhaul-track.md` (~700 words of overhaul track details)
   - Edit: `skills/refactor/SKILL.md` — replace inline track details with progressive disclosure links
   - Target: Body under 1,500 words (from 2,265)

2. Extract delegation skill parallel strategy and fix mode to references
   - Create: `skills/delegation/references/parallel-strategy.md` (~400 words)
   - Create: `skills/delegation/references/fix-mode.md` (~350 words)
   - Edit: `skills/delegation/SKILL.md` — replace inline details with links
   - Target: Body under 1,500 words (from 2,061)

3. Validate
   - Word count check: `wc -w skills/refactor/SKILL.md skills/delegation/SKILL.md`
   - Run skill integration tests: `bash scripts/validate-refactor-skill.test.sh && bash scripts/validate-delegation-skill.test.sh`
   - Verify frontmatter still valid and descriptions unchanged

**Verification:**
- [ ] refactor/SKILL.md under 1,500 words
- [ ] delegation/SKILL.md under 1,500 words
- [ ] All reference files linked with `@skills/` paths
- [ ] Skill integration tests pass
- [ ] No instruction content lost (only moved to references)

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 005: Convert MCP tool guidance from rule to compact rule + reference

**Phase:** Content restructuring

**Steps:**
1. Create compact rule
   - Edit: `rules/mcp-tool-guidance.md` — reduce to ~200 words with high-level guidance only:
     - "Use Exarchos MCP for workflow state"
     - "Use GitHub MCP for all GitHub operations"
     - "Use Serena for code structure analysis"
     - "Use Graphite for PR creation"
     - "Use Context7 for library docs"
     - Link: "For detailed tool usage and anti-patterns, see `@skills/workflow-state/references/mcp-tool-reference.md`"
   - Target: Under 300 words (from 1,754)

2. Create detailed reference
   - Create: `skills/workflow-state/references/mcp-tool-reference.md` — move detailed tables, methods, and anti-patterns here
   - This file is loaded on-demand when Claude needs detailed MCP guidance

3. Validate
   - Word count check: `wc -w rules/mcp-tool-guidance.md`
   - Verify no broken references from skills that mention the rule

**Verification:**
- [ ] Rule under 300 words
- [ ] Reference file contains all detailed guidance that was removed
- [ ] No skill or command references broken

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 006: Consolidate orchestrator constraints and slim delegate command

**Phase:** Content restructuring

**Steps:**
1. Consolidate orchestrator constraints
   - Edit: `rules/orchestrator-constraints.md` — merge additional content from `skills/delegation/references/orchestrator-constraints.md` (the reference has 362w vs rule's 132w)
   - Delete: `skills/delegation/references/orchestrator-constraints.md`
   - Update: `skills/delegation/SKILL.md` — change any reference from skill reference to rule: "See `rules/orchestrator-constraints.md`"

2. Slim delegate command
   - Edit: `commands/delegate.md` — remove inline task extraction instructions that duplicate delegation skill
   - Replace with: redirect to skill via `@skills/delegation/SKILL.md`
   - Target: Under 500 words (from 1,399)

3. Validate
   - Word count check: `wc -w commands/delegate.md rules/orchestrator-constraints.md`
   - Verify no broken skill references

**Verification:**
- [ ] Single source of truth for orchestrator constraints (in rule)
- [ ] No duplicate reference file
- [ ] Delegate command under 500 words
- [ ] All references updated

**Dependencies:** Task 004 (delegation skill changes should happen first)
**Parallelizable:** Yes (Group B, sequential after Task 004)

---

## Parallelization Strategy

### Group A: MCP Server (1 worktree)
Task 001 → Task 002 → Task 003
- All in `plugins/exarchos/servers/exarchos-mcp/src/`
- Sequential within group (share test infrastructure)
- Branch: `refactor/optimize-mcp-patterns`

### Group B: Content Layer (1 worktree)
Task 004 → Task 005 → Task 006
- All in `skills/`, `rules/`, `commands/`
- Task 006 depends on Task 004 (delegation skill changes)
- Branch: `refactor/optimize-content-tokens`

**Groups A and B can run in parallel** — they do not share any source files.

## Deferred Items

| Item | Rationale |
|------|-----------|
| Remote sync wiring | PostgreSQL/Marten not ready; sync handler implemented as plumbing-only |
| View compact parameter | Low priority; agents already use field projection where available |
| Debug skill token reduction | At 1,811w, approaching but not exceeding threshold; monitor |
| O(n) event query optimization | Materializer high-water marks mitigate; cursor pagination is future work |
| C# coding standards deduplication | Separate concern from this refactor; track separately |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage maintained
- [ ] No skill body exceeds 1,500 words (post-restructuring targets)
- [ ] MCP tool guidance rule under 300 words
- [ ] Delegate command under 500 words
- [ ] Orchestrator constraints single source of truth
- [ ] Ready for review

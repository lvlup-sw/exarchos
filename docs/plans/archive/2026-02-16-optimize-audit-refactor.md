# Implementation Plan: Optimization Audit Refactor

**Source:** `docs/prompts/optimize.md` audit findings
**Workflow:** `refactor-optimize-audit` (overhaul track)
**Date:** 2026-02-16

---

## Task Overview

| Task | Workstream | Track | Parallelizable | Files |
|------|-----------|-------|----------------|-------|
| T1 | WS1 | TDD | No (foundation) | `state-store.ts`, `state-store.test.ts` |
| T2 | WS1 | TDD | After T1 | `tools.ts`, `tools.test.ts` |
| T3 | WS1 | TDD | After T2 | `tools.ts`, `tools.test.ts` |
| T4 | WS1 | TDD | After T2 | `tools.ts`, `integration.test.ts` |
| T5 | WS2 | TDD | Yes (with T6, T7) | `coordinator.ts`, `coordinator.test.ts` |
| T6 | WS2 | TDD | Yes (with T5, T7) | `store.ts`, `store.test.ts` |
| T7 | WS2 | Code | Yes (with T5, T6) | `tools.ts` |
| T8 | WS3 | Content | Yes (with T9, T10) | `rules/*.md` |
| T9 | WS3 | Content | Yes (with T8, T10) | `skills/{debug,synthesis,delegation}/SKILL.md` |
| T10 | WS4 | Content | Yes (with T8, T9) | `skills/{spec-review,brainstorming,...}/SKILL.md` |
| T11 | WS5 | Content | After T1-T4 | `docs/adrs/distributed-sdlc-pipeline.md` |

### Dependency Graph

```
T1 ──→ T2 ──→ T3
         └──→ T4
T5 ──────────────→ (independent)
T6 ──────────────→ (independent)
T7 ──────────────→ (independent, but touches tools.ts — do after T3)
T8 ──────────────→ (independent, content-only)
T9 ──────────────→ (independent, content-only)
T10 ─────────────→ (independent, content-only)
T11 ─────────────→ (after T1-T4, needs event-first to be merged)
```

**Delegation strategy:**
- T1-T4: Sequential in one worktree (all modify `workflow/tools.ts` and `workflow/state-store.ts`)
- T5, T6: Parallel in separate worktrees (independent modules)
- T7: After T3 merges (shares `tools.ts`)
- T8, T9, T10: Parallel, content-only (orchestrator can do directly)
- T11: After WS1 merges

---

## WS1: Event-First Architectural Inversion

### T1: Add reconcileFromEvents to state-store

**Goal:** Enable state file reconstruction from event stream. This is the foundation that makes event-first safe — if state file update fails after event append, state can be rebuilt.

**Files:**
- `plugins/exarchos/servers/exarchos-mcp/src/workflow/state-store.ts`
- `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/state-store.test.ts`

#### RED

Write tests that describe the reconciliation behavior:

```typescript
describe('reconcileFromEvents', () => {
  it('should rebuild state from workflow.started event when no state file exists', async () => {
    // Arrange: append workflow.started event, no state file
    // Act: reconcileFromEvents(stateDir, featureId, eventStore)
    // Assert: state file exists with correct featureId, workflowType, phase
  });

  it('should replay workflow.transition events to reach correct phase', async () => {
    // Arrange: state file at phase "ideate", events show transition to "plan"
    // Act: reconcileFromEvents(stateDir, featureId, eventStore)
    // Assert: state file phase is "plan"
  });

  it('should apply field updates from workflow.transition event metadata', async () => {
    // Arrange: transition event with metadata containing field updates
    // Act: reconcileFromEvents
    // Assert: state file reflects metadata updates
  });

  it('should be idempotent — running twice produces same state', async () => {
    // Arrange: state + events in sync
    // Act: reconcile twice
    // Assert: state unchanged, version not double-incremented
  });

  it('should detect stale state via high-water-mark comparison', async () => {
    // Arrange: state file _eventSequence = 3, event store has 5 events
    // Act: reconcileFromEvents
    // Assert: state updated, _eventSequence = 5
  });
});
```

#### GREEN

Implement `reconcileFromEvents()` in `state-store.ts`:

1. Add `_eventSequence: number` field to state file schema (tracks last applied event sequence)
2. Read current state file (or create from `workflow.started` event if missing)
3. Query events from event store with `sinceSequence: state._eventSequence`
4. For each `workflow.transition` event: validate HSM transition, update phase
5. For each `workflow.checkpoint` event: update checkpoint metadata
6. Write updated state file with new `_eventSequence`
7. Return `{ reconciled: boolean, eventsApplied: number }`

**Signature:**
```typescript
export async function reconcileFromEvents(
  stateDir: string,
  featureId: string,
  eventStore: EventStore,
): Promise<{ reconciled: boolean; eventsApplied: number }>
```

#### REFACTOR

- Extract event-to-state-mutation logic into a pure `applyEventToState(state, event)` function for reuse
- Ensure `_eventSequence` is added to `WorkflowStateSchema` as optional (backward-compatible)
- Add `_eventSequence` to the `INTERNAL_FIELDS` strip list in `tools.ts`

---

### T2: Invert handleInit to event-first

**Goal:** Make `handleInit` append `workflow.started` event FIRST, then create state file. If state file creation fails after event append, reconciliation (T1) can recover.

**Files:**
- `plugins/exarchos/servers/exarchos-mcp/src/workflow/tools.ts`
- `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts`

#### RED

```typescript
describe('handleInit_EventFirst', () => {
  it('should append workflow.started event before creating state file', async () => {
    // Arrange: configure event store
    // Act: handleInit
    // Assert: event store has workflow.started event
    // Assert: state file exists
    // Assert: event sequence = 1, state._eventSequence = 1
  });

  it('should fail and NOT create state file if event append fails', async () => {
    // Arrange: event store that throws on append
    // Act: handleInit
    // Assert: returns error
    // Assert: NO state file created
  });

  it('should set _eventSequence on initial state', async () => {
    // Arrange: configure event store
    // Act: handleInit
    // Assert: state file has _eventSequence = 1
  });

  it('should work without event store (local-only mode)', async () => {
    // Arrange: no event store configured
    // Act: handleInit
    // Assert: state file created with _eventSequence = 0
    // Assert: success (graceful degradation)
  });
});
```

#### GREEN

Reorder `handleInit` (currently lines 72-115):

```
BEFORE: initStateFile → appendEvent (catch silently)
AFTER:  appendEvent → initStateFile (set _eventSequence from event.sequence)
```

1. If `moduleEventStore` is configured: append `workflow.started` event FIRST
2. If append fails: return error (hard fail, matching `handleCheckpoint` pattern)
3. If append succeeds: create state file with `_eventSequence` set to event sequence
4. If no `moduleEventStore`: create state file with `_eventSequence = 0` (graceful degradation)

#### REFACTOR

- Remove the silent `catch` block (lines 89-91) — event failure is now a hard error
- Add JSDoc documenting the event-first contract

---

### T3: Invert handleSet to event-first

**Goal:** Make `handleSet` append transition events FIRST (when phase changes), then write state file as a projection. This is the most complex change — must preserve CAS retry semantics with idempotency keys.

**Files:**
- `plugins/exarchos/servers/exarchos-mcp/src/workflow/tools.ts`
- `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts`

#### RED

```typescript
describe('handleSet_EventFirst', () => {
  it('should append transition event before writing state file', async () => {
    // Arrange: init feature, configure event store
    // Act: handleSet with phase transition
    // Assert: event store has workflow.transition event
    // Assert: state file updated with new phase
    // Assert: state._eventSequence matches event sequence
  });

  it('should fail and NOT update state if event append fails', async () => {
    // Arrange: event store that throws on append
    // Act: handleSet with phase transition
    // Assert: returns error with eventWarning or error code
    // Assert: state file UNCHANGED (still at old phase)
  });

  it('should use idempotency key to prevent duplicate events on CAS retry', async () => {
    // Arrange: init feature, configure event store
    // Simulate CAS conflict + retry
    // Act: handleSet triggers CAS retry
    // Assert: event store has exactly 1 transition event (not 2)
  });

  it('should update _eventSequence on state file after successful write', async () => {
    // Arrange: init feature with _eventSequence=1
    // Act: handleSet with phase transition
    // Assert: state._eventSequence incremented to new event sequence
  });

  it('should handle field-only updates (no phase) without event emission', async () => {
    // Arrange: init feature
    // Act: handleSet with updates only, no phase
    // Assert: state file updated, no new events (field updates don't emit)
    // Assert: _eventSequence unchanged
  });

  it('should support reconciliation after state write failure', async () => {
    // Arrange: event appended, but state write deliberately fails
    // Act: reconcileFromEvents
    // Assert: state rebuilt to correct phase from events
  });
});
```

#### GREEN

Restructure `handleSet` CAS retry loop:

```
BEFORE:
  for retry:
    read state → mutate → CAS write state → append events (catch silently)

AFTER:
  for retry:
    read state → mutate → generate idempotency key → append events (hard fail)
    → CAS write state with _eventSequence
    → on CAS conflict: retry (idempotency key prevents duplicate events)
```

Key implementation details:

1. Generate idempotency key per transition: `${featureId}:${from}:${to}:${expectedVersion}`
2. Append transition events with idempotency key BEFORE CAS write
3. If event append fails: return error, do NOT update state
4. CAS write state file — include `_eventSequence` from appended event
5. If CAS write fails (version conflict): retry loop re-reads state, re-appends with same idempotency key (deduplicated by event store)
6. If CAS retries exhausted: events exist but state is stale → reconciliation can recover

#### REFACTOR

- Remove the `eventWarning` return pattern (lines 351-376) — events are no longer best-effort
- Update the comment block at line 347-350 to document event-first contract
- Ensure `handleCheckpoint` (already event-first) follows the same idempotency key pattern

---

### T4: Integration test — full event-first lifecycle

**Goal:** End-to-end test proving events are sufficient to rebuild state and the event-first pattern works across the full workflow lifecycle.

**Files:**
- `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/integration.test.ts`

#### RED

```typescript
describe('EventFirst_FullLifecycle', () => {
  it('should rebuild state entirely from events after state file deletion', async () => {
    // Arrange: init feature, transition through ideate → plan → delegate
    // Act: delete state file, reconcileFromEvents
    // Assert: state file recreated at phase "delegate" with correct metadata
  });

  it('should detect and recover stale state after simulated crash', async () => {
    // Arrange: init feature, transition to plan
    //          manually append a transition event (plan→delegate) WITHOUT updating state
    // Act: reconcileFromEvents
    // Assert: state file updated to "delegate"
  });

  it('should handle concurrent event-first writes with idempotency', async () => {
    // Arrange: init feature with event store
    // Act: two concurrent handleSet calls with same phase transition
    // Assert: exactly one transition event in store (idempotency)
    // Assert: state file at correct phase
  });

  it('should maintain event-state consistency across init/set/checkpoint sequence', async () => {
    // Arrange: full workflow: init → set(phase) → checkpoint → set(phase)
    // Assert: event count matches expected transitions
    // Assert: state._eventSequence matches event store length
    // Assert: reconcile is idempotent (no changes needed)
  });
});
```

#### GREEN

Implement tests using existing test helpers from `integration.test.ts`. Add `reconcileFromEvents` calls to verify state-event consistency at each step.

#### REFACTOR

- Extract shared test fixtures (init-and-transition helpers) to reduce duplication with existing integration tests
- Verify no existing tests broke from the event-first changes

---

## WS2: Operational Hardening

### T5: TeamCoordinator auto-eviction

**Goal:** Add TTL-based eviction so stale teammates are automatically removed, preventing unbounded memory growth.

**Files:**
- `plugins/exarchos/servers/exarchos-mcp/src/team/coordinator.ts`
- `plugins/exarchos/servers/exarchos-mcp/src/__tests__/team/coordinator.test.ts`

#### RED

```typescript
describe('checkHealth_AutoEviction', () => {
  it('should evict teammates exceeding eviction threshold', async () => {
    // Arrange: spawn teammate, advance clock past 2x staleAfterMinutes
    // Act: checkHealth({ evictAfterMinutes: 60 })
    // Assert: teammate removed from map
  });

  it('should NOT evict teammates that are merely stale but under eviction threshold', async () => {
    // Arrange: spawn teammate, advance clock past staleAfterMinutes but under evictAfterMinutes
    // Act: checkHealth({ evictAfterMinutes: 120 })
    // Assert: teammate marked stale but NOT evicted
  });

  it('should emit shutdown event for evicted teammates', async () => {
    // Arrange: spawn teammate with streamId
    // Act: checkHealth with eviction
    // Assert: agent.message shutdown event in event store
  });
});
```

#### GREEN

Add optional `evictAfterMinutes` parameter to `checkHealth()`:

```typescript
checkHealth(options?: {
  staleAfterMinutes?: number;   // default 30
  evictAfterMinutes?: number;   // default undefined (no eviction)
  streamId?: string;            // for eviction event emission
}): TeammateInfo[]
```

If a teammate's `lastActivityAt` exceeds `evictAfterMinutes`, call `this.teammates.delete(name)` and optionally emit a shutdown event.

#### REFACTOR

- Update `getStatus()` to reflect evictions in the returned counts
- Add JSDoc documenting eviction behavior

---

### T6: Event store hardening

**Goal:** Address three event store findings: blank-line tolerance in fast-skip, .seq tmpFile cleanup, and idempotency cache documentation.

**Files:**
- `plugins/exarchos/servers/exarchos-mcp/src/event-store/store.ts`
- `plugins/exarchos/servers/exarchos-mcp/src/event-store/store.test.ts`

#### RED

```typescript
describe('query_BlankLineTolerance', () => {
  it('should correctly skip with sinceSequence when JSONL has blank lines', async () => {
    // Arrange: manually write JSONL with blank lines between events
    // Act: query with sinceSequence
    // Assert: returns correct events (not off-by-one)
  });
});

describe('initializeSequence_CleansTmpFiles', () => {
  it('should remove orphaned .seq.tmp files during initialization', async () => {
    // Arrange: create orphaned .seq.tmp file
    // Act: initializeSequence (via append)
    // Assert: .seq.tmp file removed
  });
});
```

#### GREEN

1. **Blank-line tolerance:** In `query()`, when `canFastSkip` is true, track a `sequenceCount` that only increments for non-blank lines (matching what we already do), but add a comment clarifying the invariant. Alternatively, disable fast-skip if the JSONL has been manually edited (detect via `.seq` mismatch).

2. **tmpFile cleanup:** In `initializeSequence()`, add a cleanup step:
   ```typescript
   const tmpPath = `${seqPath}.tmp`;
   await fs.rm(tmpPath, { force: true }).catch(() => {});
   ```

3. **Idempotency cache:** Add JSDoc on `MAX_IDEMPOTENCY_KEYS` explaining the limitation:
   > Keys older than 100 appends per stream are evicted. Retries with evicted keys will NOT be deduplicated. This is acceptable because retries are expected within the same session, not across long time spans.

#### REFACTOR

- Add single-instance assumption JSDoc on EventStore class:
  > This class uses in-memory promise-chain locks that only protect within a single Node.js process. Multiple EventStore instances sharing the same stateDir will corrupt data. The MCP server architecture ensures a single EventStore per stateDir via the singleton in views/tools.ts.

---

### T7: CAS error message improvement

**Goal:** Make the CAS retry exhaustion error message clearly indicate concurrent writes, not a generic limit.

**Files:**
- `plugins/exarchos/servers/exarchos-mcp/src/workflow/tools.ts`

#### Change

Line 383-386, change:
```typescript
`CAS retry limit exceeded for feature: ${input.featureId}`
```
To:
```typescript
`Concurrent write conflict: failed to acquire consistent version after ${MAX_CAS_RETRIES} retries for feature: ${input.featureId}`
```

**Note:** This task should be done AFTER T3 merges since both modify `tools.ts`. Can be folded into T3 if done by the same agent.

---

## WS3: Token Economy — Content Consolidation

### T8: Consolidate language-specific rules

**Goal:** Merge duplicated C#/TypeScript rules into single files with language sections. Saves ~920 words of context window.

**Files:**
- `rules/coding-standards-csharp.md` → merge into `rules/coding-standards-typescript.md` → rename to `rules/coding-standards.md`
- `rules/tdd-csharp.md` → merge into `rules/tdd-typescript.md` → rename to `rules/tdd.md`

#### Steps

1. Read both coding-standards files, identify unique C# content
2. Create `rules/coding-standards.md` with shared structure:
   - Frontmatter `paths` scoped to `**/*.ts,**/*.tsx,**/*.cs`
   - Common sections (SOLID, error handling, DRY) unified
   - Language-specific sections clearly marked with `### TypeScript` / `### C#` headers
3. Delete `rules/coding-standards-csharp.md` and `rules/coding-standards-typescript.md`
4. Same pattern for TDD rules: create `rules/tdd.md`, delete language-specific files
5. Update `src/install.ts` if it references specific rule filenames (verify via grep)
6. Update `.claude/rules/` symlinks via `npm run build`

---

### T9: Extract large skill content to references/

**Goal:** Reduce the 3 largest SKILL.md files by extracting non-core content to `references/` subdirectories.

**Files:**
- `skills/debug/SKILL.md` (1,894w → target ~900w)
- `skills/synthesis/SKILL.md` (1,490w → target ~800w)
- `skills/delegation/SKILL.md` (1,379w → target ~800w)

#### Steps

**debug/SKILL.md:**
1. Extract hotfix track details → `skills/debug/references/hotfix-track.md`
2. Extract thorough track details → `skills/debug/references/thorough-track.md`
3. Keep in SKILL.md: overview, triggers, track selection criteria, state management, auto-chain
4. Add links: "For detailed hotfix track instructions, see `references/hotfix-track.md`"

**synthesis/SKILL.md:**
1. Extract CodeRabbit integration details → `skills/synthesis/references/coderabbit-integration.md`
2. Extract anti-patterns and troubleshooting → `skills/synthesis/references/troubleshooting.md`
3. Keep in SKILL.md: overview, triggers, 5-step process summary, state management, auto-chain

**delegation/SKILL.md:**
1. Extract state management schema → `skills/delegation/references/state-schema.md`
2. Extract anti-patterns → `skills/delegation/references/anti-patterns.md`
3. Keep in SKILL.md: overview, triggers, dispatch algorithm, fix mode summary, auto-chain

---

## WS4: Workflow Trigger & Boundary Clarity

### T10: Fix skill descriptions and pre-condition guards

**Goal:** Address all 8 trigger/boundary findings. Each is a targeted edit to a SKILL.md or command file.

#### Steps

**Finding 18-19: spec-review dual identity (CRITICAL)**
- File: `skills/spec-review/SKILL.md`
- Change description (line 3) from:
  > "Design-to-plan delta analysis for implementation coverage verification. Use during the plan-review phase..."
- To:
  > "Implementation-to-spec compliance verification (code review stage 1). Use during the review phase after delegation completes to compare implemented code against design specification. Checks functional completeness, TDD compliance, and test coverage. Do NOT use for code quality review (use quality-review) or debugging."
- Change `phase-affinity` from `plan-review` to `review`

**Finding 20: /ideate vs /plan pre-condition gap (CRITICAL)**
- File: `skills/brainstorming/SKILL.md`
  - Add to description: "Use when no design document exists yet for the target feature."
  - Add negative: "Do NOT use if a design document already exists — use /plan instead."
- File: `skills/implementation-planning/SKILL.md`
  - Add to description: "Requires an existing design document as input."
  - Add negative: "Do NOT use if no design document exists — use /ideate first."

**Finding 21: Plan-review deterministic gate (HIGH)**
- File: `skills/implementation-planning/SKILL.md`
  - In the plan-review transition section, add:
    > "REQUIRED: Run `scripts/verify-plan-coverage.sh --design-file <design> --plan-file <plan>`. If exit code 1: auto-invoke `Skill({ skill: "plan", args: "--revise <design>" })`. If exit code 0: proceed to delegation."

**Finding 22: Delegate --fixes format (HIGH)**
- File: `skills/delegation/SKILL.md`
  - In the fix mode section, add:
    > "Arguments: `--fixes <state-file-path>` where `<state-file-path>` is the workflow state JSON containing review results in `.reviews.<taskId>.specReview` or `.reviews.<taskId>.qualityReview`."

**Finding 23: Debug escalation threshold (MEDIUM)**
- File: `skills/debug/SKILL.md`
  - Add to description: "Do NOT escalate to /ideate unless the fix requires architectural redesign — implementation complexity alone is not sufficient reason to escalate."

**Finding 24: Refactor scope thresholds (MEDIUM)**
- File: `skills/refactor/SKILL.md`
  - In explore phase, add: "Scope thresholds: if >5 files affected OR changes cross module boundaries → recommend overhaul track."

**Finding 25: Synthesize prerequisites (MEDIUM)**
- File: `skills/synthesis/SKILL.md`
  - In prerequisites section, add: "Requires BOTH spec-review PASS AND quality-review APPROVED. If either review is incomplete or failed, do NOT proceed — return to /review."

---

## WS5: ADR Documentation

### T11: Update ADR for event-first architecture

**Goal:** After WS1 merges, update the ADR to accurately describe the implemented architecture.

**Files:**
- `docs/adrs/distributed-sdlc-pipeline.md`

#### Steps

1. Update File Storage Conventions section (~line 1878) to document event-first contract:
   > Events in `.events.jsonl` are the source of truth. The `.state.json` file is a materialized view (projection) of the event stream, updated after successful event append. State can be rebuilt from events via `reconcileFromEvents()`.

2. Add a subsection documenting the event-state consistency model:
   > **Consistency Model:** Event append is the commit point. State file update is a projection that follows. If state lags events (e.g., crash between event append and state write), `reconcileFromEvents()` replays missing events to catch up. The `_eventSequence` field in state files tracks the last applied event sequence.

3. Update reference at line 2123 to note alignment:
   > "CQRS + Event Sourcing: Microsoft. CQRS Pattern — append-only event store as write model, materialized views as read model. **Implemented:** Event append is the commit point; state files are materialized views."

4. Document known limitations:
   - Outbox atomicity gap: event and outbox entry are not written atomically (documented limitation pending remote sync)
   - Event metadata: `correlationId`, `causationId`, `agentId` are optional; distributed tracing spans planned for remote sync phase
   - Single-instance assumption: EventStore uses in-memory locks; multi-process requires external coordination

---

## Execution Order

### Phase 1: Event-First (WS1) — Delegated, sequential
1. T1: reconcileFromEvents (foundation)
2. T2: Invert handleInit
3. T3: Invert handleSet + idempotency keys
4. T4: Integration tests

### Phase 2: Hardening + Content (WS2, WS3, WS4) — Parallel
5. T5: TeamCoordinator auto-eviction (delegated)
6. T6: Event store hardening (delegated)
7. T7: CAS error message (fold into T3 or after merge)
8. T8: Consolidate rules (orchestrator)
9. T9: Extract skill content (orchestrator)
10. T10: Fix skill descriptions (orchestrator)

### Phase 3: Documentation (WS5) — After WS1 merges
11. T11: Update ADR

---

## Verification

After all tasks complete:

```bash
# MCP server tests
cd plugins/exarchos/servers/exarchos-mcp && npm run test:run

# Type check
npm run typecheck

# Verify no broken skill references
for f in scripts/validate-*-skill.test.sh scripts/validate-misc-skills.test.sh; do
  bash "$f"
done
```

### Success Criteria Checklist

- [ ] `handleInit`, `handleSet`, `handleCheckpoint` all follow event-first ordering
- [ ] `reconcileFromEvents()` can rebuild state from events alone
- [ ] State files include `_eventSequence` tracking last applied event
- [ ] Idempotency keys prevent duplicate events on CAS retry
- [ ] All existing tests pass (no regressions)
- [ ] New tests cover event-first behavior and reconciliation
- [ ] TeamCoordinator auto-evicts stale teammates
- [ ] C#/TS rules consolidated into single files
- [ ] debug/synthesis/delegation SKILL.md bodies reduced by ~40%
- [ ] spec-review description matches actual usage (code review stage 1)
- [ ] All skill descriptions have correct pre-condition guards
- [ ] ADR accurately describes event-first architecture

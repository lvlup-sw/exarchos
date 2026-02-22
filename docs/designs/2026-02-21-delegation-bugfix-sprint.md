# Design: Delegation Bug Fix Sprint

## Problem Statement

Six bugs (#735, #738, #739, #740, #741, #713) expose a systemic failure: the delegation skill is a Pattern 2 Multi-MCP coordination skill that doesn't reliably instruct the orchestrator to use exarchos tools alongside Claude Code tools. The agent-teams-saga reference documents the correct behavior, but the orchestrator doesn't follow it consistently. Meanwhile, the MCP server's error messages don't help the agent self-correct.

Root causes per Anthropic's "Instructions not followed" troubleshooting (PDF p.26):
- **Instructions buried** — critical exarchos tool calls live in Level 3 reference, not Level 2 body
- **Ambiguous language** — event types not surfaced where needed
- **No error recovery** — guard failures don't suggest fixes; no compaction recovery protocol
- **No safety net** — server doesn't help when agent misses steps

## Chosen Approach

**Option 3: Structured Checklists + Server Hints** — Two-layer fix that respects the skill token budget while adding server-side self-correction.

**Content layer:** Restructure delegation SKILL.md with a compact "Event Emission Checklist" table and a "Common Errors" troubleshooting section. Move verbose saga explanation to references but surface the essential contract in Level 2.

**Server layer:** Improve guard error responses to include `expectedShape` and `suggestedFix` fields. Add a `reconcile` action to `exarchos_workflow` for compaction recovery. Keep event emission explicit (no auto-emit).

## Technical Design

### Work Package 1: Guard Error Improvement (#735)

**Location:** `servers/exarchos-mcp/src/workflow/guards.ts`

Every guard failure currently returns a string message. Change to return a structured object:

```typescript
interface GuardFailure {
  guardId: string;
  message: string;                    // Human-readable
  expectedShape?: Record<string, unknown>;  // What the state field should look like
  suggestedFix?: {                    // Exact tool call to fix the issue
    tool: string;
    params: Record<string, unknown>;
  };
  validTargets?: string[];            // For phase transition errors
}
```

**Specific guard improvements:**

| Guard | Current Error | New Error (adds) |
|-------|--------------|------------------|
| `all-tasks-complete` | `N task(s) incomplete` | + `expectedShape: { tasks: [{ id, status: "complete" }] }` + `suggestedFix: { tool: "exarchos_workflow", params: { action: "set", updates: { tasks: [...] } } }` with incomplete task IDs listed |
| `all-reviews-passed` | `has no recognizable review entries` | + `expectedShape: { reviews: { "<name>": { status: "pass" } } }` |
| `design-artifact-exists` | `not satisfied` | + `expectedShape: { artifacts: { design: "docs/designs/<file>.md" } }` + `suggestedFix` with set action |
| `plan-artifact-exists` | `not satisfied` | + `expectedShape: { artifacts: { plan: "docs/designs/<file>-plan.md" } }` |

**Phase transition errors** already include `validTargets` — keep these, and add the workflow type's full phase graph as a `phaseGraph` field so the agent can see the complete picture.

**Implementation:** Modify the `GuardResult` type and each guard function in `guards.ts`. Update the workflow tool handler to serialize the structured failure into the MCP tool response. Add tests for each guard's new error shape.

### Work Package 2: Event Emission Checklist in SKILL.md (#741, #740)

**Location:** `skills/delegation/SKILL.md`

Add a compact table directly in the SKILL.md body (Level 2) — ~150 words, well within budget:

```markdown
## Event Emission Contract (Agent Teams)

| Saga Step | Exarchos Call | Event Type | Required Data |
|-----------|-------------|-----------|---------------|
| 1. Create team | `exarchos_event append` | `team.spawned` | teamName, teamSize, taskCount |
| 2. Create tasks | `exarchos_event batch_append` | `team.task.planned` (per task) | taskId, title, modules |
| 3. Spawn agents | `exarchos_event append` (per agent) | `team.teammate.dispatched` | teammateName, worktreePath, assignedTaskIds |
| 4. Monitor | `exarchos_workflow set` | (state update) | tasks[N].status, completedAt |
| 5. Disband | `exarchos_event append` | `team.disbanded` | totalDurationMs, tasksCompleted, tasksFailed |
| 6. Transition | `exarchos_workflow set` (phase: review) | `workflow.transition` (auto) | — |

CRITICAL: Steps 1-3 MUST emit events BEFORE executing the Claude Code side effect.
For full payload shapes: `references/agent-teams-saga.md`
```

This surfaces the essential contract at Level 2 while keeping the detailed saga explanation at Level 3. The table format is scannable and hard to skip.

### Work Package 3: Workflow State Sync Instructions (#739)

**Location:** `skills/delegation/SKILL.md` + `skills/delegation/references/state-management.md`

Add to the SKILL.md body, immediately after the Event Emission Contract table:

```markdown
## State Synchronization

Claude Code TaskList and exarchos workflow state are INDEPENDENT systems.
After each task completion:
1. `TaskUpdate` (Claude Code) — marks native task complete
2. `exarchos_workflow set` — updates `tasks[N].status: "complete"` in workflow state

Before transitioning to review phase, ALL workflow state tasks must show `status: "complete"`.
The `all-tasks-complete` guard checks exarchos workflow state, NOT Claude Code TaskList.
```

This directly addresses the "two parallel task tracking systems" confusion documented in #739.

### Work Package 4: Compaction Recovery Protocol (#738)

**Location:** `skills/delegation/SKILL.md` + `servers/exarchos-mcp/src/workflow/tools.ts`

**Content side** — Add to SKILL.md body:

```markdown
## Context Compaction Recovery

If context compaction occurs during delegation:
1. Read team config: `~/.claude/teams/{featureId}/config.json` → discover active teammates
2. Query workflow state: `exarchos_workflow get` (featureId, fields: [tasks, phase]) → check task progress
3. Check teammate inboxes: `SendMessage` to each teammate → ask for status
4. Reconcile: `exarchos_workflow set` with actual task statuses from event stream

Do NOT re-create branches or re-dispatch agents until you have confirmed they are lost.
```

**Server side** — Add a `reconcile` action to `exarchos_workflow`:

```typescript
// New action: reconcile
// Reads event stream, materializes current task state, patches workflow state
// Returns: { reconciledTasks: [...], eventsReplayed: N, statePatched: boolean }
```

The `reconcile` action replays the event stream for a given `featureId`, extracts task completion events (`team.task.completed`, `team.task.failed`), and patches the workflow state's `tasks` array to match. This provides a one-call recovery from stale state — whether from compaction, agent mistakes, or hook failures.

### Work Package 5: Troubleshooting Section (#735 content side)

**Location:** `skills/delegation/references/troubleshooting.md`

Update the existing troubleshooting reference with Cause/Solution pairs for each bug:

```markdown
## Common Errors

### Error: `all-tasks-complete not satisfied: N task(s) incomplete`
**Cause:** Claude Code TaskList updated but exarchos workflow state not synced.
**Solution:** Call `exarchos_workflow set` with updated task statuses before transitioning.

### Error: `Expected object, received array` on reviews field
**Cause:** `reviews` must be a keyed object, not an array.
**Solution:** Use `{ "spec-review": { "status": "pass" }, "quality-review": { "status": "pass" } }`

### Error: `No transition from 'explore' to 'plan'`
**Cause:** Refactor workflows use different phase names than feature workflows.
**Solution:** Use `overhaul-plan` (overhaul track) or `polish-implement` (polish track). Check `validTargets` in error response.

### Error: `invalid_enum_value` on event type
**Cause:** Invalid event type string. See Event Emission Contract table in SKILL.md.
**Solution:** Use exact type strings from the contract table. Full list in saga reference.
```

### Work Package 6: Orphan Event Schema Wiring (#713 P1-P2)

**Location:** `servers/exarchos-mcp/src/`

**P1 — `QualityHintGeneratedData`:** Wire `hints.ts` `generateHints()` to emit `quality.hint.generated` after computing hints. Low effort — the schema exists, the function exists, just add the event append call.

**P2 — `ReviewFindingData` + `ReviewEscalatedData`:** Wire review triage handler to emit `review.finding` per actionable comment and `review.escalated` when routing to human review.

## Integration Points

| Component | Changes | Connects To |
|-----------|---------|-------------|
| `guards.ts` | Structured error objects | Workflow tool handler serializes to MCP response |
| `tools.ts` | New `reconcile` action | Reads event store, patches workflow state |
| `SKILL.md` | Event contract table, state sync, compaction recovery | References saga for full details |
| `troubleshooting.md` | Cause/Solution error catalog | Cross-referenced from SKILL.md |
| `hints.ts` | Event emission | Event store append |
| `review/tools.ts` | Event emission | Event store append |

## Testing Strategy

### MCP Server (TDD)

**Guard error tests** (`guards.test.ts`):
- Each guard returns structured `GuardFailure` with `expectedShape`
- `all-tasks-complete` includes incomplete task IDs in `suggestedFix`
- `all-reviews-passed` includes expected object shape
- Phase transition errors include `phaseGraph`

**Reconcile action tests** (`tools.test.ts`):
- Reconciles stale task state from event stream
- Handles empty event stream gracefully
- Patches only changed tasks (idempotent)
- Returns accurate reconciliation summary

**Event wiring tests**:
- `hints.ts` emits `quality.hint.generated` with correct payload
- Review triage emits `review.finding` per actionable comment
- Review triage emits `review.escalated` on high-risk routing

### Content Validation

- SKILL.md word count stays under 1,300 words after additions
- Event contract table matches event type enum in `schemas.ts`
- Troubleshooting Cause/Solution pairs match actual error messages
- Compaction recovery steps reference correct file paths

## Implementation Phases

| Phase | Issues | Type | Parallelizable |
|-------|--------|------|---------------|
| **1** | #735 (guard errors) | Server (TypeScript + tests) | Foundation — do first |
| **2a** | #741, #740 (event checklist) | Content (SKILL.md) | Yes, parallel with 2b |
| **2b** | #739 (state sync) | Content (SKILL.md) | Yes, parallel with 2a |
| **2c** | #738 server (reconcile action) | Server (TypeScript + tests) | Yes, after Phase 1 |
| **2d** | #738 content (compaction recovery) | Content (SKILL.md) | Yes, parallel with 2a-c |
| **2e** | Troubleshooting update | Content (references) | Yes, parallel with 2a-d |
| **3** | #713 P1 (hints event) | Server (TypeScript + tests) | Yes, after Phase 1 |
| **4** | #713 P2 (review events) | Server (TypeScript + tests) | Yes, after Phase 1 |

Phases 2a-2e can all run in parallel. Phase 1 is the foundation. Phases 3-4 are independent quick wins.

## Open Questions

1. **Skill budget accounting** — Need to verify the SKILL.md additions (event table + state sync + compaction recovery) fit within 1,300 words. May need to trim existing body content to make room.
2. **Reconcile action scope** — Should `reconcile` also check team config and teammate status, or just event stream → task state?
3. **Guard error backward compatibility** — Existing consumers may parse guard error strings. Should `suggestedFix` be opt-in (via a `verbose` flag) or always returned?

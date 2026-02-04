# Design: Workflow State MCP Server

## Problem Statement

The lvlup-claude SDLC workflow manages persistent state across context compactions via `~/.claude/scripts/workflow-state.sh`, a ~920-line bash script invoked through `Bash()` tool calls. Every state operation — init, get, set, summary, reconcile, next-action — produces a full tool invocation block (command string + stdout + stderr), consuming context tokens that could be spent on actual work. The bash script also depends on `jq` for JSON manipulation, provides untyped string-based error messages, and cannot validate inputs or enforce workflow rules at the tool level.

Additionally, context checkpointing during long workflows is entirely manual. The orchestrator must notice context pressure, interrupt the current phase, and invoke `/checkpoint`. This leads to either premature checkpoints (wasting progress) or late checkpoints (risking context loss mid-operation).

The workflows are long-running, multi-step sagas (ideate → plan → delegate → integrate → review → synthesize) where each step produces side effects (worktrees, branches, PRs). Failure at any step requires either compensation (undo side effects) or retry (fix cycle). Neither failure mode is currently enforced or bounded.

## Chosen Approach

**Pure TypeScript MCP server with hierarchical state machine, event logging, saga compensation, circuit breakers, and intelligent checkpointing.**

A self-contained npm package (`@lvlup-sw/workflow-state-mcp`) exposing workflow state operations as MCP tools, with:

- **Zod-validated inputs** — type safety at the tool boundary
- **Hierarchical state machine (HSM)** — prevents invalid phase transitions as the single source of truth
- **Lightweight event log** — append-only audit trail with sequence ordering
- **Saga compensation** — formal workflow cancellation with per-phase cleanup
- **Circuit breakers** — bounds fix cycles to prevent infinite autonomous loops
- **Three-tier checkpointing** — automatic at phase boundaries, advisory within phases
- **Idempotency guarantees** — safe to re-invoke after context compaction
- **Schema validation and migration** — graceful handling of state file evolution

Installable via `npx -y @lvlup-sw/workflow-state-mcp` or as a Claude Code plugin.

**Rationale:** For a batteries-included SDLC workflow where autonomous phase chaining runs unattended across context compactions, four failure modes dominate:

1. **Invalid state transitions** — silent workflow corruption (addressed by HSM)
2. **Context exhaustion** — lost work mid-operation (addressed by checkpointing)
3. **Infinite fix cycles** — unbounded autonomous loops (addressed by circuit breakers)
4. **Abandoned workflows** — orphaned side effects (addressed by compensation)

The TypeScript rewrite eliminates the `jq` dependency and enables proper type validation. The architectural patterns are drawn from Microsoft's [Cloud Design Patterns](https://learn.microsoft.com/en-us/azure/architecture/patterns/), specifically the Saga, Compensating Transaction, Circuit Breaker, and Event Sourcing patterns adapted for local state management.

## Technical Design

### Package Structure

```
plugins/workflow-state/
├── .claude-plugin/
│   └── plugin.json
├── mcp-servers.json
├── servers/workflow-state-mcp/
│   ├── package.json            # @lvlup-sw/workflow-state-mcp
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts            # MCP server entry point
│   │   ├── tools.ts            # Tool definitions and handlers
│   │   ├── state-machine.ts    # HSM: states, transitions, guards, effects
│   │   ├── state-store.ts      # File I/O: atomic writes, validation, migration
│   │   ├── compensation.ts     # Saga compensation: per-phase cleanup actions
│   │   ├── circuit-breaker.ts  # Fix-cycle bounding logic
│   │   ├── checkpoint.ts       # Checkpoint tracking and advisory logic
│   │   ├── events.ts           # Event log: append, query, cap enforcement
│   │   ├── migration.ts        # State file version migration
│   │   ├── schemas.ts          # Zod schemas for all inputs/outputs/state
│   │   └── types.ts            # TypeScript types (derived from Zod)
│   └── src/__tests__/
│       ├── state-machine.test.ts
│       ├── state-store.test.ts
│       ├── compensation.test.ts
│       ├── circuit-breaker.test.ts
│       ├── checkpoint.test.ts
│       ├── events.test.ts
│       ├── migration.test.ts
│       ├── idempotency.test.ts
│       ├── tools.test.ts
│       └── schemas.test.ts
└── README.md
```

---

### MCP Tools (10 tools)

#### `workflow_state_init`

Create a new workflow state file.

**Idempotency:** Not idempotent (intentional). Returns `STATE_ALREADY_EXISTS` if state file exists. This is correct — callers should check `list` first. The error response includes the existing state's phase, enabling the caller to decide whether to resume or create anew.

```typescript
// Input
z.object({
  featureId: z.string().min(1).regex(/^[a-z0-9-]+$/),
  workflowType: z.enum(["feature", "debug", "refactor"]).default("feature"),
})

// Success response
{
  stateFile: string,
  featureId: string,
  phase: string,
  workflowType: string,
  _meta: CheckpointMeta,
}

// Error response
{ error: "STATE_ALREADY_EXISTS", featureId: string, currentPhase: string }
```

#### `workflow_state_list`

List all active (non-completed, non-cancelled) workflows. Includes staleness detection.

**Idempotency:** Yes (read-only, no side effects).

```typescript
// Input: none

// Response
{
  workflows: Array<{
    featureId: string,
    phase: string,
    workflowType: string,
    updatedAt: string,
    stale: boolean,              // True if no activity for staleAfterMinutes
    minutesSinceActivity: number,
  }>
}
```

#### `workflow_state_get`

Read state or a specific field via dot-path query. The `_events` and `_checkpoint` fields are readable via get (but not writable via set).

**Idempotency:** Yes (read-only). Increments operation counter for checkpoint advisory.

```typescript
z.object({
  featureId: z.string(),
  query: z.string().optional(), // Dot-path: "artifacts.design", "tasks[0].status", "_events"
})

// Response
{
  value: unknown,
  _meta: CheckpointMeta,
}
```

#### `workflow_state_set`

Update state fields. Accepts structured dot-path updates. When a `phase` field is included, validates the transition against the HSM — checking that the transition is defined, all guard conditions are met, and the circuit breaker allows it.

**Idempotency:** Yes. If current phase already equals the requested phase (e.g., after a compaction where the response was lost), returns success without re-executing transition effects or appending duplicate events. Field updates are applied with last-write-wins semantics — applying the same update twice produces the same result.

```typescript
z.object({
  featureId: z.string(),
  updates: z.record(z.string(), z.unknown()).optional(), // Dot-path keys → values
  phase: z.string().optional(), // If provided, validates transition via HSM
})

// Success response
{
  updated: true,
  stateFile: string,
  phase: string,
  effects: string[],           // Effects triggered by transition (e.g., ["checkpoint", "log"])
  event: StateEvent | null,    // The event logged (null if idempotent no-op)
  idempotent: boolean,         // True if phase was already at target (no-op)
  _meta: CheckpointMeta,
}

// Error responses
{ error: "INVALID_TRANSITION", from: string, to: string, validTargets: string[] }
{ error: "GUARD_FAILED", from: string, to: string, guard: string, unmetCondition: string }
{ error: "CIRCUIT_OPEN", from: string, to: string, fixCycleCount: number, maxFixCycles: number }
```

#### `workflow_state_summary`

Produce a minimal context-restoration summary. Returns structured data. Includes checkpoint status, staleness, recent events, and circuit breaker state.

**Idempotency:** Yes (read-only). Increments operation counter.

```typescript
z.object({
  featureId: z.string(),
})

// Response
{
  featureId: string,
  phase: string,
  workflowType: string,
  updatedAt: string,
  stale: boolean,
  artifacts: { design?: string, plan?: string, pr?: string },
  taskProgress: { completed: number, total: number },
  pendingTasks: Array<{ id: string, title: string, status: string }>,
  activeWorktrees: Array<{ path: string, branch: string }>,
  nextAction: string,
  checkpoint: { timestamp: string, operationsSince: number, advised: boolean },
  circuitBreaker: { fixCycleCount: number, maxFixCycles: number, open: boolean },
  recentEvents: StateEvent[],  // Last 5 events
  // Workflow-type-specific context:
  debug?: { track: string, urgency: string, symptom: string, rootCause: string, findings: string[] },
  refactor?: { track: string, scopeAssessment: object, brief: object, validation: object },
  _meta: CheckpointMeta,
}
```

#### `workflow_state_reconcile`

Verify state matches git reality (worktrees, branches). Shells out to `git` commands.

**Idempotency:** Yes (read-only diagnostic).

```typescript
z.object({
  featureId: z.string(),
})

// Response
{
  worktrees: Array<{ path: string, status: "ok" | "missing" }>,
  branches: Array<{ name: string, status: "ok" | "missing" }>,
  _meta: CheckpointMeta,
}
```

#### `workflow_state_next_action`

Determine the next auto-continue action. Derived from the HSM — evaluates guards on all outbound transitions from the current state. Returns the first satisfied `AUTO:*` action, the appropriate `WAIT:*` status, or `DONE`. Also evaluates circuit breaker state.

**Idempotency:** Yes (read-only computation). Increments operation counter.

```typescript
z.object({
  featureId: z.string(),
})

// Response
{
  action: string,              // "AUTO:plan:<path>", "WAIT:human-checkpoint:...", "DONE"
  validTransitions: Array<{
    to: string,
    guardSatisfied: boolean,
    guard: string,             // Human-readable guard description
    circuitOpen: boolean,      // True if fix cycle limit reached for this transition
  }>,
  _meta: CheckpointMeta,
}
```

#### `workflow_state_transitions`

Introspect the state machine for a given workflow type. Returns the full transition graph or valid transitions from a specific phase. Pure computation — no state file needed.

**Idempotency:** Yes (pure function, no side effects, no operation counter increment).

```typescript
z.object({
  workflowType: z.enum(["feature", "debug", "refactor"]),
  fromPhase: z.string().optional(),
})

// Response
{
  transitions: Array<{
    from: string,
    to: string,
    guard: string | null,
    effects: string[],
    isCompoundEntry: boolean,
    isFixCycleTransition: boolean,
  }>,
}
```

#### `workflow_state_cancel`

Cancel a workflow and execute compensation actions. Undoes side effects in reverse phase order. Compensation actions are idempotent — safe to re-invoke if the first attempt is interrupted.

**Idempotency:** Yes. If workflow is already cancelled, returns success with `alreadyCancelled: true`. Compensation actions check for existence before attempting cleanup.

```typescript
z.object({
  featureId: z.string(),
  reason: z.string().optional(),  // Why the workflow is being cancelled
  dryRun: z.boolean().default(false), // If true, list compensation actions without executing
})

// Success response
{
  cancelled: true,
  featureId: string,
  previousPhase: string,
  compensationActions: CompensationResult[],
  alreadyCancelled: boolean,
  event: StateEvent,
}

// Dry-run response
{
  cancelled: false,
  dryRun: true,
  plannedActions: CompensationAction[],
}

// CompensationResult
{
  action: string,       // "cleanup-worktrees", "delete-branches", "close-pr"
  status: "completed" | "skipped" | "failed",
  detail: string,       // What was done or why it was skipped/failed
}
```

#### `workflow_state_checkpoint`

Explicitly trigger a checkpoint. Resets the operation counter and records a checkpoint event. Use this when the orchestrator decides to checkpoint mid-phase (e.g., at a skill-level gate point).

**Idempotency:** Yes. Multiple checkpoints in sequence are harmless — each resets the counter.

```typescript
z.object({
  featureId: z.string(),
  summary: z.string().optional(), // One-line context hint for restoration
})

// Response
{
  checkpointed: true,
  phase: string,
  operationsReset: number,  // How many operations were counted before reset
  event: StateEvent,
  _meta: CheckpointMeta,    // Will show operationsSinceCheckpoint: 0
}
```

---

### Hierarchical State Machine

The workflows are sagas — long-running, multi-step operations where each step produces side effects and failure requires either compensation or retry. The HSM models the valid phase transitions for each saga, with compound states grouping related phases, guard conditions enforcing preconditions, and effects triggering side actions on transitions.

#### Design Principles

1. **Single source of truth.** The HSM definition is the authoritative specification of valid transitions. Skill files and auto-resume rules reference the server's enforcement rather than implementing their own transition logic.
2. **Guards are preconditions, not business logic.** Guards check that required artifacts exist or conditions are met. They do not perform work — they only observe state.
3. **Effects are declarative, not imperative.** Transitions declare which effects should occur (e.g., `"checkpoint"`, `"log"`). The effect execution layer interprets these declarations.
4. **History enables resumption.** The `_history` field records the last active sub-state of each compound state, enabling correct resumption after context compaction.
5. **Circuit breakers bound retry loops.** Fix-cycle transitions (back-edges in the graph) are subject to circuit breaker limits.

#### Feature Workflow HSM

```
FeatureWorkflow (root)
│
├── ideate (atomic)
│   └─→ plan [guard: design artifact exists]
│
├── plan (atomic)
│   └─→ Implementation [guard: plan artifact exists]
│
├── Implementation (compound state, maxFixCycles: 3)
│   │   entry: checkpoint, log("entering-implementation")
│   │   exit:  checkpoint, log("exiting-implementation")
│   │
│   ├── delegate (atomic)
│   │   └─→ integrate [guard: all tasks complete]
│   │
│   ├── integrate (atomic)
│   │   ├─→ review    [guard: integration passed]
│   │   └─→ delegate  [guard: integration failed]  ← fix cycle (circuit-breakered)
│   │
│   └── review (atomic)
│       ├─→ EXIT      [guard: all reviews passed]  → synthesize
│       └─→ delegate  [guard: any review failed]   ← fix cycle (circuit-breakered)
│
├── synthesize (atomic)
│   └─→ completed [guard: PR URL exists]
│
├── completed (final)
│
├── cancelled (final)
│
└── blocked (terminal, requires human intervention)
    └─→ delegate [guard: human unblocked]  ← re-entry after circuit breaker trip
```

#### Debug Workflow HSM

```
DebugWorkflow (root)
│
├── triage (atomic)
│   └─→ investigate [guard: track selected]
│
├── investigate (atomic)
│   ├─→ HotfixTrack.implement  [guard: root cause found AND track = hotfix]
│   └─→ ThoroughTrack.rca      [guard: root cause found AND track = thorough]
│
├── ThoroughTrack (compound state, maxFixCycles: 2)
│   │   entry: checkpoint
│   │   exit:  checkpoint
│   │
│   ├── rca (atomic)
│   │   └─→ design [guard: RCA artifact exists]
│   │
│   ├── design (atomic)
│   │   └─→ implement [guard: fix design artifact exists]
│   │
│   ├── implement (atomic)
│   │   └─→ validate [guard: all tasks complete OR direct implementation]
│   │
│   ├── validate (atomic)
│   │   └─→ review [guard: always — thorough track]
│   │
│   └── review (atomic)
│       └─→ EXIT → synthesize
│
├── HotfixTrack (compound state)
│   │   entry: checkpoint
│   │
│   ├── implement (atomic)
│   │   └─→ validate [guard: fix applied]
│   │
│   └── validate (atomic)
│       └─→ EXIT → HUMAN_CHECKPOINT(hotfix-merge)
│
├── synthesize (atomic)
│   └─→ completed [guard: PR URL exists]
│
├── completed (final)
│
├── cancelled (final)
│
└── blocked (terminal, requires human intervention)
```

#### Refactor Workflow HSM

```
RefactorWorkflow (root)
│
├── explore (atomic)
│   └─→ brief [guard: track selected]
│
├── brief (atomic)
│   ├─→ PolishTrack    [guard: track = polish AND brief complete]
│   └─→ OverhaulTrack  [guard: track = overhaul AND brief complete]
│
├── PolishTrack (compound state)
│   │   entry: checkpoint
│   │   exit:  checkpoint
│   │
│   ├── implement (atomic)
│   │   └─→ validate [guard: tests pass, brief implemented, no scope expansion, ≤5 files]
│   │
│   ├── validate (atomic)
│   │   └─→ update-docs [guard: tests pass]
│   │
│   └── update-docs (atomic)
│       └─→ EXIT → HUMAN_CHECKPOINT(polish-complete)
│
├── OverhaulTrack (compound state, maxFixCycles: 3)
│   │   entry: checkpoint
│   │   exit:  checkpoint
│   │
│   ├── plan (atomic)
│   │   └─→ delegate [guard: plan artifact exists]
│   │
│   ├── delegate (atomic)
│   │   └─→ integrate [guard: all tasks complete]
│   │
│   ├── integrate (atomic)
│   │   ├─→ review   [guard: integration passed]
│   │   └─→ delegate [guard: integration failed]  ← fix cycle (circuit-breakered)
│   │
│   ├── review (atomic)
│   │   ├─→ update-docs [guard: all reviews passed]
│   │   └─→ delegate    [guard: any review failed]  ← fix cycle (circuit-breakered)
│   │
│   └── update-docs (atomic)
│       └─→ EXIT → synthesize
│
├── synthesize (atomic)
│   └─→ completed [guard: PR URL exists]
│
├── completed (final)
│
├── cancelled (final)
│
└── blocked (terminal, requires human intervention)
```

#### HSM Implementation

```typescript
interface State {
  id: string;
  type: "atomic" | "compound" | "final";
  parent?: string;                          // Parent compound state ID
  initial?: string;                         // Initial sub-state (for compound)
  onEntry?: Effect[];                       // Actions on entering this state
  onExit?: Effect[];                        // Actions on exiting this state
  maxFixCycles?: number;                    // Circuit breaker limit (compound states only)
}

interface Transition {
  from: string;
  to: string;
  guard?: Guard;
  effects?: Effect[];
  isFixCycle?: boolean;                     // Marks back-edges subject to circuit breaker
}

interface Guard {
  id: string;                               // Stable identifier for idempotency checks
  evaluate: (state: WorkflowState) => boolean;
  description: string;                      // Human-readable for error messages
}

type Effect = "checkpoint" | "log" | "increment-fix-cycle";

interface HSMDefinition {
  id: string;                               // "feature" | "debug" | "refactor"
  states: Record<string, State>;
  transitions: Transition[];
}
```

#### Transition Algorithm

When a phase transition is requested via `workflow_state_set({ phase: "target" })`:

1. **Idempotency check.** If the current phase already equals the target phase, return success immediately with `idempotent: true`, no effects executed, no event appended. This handles the case where a transition succeeded but the response was lost during context compaction.

2. **Lookup.** Find all transitions from the current state to the target state in the HSM definition. If none exist, return `INVALID_TRANSITION` with the list of valid targets (all states reachable via defined transitions from the current state).

3. **Guard evaluation.** Evaluate the guard condition against the current state. If it fails, return `GUARD_FAILED` with the guard's human-readable description and a list of valid targets whose guards _would_ currently pass.

4. **Circuit breaker check.** If the transition is marked `isFixCycle: true`, check the fix cycle count for the enclosing compound state against its `maxFixCycles`. If the limit is reached, return `CIRCUIT_OPEN` and the HSM transitions to `blocked` instead.

5. **Exit actions.** Execute `onExit` effects for the current state and any parent compound states being left (inner to outer order).

6. **State update.** Write the new phase to the state file atomically.

7. **Entry actions.** Execute `onEntry` effects for any parent compound states being entered and the target state (outer to inner order).

8. **History update.** If leaving a compound state, record the current sub-state in `_history[compoundStateId]`. If entering a compound state, check `_history` for a previous sub-state (history pseudo-state). On first entry, use the compound's `initial` sub-state.

9. **Event append.** Append a `transition` event to the event log. If this is a fix cycle re-entry, also append a `fix-cycle` event.

10. **Return.** Return the success response with the list of effects executed, the appended event, and the current `_meta` checkpoint advisory.

---

### Event Log

A lightweight append-only log stored in the state file. This is **not** full event sourcing — state is mutated directly, and the event log is an auxiliary structure for audit, diagnostics, and circuit breaker counting. The distinction is important: the state file (not the event log) is the system of record. Events cannot be replayed to reconstruct state; they exist to answer "what happened and when."

This design choice follows Microsoft's guidance that full event sourcing "permeates through the entire architecture and introduces trade-offs" and "isn't justified for most systems." Our system is local, single-writer, and doesn't need the scalability or auditability guarantees that justify full event sourcing.

#### Event Schema

```typescript
interface StateEvent {
  sequence: number;         // Monotonically increasing within workflow (1, 2, 3...)
  version: "1.0";           // Event schema version for forward compatibility
  timestamp: string;        // ISO 8601 UTC
  type: EventType;
  from?: string;            // Previous phase (for transitions)
  to?: string;              // New phase (for transitions)
  trigger: string;          // What caused this event ("design-saved", "tasks-complete", etc.)
  metadata?: Record<string, unknown>;
}

type EventType =
  | "transition"            // Phase changed
  | "checkpoint"            // Checkpoint taken (Tier 1 or explicit)
  | "guard-failed"          // Transition attempted but guard rejected
  | "compound-entry"        // Entered a compound state
  | "compound-exit"         // Exited a compound state
  | "fix-cycle"             // Re-entered compound state via back-edge
  | "circuit-open"          // Circuit breaker tripped (fix cycle limit reached)
  | "compensation"          // Compensation action executed during cancel
  | "cancel"                // Workflow cancelled
  | "field-update";         // Non-phase field updated (configurable)
```

#### Event Ordering

The `sequence` field provides unambiguous ordering within a workflow. Timestamps alone are insufficient — two events in the same millisecond (e.g., a transition and its compound-entry effect) would have ambiguous order. The sequence counter is stored as `_eventSequence: number` in the state file and incremented atomically with each event append.

Per Microsoft's Event Sourcing guidance: "Adding a timestamp to every event can help to avoid issues. Another common practice is to annotate each event with an incremental identifier."

#### Event Versioning

The `version` field on each event enables future schema evolution. If event schema changes are needed (e.g., adding new fields), event handlers can branch on `version`:

```typescript
if (event.version === "1.0") {
  // Handle v1.0 events
} else if (event.version === "1.1") {
  // Handle v1.1 events with new fields
}
```

This follows Microsoft's recommendation to "implement a version stamp on each version of the event schema to maintain both the old and the new event formats."

#### Event Cap

The log is capped at 100 events. When appending would exceed the cap, the oldest events are discarded (FIFO). 100 events is sufficient for any single workflow lifecycle — a typical feature workflow generates ~15-30 events, and even a workflow with 3 fix cycles stays under 60.

The cap prevents unbounded state file growth while retaining enough history for diagnostics. If full history is needed, the entire event log can be exported before cap truncation via `workflow_state_get({ query: "_events" })`.

#### Event Queries

The event log supports simple filtered queries used internally by other subsystems:

```typescript
// Count fix cycles in current compound state
function getFixCycleCount(events: StateEvent[], compoundStateId: string): number {
  return events.filter(e =>
    e.type === "fix-cycle" &&
    e.metadata?.compoundStateId === compoundStateId
  ).length;
}

// Duration of a phase
function getPhaseDuration(events: StateEvent[], phase: string): number | null {
  const entered = events.find(e => e.type === "transition" && e.to === phase);
  const exited = events.find(e => e.type === "transition" && e.from === phase);
  if (!entered || !exited) return null;
  return new Date(exited.timestamp).getTime() - new Date(entered.timestamp).getTime();
}
```

The `workflow_state_summary` tool includes the 5 most recent events for context restoration.

---

### Circuit Breaker

Fix cycles (review → delegate → integrate → review) are the retry mechanism of the saga. Without bounds, an autonomous workflow can loop indefinitely — reviews finding issues, fixes introducing new issues, context exhausting without resolution.

The circuit breaker pattern (per [Microsoft's Cloud Design Patterns](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker)) "prevents an application from performing an operation that's unlikely to succeed" and is specifically designed to complement retry patterns.

#### Implementation

Each compound state that contains fix-cycle transitions declares a `maxFixCycles` limit. Fix-cycle transitions are identified by the `isFixCycle: true` flag on the transition definition.

```typescript
interface CircuitBreakerState {
  fixCycleCount: number;            // Current count for active compound state
  maxFixCycles: number;             // Limit from HSM definition
  open: boolean;                    // True if limit reached
  lastTrippedAt?: string;          // ISO 8601 — when the circuit opened
  compoundStateId: string;          // Which compound state this applies to
}
```

The fix cycle count is derived from the event log — specifically, the count of `fix-cycle` events for the current compound state since its most recent `compound-entry` event. This is computed on demand, not stored separately, ensuring consistency with the event log.

#### Circuit Breaker Flow

```
1. Transition requested: review → delegate (isFixCycle: true)
2. Count fix-cycle events for "Implementation" since last compound-entry
3. If count >= maxFixCycles:
   a. Append circuit-open event
   b. Transition to "blocked" instead of "delegate"
   c. Return CIRCUIT_OPEN error with cycle count and limit
   d. next-action returns WAIT:blocked:fix-cycle-limit-reached
4. If count < maxFixCycles:
   a. Execute transition normally
   b. Append fix-cycle event
   c. Increment count
```

#### Configuration

| Workflow | Compound State | Default maxFixCycles |
|----------|---------------|---------------------|
| Feature | Implementation | 3 |
| Debug (thorough) | ThoroughTrack | 2 |
| Refactor (overhaul) | OverhaulTrack | 3 |

These defaults are encoded in the HSM definition and can be overridden via environment variable `MAX_FIX_CYCLES` (applies uniformly to all compound states). Per-compound-state configuration is not supported in v1.0 to avoid complexity.

#### Recovery from Blocked State

When a workflow reaches `blocked`:
1. The orchestrator surfaces this to the user via `next-action` returning `WAIT:blocked:fix-cycle-limit-reached`
2. The user investigates and resolves the systemic issue
3. The user manually transitions back to `delegate` (the blocked state allows this transition with a human-unblocked guard)
4. The fix cycle counter for the compound state resets on re-entry

---

### Saga Compensation

The workflows produce side effects at each phase: worktrees, branches, integration branches, PRs. When a workflow is cancelled (user abandons it, or it reaches a terminal failure), these side effects should be cleaned up. This follows the [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction).

Per Microsoft's guidance: "The steps in a compensating transaction undo the effects of the steps in the original operation... A common approach is to use a workflow to implement an eventually consistent operation that requires compensation."

#### Compensation Actions Per Phase

Each phase has a set of compensation actions that undo its side effects. Compensation runs in **reverse phase order** — most recent side effects are undone first.

```typescript
interface CompensationAction {
  phase: string;                     // Which phase produced this side effect
  action: string;                    // Machine-readable action identifier
  description: string;               // Human-readable description
  execute: (state: WorkflowState) => Promise<CompensationResult>;
}

const compensationRegistry: Record<string, CompensationAction[]> = {
  synthesize: [
    {
      phase: "synthesize",
      action: "close-pr",
      description: "Close the pull request if it exists and is open",
      execute: async (state) => {
        // Shell out to: gh pr close <url>
        // Skip if prUrl is null or PR already closed/merged
      },
    },
  ],
  integrate: [
    {
      phase: "integrate",
      action: "delete-integration-branch",
      description: "Delete the integration branch",
      execute: async (state) => {
        // Shell out to: git branch -D <branch>
        // Skip if branch doesn't exist
      },
    },
  ],
  delegate: [
    {
      phase: "delegate",
      action: "cleanup-worktrees",
      description: "Remove all worktrees created by this workflow",
      execute: async (state) => {
        // For each worktree in state.worktrees:
        //   git worktree remove <path> --force
        // Skip worktrees that don't exist
      },
    },
    {
      phase: "delegate",
      action: "delete-feature-branches",
      description: "Delete feature branches created by tasks",
      execute: async (state) => {
        // For each task with a branch:
        //   git branch -D <branch>
        // Skip branches that don't exist
      },
    },
  ],
  plan: [],      // No side effects to undo
  ideate: [],    // No side effects to undo
};
```

#### Compensation Design Principles

1. **Idempotent.** Every compensation action checks for existence before acting. Deleting a worktree that doesn't exist is a no-op, not an error. Per Microsoft: "define the steps in a compensating transaction as idempotent commands."

2. **Best-effort.** Individual compensation actions can fail (e.g., branch protected, worktree has uncommitted changes). Failures are logged but do not prevent other compensation actions from executing. The overall cancel operation succeeds even if some compensation actions fail.

3. **Reverse order.** Compensation runs from most recent phase backward. synthesize → integrate → delegate → plan → ideate. This ensures dependencies are undone before their prerequisites (e.g., worktrees removed before branches deleted).

4. **Dry-run support.** The `workflow_state_cancel` tool accepts `dryRun: true` to list planned compensation actions without executing them. This lets the orchestrator preview cleanup before committing.

5. **Event-logged.** Each compensation action (success, skip, or failure) is recorded as a `compensation` event in the event log, followed by a `cancel` event when complete.

#### Cancel State Transitions

Any non-final state can transition to `cancelled`. This is a universal transition available from every state, guarded only by the requirement that the workflow is not already `completed` or `cancelled`. The `cancelled` state is a final state — no transitions out.

---

### Intelligent Checkpointing

A three-tier system that replaces manual `/checkpoint` invocations with automatic and advisory checkpointing.

#### Tier 1: Phase-Boundary Auto-Checkpoints

Every phase transition triggers an automatic checkpoint. This is modeled as an effect on compound state entry/exit actions and on transitions between top-level states.

The checkpoint is the state file itself (already persisted on every `set`), plus a `_checkpoint` metadata block:

```typescript
interface CheckpointState {
  timestamp: string;              // When checkpoint was taken
  phase: string;                  // Phase at checkpoint time
  summary: string;                // One-line context restoration hint
  operationsSince: number;        // Reset to 0 on checkpoint
  fixCycleCount: number;          // Fix cycles in current compound state
  lastActivityTimestamp: string;  // Updated on EVERY state operation
  staleAfterMinutes: number;      // Default: 120 (2 hours)
}
```

This is "free" — the state file is already written on phase transitions. The checkpoint block formalizes it as a resumable snapshot.

#### Tier 2: Operation-Count Advisory

The MCP server tracks how many state-mutating tool calls have been made since the last checkpoint. After a configurable threshold (default: 20 operations), every tool response includes an advisory in `_meta`:

```typescript
interface CheckpointMeta {
  checkpointAdvised: boolean;
  operationsSinceCheckpoint: number;
  lastCheckpointPhase: string;
  lastCheckpointTimestamp: string;
  stale: boolean;
  minutesSinceActivity: number;
}
```

The operation counter is incremented on `set`, `get`, `summary`, `next_action`, and `reconcile` calls. It is NOT incremented on `transitions` (pure computation) or `list` (multi-workflow). It resets to 0 on phase transitions (Tier 1) or explicit `workflow_state_checkpoint` calls.

The `_meta` block is included on **every** tool response that operates on a specific workflow (all tools except `list` and `transitions`).

#### Tier 3: Skill-Level Checkpoint Gates

Within long phases like `delegate` (which may dispatch 10+ tasks), skill instructions define explicit gate points. After each task completes, the skill checks `_meta.checkpointAdvised`. If true, it invokes `workflow_state_checkpoint` and then runs `/checkpoint`.

This tier is a convention in skill files, not MCP server logic. The server provides the signal; skills act on it.

#### Staleness Detection

The `_checkpoint.lastActivityTimestamp` is updated on every state operation. The `staleAfterMinutes` threshold (default: 120 minutes, configurable via `STALE_AFTER_MINUTES` env var) determines when a workflow is considered stale — meaning no tool calls have been made for an extended period, suggesting the session crashed or the user walked away.

Staleness is surfaced in `list` and `summary` responses, and in the `_meta` block.

#### Checkpoint Configuration

```
CHECKPOINT_ON_PHASE_TRANSITION=true    # Tier 1 default
CHECKPOINT_OPERATION_THRESHOLD=20      # Tier 2 default
STALE_AFTER_MINUTES=120                # Staleness default
```

---

### State File Format

Extended from the existing JSON format with new internal fields. The schema version enables forward-compatible migration.

```typescript
interface FeatureWorkflowState {
  // Schema version — used by migration layer
  version: "1.1";

  // Core workflow fields (unchanged from bash script)
  featureId: string;
  createdAt: string;              // ISO 8601 UTC
  updatedAt: string;              // ISO 8601 UTC, set on every write
  phase: FeaturePhase;
  artifacts: {
    design: string | null;
    plan: string | null;
    pr: string | null;
  };
  tasks: Task[];
  worktrees: Record<string, Worktree>;
  julesSessions: Record<string, unknown>;
  reviews: Record<string, Review>;
  synthesis: Synthesis;

  // Internal fields (managed by MCP server, prefixed with _)
  _history: Record<string, string>;   // Compound state ID → last active sub-state
  _events: StateEvent[];               // Append-only event log (max 100)
  _eventSequence: number;              // Monotonic counter for event ordering
  _checkpoint: CheckpointState;        // Checkpoint metadata
}

// DebugWorkflowState and RefactorWorkflowState follow the same pattern
// with their workflow-specific fields plus the same _ internal fields.
```

#### The `_` Prefix Convention

Fields prefixed with `_` are internal metadata managed exclusively by the MCP server:

- **Not writable** via `workflow_state_set` `updates` parameter — returns `RESERVED_FIELD` error
- **Readable** via `workflow_state_get` — callers can query `_events`, `_checkpoint`, etc.
- **Ignored** by the bash script — backward compatible since the script doesn't access `_`-prefixed keys
- **Managed** by specific subsystems: `_history` by the HSM, `_events`/`_eventSequence` by the event log, `_checkpoint` by the checkpoint system

---

### State File I/O

#### Atomic Writes

All state file writes use the write-to-temp-then-rename pattern to prevent corruption on crash:

```typescript
async function writeStateFile(path: string, state: WorkflowState): Promise<void> {
  const tmpPath = `${path}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await fs.rename(tmpPath, path);  // Atomic on same filesystem
}
```

The temp file includes the PID to avoid conflicts if multiple processes write simultaneously (though single-writer is the expected usage pattern).

#### Schema Validation on Read

Every state file read validates the contents against the appropriate Zod schema:

```typescript
async function readStateFile(path: string): Promise<WorkflowState> {
  const raw = await fs.readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError("STATE_CORRUPT", "State file is not valid JSON", { path });
  }

  // Migrate if needed (see Migration section)
  const migrated = migrateState(parsed);

  // Validate against schema
  const result = workflowStateSchema.safeParse(migrated);
  if (!result.success) {
    throw new ToolError("STATE_CORRUPT", "State file failed schema validation", {
      path,
      issues: result.error.issues,
    });
  }

  return result.data;
}
```

This catches corruption early — whether from manual editing, partial writes (if atomic write somehow fails), or version incompatibilities — with actionable error messages rather than mysterious runtime failures downstream.

#### State File Version Migration

The state file includes a `version` field. When the MCP server reads a state file with an older version, it applies migrations automatically:

```typescript
const CURRENT_VERSION = "1.1";

interface Migration {
  from: string;
  to: string;
  migrate: (state: Record<string, unknown>) => Record<string, unknown>;
}

const migrations: Migration[] = [
  {
    from: "1.0",
    to: "1.1",
    migrate: (state) => ({
      ...state,
      version: "1.1",
      _history: state._history ?? {},
      _events: state._events ?? [],
      _eventSequence: state._eventSequence ?? 0,
      _checkpoint: state._checkpoint ?? {
        timestamp: state.updatedAt ?? new Date().toISOString(),
        phase: state.phase ?? "unknown",
        summary: "",
        operationsSince: 0,
        fixCycleCount: 0,
        lastActivityTimestamp: state.updatedAt ?? new Date().toISOString(),
        staleAfterMinutes: 120,
      },
    }),
  },
];

function migrateState(raw: unknown): unknown {
  let state = raw as Record<string, unknown>;
  const currentVersion = (state.version as string) ?? "1.0";

  if (currentVersion === CURRENT_VERSION) return state;

  // Apply migrations in sequence
  let version = currentVersion;
  for (const migration of migrations) {
    if (migration.from === version) {
      state = migration.migrate(state);
      version = migration.to;
    }
  }

  if (version !== CURRENT_VERSION) {
    throw new ToolError("MIGRATION_FAILED", `No migration path from v${currentVersion} to v${CURRENT_VERSION}`, {
      currentVersion,
      targetVersion: CURRENT_VERSION,
    });
  }

  // Write back migrated state (so subsequent reads don't re-migrate)
  return state;
}
```

Migrations are:
- **Additive only** — new fields with defaults, never removing fields
- **Applied on read** — transparent to callers
- **Written back** — migrated state is persisted so subsequent reads skip migration
- **Sequential** — migrations chain (1.0 → 1.1 → 1.2, not 1.0 → 1.2 directly) for simplicity

---

### Idempotency Design

After context compaction, the auto-resume system may re-invoke a tool call that already succeeded but whose response was lost. All state-mutating operations must handle this gracefully.

Per Microsoft's [guidance on idempotent operations](https://learn.microsoft.com/en-us/azure/architecture/microservices/design/api-design#idempotent-operations): "An operation is idempotent if you can call it multiple times without producing more side effects after the first call."

| Tool | Idempotent? | Strategy |
|------|-------------|----------|
| `init` | No (intentional) | Fails with `STATE_ALREADY_EXISTS` including current phase |
| `list` | Yes | Read-only, no side effects |
| `get` | Yes | Read-only. Increments op counter (harmless if repeated) |
| `set` (fields only) | Yes | Dot-path updates are last-write-wins. Same value → same result |
| `set` (phase transition) | Yes | **If current == target, return success with `idempotent: true`, skip effects** |
| `summary` | Yes | Read-only. Increments op counter |
| `reconcile` | Yes | Read-only diagnostic |
| `next_action` | Yes | Read-only computation. Increments op counter |
| `transitions` | Yes | Pure function. No state file access |
| `cancel` | Yes | **If already cancelled, return success with `alreadyCancelled: true`** |
| `checkpoint` | Yes | Multiple checkpoints are harmless (counter resets each time) |

The critical case is `set` with a phase transition. The idempotency check at step 1 of the Transition Algorithm (current phase == target phase → immediate success) prevents duplicate event log entries, duplicate effect execution, and incorrect fix-cycle counting that would result from naively re-executing the transition.

---

### Dot-Path Updates (replacing jq filters)

The bash script uses raw jq filters like `.artifacts.design = "path" | .phase = "plan"`. The MCP server replaces this with structured dot-path updates:

```typescript
// Before (bash):
// workflow-state.sh set state.json '.artifacts.design = "docs/designs/foo.md" | .phase = "plan"'

// After (MCP tool):
// workflow_state_set({
//   featureId: "foo",
//   updates: { "artifacts.design": "docs/designs/foo.md" },
//   phase: "plan"
// })
```

The `updates` field uses dot-notation keys mapped to values. A small utility converts these to nested object mutations:

```typescript
function applyDotPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
```

Array access syntax (`tasks[0].status`) is supported. Fields prefixed with `_` are rejected with `RESERVED_FIELD`.

---

### Error Handling

All errors are returned as structured MCP tool results with `isError: true`:

```typescript
interface ToolError {
  error: string;           // Machine-readable error code
  message: string;         // Human-readable description
  details?: Record<string, unknown>;
}
```

Error codes:

| Code | Meaning |
|------|---------|
| `STATE_NOT_FOUND` | No state file for the given featureId |
| `STATE_ALREADY_EXISTS` | Init called for existing featureId |
| `STATE_CORRUPT` | State file failed JSON parse or Zod validation |
| `MIGRATION_FAILED` | No migration path from state file version to current |
| `INVALID_TRANSITION` | Phase transition not in HSM definition |
| `GUARD_FAILED` | Transition exists but guard condition not met |
| `CIRCUIT_OPEN` | Fix cycle limit reached for compound state |
| `INVALID_INPUT` | Zod validation failure on tool input |
| `RESERVED_FIELD` | Attempt to set a `_`-prefixed field via updates |
| `ALREADY_CANCELLED` | Cancel called on already-cancelled workflow (success, not error) |
| `COMPENSATION_PARTIAL` | Some compensation actions failed (cancel still succeeded) |
| `FILE_IO_ERROR` | Filesystem error reading/writing state |

---

### Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0"
  }
}
```

No `jq`. No bash. Zero external binary dependencies. The HSM, event log, circuit breaker, compensation, and checkpoint systems are all implemented in pure TypeScript with no additional libraries.

### Configuration

**As a Claude Code plugin** (primary):

```json
// plugins/workflow-state/mcp-servers.json
{
  "workflow-state": {
    "type": "stdio",
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/servers/workflow-state-mcp/dist/index.js"],
    "env": {
      "WORKFLOW_STATE_DIR": "${REPO_ROOT}/docs/workflow-state"
    }
  }
}
```

**Via npx** (for other repos using lvlup-claude workflows):

```json
// .mcp.json
{
  "mcpServers": {
    "workflow-state": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@lvlup-sw/workflow-state-mcp"],
      "env": {
        "WORKFLOW_STATE_DIR": "./docs/workflow-state"
      }
    }
  }
}
```

The server auto-detects the git repo root for state directory resolution, matching the bash script's behavior, but `WORKFLOW_STATE_DIR` can override it.

**All environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKFLOW_STATE_DIR` | Auto-detected from git root | Directory for state files |
| `CHECKPOINT_ON_PHASE_TRANSITION` | `true` | Tier 1 auto-checkpoint |
| `CHECKPOINT_OPERATION_THRESHOLD` | `20` | Tier 2 advisory threshold |
| `STALE_AFTER_MINUTES` | `120` | Staleness detection threshold |
| `MAX_FIX_CYCLES` | (per HSM definition) | Override circuit breaker limit |
| `EVENT_LOG_FIELD_UPDATES` | `false` | Log field-update events |
| `EVENT_LOG_MAX` | `100` | Maximum events before FIFO discard |

---

## Integration Points

### Skills and Auto-Resume Rules

All skill files (`SKILL.md`) that currently reference `~/.claude/scripts/workflow-state.sh` will need updating to use the MCP tool names. For example:

```markdown
# Before
~/.claude/scripts/workflow-state.sh set docs/workflow-state/foo.state.json '.phase = "plan"'

# After
workflow_state_set({ featureId: "foo", phase: "plan" })
```

The `workflow-auto-resume.md` rule's detection logic changes from:
```bash
~/.claude/scripts/workflow-state.sh list 2>/dev/null
```
to:
```
workflow_state_list()
```

Skills that run long phases add checkpoint gate and circuit breaker awareness:

```markdown
# After each task completes
1. Call workflow_state_set to update task status
2. If response._meta.checkpointAdvised == true:
   - Call workflow_state_checkpoint with summary
   - Run /checkpoint for context management
3. If response.error == "CIRCUIT_OPEN":
   - Stop fix cycle
   - Surface blocked state to user
```

### HSM as Source of Truth for Transitions

The HSM definitions replace the scattered transition logic currently encoded across:
- `workflow-auto-resume.md` (next-action mapping tables)
- Individual skill files (phase transition instructions)
- `workflow-state.sh` `cmd_next_action` function

After migration, these sources reference the MCP server's transition enforcement rather than implementing their own. The `workflow_state_transitions` tool lets skills introspect valid next phases dynamically.

### Bash Script Coexistence

The bash script remains functional and is not deleted. This allows:
- Gradual migration of skill files
- Shell-based debugging and inspection
- Use in git hooks or CI where MCP isn't available

The bash script does not gain HSM enforcement, event logging, circuit breakers, compensation, or checkpoint tracking. These features are exclusive to the MCP server, creating a natural incentive to migrate.

### Settings.json

The existing `Bash(~/.claude/scripts/workflow-state.sh:*)` permission can be removed once all callers migrate to MCP tools. The MCP tools are auto-permitted by the plugin registration.

---

## Testing Strategy

### Unit Tests

- **schemas.test.ts** — Zod schema validation: valid inputs pass, invalid inputs produce correct error codes. Reserved field rejection. State file schema validation catches corruption.
- **state-machine.test.ts** — HSM tests:
  - Every valid transition per workflow type succeeds
  - Every invalid transition returns `INVALID_TRANSITION` with valid targets
  - Guard conditions correctly gate transitions (satisfied and unsatisfied)
  - Compound state entry/exit effects fire in correct order (inner-to-outer exit, outer-to-inner entry)
  - History pseudo-state correctly resumes last active sub-state on compound re-entry
  - Fix cycle detection: re-entering compound state via back-edge logs `fix-cycle` event
  - Transition introspection returns correct graph per workflow type
  - `blocked` state reachable from any non-final state via cancel
  - `cancelled` state reachable from any non-final state
- **circuit-breaker.test.ts** — Circuit breaker tests:
  - Fix cycle count derived correctly from event log
  - Circuit opens at exactly maxFixCycles
  - `CIRCUIT_OPEN` error returned with correct count and limit
  - Transition to `blocked` state on circuit open
  - Recovery: re-entry to compound state resets cycle count
- **compensation.test.ts** — Compensation tests:
  - Each phase's compensation actions execute in reverse order
  - Idempotent: compensation of already-cleaned-up resources succeeds (skip)
  - Partial failure: some actions fail, others still execute, overall cancel succeeds
  - Dry run: lists actions without executing
  - Cancel of already-cancelled workflow returns `alreadyCancelled: true`
  - Compensation events logged to event log
- **state-store.test.ts** — File I/O tests:
  - Init creates correct JSON structure per workflow type with v1.1 schema
  - Get with dot-paths returns correct values (including `_` fields)
  - Set applies updates atomically (write-to-temp-then-rename)
  - `_`-prefixed fields rejected from external updates
  - Schema validation catches corrupt files with actionable errors
  - Handles missing files, permission errors
- **migration.test.ts** — Migration tests:
  - v1.0 state files migrated to v1.1 with correct defaults
  - Already-current files pass through unchanged
  - Migrated state written back to disk
  - Unknown version produces `MIGRATION_FAILED` error
  - Migration chain works (v1.0 → v1.1 → v1.2 if needed)
- **idempotency.test.ts** — Idempotency tests:
  - Phase transition to current phase returns `idempotent: true`, no event appended
  - Same field updates applied twice produce identical state
  - Cancel of cancelled workflow returns `alreadyCancelled: true`
  - Multiple checkpoints in sequence are harmless
  - Operation counter incremented correctly (not doubled on idempotent calls)
- **checkpoint.test.ts** — Checkpoint tests:
  - Operation counting increments on mutating calls
  - Advisory triggers at threshold
  - Counter resets on phase transition and explicit checkpoint
  - `_meta` block included on all per-workflow responses
  - Staleness detection: correct after threshold, not before
  - `lastActivityTimestamp` updated on every operation
- **events.test.ts** — Event log tests:
  - Events appended with correct sequence numbers
  - Event cap enforced at configured maximum (FIFO discard)
  - Correct event types emitted for all operations
  - Event version field present on all events
  - Recent events queryable (last N)
  - Fix cycle count derivable from event log
- **tools.test.ts** — Full tool handler tests:
  - Input validation → HSM transition → state mutation → event log → checkpoint meta → response structure
  - Error responses have correct structure and error codes
  - All 10 tools produce correct responses for happy path and error cases

### Integration Tests

- **Full lifecycle:** init → set → get → summary → next-action for each workflow type
- **Feature workflow lifecycle:** Complete ideate → plan → delegate → integrate → review → synthesize → completed, verifying events, checkpoints, and state at each phase
- **Fix cycle:** delegate → integrate (fail) → delegate → integrate (pass) → review, verifying history state, fix-cycle event count, and circuit breaker state
- **Circuit breaker trip:** Simulate maxFixCycles + 1 fix cycles, verify transition to `blocked`, verify recovery after human intervention
- **Compensation:** Create workflow through delegate (with worktrees and branches), cancel, verify cleanup actions executed
- **Checkpoint advisory:** Simulate threshold + 5 operations, verify advisory triggers after threshold
- **Idempotency after compaction:** Simulate a phase transition, then re-invoke the same transition, verify no duplicate events
- **Migration:** Create v1.0 state file (bash script format), read via MCP server, verify migration to v1.1 with correct defaults
- **Event log lifecycle:** Walk full workflow, verify event sequence is monotonically increasing, timestamps are non-decreasing, event types match expected transitions

### Compatibility Tests

- State files produced by the MCP server are readable by the bash script (core fields identical; bash ignores `_`-prefixed fields)
- State files produced by the bash script are readable by the MCP server (missing `_` fields filled by migration, v1.0 → v1.1)
- State files round-trip correctly: bash creates → MCP reads/migrates → bash reads (core fields unchanged)

---

## Architectural Pattern References

| Pattern | Source | Application in This Design |
|---------|--------|---------------------------|
| Saga (Orchestration) | [Azure Architecture Patterns](https://learn.microsoft.com/en-us/azure/architecture/reference-architectures/saga/saga) | Workflow as orchestrated saga with HSM as orchestrator |
| Compensating Transaction | [Azure Architecture Patterns](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction) | `workflow_state_cancel` with per-phase idempotent cleanup |
| Circuit Breaker | [Azure Architecture Patterns](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker) | Fix cycle bounding on compound states |
| Event Sourcing (lightweight) | [Azure Architecture Patterns](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) | Append-only event log for audit, not as system of record |
| Retry + Idempotency | [Azure Architecture Patterns](https://learn.microsoft.com/en-us/azure/architecture/patterns/retry) | All state-mutating operations safe to re-invoke |
| Scheduler-Agent-Supervisor | [Azure Architecture Patterns](https://learn.microsoft.com/en-us/azure/architecture/patterns/scheduler-agent-supervisor) | Staleness detection for hung workflows |
| Durable Functions Checkpointing | [Azure Durable Functions](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-overview) | Three-tier checkpointing at phase boundaries |

---

## Open Questions

1. **npm scope** — Is `@lvlup-sw/workflow-state-mcp` the right package name, or should it be scoped differently?
2. **Reconcile git dependency** — `reconcile` and `compensation` need git operations. Shell out to `git` (simpler, more reliable) or use `isomorphic-git` (no binary dependency)?
3. **Event log field-update tracking** — Should non-phase field updates emit `field-update` events? Default off, configurable via `EVENT_LOG_FIELD_UPDATES=true`.
4. **Circuit breaker per-compound override** — Should `maxFixCycles` be configurable per compound state via env vars, or is a single `MAX_FIX_CYCLES` override sufficient for v1.0?

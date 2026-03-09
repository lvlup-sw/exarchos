# Design: Lazy Schema + Runbook Protocol

## Problem Statement

Exarchos registers 5 composite tools with ~45 actions at MCP startup, costing ~3,045 tokens in schema and description payload. Every session pays this upfront tax regardless of which actions are actually used. For short sessions (checkpoint, rehydrate, single query), this is disproportionate.

More critically, agents struggle with multi-step orchestration sequences. Gate chains (TDD → static analysis → task_complete), quality review flows (4-6 sequential calls), and the Agent Teams Saga (10-15 calls with event-first ordering) are documented in skill prose, but prose is advisory — agents skip steps, reorder gates, and miss conditional branches. The existing composite actions (`prepare_delegation`, `prepare_synthesis`, `assess_stack`) prove that bundling works, but they're hand-coded and don't scale to every multi-step pattern.

**Two problems, one design:**

1. **Context efficiency** — Reduce registration payload from ~3,045 tokens to ~500-700 tokens via lazy schema loading
2. **Orchestration reliability** — Replace prose-documented step sequences with machine-readable runbooks that encode ordering, gate semantics, and template variables

**Related:** [#966](https://github.com/lvlup-sw/exarchos/issues/966) — Runbooks make the MCP server self-describing, reducing reliance on Claude Code-specific skill prose. Any MCP client (Copilot CLI, Cursor, etc.) can call `runbook()` to discover orchestration sequences without needing skills loaded into context.

## Design Constraints

- **Registry remains the single source of truth** — Runbooks reference actions by name; schemas are resolved from the registry at runtime, not duplicated
- **No new tools** — `describe` and `runbook` are actions on existing composite tools, not new MCP tool registrations
- **Backward compatible** — Full schemas remain available; slim registration is opt-in via MCP server configuration
- **Gate semantics are not duplicated** — Blocking/advisory classification lives on the action definition in the registry; runbooks inherit it
- **Existing anti-drift pattern** — Runbook validation tests follow the proven bidirectional sync pattern from `registry.test.ts`
- **No code execution** — Unlike Cloudflare's code-mode, agents receive structured step sequences, not executable code. This preserves the "structured input, strict validation" philosophy

## Prior Art: Cloudflare Code-Mode

Cloudflare's [agents/codemode](https://github.com/cloudflare/agents/tree/main/packages/codemode) and [MCP server](https://github.com/cloudflare/mcp) collapse ~2,500 API endpoints into 2 tools (`search` + `execute`) by having agents write JavaScript that queries specs and invokes APIs. This achieves 99.95% token reduction (2M → 1k tokens).

**What we adopt:** The two-phase discover-then-execute pattern and the spec-on-server philosophy (schemas stay server-side, served on demand).

**What we don't adopt:** Code execution. Cloudflare's problem is combinatorial API surface; ours is ordered step sequences with gates. Code-mode would let agents bypass phase gates by writing arbitrary orchestration — the opposite of what we want.

## Chosen Approach: Lazy Schema + Runbook Protocol

### Architecture Overview

Two new capabilities, both implemented as actions on existing composite tools:

1. **`describe` action** on each composite tool — Returns full schemas for specific actions on demand. Registration descriptions shrink to tool-level summaries + action enum.

2. **`runbook` action** on `exarchos_orchestrate` — Returns ordered step sequences with schemas, gate semantics, and template variables for a given workflow phase and operation.

```
Session start (today):                     Session start (proposed):
┌─────────────────────────────────┐        ┌─────────────────────────────────┐
│ MCP Registration                │        │ MCP Registration                │
│ 5 tools × full schemas          │        │ 5 tools × slim descriptions     │
│ ~3,045 tokens                   │        │ ~500-700 tokens                 │
└─────────────────────────────────┘        └─────────────────────────────────┘

Agent needs to run gates:                  Agent needs to run gates:
┌─────────────────────────────────┐        ┌─────────────────────────────────┐
│ 1. Read skill prose             │        │ 1. runbook("delegate",          │
│ 2. Infer step ordering          │        │      "task-completion")         │
│ 3. Call check_tdd_compliance    │        │    → returns 3 steps with       │
│ 4. Parse result, decide next    │        │      schemas + gate semantics   │
│ 5. Call check_static_analysis   │        │ 2. Execute steps in order       │
│ 6. Parse result, decide next    │        │    (schemas already in hand)    │
│ 7. Call task_complete           │        │ 3. Stop on gate failure         │
└─────────────────────────────────┘        └─────────────────────────────────┘
```

### Key Properties

1. **Zero schema drift** — Runbooks store action references; schemas resolve from the registry at serve-time
2. **Single-source gate semantics** — `gate` metadata on the action definition; runbooks inherit it
3. **Bidirectional sync tests** — Same pattern as existing `OrchestrateActions_MatchCompositeHandlers_InSync`
4. **Progressive disclosure** — Agents pay for schemas only when they need them
5. **Composable** — Runbooks can reference other runbooks for nested sequences

---

## Technical Design

### 1. Slim Registration

#### Current registration description (example: `exarchos_orchestrate`)

```
Task coordination — claim, complete, and fail tasks

Actions:
- task_claim(taskId, agentId, streamId): Claim a task for execution
- task_complete(taskId, result?, evidence?, streamId): Mark a task as complete...
[... 20 more action signatures with full param lists ...]
```

~3,750 bytes for orchestrate alone.

#### Proposed slim description

```
Task coordination, quality gates, and script execution. Use describe(actions) for schemas.

Actions: task_claim, task_complete, task_fail, review_triage, prepare_delegation,
prepare_synthesis, assess_stack, check_static_analysis, check_security_scan,
check_context_economy, check_operational_resilience, check_workflow_determinism,
check_review_verdict, check_convergence, check_provenance_chain,
check_design_completeness, check_plan_coverage, check_tdd_compliance,
check_post_merge, check_task_decomposition, check_event_emissions, run_script
```

~500 bytes. Action names are self-descriptive; full schemas available via `describe`.

#### Implementation

In `registry.ts`, add a `slimDescription` field to `CompositeTool`:

```typescript
export interface CompositeTool {
  readonly name: string;
  readonly description: string;      // Full description (existing)
  readonly slimDescription: string;   // NEW: tool summary + action list
  readonly actions: readonly ToolAction[];
  readonly hidden?: boolean;
}
```

In `adapters/mcp.ts`, select description based on server config:

```typescript
const description = ctx.slimRegistration
  ? tool.slimDescription
  : buildToolDescription(tool);
```

Configuration via environment variable or `exarchos.config.ts`:

```typescript
// exarchos.config.ts
export default defineConfig({
  mcp: {
    slimRegistration: true,  // default: true for new installs
  },
});
```

### 2. `describe` Action

A new action on every composite tool that returns full schemas for requested actions.

#### Schema

```typescript
const describeSchema = z.object({
  actions: z.array(z.string()).min(1).max(10)
    .describe('Action names to describe. Returns full schema + description for each.'),
});
```

#### Handler

```typescript
// Added to each composite handler
async function handleDescribe(
  args: { actions: string[] },
  tool: CompositeTool,
): Promise<ToolResult> {
  const results: Record<string, ActionDescription> = {};

  for (const actionName of args.actions) {
    const action = tool.actions.find(a => a.name === actionName);
    if (!action) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown action: ${actionName}`,
          validTargets: tool.actions.map(a => a.name),
        },
      };
    }

    results[actionName] = {
      description: action.description,
      schema: zodToJsonSchema(action.schema),
      gate: action.gate ?? null,
      phases: [...action.phases],
      roles: [...action.roles],
    };
  }

  return { success: true, data: results };
}
```

#### Response example

```json
{
  "success": true,
  "data": {
    "check_tdd_compliance": {
      "description": "Verify TDD compliance — test-first discipline",
      "schema": {
        "type": "object",
        "properties": {
          "taskId": { "type": "string" },
          "featureId": { "type": "string" },
          "streamId": { "type": "string" }
        },
        "required": ["taskId"]
      },
      "gate": { "blocking": true, "dimension": "D1" },
      "phases": ["delegate", "review"],
      "roles": ["orchestrator", "reviewer"]
    }
  }
}
```

### 3. Gate Metadata on Action Definitions

Add gate classification to the `ToolAction` interface:

```typescript
export interface ToolAction {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly phases: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
  // NEW:
  readonly gate?: {
    readonly blocking: boolean;
    readonly dimension?: string;  // D1-D5 convergence dimension
  };
}
```

Existing action definitions are updated:

```typescript
{
  name: 'check_tdd_compliance',
  // ...existing fields...
  gate: { blocking: true, dimension: 'D1' },
},
{
  name: 'check_operational_resilience',
  // ...existing fields...
  gate: { blocking: false, dimension: 'D4' },  // advisory
},
```

Non-gate actions (e.g., `task_claim`, `run_script`) omit the `gate` field.

### 4. Runbook Protocol

#### 4.1 Runbook Definition Type

```typescript
// src/runbooks/types.ts
export interface RunbookStep {
  /** Tool name (e.g., 'exarchos_orchestrate') or 'native:Task' for native tools */
  readonly tool: string;
  /** Action name within the tool */
  readonly action: string;
  /** Behavior on failure: 'stop' halts the sequence, 'continue' proceeds, 'retry' retries once */
  readonly onFail: 'stop' | 'continue' | 'retry';
  /** Static params to pre-fill (agent fills the rest from templateVars) */
  readonly params?: Record<string, unknown>;
  /** Human-readable note for this step (e.g., "Run before static analysis") */
  readonly note?: string;
}

export interface RunbookDefinition {
  /** Unique identifier (e.g., 'task-completion') */
  readonly id: string;
  /** Workflow phase this runbook applies to */
  readonly phase: string;
  /** Human-readable description */
  readonly description: string;
  /** Ordered steps */
  readonly steps: readonly RunbookStep[];
  /** Variables the agent must supply (resolved from context) */
  readonly templateVars: readonly string[];
  /** Events auto-emitted by the steps (agent should NOT manually emit these) */
  readonly autoEmits: readonly string[];
}
```

#### 4.2 Runbook Definitions (Co-located Constants)

```typescript
// src/runbooks/definitions.ts
import type { RunbookDefinition } from './types.js';

export const TASK_COMPLETION: RunbookDefinition = {
  id: 'task-completion',
  phase: 'delegate',
  description: 'Complete a task after execution: run blocking gates, then mark complete.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'check_tdd_compliance', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'check_static_analysis', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'task_complete', onFail: 'stop' },
  ],
  templateVars: ['taskId', 'featureId', 'streamId'],
  autoEmits: ['gate.executed', 'task.completed'],
};

export const QUALITY_EVALUATION: RunbookDefinition = {
  id: 'quality-evaluation',
  phase: 'review',
  description: 'Run quality gates and compute review verdict.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'check_static_analysis', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'check_security_scan', onFail: 'continue' },
    { tool: 'exarchos_orchestrate', action: 'check_convergence', onFail: 'continue' },
    { tool: 'exarchos_orchestrate', action: 'check_review_verdict', onFail: 'stop' },
  ],
  templateVars: ['featureId'],
  autoEmits: ['gate.executed'],
};

export const AGENT_TEAMS_SAGA: RunbookDefinition = {
  id: 'agent-teams-saga',
  phase: 'delegate',
  description: 'Full delegation saga: create team, plan tasks, dispatch teammates, monitor, disband.',
  steps: [
    { tool: 'exarchos_event', action: 'append', onFail: 'stop',
      params: { type: 'team.spawned' },
      note: 'Event-first: emit before TeamCreate' },
    { tool: 'native:TeamCreate', action: 'create', onFail: 'stop' },
    { tool: 'exarchos_event', action: 'batch_append', onFail: 'stop',
      params: { type: 'team.task.planned' },
      note: 'Atomic batch: ALL task events in one call' },
    { tool: 'native:TaskCreate', action: 'create', onFail: 'stop',
      note: 'Create N tasks, then wire dependencies' },
    { tool: 'exarchos_workflow', action: 'set', onFail: 'stop',
      note: 'Store task correlation — orchestrator is sole writer of workflow.tasks[]' },
    { tool: 'exarchos_event', action: 'append', onFail: 'stop',
      params: { type: 'team.teammate.dispatched' },
      note: 'Emit per teammate. PIVOT POINT: past here, compensation is partial' },
    { tool: 'native:Task', action: 'spawn', onFail: 'stop',
      note: 'Spawn N teammates in worktrees' },
    { tool: 'exarchos_view', action: 'workflow_status', onFail: 'continue',
      note: 'Monitor: poll every 30-60s (~85 tokens)' },
    { tool: 'exarchos_event', action: 'append', onFail: 'stop',
      params: { type: 'team.disbanded' },
      note: 'Event-first: emit before SendMessage shutdown' },
    { tool: 'native:SendMessage', action: 'shutdown', onFail: 'continue',
      note: 'Shutdown N teammates, then TeamDelete' },
    { tool: 'exarchos_workflow', action: 'set', onFail: 'stop',
      params: { phase: 'review' },
      note: 'Auto-emits workflow.transition' },
  ],
  templateVars: ['featureId', 'streamId', 'teamId'],
  autoEmits: ['workflow.transition'],
};

export const SYNTHESIS_FLOW: RunbookDefinition = {
  id: 'synthesis-flow',
  phase: 'synthesize',
  description: 'Verify readiness, create PR, submit for merge.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'prepare_synthesis', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'run_script', onFail: 'stop',
      params: { script: 'validate-pr-body.sh' } },
    { tool: 'native:bash', action: 'gh_pr_create', onFail: 'stop',
      note: 'Create PR via gh CLI' },
    { tool: 'exarchos_workflow', action: 'set', onFail: 'stop',
      note: 'Record PR URL in artifacts.prUrl' },
  ],
  templateVars: ['featureId'],
  autoEmits: ['gate.executed'],
};

export const SHEPHERD_ITERATION: RunbookDefinition = {
  id: 'shepherd-iteration',
  phase: 'synthesize',
  description: 'Assess PR stack health, fix issues, re-push.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'assess_stack', onFail: 'stop',
      note: 'Returns actionItems[] and recommendation' },
    { tool: 'exarchos_event', action: 'append', onFail: 'continue',
      params: { type: 'shepherd.iteration' },
      note: 'Record iteration for convergence tracking' },
    { tool: 'exarchos_event', action: 'append', onFail: 'continue',
      params: { type: 'remediation.attempted' },
      note: 'Per action item: emit before fix attempt' },
    { tool: 'native:bash', action: 'fix', onFail: 'continue',
      note: 'Apply fixes for each action item' },
    { tool: 'exarchos_event', action: 'append', onFail: 'continue',
      params: { type: 'remediation.succeeded' },
      note: 'Per action item: emit after successful fix' },
    { tool: 'native:bash', action: 'push', onFail: 'stop',
      note: 'git push to trigger CI re-run' },
  ],
  templateVars: ['featureId', 'streamId'],
  autoEmits: ['ci.status', 'shepherd.started', 'shepherd.approval_requested', 'shepherd.completed'],
};

export const ALL_RUNBOOKS: readonly RunbookDefinition[] = [
  TASK_COMPLETION,
  QUALITY_EVALUATION,
  AGENT_TEAMS_SAGA,
  SYNTHESIS_FLOW,
  SHEPHERD_ITERATION,
];
```

#### 4.3 Runbook Action Handler

New action on `exarchos_orchestrate`:

```typescript
const runbookSchema = z.object({
  phase: z.string().optional()
    .describe('Filter runbooks by phase. Omit to list all.'),
  id: z.string().optional()
    .describe('Specific runbook ID. Returns full runbook with resolved schemas.'),
});
```

Two modes:

- **List mode** (`phase` only or no params): Returns available runbook IDs + descriptions for the phase. Cheap discovery — no schemas resolved.
- **Detail mode** (`id` provided): Returns full runbook with schemas resolved from registry for each step.

```typescript
async function handleRunbook(
  args: { phase?: string; id?: string },
  ctx: DispatchContext,
): Promise<ToolResult> {
  // List mode
  if (!args.id) {
    const filtered = args.phase
      ? ALL_RUNBOOKS.filter(r => r.phase === args.phase)
      : ALL_RUNBOOKS;
    return {
      success: true,
      data: filtered.map(r => ({
        id: r.id,
        phase: r.phase,
        description: r.description,
        stepCount: r.steps.length,
      })),
    };
  }

  // Detail mode
  const runbook = ALL_RUNBOOKS.find(r => r.id === args.id);
  if (!runbook) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_RUNBOOK',
        message: `Unknown runbook: ${args.id}`,
        validTargets: ALL_RUNBOOKS.map(r => r.id),
      },
    };
  }

  // Resolve schemas from registry at runtime
  const resolvedSteps = runbook.steps.map((step, i) => {
    const resolved: ResolvedRunbookStep = {
      seq: i + 1,
      tool: step.tool,
      action: step.action,
      onFail: step.onFail,
      params: step.params,
      note: step.note,
    };

    // Only resolve schemas for MCP tools (not native: prefixed)
    if (!step.tool.startsWith('native:')) {
      const action = findActionInRegistry(step.tool, step.action);
      if (action) {
        resolved.schema = zodToJsonSchema(action.schema);
        resolved.description = action.description;
        resolved.gate = action.gate ?? null;
      }
    }

    return resolved;
  });

  return {
    success: true,
    data: {
      id: runbook.id,
      phase: runbook.phase,
      description: runbook.description,
      steps: resolvedSteps,
      templateVars: runbook.templateVars,
      autoEmits: runbook.autoEmits,
    },
  };
}
```

#### 4.4 Resolved Runbook Response (What the Agent Sees)

```json
{
  "success": true,
  "data": {
    "id": "task-completion",
    "phase": "delegate",
    "description": "Complete a task after execution: run blocking gates, then mark complete.",
    "steps": [
      {
        "seq": 1,
        "tool": "exarchos_orchestrate",
        "action": "check_tdd_compliance",
        "onFail": "stop",
        "gate": { "blocking": true, "dimension": "D1" },
        "schema": {
          "type": "object",
          "properties": {
            "taskId": { "type": "string" },
            "featureId": { "type": "string" },
            "streamId": { "type": "string" }
          },
          "required": ["taskId"]
        },
        "description": "Verify TDD compliance — test-first discipline"
      },
      {
        "seq": 2,
        "tool": "exarchos_orchestrate",
        "action": "check_static_analysis",
        "onFail": "stop",
        "gate": { "blocking": true, "dimension": "D2" },
        "schema": { "..." },
        "description": "Run static analysis checks (lint + typecheck)"
      },
      {
        "seq": 3,
        "tool": "exarchos_orchestrate",
        "action": "task_complete",
        "onFail": "stop",
        "gate": null,
        "schema": { "..." },
        "description": "Mark a task as complete with provenance"
      }
    ],
    "templateVars": ["taskId", "featureId", "streamId"],
    "autoEmits": ["gate.executed", "task.completed"]
  }
}
```

### 5. Anti-Drift Architecture

#### 5.1 Zero-drift by construction (schemas)

Runbook definitions contain action references (`tool` + `action` strings), not schema copies. The `handleRunbook()` handler resolves schemas from the live registry at request time. If a schema changes, the runbook automatically returns the updated schema. **No maintenance required.**

#### 5.2 Zero-drift by construction (gate semantics)

Gate metadata (`blocking`, `dimension`) lives on the `ToolAction` definition in the registry. Runbooks inherit it via `action.gate`. If a gate changes from blocking to advisory, the action definition is the one place that changes. **No maintenance required.**

#### 5.3 Bidirectional sync tests (step references)

Following the proven pattern from `registry.test.ts` (`OrchestrateActions_MatchCompositeHandlers_InSync`):

```typescript
// src/runbooks/runbooks.test.ts

describe('Runbook drift prevention', () => {
  it('every runbook step references a valid registry action', () => {
    for (const runbook of ALL_RUNBOOKS) {
      for (const step of runbook.steps) {
        if (step.tool.startsWith('native:')) continue; // Skip native tools
        const action = findActionInRegistry(step.tool, step.action);
        expect(action).toBeDefined(
          `Runbook "${runbook.id}" step references unknown action: ${step.tool}.${step.action}`
        );
      }
    }
  });

  it('template vars cover required params for each MCP step', () => {
    for (const runbook of ALL_RUNBOOKS) {
      for (const step of runbook.steps) {
        if (step.tool.startsWith('native:')) continue;
        const action = findActionInRegistry(step.tool, step.action);
        if (!action) continue;
        const required = getRequiredFields(action.schema);
        for (const field of required) {
          const covered =
            runbook.templateVars.includes(field) ||
            (step.params && field in step.params) ||
            field === 'action'; // discriminator is auto-filled
          expect(covered).toBe(true,
            `Runbook "${runbook.id}" missing template var for required field "${field}" ` +
            `in ${step.tool}.${step.action}`
          );
        }
      }
    }
  });

  it('every blocking gate action appears in at least one runbook', () => {
    const referencedActions = new Set(
      ALL_RUNBOOKS.flatMap(r =>
        r.steps
          .filter(s => !s.tool.startsWith('native:'))
          .map(s => `${s.tool}.${s.action}`)
      )
    );
    for (const tool of getFullRegistry()) {
      for (const action of tool.actions) {
        if (action.gate?.blocking) {
          expect(referencedActions.has(`${tool.name}.${action.name}`)).toBe(true,
            `Blocking gate ${tool.name}.${action.name} is not referenced by any runbook`
          );
        }
      }
    }
  });

  it('autoEmits only lists events classified as auto in EVENT_EMISSION_REGISTRY', () => {
    for (const runbook of ALL_RUNBOOKS) {
      for (const eventType of runbook.autoEmits) {
        const source = EVENT_EMISSION_REGISTRY[eventType];
        expect(source).toBe('auto',
          `Runbook "${runbook.id}" lists "${eventType}" in autoEmits but ` +
          `EVENT_EMISSION_REGISTRY classifies it as "${source}"`
        );
      }
    }
  });

  it('runbook IDs are unique', () => {
    const ids = ALL_RUNBOOKS.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

#### 5.4 What tests catch

| Drift Scenario | Test That Catches It |
|---|---|
| Action renamed or removed | "every runbook step references a valid registry action" |
| Required param added to action | "template vars cover required params" |
| New blocking gate added but no runbook references it | "every blocking gate action appears in at least one runbook" |
| Runbook claims event is auto-emitted but it's model-emitted | "autoEmits only lists events classified as auto" |
| Duplicate runbook IDs | "runbook IDs are unique" |

#### 5.5 What tests don't catch

| Drift Scenario | Mitigation |
|---|---|
| Step ordering should change (e.g., swap gate order) | Code review — runbook diffs are small and readable |
| Handler behavior changes semantically (same params, different effect) | Integration tests that execute runbooks against test workflows |
| New multi-step pattern added but no runbook created | Reverse coverage test only catches blocking gates; non-gate sequences require review-time diligence |
| `onFail` semantics don't match handler behavior | Handler tests should verify error behavior independently |

### 6. Registration Schema Changes

#### `buildRegistrationSchema()` — No Change

The flattened union schema generation remains unchanged. In slim mode, the schema is still registered (MCP SDK requires it for input validation). Only the description changes.

#### `buildToolDescription()` — Dual Mode

```typescript
export function buildToolDescription(tool: CompositeTool, slim: boolean): string {
  if (slim) {
    return tool.slimDescription;
  }
  // Existing full description generation
  return buildFullDescription(tool);
}
```

#### New action registrations

Add to the registry:

```typescript
// On every composite tool:
{
  name: 'describe',
  schema: describeSchema,
  description: 'Return full schemas for specific actions',
  phases: new Set(['*']),
  roles: new Set(['any']),
}

// On exarchos_orchestrate only:
{
  name: 'runbook',
  schema: runbookSchema,
  description: 'List or retrieve runbooks for multi-step orchestration sequences',
  phases: new Set(['*']),
  roles: new Set(['any']),
}
```

### 7. Skill Integration

Skills currently document step sequences in prose. With runbooks, skills can reference them:

**Before (prose):**
```markdown
### Step 3: Task Completion

For each completed task:
1. **MANDATORY** — Run TDD compliance check: `exarchos_orchestrate({ action: "check_tdd_compliance", taskId, featureId })`
2. If passed, run static analysis: `exarchos_orchestrate({ action: "check_static_analysis", featureId })`
3. If passed, mark complete: `exarchos_orchestrate({ action: "task_complete", taskId, result })`
```

**After (runbook reference):**
```markdown
### Step 3: Task Completion

For each completed task, execute the `task-completion` runbook:
`exarchos_orchestrate({ action: "runbook", id: "task-completion" })`

Execute steps in order. Stop on gate failure.
```

Skills become shorter. Orchestration logic lives in one place (the runbook definition), not duplicated across skills and reference docs.

### 8. Token Budget Analysis

| Scenario | Today | Proposed |
|---|---|---|
| MCP registration (all 5 tools) | ~3,045 tokens | ~500-700 tokens (slim) |
| First action call (needs schema) | 0 (already loaded) | ~150-300 tokens (describe response) |
| Multi-step sequence (3 gates) | 3 × skill prose parsing | ~400 tokens (runbook response with 3 schemas) |
| Short session (checkpoint only) | ~3,045 tokens overhead | ~500 tokens overhead |
| Full workflow session | ~3,045 tokens overhead | ~700 + ~400 (runbook) = ~1,100 tokens |

**Net savings for short sessions:** ~2,345 tokens (~77% reduction)
**Net savings for full sessions:** ~1,945 tokens (~64% reduction) plus improved orchestration reliability

---

## Implementation Plan

### Phase 1: Foundation
1. Add `gate` metadata to all action definitions in the registry
2. Add `slimDescription` to each `CompositeTool`
3. Implement `describe` action on all composite handlers
4. Add slim registration mode to MCP adapter

### Phase 2: Runbook Protocol
5. Define `RunbookDefinition` types
6. Write initial runbook definitions (5 runbooks as specified above)
7. Implement `runbook` action on `exarchos_orchestrate`
8. Write bidirectional sync tests

### Phase 3: Skill Integration
9. Update skill references to point to runbooks instead of prose sequences
10. Measure token savings and orchestration reliability in eval framework

### Phase 4: Iteration
11. Add runbooks for additional patterns as they emerge
12. Consider `runbook` action on `exarchos_view` for read-heavy sequences
13. Evaluate whether runbook responses should include `_eventHints` for model-emitted events expected after the sequence completes

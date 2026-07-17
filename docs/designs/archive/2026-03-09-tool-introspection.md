# Design: Tool Introspection Phases 2-4

## Problem Statement

Phase 1 (#982) added HSM topology and event emission catalog to `describe`, enabling agents to discover workflow structure and event types. Three gaps remain:

1. **Emission context** — Agents know what events exist but not which tool actions trigger which auto-emissions. An agent can't discover that `workflow.set` with a `phase` param auto-emits `workflow.transition`.
2. **Playbook recipes** — The playbook registry (60+ phase playbooks) is only accessible via `handleGet` on active workflows. Plugin-free agents with no active workflow can't access phase choreography guidance.
3. **Skill drift** — 12+ skill files duplicate parameter schemas, phase transitions, and guard prerequisites that drift from the actual code.

Additionally, `RunbookDefinition.autoEmits` is manually declared but derivable from ToolAction emissions — a consolidation opportunity.

**Issue:** #981

## Chosen Approach

**ToolAction Metadata Extension** — extend existing patterns rather than introducing new abstractions.

Three proven codebase precedents drive this design:

1. **`ToolAction.gate`** (`registry.ts:25-28`) — per-action metadata returned by describe. Template for `autoEmits`.
2. **`RunbookDefinition.autoEmits`** (`runbooks/types.ts:36`) with drift tests (`runbooks/drift.test.ts:91-109`). Proves emission declaration + validation works.
3. **`topology` parameter** on workflow describe (`registry.ts:251-258`). Template for `playbook` parameter.

**Rationale:** Co-locating emission metadata with action definitions prevents drift. Optional `playbook` parameter follows topology wiring exactly. Deriving runbook emissions from ToolAction emissions eliminates manual sync. No new modules, no new abstractions — pure extension of existing patterns.

## Requirements

### DR-1: AutoEmission type and ToolAction.autoEmits field

Add an `AutoEmission` interface and optional `autoEmits` field to `ToolAction` in `registry.ts`. This follows the `gate?: GateMetadata` pattern — optional metadata attached to actions that emit events.

```typescript
export interface AutoEmission {
  readonly event: string;
  readonly condition: 'always' | 'conditional';
  readonly description?: string;
}

export interface ToolAction {
  // ...existing fields...
  readonly gate?: GateMetadata;
  readonly autoEmits?: readonly AutoEmission[];
}
```

**Acceptance criteria:**
- `AutoEmission` interface exported from `registry.ts`
- `ToolAction.autoEmits` is `readonly AutoEmission[] | undefined`
- Field is optional — actions with no auto-emissions omit it (like `gate`)
- TypeScript compiles with strict mode

### DR-2: Populate autoEmits across all tool actions

Audit every handler to extract the complete emission map and declare `autoEmits` on every action that auto-emits events. The mapping must be exhaustive — every `appendEvent`/`store.append` call in handler code must have a corresponding `autoEmits` entry.

**Known emissions from handler audit:**

| Tool | Action | Auto-Emits | Condition |
|------|--------|-----------|-----------|
| workflow | init | workflow.started | always |
| workflow | set | workflow.transition | when phase provided |
| workflow | set | state.patched | always |
| workflow | cancel | workflow.cancel | always |
| workflow | cancel | workflow.compensation | per compensation action |
| workflow | cleanup | workflow.cleanup | always |
| orchestrate | task_claim | task.claimed | always |
| orchestrate | task_complete | task.completed | always |
| orchestrate | task_fail | task.failed | always |
| orchestrate | check_static_analysis | gate.executed | always |
| orchestrate | check_security_scan | gate.executed | always |
| orchestrate | check_context_economy | gate.executed | always |
| orchestrate | check_operational_resilience | gate.executed | always |
| orchestrate | check_workflow_determinism | gate.executed | always |
| orchestrate | check_review_verdict | gate.executed | always |
| orchestrate | check_design_completeness | gate.executed | always |
| orchestrate | check_plan_coverage | gate.executed | always |
| orchestrate | check_tdd_compliance | gate.executed | always |
| orchestrate | check_post_merge | gate.executed | always |
| orchestrate | check_task_decomposition | gate.executed | always |
| orchestrate | check_provenance_chain | gate.executed | always |
| orchestrate | assess_stack | shepherd.started | first invocation (idempotent) |
| orchestrate | assess_stack | shepherd.iteration | conditional |
| orchestrate | assess_stack | shepherd.approval_requested | when approval needed |
| orchestrate | assess_stack | shepherd.completed | when PR merged |
| orchestrate | assess_stack | gate.executed | always |
| orchestrate | prepare_synthesis | gate.executed | always |
| orchestrate | prepare_delegation | quality.hint.generated | when hints exist |
| orchestrate | review_triage | review.routed | per PR |
| orchestrate | check_event_emissions | quality.hint.generated | when missing events found |

**Acceptance criteria:**
- Every action in `registry.ts` that auto-emits events has a populated `autoEmits` field
- Actions that do NOT auto-emit events omit `autoEmits` (not an empty array)
- All `autoEmits` event names are members of `EventTypes` or registered custom types
- All `autoEmits` events have `source: 'auto'` in `EVENT_EMISSION_REGISTRY`
- `condition` is `'always'` for unconditional emissions, `'conditional'` with a `description` for conditional ones

### DR-3: Include autoEmits in describe handler output

The `handleDescribe` function in `describe/handler.ts` already returns `gate` for each action. Add `autoEmits` to the response using the same pattern.

```typescript
// Current describe output per action:
{ description, schema, gate, phases, roles }

// New describe output per action:
{ description, schema, gate, phases, roles, autoEmits }
```

`autoEmits` is included when present on the ToolAction, omitted (not null) when absent. This matches how `gate` is handled — returned as `null` when absent, but `autoEmits` uses omission since it's an array (no meaningful null vs empty distinction needed).

**Acceptance criteria:**
- `handleDescribe` returns `autoEmits` field for actions that have it
- Actions without `autoEmits` omit the field from the response (not null, not empty array)
- Existing describe tests continue to pass
- New test: `HandleDescribe_ActionWithAutoEmits_ReturnsEmissionMetadata`
- New test: `HandleDescribe_ActionWithoutAutoEmits_OmitsField`

### DR-4: Emission drift test

Add a drift test in `registry.test.ts` validating that every `autoEmits` entry:
1. References a valid event type in `EVENT_EMISSION_REGISTRY`
2. Has `source: 'auto'` in the registry (not 'model' or 'hook')

This follows the exact pattern from `runbooks/drift.test.ts:91-109`.

Additionally, add a completeness test: for every action whose `description` contains the phrase "Auto-emits" or "Emits", verify that `autoEmits` is populated. This catches new emissions added to descriptions but not to metadata.

**Acceptance criteria:**
- Test: `RegistryDrift_AutoEmitsMatchEventEmissionRegistry` — every autoEmits entry is in EVENT_EMISSION_REGISTRY with source 'auto'
- Test: `RegistryDrift_DescriptionEmitsImpliesAutoEmitsField` — actions mentioning "emits" in description have autoEmits populated
- Tests fail if a new action auto-emits an event but doesn't declare it in autoEmits

### DR-5: Derive Runbook.autoEmits from ToolAction.autoEmits

Add a `computeRunbookAutoEmits(runbook)` utility that computes the deduplicated union of `autoEmits` event names across all non-native steps. Update the drift test to validate that manually declared `RunbookDefinition.autoEmits` matches the computed value.

```typescript
export function computeRunbookAutoEmits(runbook: RunbookDefinition): readonly string[] {
  const events = new Set<string>();
  for (const step of runbook.steps) {
    if (step.tool.startsWith('native:')) continue;
    const action = findActionInRegistry(step.tool, step.action);
    if (action?.autoEmits) {
      for (const emission of action.autoEmits) {
        events.add(emission.event);
      }
    }
  }
  return [...events].sort();
}
```

Keep `RunbookDefinition.autoEmits` as a declared field for readability but enforce consistency via drift test. This preserves the existing runbook interface while ensuring correctness.

**Acceptance criteria:**
- `computeRunbookAutoEmits` exported from `runbooks/` module
- Drift test `RunbookDrift_AutoEmitsMatchComputedFromToolActions` validates declared autoEmits matches computed
- Existing `RunbookDrift_AutoEmitsMatchEventEmissionRegistry` test preserved (validates against EVENT_EMISSION_REGISTRY)
- If a runbook's declared autoEmits diverges from computed, the drift test fails with a clear message showing expected vs actual

### DR-6: Playbook serialization functions

Add serialization functions to `playbooks.ts` following the pattern of `serializeTopology()` in `state-machine.ts` and `serializeEventCatalog()` in `schemas.ts`. Pure functions, no side effects.

```typescript
export interface SerializedPlaybooks {
  workflowType: string;
  phases: Record<string, SerializedPhasePlaybook>;
  phaseCount: number;
}

export interface SerializedPhasePlaybook {
  skill: string;
  skillRef: string;
  tools: readonly ToolInstruction[];
  events: readonly EventInstruction[];
  transitionCriteria: string;
  guardPrerequisites: string;
  validationScripts: readonly string[];
  humanCheckpoint: boolean;
  compactGuidance: string;
}

export function serializePlaybooks(workflowType: string): SerializedPlaybooks;
export function listPlaybookWorkflowTypes(): string[];
```

`serializePlaybooks` returns all playbooks for a workflow type keyed by phase name. `listPlaybookWorkflowTypes` returns distinct workflow types from the registry.

**Acceptance criteria:**
- `serializePlaybooks(workflowType)` returns all registered playbooks for that type
- `serializePlaybooks` throws for unknown workflow types
- `listPlaybookWorkflowTypes()` returns `['feature', 'debug', 'refactor']` (or current set)
- Both are pure functions (no state mutation, no I/O)
- Co-located tests in `playbooks.test.ts`

### DR-7: Playbook parameter on workflow describe

Add `playbook` parameter to the workflow describe schema, following the `topology` parameter pattern exactly.

```typescript
const workflowDescribeSchema = z.object({
  actions: z.array(z.string()).min(1).max(10)
    .describe('Action names to describe.').optional(),
  topology: z.string()
    .describe('Workflow type for HSM topology. "all" lists types.').optional(),
  playbook: z.string()
    .describe('Workflow type for phase playbooks. "all" lists types.').optional(),
});
```

The describe handler gets a `handlePlaybookDescribe(playbook: string)` function modeled on `handleTopologyDescribe()`:
- `"all"` → returns `listPlaybookWorkflowTypes()`
- Specific type → returns `serializePlaybooks(type)`
- Unknown type → error with `validTargets`

Update validation: at least one of `actions`, `topology`, or `playbook` must be provided.

**Acceptance criteria:**
- `playbook` parameter accepted on `exarchos_workflow describe`
- `playbook: "all"` returns list of workflow types
- `playbook: "feature"` returns serialized playbooks for feature workflow
- `playbook: "nonexistent"` returns error with `code: 'UNKNOWN_WORKFLOW_TYPE'` and `validTargets`
- `describe` still requires at least one of actions/topology/playbook
- Tests mirror topology describe tests

### DR-8: Schema introspection adapter for playbooks

Add `resolvePlaybookRef()` to `schema-introspection.ts` following the `resolveTopologyRef()` pattern. This enables CLI access to playbook data.

```typescript
export function resolvePlaybookRef(
  workflowType?: string
): SerializedPlaybooks | string[] {
  if (workflowType) return serializePlaybooks(workflowType);
  return listPlaybookWorkflowTypes();
}
```

**Acceptance criteria:**
- `resolvePlaybookRef()` exported from `schema-introspection.ts`
- CLI command `schema playbooks [type]` works (if CLI surface is wired)
- Returns `SerializedPlaybooks` for specific type, `string[]` for listing

### DR-9: Skill refactoring to reference describe

Audit each skill `SKILL.md` for content that duplicates `describe` output and replace with describe references. Retain strategy content (when to use, scope assessment, track selection). Remove mechanical content (parameter schemas, phase transition tables, guard prerequisite tables, event payload examples).

**Content classification:**

| Content Type | Action | Example |
|-------------|--------|---------|
| Parameter schemas | Remove, add describe reference | "featureId: string, workflowType: ..." |
| Phase transition tables | Remove, add describe reference | "ideate → plan: design-artifact-exists" |
| Guard prerequisite tables | Remove, add describe reference | "Set artifacts.design to transition" |
| Inline tool call examples | Keep if strategic, remove if mechanical | Keep: "Use set with phase to transition". Remove: full JSON example |
| Workflow strategy | Keep | "Use polish for <=5 files" |
| When-to-use guidance | Keep | "Use /debug for broken code, /refactor for messy code" |
| Anti-pattern tables | Keep | "Don't skip exploration" |

**Replacement pattern:**
```markdown
### Schema Discovery
Use `exarchos_workflow({ action: "describe", actions: ["set", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "<type>" })`
for phase transitions, guards, and playbook guidance.
```

**Acceptance criteria:**
- Every skill that currently includes inline parameter schemas adds a "Schema Discovery" section referencing describe
- Phase transition tables removed from skills where they duplicate playbook data
- Strategy content preserved verbatim (when-to-use, scope assessment, track selection, anti-patterns)
- No skill loses information — anything removed must be discoverable via describe
- Skills that don't reference MCP tools are unchanged (e.g., utility skills)

### DR-10: Error handling and edge cases

All new introspection endpoints must handle errors gracefully with helpful messages.

**Acceptance criteria:**
- Unknown workflow type in `playbook` parameter returns `{ code: 'UNKNOWN_WORKFLOW_TYPE', validTargets: [...] }` (matches topology error pattern)
- `autoEmits` with an event type not in `EVENT_EMISSION_REGISTRY` fails the drift test at build time, not at runtime
- `describe` with no parameters still returns clear error with `expectedShape` including new `playbook` option
- `serializePlaybooks` for a workflow type with no registered playbooks returns empty `phases` (not an error)
- All error responses include `validTargets` or `expectedShape` for agent self-correction

## Technical Design

### Data Flow

```
                    ToolAction.autoEmits          PhasePlaybook
                    (per-action metadata)         (per-phase guidance)
                           │                            │
                           ▼                            ▼
                   ┌──────────────┐            ┌──────────────────┐
                   │   describe   │            │ describe         │
                   │   handler    │◄───────────│ --playbook       │
                   │              │            │ parameter        │
                   └──────┬───────┘            └──────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        action schema  gate meta  autoEmits
        (existing)    (existing)  (new)
```

### File Changes

**Modified files:**
- `servers/exarchos-mcp/src/registry.ts` — `AutoEmission` interface, `autoEmits` on actions
- `servers/exarchos-mcp/src/describe/handler.ts` — `autoEmits` in output, `handlePlaybookDescribe()`
- `servers/exarchos-mcp/src/workflow/playbooks.ts` — `serializePlaybooks()`, `listPlaybookWorkflowTypes()`
- `servers/exarchos-mcp/src/adapters/schema-introspection.ts` — `resolvePlaybookRef()`
- `servers/exarchos-mcp/src/runbooks/drift.test.ts` — computed autoEmits validation
- `skills/*/SKILL.md` — ~12 skill files (remove duplicated schemas/tables)

**New files:**
- None. All changes extend existing files.

**Test files (co-located):**
- `servers/exarchos-mcp/src/registry.test.ts` — emission drift tests
- `servers/exarchos-mcp/src/describe/handler.test.ts` — autoEmits and playbook tests
- `servers/exarchos-mcp/src/workflow/playbooks.test.ts` — serialization tests

### Context Economy Considerations

- `autoEmits` is always included in describe output (0-5 entries per action, ~20 tokens — comparable to `gate`)
- `playbook` is opt-in via parameter (can return 60+ playbooks — too large for default inclusion)
- Skill files shrink by ~20-30% after removing duplicated content

## Integration Points

1. **Registry → Describe handler** — `autoEmits` flows through existing action metadata serialization
2. **Playbooks → Describe handler** — new parameter, new internal handler function
3. **Describe handler → Adapter** — `resolvePlaybookRef()` follows `resolveTopologyRef()` pattern
4. **ToolAction → Runbook drift** — `computeRunbookAutoEmits()` cross-references registry
5. **Skills → Describe** — editorial changes only, no code integration

## Testing Strategy

**Unit tests:**
- `AutoEmission` type validation
- `serializePlaybooks()` for each workflow type
- `handlePlaybookDescribe()` success and error paths
- `computeRunbookAutoEmits()` for each runbook

**Drift tests (build-time validation):**
- `RegistryDrift_AutoEmitsMatchEventEmissionRegistry` — autoEmits entries have source 'auto'
- `RegistryDrift_DescriptionEmitsImpliesAutoEmitsField` — description consistency
- `RunbookDrift_AutoEmitsMatchComputedFromToolActions` — runbook/registry consistency

**Integration tests:**
- Full describe call with `actions + playbook + topology` returns composed response
- Skill files reference describe endpoints that actually exist

## Open Questions

None — all design decisions resolved during brainstorming.

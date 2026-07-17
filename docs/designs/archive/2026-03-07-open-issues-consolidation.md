# Design: Open Issues Consolidation

Addresses: #968, #952, #350 (rescoped)

## Problem Statement

Three open issues remain actionable after triage. Rather than three separate workflows, this design consolidates them into a single implementation effort with three tracks:

1. **CI eval wiring (#968)** — Wire `RUN_EVALS=1` into `ci.yml` when prompt-related paths change
2. **Event emitter gaps (#952)** — Wire remaining unimplemented event emitters (shepherd lifecycle, task.progressed playbook, eval.judge.calibrated, cleanup dead schemas)
3. **Post-GA extensibility (#350)** — Extend event schema registry, view materializer registry, and tool registry to be config-driven

## Design Constraints

- Track 1 is CI-only — no MCP server changes
- Track 2 is server-only — playbook updates, auto-emission wiring, schema cleanup
- Track 3 builds on the existing `defineConfig()` / `registerWorkflowType()` patterns from PR #963
- All tracks are independent and parallelizable

---

## Track 1: CI Eval Wiring (#968)

### Current State

- `eval-gate.yml` already runs the production eval pipeline on prompt-related path changes
- 3 vitest integration tests in `harness.test.ts` and `llm-rubric.test.ts` are gated behind `RUN_EVALS=1`
- `ci.yml` already uses `dorny/paths-filter@v3` with `root` and `mcp` filter groups

### Change

Add a third filter group `prompts` to the existing `dorny/paths-filter` in `ci.yml` that detects prompt-related paths. When triggered, set `RUN_EVALS=1` in the `test-mcp` job's environment.

```yaml
# In the changes job, add:
prompts:
  - 'skills/**'
  - 'commands/**'
  - 'rules/**'
  - 'evals/**'
  - 'servers/exarchos-mcp/src/evals/**'
  - 'servers/exarchos-mcp/src/workflow/playbooks.ts'

# In the test-mcp job, add conditional env:
env:
  RUN_EVALS: ${{ needs.changes.outputs.prompts == 'true' && '1' || '' }}
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Files Changed

- `.github/workflows/ci.yml`

---

## Track 2: Event Emitter Gaps (#952)

### Verified Gap Analysis (March 7, 2026)

**True gaps (@planned, no emitters, no playbook):**

| Event | Action Required |
|-------|----------------|
| `shepherd.started` | Wire auto-emission in assess-stack when first shepherd iteration begins |
| `shepherd.approval_requested` | Wire auto-emission when assess-stack determines approval is needed |
| `shepherd.completed` | Wire auto-emission when shepherd status resolves to healthy/merged |
| `team.context.injected` | Remove — not referenced in any playbook, view handler is a no-op |

**Partial gaps (views ready, playbook missing):**

| Event | Action Required |
|-------|----------------|
| `task.progressed` | Add to delegate playbook: instruct model to emit with TDD phase data |
| `eval.judge.calibrated` | Wire auto-emission in grader calibration flow (eval harness already emits run events) |

### 2a. Shepherd Lifecycle Events

The shepherd operates as an iteration loop within the `synthesize` phase via `assess-stack`. Currently, `assess-stack.ts` queries `shepherd.iteration` events but doesn't emit shepherd lifecycle events.

**Approach:** Auto-emit shepherd lifecycle events from `assess-stack` orchestration:

- `shepherd.started` — Emit on first `assess-stack` invocation for a workflow (check: no prior `shepherd.started` event exists)
- `shepherd.approval_requested` — Emit when assess-stack determines all checks pass and approval is the next action
- `shepherd.completed` — Emit when assess-stack detects the PR is merged or when workflow transitions out of synthesize

The shepherd-status-view already handles `shepherd.iteration` events. Adding handlers for `started`, `approval_requested`, and `completed` gives the view complete lifecycle tracking.

### 2b. Task Progress Playbook

Add `task.progressed` instruction to the delegate phase playbook in `playbooks.ts`:

```
After each TDD phase transition (red → green → refactor), emit:
  exarchos_event({ action: "append", featureId, type: "task.progressed",
    data: { taskId, tddPhase: "red"|"green"|"refactor", detail: "..." } })
```

Three views already consume this event: `workflow-state-projection`, `unified-task-view`, `task-detail-view`.

### 2c. Eval Judge Calibration

Wire `eval.judge.calibrated` emission into the LLM rubric grader when calibration metrics (TPR/TNR/F1) are computed. The `eval-results-view` already has a `calibrations[]` array ready to consume this.

### 2d. Schema Cleanup

Remove `team.context.injected` schema and its view handler stub — it's @planned with no playbook reference and no real view handler (just a case statement with no action). If needed later, it can be re-added with a proper design.

### Files Changed

- `servers/exarchos-mcp/src/orchestrate/assess-stack.ts` — shepherd lifecycle emissions
- `servers/exarchos-mcp/src/views/shepherd-status-view.ts` — add handlers for started/approval_requested/completed
- `servers/exarchos-mcp/src/workflow/playbooks.ts` — task.progressed instruction
- `servers/exarchos-mcp/src/evals/graders/llm-rubric.ts` — eval.judge.calibrated emission
- `servers/exarchos-mcp/src/event-store/schemas.ts` — remove team.context.injected
- `servers/exarchos-mcp/src/views/workflow-state-projection.ts` — remove team.context.injected case

---

## Track 3: Post-GA Extensibility (#350 rescoped)

### Current State

PR #963 delivered config-driven custom workflows:
- `defineConfig()` in `config/define.ts`
- Config loader in `config/loader.ts` (dynamic import of `exarchos.config.ts`)
- HSM registry extension in `workflow/state-machine.ts` (`registerWorkflowType()`)
- WorkflowType schema extension in `workflow/schemas.ts` (`extendWorkflowTypeEnum()`)
- Custom guard execution in `config/guards.ts`

### Remaining: Three Registry Extensions

#### 3a. Event Schema Registry Extension

Allow custom event types to be defined in `exarchos.config.ts`:

```typescript
export default defineConfig({
  workflows: { /* existing */ },
  events: {
    'deploy.started': {
      source: 'auto',
      schema: z.object({
        environment: z.string(),
        version: z.string(),
      }),
    },
    'deploy.completed': {
      source: 'auto',
      schema: z.object({
        environment: z.string(),
        duration: z.number(),
        success: z.boolean(),
      }),
    },
  },
});
```

Implementation:
- Add `events` field to `ExarchosConfig` schema in `config/loader.ts`
- Add `registerEventType()` to `event-store/schemas.ts` (parallel to `registerWorkflowType()`)
- Wire registration in `config/register.ts` alongside workflow registration
- Validate that custom event types don't collide with built-in types
- Custom events get the same telemetry, hints, and trace treatment as built-in events

#### 3b. View Materializer Registry Extension

Allow custom view projections via config:

```typescript
export default defineConfig({
  views: {
    'deploy-status': {
      events: ['deploy.started', 'deploy.completed'],
      handler: './views/deploy-status.ts',  // Path to handler module
    },
  },
});
```

Implementation:
- Add `views` field to `ExarchosConfig`
- Add `registerView()` to `views/registry.ts` (new file, extracts from current hardcoded wiring)
- View handler modules export a standard interface: `{ initialState(), handle(state, event) }`
- Custom views appear in `exarchos_view` as new action targets
- Dynamic import of handler modules at startup

#### 3c. Tool Registry Extension

Allow custom tool actions via config:

```typescript
export default defineConfig({
  tools: {
    'deploy': {
      description: 'Deployment lifecycle management',
      actions: [
        {
          name: 'trigger',
          description: 'Trigger a deployment',
          schema: z.object({ environment: z.string(), version: z.string() }),
          handler: './tools/deploy-trigger.ts',
        },
      ],
    },
  },
});
```

Implementation:
- Add `tools` field to `ExarchosConfig`
- Extend `TOOL_REGISTRY` to accept dynamic registrations (currently static array)
- Custom tools get CLI commands and MCP exposure automatically (existing registry-driven generation)
- Handler modules export `async (args, stateDir) => ToolResult`

### Files Changed

- `servers/exarchos-mcp/src/config/define.ts` — extend ExarchosConfig type
- `servers/exarchos-mcp/src/config/loader.ts` — validate new config sections
- `servers/exarchos-mcp/src/config/register.ts` — wire event/view/tool registration
- `servers/exarchos-mcp/src/event-store/schemas.ts` — `registerEventType()`
- `servers/exarchos-mcp/src/views/registry.ts` — new view registry (extract from hardcoded wiring)
- `servers/exarchos-mcp/src/core/registry.ts` — extend TOOL_REGISTRY for dynamic registration

---

## Implementation Order

Tracks are independent and can be delegated in parallel:

1. **Track 1** (CI eval wiring) — Single file change, no tests needed beyond CI validation
2. **Track 2** (event emitters) — Server changes with co-located tests, medium effort
3. **Track 3** (extensibility registries) — Largest track, can be sub-divided into 3a/3b/3c

Track 2 and Track 3 share some files (`schemas.ts`, `register.ts`) but touch different concerns — Track 2 wires existing schemas, Track 3 makes schemas extensible. They should be sequenced: Track 2 first (wires the existing events), Track 3 second (makes the system extensible for new events).

## Testing Strategy

- **Track 1:** Verify via CI workflow run on a PR touching `skills/`
- **Track 2:** Co-located tests for each emission point. Property: events emitted match playbook expectations. Shepherd lifecycle events tested via assess-stack integration tests.
- **Track 3:** Config loading tests (custom events/views/tools register correctly), registration tests (collision detection, built-in protection), integration tests (custom view responds to custom events)

## Success Criteria

1. `RUN_EVALS=1` tests run automatically in CI when prompt-related files change
2. All events in schemas.ts either have emitters or are removed
3. Shepherd lifecycle has complete event coverage (started → iterations → completed)
4. Custom event types, views, and tools can be defined in `exarchos.config.ts`
5. Custom registrations appear in both CLI and MCP surfaces automatically

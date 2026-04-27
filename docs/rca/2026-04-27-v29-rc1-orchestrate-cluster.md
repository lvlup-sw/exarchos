# RCA: v2.9.0-rc.1 Orchestrate/Views/Tasks Cluster (#1187, #1188, #1189, #1190)

**Date:** 2026-04-27
**Anchor issue:** #1188 (parent-tool default-key leak — the cascade trigger)
**Cluster:** #1187, #1189, #1190
**Workflow:** `debug-v29-rc1-orchestrate-cluster`
**Reproduction context:** `refactor-projection-state-patched-fold` workflow, 2026-04-26 (same session that produced PR #1185)

## Summary

Four bugs filed against v2.9.0-rc.1 share a common dimension: **schema/contract integrity at the boundary** (DIM-3 in axiom backend-quality taxonomy). Each defect is a different surface of the same underlying issue — payload shapes drift between producer and consumer, and the existing safety nets (Zod `.strict()`, runtime preconditions, projection event types) reject or silently drop the misshapen data without telling the caller what shape was expected.

| # | Surface | Producer | Consumer | What drifts |
|---|---------|----------|----------|-------------|
| #1187 | View output | `discoverStreams()` | `handleViewPipeline` | Stream-id taxonomy: feature vs infra |
| #1188 | Per-action validation | MCP SDK auto-defaults | `dispatch()` per-action `safeParse` | Sibling-action keys leak across discriminated union |
| #1189 | Gate consultation | Manually-emitted `gate.executed` | `hasPassingGate` | `data.taskId` shape: top-level vs `data.details.taskId` |
| #1190 | Skill instruction | `prepare_delegation` precondition check | Operator (skill reader) | `task.assigned` event is required but undocumented |

These are post-PR-1185 follow-ups. The event-store and projection cluster (#1179, #1180, #1182, #1184) hardened the *event* contract; this cluster hardens the *dispatch and view* contracts.

## Defect 1: Pipeline View Phantom Rows (#1187)

### Symptom

`exarchos view ls` (CLI) and `exarchos_view pipeline` (MCP) return rows where `featureId`, `workflowType`, and `phase` are empty strings, even when `workflow_state` is empty. The phantoms come from infrastructure event streams (`exarchos-init`, `exarchos-doctor`, `telemetry`).

### Root Cause

`servers/exarchos-mcp/src/views/tools.ts:399-443` (`handleViewPipeline`) materializes every stream returned by `discoverStreams()`. The `PIPELINE_VIEW` projection's initial state has empty strings for `featureId`/`workflowType`/`phase`. Infrastructure streams never emit `workflow.started`, so their materialized state remains in the initial-empty shape — but the loop at line 412 pushes them onto `allWorkflows` regardless.

Three stream IDs are reserved for non-feature use across three modules:

- `INIT_STREAM_ID = 'exarchos-init'` — `orchestrate/init/index.ts:42`
- `DOCTOR_STREAM_ID = 'exarchos-doctor'` — `orchestrate/doctor/index.ts:116`
- `TELEMETRY_STREAM = 'telemetry'` — `telemetry/constants.ts:1`

No shared module enumerates them. The view layer has no way to distinguish "feature stream" from "infra stream" without hard-coding the names.

### Fix

Introduce `servers/exarchos-mcp/src/core/infra-streams.ts` re-exporting the three constants as a `INFRA_STREAM_IDS: ReadonlySet<string>` and a `isFeatureStream(streamId): boolean` predicate. Filter `discoverStreams()` output through `isFeatureStream` in `handleViewPipeline` before materialization.

This is the **Specification pattern** (predicate as a first-class value) plus **DRY** (single source of truth — the existing per-module constants are imported, not duplicated).

## Defect 2: Orchestrate Parent-Tool Default-Key Leak (#1188)

### Symptom

Every call to `exarchos_orchestrate({ action: "check_tdd_compliance", ... })` rejects with:

```
INVALID_INPUT: (root): Unrecognized key(s) in object: 'nativeIsolation', 'outputFormat'
```

The keys are not in the caller's payload. They are defaults from sibling action schemas (`nativeIsolation` from `prepare_delegation`, `outputFormat` from `agent_spec`).

Cascade impact: `task_complete` requires `tdd-compliance` to have passed. Because `check_tdd_compliance` is unreachable, every `task_complete` call in the delegate phase returns `GATE_NOT_PASSED`.

### Root Cause

`servers/exarchos-mcp/src/registry.ts:134-173` (`buildRegistrationSchema`) flattens every per-action schema into one parent `z.object().strict()` discriminated by `action`. At line 167:

```typescript
shape[key] = field.isOptional() ? field : field.optional();
```

Fields keep their `.default()` wrappers from the originating per-action schema. When the MCP SDK validates the caller's payload against this parent schema, Zod applies the defaults: every payload, regardless of action, gets `nativeIsolation: false` and `outputFormat: 'full'` injected.

`servers/exarchos-mcp/src/core/dispatch.ts:311-319` then re-validates against the matching action's per-action schema:

```typescript
const { action: _action, ...rest } = args;
const parsed = matchingAction.schema.safeParse(rest);
```

If that schema is `.strict()` (like `check_tdd_compliance` at `registry.ts:926-934`), `rest` contains the leaked defaults that the per-action schema does not declare → rejection.

Per-action `.strict()` is the right safety choice (catches caller typos). The problem is the parent schema injecting cross-action keys before the per-action validator sees the payload.

### Fix

In `core/dispatch.ts`, before per-action `safeParse`, drop only keys declared on a *sibling* action's schema. Keys declared on the matching action's schema, and keys not declared on any action, both pass through. The leaked sibling defaults disappear; caller typos still hit `.strict()` and are reported with a clear unrecognized-key error.

```typescript
const actionShape = (matchingAction.schema as { shape?: Record<string, unknown> }).shape;
const siblingKeys = new Set<string>();
for (const a of registeredTool.actions) {
  if (a === matchingAction) continue;
  const shape = (a.schema as { shape?: Record<string, unknown> }).shape;
  if (shape && typeof shape === 'object') {
    for (const k of Object.keys(shape)) siblingKeys.add(k);
  }
}
const cleaned = Object.fromEntries(
  Object.entries(rest).filter(([k]) => {
    const inAction = !!actionShape && Object.prototype.hasOwnProperty.call(actionShape, k);
    if (inAction) return true;
    return !siblingKeys.has(k); // keep unknown caller keys; drop only leaked sibling defaults
  })
);
const parsed = matchingAction.schema.safeParse(cleaned);
```

Pure function, single boundary, preserves `.strict()` typo-detection on caller-supplied keys (the only stripped keys are ones that belong to a sibling action's schema, which is exactly the parent-default leak surface).

This is **Tolerant Dispatch** — the boundary tolerates upstream's well-meaning over-supply while the per-action schema retains its strict contract for caller-originated keys. Analogous to Microsoft's [forward-compatible data contracts](https://learn.microsoft.com/dotnet/framework/wcf/feature-details/forward-compatible-data-contracts) (extra fields ignored at deserialization).

## Defect 3: task_complete Gate Consultation (#1189)

### Symptom

`task_complete` enforces a `tdd-compliance` gate precondition. When a `gate.executed` event with `passed: true` is manually emitted to the event store and then `task_complete` is called, the handler returns `GATE_NOT_PASSED` — it does not see the manually-emitted gate.

The only override is `evidence.type === 'manual'` (added by #940 closed 2026-03-01). Any other `evidence.type` (`test`, `build`, `typecheck`) does not bypass — even with `evidence.passed === true`.

### Root Cause

`servers/exarchos-mcp/src/tasks/tools.ts:206-233` has two compounding issues:

**(a) Schema-shape mismatch in `hasPassingGate`** (lines 212-219):

```typescript
const hasPassingGate = (gateName: string): boolean =>
  gateEvents.some((e) => {
    const d = e.data as Record<string, unknown> | undefined;
    if (!d) return false;
    const details = d.details as Record<string, unknown> | undefined;
    return d.gateName === gateName && d.passed === true &&
      (details != null && (!details.taskId || details.taskId === args.taskId));
  });
```

The check requires `details != null` and reads `details.taskId`. Manually-emitted events that put `taskId` at `data.taskId` (the natural place for an operator following the gate-event schema as documented) match `data.gateName` and `data.passed` but fail `details != null`. Result: every operator-supplied gate event is silently dropped.

**(b) Narrow `manualBypass` (line 207):**

```typescript
const manualBypass = args.evidence?.type === 'manual' && args.evidence.passed === true;
```

Conflates two orthogonal concerns: *what kind of proof* (`evidence.type`) and *whether to skip prerequisites* (`bypass`). The intent of `evidence.passed === true` is "I have evidence the work succeeded" — independent of the proof type.

### Fix

Two complementary changes — both Tolerant Reader (Postel's Law) applied at the same boundary:

1. **Broaden `hasPassingGate`** to accept `taskId` at either `data.taskId` (top level) or `data.details.taskId` (nested), preserving back-compat with handler-emitted events while accepting operator-emitted events.
2. **Broaden the evidence bypass** to accept any `evidence?.passed === true` *and* a non-empty `evidence.output` (after trimming whitespace), regardless of `evidence.type`. The non-empty-output guard is a sanity check — it preserves the "substantive proof" intent of the original `manual` bypass while removing the type-tag conflation. This separates evidence-type-tag from override-mechanism per **SRP**.

The two changes are independent — either alone would unblock the issue's repro. Both together close the loop.

This is the **Tolerant Reader pattern** (Fowler) / forward-compatible deserialization (Microsoft data-contract guidance): accept extra/alternative shapes at read time without requiring the producer to know the canonical layout.

## Defect 4: prepare_delegation Undocumented Precondition (#1190)

### Symptom

The delegation skill (`skills-src/delegation/SKILL.md`) instructs Step 1 = call `prepare_delegation`. The action returns `{ ready: false, blockers: ["no task.assigned events found — emit task.assigned events for each task via exarchos_event before calling prepare_delegation"] }` even though `task.assigned` is *not* listed in the skill's event-contract table (line 142-156). Operators discover the requirement only by attempting the call.

Same UX defect class as #1029 (closed 2026-03-14), which fixed the `quality.queried` version of the same gap. The fix was incomplete — `task.assigned` was missed.

### Root Cause

Two factors:

1. **DelegationReadinessView** (`servers/exarchos-mcp/src/views/delegation-readiness-view.ts:138-156`) counts `task.assigned` events to determine `taskCount`. The skill's event-contract table lists `team.task.planned` (team-scoped, agent-teams mode) but not `task.assigned` (feature-scoped, canonical task initialization). The codebase doesn't explain why both events exist.

2. **Adjacent UX nit:** `prepare_delegation` returns `{ blocked: true, reason: "current-branch-protected", currentBranch: "main" }` (`prepare-delegation.ts:301-321`) with no remediation hint. Resolution requires reading `CLAUDE.md`'s Workflow Dispatch Conventions section.

### Fix

**Option C (hybrid)** from the issue body — lowest UX friction, minimal code surface:

1. **Skill update** (`skills-src/delegation/SKILL.md`):
   - Add `task.assigned` row to event-contract table with "When: before `prepare_delegation`"
   - Reframe Step 1: "validates readiness; canonical preconditions live in `exarchos_orchestrate describe(['prepare_delegation'])`" — making `describe` the authoritative spec (mirrors the #1029 pattern of "when in doubt, query the runtime")

2. **Handler hint** (`prepare-delegation.ts`):
   - Add `hint: "checkout the feature/phase branch before dispatching delegation"` to the `current-branch-protected` blocker payload

**Rejecting Option B (drop precondition server-side):** would require migrating readiness-counting from `task.assigned` (feature-scope, mode-agnostic) to `team.task.planned` (team-scope, agent-teams-mode only). Different semantics. Higher risk than the docs+hint approach.

## Cross-Cutting (#1109) Verification

| Constraint | Each fix |
|------------|----------|
| **Event-sourcing integrity** | No new events emitted; #1189's `hasPassingGate` becomes more tolerant in *reading* `gate.executed` events; output of every projection remains reconstructable from the event log alone. |
| **MCP parity** | Every code-side fix is in shared core (`views/tools.ts`, `core/dispatch.ts`, `tasks/tools.ts`, `orchestrate/prepare-delegation.ts`) — both CLI and MCP facades dispatch through the same handlers, so behavior is uniform by construction. |
| **Basileus-forward** | No fix introduces a local-only assumption. The `infra-streams.ts` predicate is transport-agnostic; dispatch tolerance is transport-agnostic. |
| **Capability resolution** | None of the fixes touch capability/handshake state — no yaml-vs-handshake reads added or modified. |

## Backend-Quality Dimension Mapping

| Defect | Primary | Secondary |
|--------|---------|-----------|
| #1187 | DIM-3 (Contracts: stream-id taxonomy) | DIM-2 (Observability: phantom-row noise) |
| #1188 | DIM-1 (Topology: cross-action ambient state) | DIM-3 (Contracts: schema-dispatch invariant) |
| #1189 | DIM-3 (Contracts: gate-event shape) | DIM-7 (Resilience: silent drop of valid evidence) |
| #1190 | DIM-3 (Contracts: undocumented preconditions) | DIM-2 (Observability: runtime-only blocker discovery) |

## Contributing Factors

- [x] Missing test coverage — none of the four bugs had a regression test before this RCA
- [x] Edge case not considered — each defect is a "happy-path tested, degenerate-input untested" pattern
- [x] Inadequate cross-module discoverability — infra-stream constants live in three modules; gate-event shape is implicit; preconditions are runtime-only
- [ ] Race condition / timing issue (n/a)
- [ ] External dependency failure (n/a)

## Prevention

### Immediate (this PR)

- [x] Centralize `INFRA_STREAM_IDS` in shared `core/infra-streams.ts` (one fact, one place)
- [x] Add Tolerant Dispatch helper in `core/dispatch.ts` (boundary normalization)
- [x] Apply Tolerant Reader to `hasPassingGate` (accept canonical and operator shapes)
- [x] Add regression tests for all four defects (the missing dimension above)
- [x] Reframe delegation Step 1 around `describe()` (runtime is the spec)

### Longer-term

- [ ] Audit other discriminated-union schemas in `registry.ts` for cross-action default leakage (this could affect any per-action schema with `.strict()`)
- [ ] Audit other gate handlers in `tasks/tools.ts` for the same `data.taskId` vs `data.details.taskId` shape ambiguity
- [ ] Consider a generic "describe-driven preconditions" generator so skills cannot drift from runtime checks (would have prevented #1029 and #1190)

## Timeline

| Event | Date | Notes |
|-------|------|-------|
| Reported | 2026-04-26 | Issues #1187, #1188, #1189, #1190 filed during `refactor-projection-state-patched-fold` workflow |
| Investigated | 2026-04-27 | Five parallel Explore agents; ~30 min total |
| Fixed | 2026-04-27 | This PR |
| Verified | TBD | Pending merge + post-merge eval-capture run |

## Related

- Parent cluster: `docs/rca/2026-04-26-v29-event-projection-cluster.md` (PR #1185, the *event/projection* half of v2.9.0-rc.1 hardening)
- Issues: #1187, #1188, #1189, #1190
- Closed sibling: #940 (manual-evidence bypass — too narrow, broadened here), #1029 (delegation precondition gap — incomplete fix, completed here), #971 (PID-lock for cross-process EventStore — orthogonal but referenced by #1188 cascade context), #1184 (4 of 5 sub-bugs in PR #1185; sub-bug 5 confirmed already-fixed during this RCA's investigation, issue closed 2026-04-27)
- Cross-cutting: #1109 (event-sourcing + MCP parity + Basileus-forward invariants)

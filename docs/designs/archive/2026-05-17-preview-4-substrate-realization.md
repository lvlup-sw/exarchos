# Design — v2.10.0-preview.4 Substrate Realization

> **Status:** Design
> **Author:** @rsalus
> **Opened:** 2026-05-17
> **Bundle:** Closes #1436 + #1440 (partial: Op 1 + Op 2 + Op 4)
> **Parent epic:** #1441 — v2.10.0-preview.4 polish + post-bundle follow-ups
> **Predecessor design:** `docs/designs/2026-05-17-preview-4-substrate-hygiene.md` (#1450)

## 1. Context

The v2.10.0-preview.4 bundle (PRs #1421–#1435) landed two substrates whose realized utility is currently narrower than the infrastructure justifies:

- **Elicitation form-mode** (PR #1424) shipped the round-trip plumbing through `dispatch/core/dispatch.ts:811-855` and wired `createElicitationClient` against SDK 1.29 `server.elicitInput` in `adapters/mcp.ts:266`. The CodeRabbit MAJOR finding caught a "wired-but-not-invoked" class of failure (the gate always failed `elicitationClient !== undefined`). The fix landed pre-merge, but **no integration test verifies the path actually fires end-to-end against a real MCP client.** (#1436)
- **Tasks dispatch-core** (PR #1273, split C1/C2/C3) shipped the shared dispatch surface between CLI `--follow` and MCP `tasks/*` methods, with INV-2 facade equivalence verified and `EventSourcedTaskStore` projection proven via REPLAY test. **The substrate is correct.** The realized utility is three production callsites: `view workflow_status --follow`, `view shepherd_status --follow`, and the MCP `tools/call` `task: { ttl }` opt-in. (#1440 — 5 unrealized opportunities)

The companion hygiene wave (#1450, 2026-05-18) closed the substrate's correctness debt. This bundle closes the **realization debt**: moving substrate from "shipped and correct" to "actually used and verified end-to-end."

Five unrealized opportunities are catalogued in #1440. This design scopes three of them (Op 1, Op 2, Op 4) plus the elicitation E2E gap (#1436). Op 3 (workflow verb wiring) and Op 5 (SSE) are deferred to dedicated designs — rationale in §7.

## 2. Goals

- **Verification:** prove the elicitation form-mode round-trip works end-to-end against a real MCP client, with three paths covered (accept / decline / capability-absent).
- **Realization:** expand `--follow` to three more long-running view actions, surface a `taskSuitable` annotation through `view describe`, and emit a `retry_with_task` `next_actions` hint when a task-suitable one-shot crosses a duration threshold.
- **Conformance:** every addition must pass `/design-invariants` (INV-1..INV-6) and `/axiom:design` (DIM-1..DIM-8); the bundle is explicitly a recursive application of both skills.

## 3. Non-goals

- Workflow verb wiring (Op 3 — `merge_orchestrate`, `synthesize`, `cleanup` through Tasks-augmented dispatch). Deferred: this has per-verb cancellation semantics that deserve dedicated design.
- SSE/server-push fallback (Op 5). Deferred per #1440 acceptance criteria: gated on a client that needs it.
- Rehydration-report optimization spike (#1395 Spike). Out of bundle theme.
- Any change to the existing `taskCapabilityGate` at `dispatch/core/dispatch.ts:927-954`. The annotation is **advisory and discovery-only**; the gate continues to be the binding opt-in.

## 4. Component designs

### 4.1 — #1436 Elicitation form-mode E2E smoketest

**Surface:** new test file `servers/exarchos-mcp/src/__tests__/integration/elicitation-roundtrip.test.ts`.

The test wires an in-process MCP client + server pair using the SDK's `InMemoryTransport` (already used by `tools-call-handler.test.ts` and `tasks-methods.test.ts`). Three paths:

1. **Accept path.** Client declares `capabilities.elicitation: {}` at handshake. Server is invoked with `tools/call` for an action that has a required field omitted from the input. Assert: server sends `elicitation/create` form-mode request to the client; client responds with `action: 'accept'` and the field value; dispatch retries with the spliced value and returns a success envelope. Query the per-operation stream `elicitation/<operationId>`: assert both `elicitation.requested` and `elicitation.fulfilled` events present. Assert `operationId` is shared with the dispatch's parent envelope `_meta.operationId` (closes the trust boundary for cross-stream correlation).

2. **Decline path.** Client returns `action: 'reject'`. Assert: server emits `elicitation.declined` (the typed event added during the CodeRabbit MEDIUM fix at `dispatch/elicitation-dispatch.ts:122-126`); dispatch falls back to `INVALID_INPUT` envelope; no retry attempted.

3. **Capability-absent path.** Client does NOT declare `elicitation` capability. Server skips the elicitation branch entirely (gate at `dispatch.ts:814` short-circuits because `elicitationClient` is undefined for that client); dispatch returns the legacy `INVALID_INPUT` envelope on the missing field. Assert: no events on any `elicitation/*` stream.

Each path asserts **both** the envelope outcome AND the event-store emissions. This is the INV-1 closure: event-stream truth and envelope truth must agree, end-to-end.

**Test target action.** The test needs an action with at least one required field that's worth eliciting. Candidates: `exarchos_workflow init` (`featureId` required). The test fixture's seeded workflow ID must not collide; use a unique per-test featureId.

### 4.2 — #1440 Op 1: `--follow` expansion to additional view actions

**Surface:** `adapters/cli.ts:236-238` — the `isViewFollow` predicate.

Current:

```typescript
const isViewFollow =
  tool.name === 'exarchos_view' &&
  (action.name === 'workflow_status' || action.name === 'shepherd_status');
```

Expansion targets (from #1440 §"Opportunity 1"):

- `view pipeline` — paginated list of active workflows; useful to watch as workflows arrive/complete
- `view convergence` — D1-D5 gate convergence; useful during a synthesis push
- `view delegation_timeline` — bottleneck detection in flight

Predicate becomes a set membership check against a registry-driven constant:

```typescript
const VIEW_FOLLOW_ACTIONS = new Set([
  'workflow_status',
  'shepherd_status',
  'pipeline',
  'convergence',
  'delegation_timeline',
]);
const isViewFollow = tool.name === 'exarchos_view' && VIEW_FOLLOW_ACTIONS.has(action.name);
```

**Invariant constraint:** each underlying handler must be **idempotent for repeated polls** — calling the action N times in a row with the same args must return monotonically-current state without write side effects. The three existing follow-able actions already meet this; we audit the three new ones during implementation. Any handler that doesn't (e.g., one that emits a `*.polled` event itself) must be hardened first.

**Test:** one `cli-follow.test.ts` case per new action verifying NDJSON frames are emitted and the underlying handler is read-only.

### 4.3 — #1440 Op 2: `taskSuitable` action annotation + describe projection

**Issue framing:** `cli.taskSuitable: true` annotation, projected into `exarchos_view describe`.

**Refined placement (INV-2 + INV-4 + DIM-2):** the issue's `cli.` prefix is a misnomer. The Tasks dispatch-core is **shared** between CLI and MCP (INV-2). The annotation is *action-behavior metadata* (this action is long-running and benefits from Tasks-augmented dispatch), not CLI presentation. The right home is a sibling-level optional field on the `ToolAction` interface, not under `CliActionHints`.

**Surface changes:**

```typescript
// servers/exarchos-mcp/src/registry.ts
export interface DispatchHints {
  /**
   * Advisory marker: this action is long-running and benefits from
   * Tasks-augmented dispatch. Surfaced via `exarchos_view describe` so
   * clients can enumerate. The actual opt-in gate remains
   * `taskAugmented && ctx.taskStore && taskCapabilityGate` at
   * core/dispatch.ts:927-954. Clients are not required to honor this
   * marker; the gate is binding.
   */
  readonly taskSuitable?: boolean;
  /**
   * Suggested TTL for Tasks-augmented dispatch, in ms. Surfaced
   * alongside `taskSuitable` so clients have a sensible default to
   * thread when they opt in.
   */
  readonly taskTtlSuggestionMs?: number;
}

export interface ToolAction {
  // ... existing fields ...
  readonly dispatch?: DispatchHints;
}
```

Initial annotation targets (from #1440 §"Opportunity 2"):

- `exarchos_orchestrate merge` — multi-step git merge orchestration
- `exarchos_workflow synthesize` — PR creation flow
- `exarchos_workflow cleanup` — post-merge cleanup
- `exarchos_workflow rehydrate` — full state rebuild

For each: `dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 }`. The TTL suggestion is a sensible default; clients may override.

**Describe projection.** Extend `describe/handler.ts:113-149` to include `dispatch` in the per-action result when present:

```typescript
...(action.dispatch ? { dispatch: action.dispatch } : {}),
```

The shape mirrors existing optional fields (`autoEmits`, `deprecated`, `outputSchema`). Test in `describe/handler.test.ts` (and `views/describe.coverage.test.ts`): assert the four target actions surface `dispatch.taskSuitable: true`.

**Naming rationale.** `dispatch` (not `cli` or `tasks`) because the annotation is dispatch-layer metadata; `tasks` would be too narrow (a future `streaming: true` annotation belongs in the same block); `cli` violates INV-2/INV-4.

### 4.4 — #1440 Op 4: `retry_with_task` next-actions hint

**Surface:** `next-actions-computer.ts` + `next-actions-from-result.ts` — the next-actions surface.

**Trigger condition.** When a task-suitable action (Op 2 annotation `dispatch.taskSuitable === true`) is invoked **without** the `task: { ttl }` augmentation, AND the dispatch's elapsed time exceeds a threshold, emit a `next_actions` hint of shape:

```typescript
{
  verb: 'retry_with_task',
  reason: `this action took ${elapsedMs}ms; consider Tasks-augmented dispatch for live progress`,
  ttl_suggestion_ms: action.dispatch.taskTtlSuggestionMs ?? 60_000,
}
```

**Threshold.** Hardcoded to 10_000 ms (10s) for this bundle. Config wiring at `.exarchos.yml` (`dispatch.retryWithTaskHintThresholdMs`) is deferred to a follow-up — see `dispatch.ts:1011` TODO.

**Where it fires.** The hint computation runs at the dispatch boundary — `dispatch/core/dispatch.ts`, after the action handler returns its `ToolResult` and BEFORE `nextActionsFromResult` runs. The hint is **prepended** to whatever the result-derived hints are, because it's a meta-hint about dispatch shape, not about the result's domain content.

**Idempotency.** If the caller already used `task: { ttl }`, the hint is not emitted (would be tautological). If the action is not `taskSuitable`, the hint is not emitted (no value to add).

**INV-5b conformance.** The `verb: 'retry_with_task'` is a new entry in the next-actions vocabulary. It must be added to the spec-aligned discriminator schema, not free-form prose. Check `next-actions-from-result.ts:122` for the existing discriminator pattern; extend it.

**Aspire-inspired (INV-5c).** `retry_with_task` is the right verb — it names the action the caller should take (`retry`) plus the augmentation that would help (`with_task`). Compare with existing verbs like `merge_orchestrate`, which name a control-plane action plus its subject. Vocabulary stays consistent.

**Test:**
- Unit test in `next-actions-computer.test.ts`: assert the hint is emitted when elapsed > threshold AND `taskSuitable: true` AND `task: { ttl }` was not threaded.
- Negative tests: (a) hint not emitted when elapsed < threshold; (b) hint not emitted when `taskSuitable: false`; (c) hint not emitted when `task: { ttl }` was threaded.
- Integration test in `dispatch/core/dispatch.test.ts`: full path with a slow action (simulated via `vi.useFakeTimers`).

## 5. /design-invariants conformance check

Applied recursively to this bundle:

| Invariant | Bundle impact | Disposition |
|---|---|---|
| **INV-1** (event-sourcing integrity) | #1436 asserts both envelope AND event-store truth for all three paths. Op 1 expansion preserves: each new follow-able action's underlying handler is read-only on repeated polls. Op 2 + Op 4 add no new event types. | ✅ Conforms |
| **INV-2** (facade equivalence) | Op 1: `--follow` is CLI-side; MCP gets equivalent behavior via `tasks/get` polling against the same handler. Op 2: annotation lives on action metadata (registry.ts), projected by both CLI doctor and MCP describe — same source. Op 4: hint emits from dispatch boundary, which both facades cross. | ✅ Conforms (this is precisely why Op 2 doesn't live under `cli.`) |
| **INV-3** (basileus-forward) | All four items are local-only. No remote substrate surface added. The `taskSuitable` annotation does NOT promise remote-Tasks support; it stays advisory for local dispatch. | ✅ Conforms |
| **INV-4** (platform-agnosticity) | None of the changes assume Claude Code as runtime. `taskSuitable` is a generic MCP-spec-aligned annotation; `--follow` works in any MCP-compatible CLI; `retry_with_task` is a generic next-actions verb. | ✅ Conforms |
| **INV-5a** (input ergonomics) | `task: { ttl }` augmentation remains optional and backward-compatible. The `retry_with_task` hint teaches agents the augmentation surface through use, lowering discovery cost. | ✅ Conforms (improves) |
| **INV-5b** (spec-aligned output) | `retry_with_task` is a new entry in the next-actions discriminator. It must extend the existing schema, not invent a parallel structure. `dispatch.taskSuitable` surfaces via existing `describe` output's slot pattern. | ✅ Conforms (with implementation discipline) |
| **INV-5c** (Aspire-inspired control verbs) | `retry_with_task` follows the `verb_subject` pattern (`merge_orchestrate`, `task_create`, `next_action`). No new control surface; uses existing `next_actions` hint envelope. | ✅ Conforms |
| **INV-5d** (action discriminator) | No new actions added. `retry_with_task` is a hint verb, not a tool action — discriminator pattern unaffected. | ✅ Conforms (no impact) |
| **INV-6** (workflow-agnosticism) | All four items live below the workflow playbook layer. Op 2's initial annotations include workflow verbs (`synthesize`, `cleanup`, `rehydrate`) but only as instances of dispatch metadata — playbooks still drive phase transitions. | ✅ Conforms |

**No invariant violations.** One implementation-discipline note (INV-5b): the `retry_with_task` verb must be added to the next-actions discriminator schema, not threaded as free-form prose. This is a TDD task gate — RED test asserts the discriminator validates `retry_with_task` before GREEN code emits it.

## 6. /axiom:design conformance check (DIM-1..DIM-8)

| Dimension | Bundle treatment |
|---|---|
| **DIM-1** (cohesion / coupling) | Each component touches one seam: #1436 → test harness; Op 1 → `isViewFollow` predicate; Op 2 → registry interface + describe handler; Op 4 → dispatch boundary + next-actions computer. No cross-seam coupling introduced. |
| **DIM-2** (boundaries / direction) | The `dispatch` annotation block lives on the action descriptor (where action metadata belongs), not under `cli.` (where presentation lives) — this is the design's most important boundary call. Op 4's hint emission lives at the dispatch boundary, downstream of action handlers (correct direction). |
| **DIM-3** (resource / lifecycle) | Op 4's hint is informational only — zero lifecycle impact. Op 1's `--follow` reuses existing `cli/follow-loop.ts` lifecycle (already C3-SIGINT-aware). No new resources acquired. |
| **DIM-4** (error handling) | #1436's decline-path verifies the `elicitation.declined` event lands AND the dispatch falls back to `INVALID_INPUT` — error path is exercised. No new error envelopes added; existing patterns reused. |
| **DIM-5** (concurrency) | Op 1's three new follow-able view actions must be **read-only on repeated polls** — this is the concurrency hazard. Each gets an idempotency audit during implementation; any handler that emits a `*.polled` event itself must be hardened with FINDING-3 throttle (already shipped) BEFORE landing follow support. |
| **DIM-6** (performance) | Op 4's hint emission adds an `elapsed > threshold` check per dispatch — O(1), zero allocation. Op 1's `--follow` is opt-in; no impact when not used. Op 2's annotation adds one field per action descriptor — negligible. |
| **DIM-7** (testability) | #1436 is *literally* a testability improvement — fills the verification gap from PR #1424. Op 4 is testable via fake timers (vi.useFakeTimers) without real elapsed time. Op 1 uses the existing `cli-follow.test.ts` harness. Op 2 has straightforward describe-projection tests. |
| **DIM-8** (observability) | Op 4's hint surface is observable via envelope `_meta`. #1436 asserts event-store emissions exist (closes a verification gap = observability gap). Op 2's annotation is observable via `view describe`. No new opaque surface. |

**One DIM-5 risk noted:** Op 1's idempotency audit is non-trivial for `pipeline` / `convergence` / `delegation_timeline`. The implementation plan must include a "audit handler idempotency" task BEFORE the predicate expansion task, so we don't ship a `--follow` flag that pollutes the event store on every poll.

## 7. Deferrals + rationale

| Deferred | Where to | Why |
|---|---|---|
| #1440 Op 3 (workflow verb wiring) | Dedicated design | Per-verb cancellation semantics differ (`merge_orchestrate` mid-rebase ≠ `cleanup` mid-branch-delete). Each verb deserves its own design + risk envelope. Folding into this bundle would dilute review and inflate blast radius. |
| #1440 Op 5 (SSE/server-push) | Future design, gated on demand | Per #1440 acceptance criteria: "implementation gated on a client that needs it." No such client exists today. Polling cost is real but not RC1-blocking. |
| #1395 (rehydration spike) | Separate ideate cycle | Different bundle theme (observability vs. realization). Spike scope (live user think-aloud sessions) doesn't fit the implementation rhythm of this bundle. |
| #1370 + #1439 (invariants audits) | Dedicated ideate cycle | Audit work is research-doc-first, then targeted edits; different cadence from feature/test work. Better as their own bundle. |

## 8. Acceptance criteria

- [ ] **#1436 closed:** `servers/exarchos-mcp/src/__tests__/integration/elicitation-roundtrip.test.ts` passes with three paths (accept / decline / capability-absent). Each path asserts envelope outcome AND event-store emissions.
- [ ] **#1440 Op 1 closed:** `view pipeline` / `view convergence` / `view delegation_timeline` accept `--follow`; CLI-follow test covers each; idempotency audit recorded in PR description.
- [ ] **#1440 Op 2 closed:** `DispatchHints` interface added to `registry.ts`; four actions annotated (`merge`, `synthesize`, `cleanup`, `rehydrate`); `describe` projects `dispatch` field; describe-coverage test asserts.
- [ ] **#1440 Op 4 closed:** `retry_with_task` verb added to next-actions discriminator schema; hint emitted from dispatch boundary when (elapsed > threshold) AND (`taskSuitable: true`) AND (`task: { ttl }` not threaded); unit + integration tests cover positive + 3 negative paths.
- [ ] No regression in existing `--follow` parity (CLI vs MCP byte-identical per transition).
- [ ] No new event types added (DIM-8 + INV-1 discipline).
- [ ] All `/design-invariants` and `/axiom:design` checks in §5 + §6 pass at PR review time.

## 9. Out of scope (explicit)

- Op 3 (workflow verb wiring): `merge_orchestrate`, `synthesize`, `cleanup` through Tasks-augmented dispatch. See §7.
- Op 5 (SSE fallback). See §7.
- Changing the binding `taskCapabilityGate` at `dispatch/core/dispatch.ts:927-954`. The annotation is advisory and discovery-only.
- Renaming any existing CLI flags or MCP method names.
- Migration tooling for the `dispatch` annotation (it's optional; existing actions stay valid without it).

## 10. References

- Epic: [#1441](https://github.com/lvlup-sw/exarchos/issues/1441) — preview.4 polish + post-bundle follow-ups
- Sub-issues: [#1436](https://github.com/lvlup-sw/exarchos/issues/1436), [#1440](https://github.com/lvlup-sw/exarchos/issues/1440)
- Predecessor design: `docs/designs/2026-05-17-preview-4-substrate-hygiene.md` (#1450)
- Invariants catalog: `docs/architecture/invariants.md`
- Bundle audit: `docs/research/2026-05-16-v2-10-0-preview-4-bundle-audit.md`
- Relevant code:
  - `servers/exarchos-mcp/src/dispatch/core/dispatch.ts:811-855` (elicitation gate)
  - `servers/exarchos-mcp/src/dispatch/core/dispatch.ts:927-954` (taskCapabilityGate)
  - `servers/exarchos-mcp/src/adapters/cli.ts:236-238` (isViewFollow)
  - `servers/exarchos-mcp/src/adapters/mcp.ts:266` (createElicitationClient)
  - `servers/exarchos-mcp/src/registry.ts:45-72` (ActionAnnotations + ToolAction)
  - `servers/exarchos-mcp/src/describe/handler.ts:113-149` (action describe projection)
  - `servers/exarchos-mcp/src/next-actions-from-result.ts:122` (next-actions discriminator)

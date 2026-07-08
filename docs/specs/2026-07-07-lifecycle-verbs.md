# Spec: Process Lifecycle Verbs — generic ps / describe / wait / export over the event log

**Date:** 2026-07-07 · **Feature:** `lifecycle-verbs` · **Depth:** deep
**Inputs:** #1316 (design spike, this spec closes it) · #1090 (epic; children #1103–#1106 absorbed here) · #1315 (subscription primitive — contract defined here) · #1599 roadmap (Z2 critical path, coordination rules 2–4) · `docs/specs/2026-07-03-wlm-6-surface-and-workflow-fixes.md` · `docs/specs/2026-06-26-wlm-operational-core.md` · `docs/architecture/runtime.md` §L7/§6 · `.exarchos/invariants.md` (INV-1/2/5a–d/6/7/8/10/12/15/16)

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

Epic #1090 promises generic workflow-lifecycle verbs — `ps` (list), `describe` (project), `wait` (event-driven gate), `export` (diagnostic bundle) — as layer L7 of the runtime: supervisor primitives over the event log, replacing ad-hoc `view pipeline` / `workflow get` polling. What exists today diverges:

- **WLM-6 (PR #1642) shipped worktree-scoped `ps`/`wait`** on `exarchos_view` — a `worktrees@v1` fold (merges/launches/prunes) with `until: merge|idle` polling. Same names as #1090, different semantics. Preview-only (v2.12.0-preview.1), so the shapes are still cheap to change.
- **The workflow-projection `describe` is absent**; the `describe` name on every composite tool is taken by GA'd schema-introspection.
- **`export` is absent.**
- **The #1315 subscription primitive is absent** — every waiter re-folds a projection on a sleep loop.
- **INV-10 is aspirational**: four surfaces emit `<surface>.executing_started`/terminal pairs (merge, launch, mutation, prune) as ad-hoc per-surface schemas with no shared base and no generic consumer; `mutation` is observable by nothing.
- **Audit S-6 (stuck-`executing` recovery) remains open**: no generic way to wait out or inspect a crashed long-running operation.

Without one design, the four implementation issues (#1103–#1106) would diverge on subscription handling, predicate language, output schemas, and postures — exactly what #1316 was filed to prevent.

### Chosen Approach

**Unify under generic verbs on the two-tier subscription substrate** (Exploration, Option 2 — decided with the owner 2026-07-07):

1. **One subscription primitive (DR-1)** — in-process post-commit notification plus a `PRAGMA data_version` cross-process poll floor — serves `wait`, `describe --follow`, and every future waiter. Subscriptions are ephemeral (per-dispatch), so INV-15's no-daemon frame holds by construction.
2. **One liveness contract (DR-2)** — `ExecutingStartedBase` + a liveness-pair registry — turns INV-10 from convention into checkable contract, and gives `ps` its generic operations fold (adopted from Exploration Option 3, without its row-shape conflation).
3. **The verbs are pure consumers** — `ps`/`inspect`/`wait` are projections or subscriptions (no writes; `wait` emits no events, revising #1316 Q7); `export` is the one emitter and follows INV-13's two-event split.
4. **CLI promotion (DR-7)** hoists the verbs to `exarchos ps|describe|wait|export` through a registry-driven mechanism, keeping INV-2 parity.

Compatibility posture: **break-in-preview** — the WLM-6 `ps`/`wait` schemas are redesigned freely (no shims); the unified surface lands before v2.12.0 GA. Worktree capabilities (probe/reconcile, merge/idle waits) are preserved as a *scope* of the generic verbs.

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: Two-tier subscription primitive (#1315)

The event store exposes `subscribe(filter, onEvent): SubscriptionHandle` where `filter` is `{ streamId?, eventTypes?[] }`. Tier 1 (in-process): after a successful append commits, matching listeners fire synchronously, post-commit — a listener failure is isolated and never affects the append result (at-most-once; mirrors INV-7's two-tier split). Tier 2 (cross-process): a bounded poll floor re-checks `PRAGMA data_version` (near-free) and re-reads only when another connection has committed, delivering matching events in sequence order. Subscriptions are ephemeral: registered by a dispatch, disposed when it returns — nothing outlives the verb (INV-15).

**Acceptance criteria:**
- Given a subscription on stream S for type T, when a matching event is appended in-process, then `onEvent` fires after commit without waiting any poll interval.
- Given an append from a second process (test: second connection), when `data_version` changes, then matching events are delivered in sequence order within one floor interval (default documented; configurable per call).
- Given a listener that throws, when the append commits, then the append result is unchanged and remaining listeners still fire.
- Given a dispatch that registered subscriptions, when it returns (success or error), then all its handles are disposed — a leak test asserts the registry count returns to zero.
- With zero subscribers, the append hot path executes no listener-related work beyond a single guard check (benchmarked: no measurable regression in the append benchmark).

#### DR-2: `ExecutingStartedBase` and the liveness-pair registry (INV-10 made checkable)

Extract a shared Zod base `{ surface, instanceId, startedAt, expectedDurationMs? }`; the four existing schemas (`merge`/`launch`/`mutation`/`prune` `.executing_started`) retrofit via `.extend(...)` with **byte-identical event data** (no migration). A liveness-pair registry — one table mapping each `<surface>.executing_started` to its terminal event types — becomes the single source `ps`'s operations fold and `wait`'s terminal detection consume. Adding a surface to the lifecycle plane = one registry entry, zero verb code.

**Acceptance criteria:**
- All four existing `*.executing_started` schemas extend the base; snapshot tests prove emitted event data is unchanged.
- A conformance test fails if any `*.executing_started` event type in the emission catalog lacks a registry entry with ≥1 terminal type.
- `docs/architecture/runtime.md` §6 documents the convention (base schema + pairing rule) and cites the registry as its enforcement.

#### DR-3: Generic `ps` — scope-parameterized process listing

`exarchos_view { action: 'ps', scope: 'workflow' | 'worktree' | 'all' }` (default `all`). Output has two honestly-shaped sections, never conflated rows: `workflows` (fold of `workflow_state` joined with `streams.workflow_type`: featureId, workflowType, phase, status, ageMs) and `operations` (generic fold over the DR-2 registry: any `executing_started` without its terminal — including `mutation`, which today nothing surfaces). Filters: `workflowType` (indexed pushdown via `streams.workflow_type`), `status`, `phase`, `all` (include completed/cancelled; default excludes them). The WLM-6 worktree fold (in-flight merges/launches/prunes + `probe` reconciliation) is preserved under `scope: 'worktree' | 'all'`; `probe: true` remains a conditional writer with its existing `LOCAL_MUTATION_IDEMPOTENT` annotation.

**Acceptance criteria:**
- Given workflows of mixed types and phases, when `ps --workflow-type feature`, then only `feature` rows return, and the query uses the indexed `streams.workflow_type` column.
- Given a completed workflow, then default `ps` excludes it and `--all` includes it.
- Given a synthetic `mutation.executing_started` without terminal, then it appears in `operations` with no mutation-specific code in any verb handler (generic-fold test).
- Given `scope: 'workflow'` with `probe: true`, then the input is rejected as `INVALID_INPUT` (probe is a worktree-scope capability).
- Worktree-scope output preserves every WLM-6 capability (in-flight pairs, launches, prunes, probe reconcile) under the redesigned schema.

#### DR-4: `inspect` — the workflow-projection describe

New `exarchos_view` action `inspect(featureId, follow?, limit?)`: composite projection returning workflow state (via the canonical `resolveWorkflowState`/rehydration path — never `.state.json` presence), recent events (with `operationId`/`correlationId`/`causationId`), artifacts, and task progress. Existence signal is `_meta.workflowExists`; a cold probe of an unknown featureId is side-effect-free. `--follow` consumes DR-1 and streams through two carriers per #1316 Q3: NDJSON frames on the CLI (existing encoder/heartbeat), MCP Tasks (SEP-1686) on the MCP path — one contract, two presentations (INV-5b). The MCP action name avoids the GA'd schema-`describe` (no rename, no Zod-union overload — a known CLI-parity hazard); DR-7 maps the CLI top-level verb `exarchos describe <id>` onto it.

**Acceptance criteria:**
- Given an unknown featureId, when `inspect` runs, then `_meta.workflowExists: false` with `expectedShape` in the error envelope, and no event is appended.
- Given `--follow`, when events append to the feature's stream (in-process or cross-process), then they appear as NDJSON `event` frames deduplicated by sequence; heartbeat frames cover silent gaps.
- The MCP path exposes follow via Tasks (`tasks/get`/`tasks/result`), sharing the DR-1 subscription with the CLI carrier.
- Schema-introspection `describe` on all four composite tools is byte-unchanged.

#### DR-5: Generic `wait` — event-driven phase gate, no self-journaling

`wait(featureId, phase?, status?, until?, integrationRef?, timeoutMs)`: phase targets use **reached-or-passed** semantics — the projection is checked first, returning immediately if the target phase was already reached (idempotent re-runs, #1316 Q2); otherwise a DR-1 subscription on `workflow.transition` + registry terminal events resolves it. `status` supports terminal waits (`completed`/`failed`/`cancelled`). The WLM-6 worktree predicates (`until: merge|idle` + `integrationRef`) are retained as the worktree scope of the same action. `wait` emits **no events** (revises #1316 Q7): posture read-only, `readOnlyHint: true`, `idempotentHint: true` — the log records domain facts, not observations of them. Timeout/failure return structured `WAIT_TIMEOUT` / `WAIT_FAILED` envelopes; the CLI adapter maps them to exit codes 17/18 as pure presentation (a generic errorCode→exitCode map, INV-2-safe).

**Acceptance criteria:**
- Given a workflow already past `--phase plan-review`, when `wait --phase plan-review` runs, then it returns success immediately (exit 0) without subscribing.
- Given no matching transition within `timeoutMs`, then `WAIT_TIMEOUT` is returned and the CLI exits 17.
- Given the workflow enters `failed`/`cancelled` while waiting on a phase, then `WAIT_FAILED` is returned and the CLI exits 18.
- Given an in-process `workflow.transition` to the target phase, then `wait` resolves without waiting a poll interval (Tier-1 path test).
- **S-6 closure walkthrough:** given `merge.executing_started` with no terminal (simulated crash), `wait <id> --phase delegate --timeout 10m` resolves when `merge.recovered` lands, or exits 17 on timeout; `inspect` shows the unpaired `executing_started`; no merge-specific code exists in `wait` (grep-asserted).
- `wait` appends zero events across all paths (asserted by event-count invariance in tests).

#### DR-6: `export` — event-log bundle with the INV-13 two-event split

`export(featureId, output?)`: writes a zip containing `events.jsonl` (full stream extract), `state.json` (projection snapshot), `metadata.json` (version, eventCount, phase, exportedAt), and `artifacts/` (referenced artifact files that exist on disk). Writing outside `.exarchos/` is a non-idempotent external side effect, so export follows INV-13: `export.requested` (intent + resolved path) before the write, `export.executed` (result + content hash) after. Crash between the two → the next invocation runs an idempotent precheck (zip exists + hash matches manifest) to re-emit or skip. Posture `task-isolated`, `openWorldHint: true`. Default output `./<featureId>-export.zip`; invalid paths return `suggestedFix` with the default.

**Acceptance criteria:**
- Given an exported bundle, when `events.jsonl` is replayed through the reducers, then the result equals `state.json` (round-trip test) — the event log **is** the export.
- Every successful export appends exactly the `export.requested`/`export.executed` pair, idempotency-keyed per INV-8.
- Given a crash simulated between the pair, when export re-runs, then the precheck detects the existing/partial zip and completes without duplicating the `requested` intent.
- Given an invalid `--output` path, then a structured error with `suggestedFix` (default location) returns and no events are appended.
- Zip paths are built with `path.join` / POSIX-normalized entries; tests close SQLite handles before temp-dir removal (INV-16).

#### DR-7: Registry-driven CLI top-level promotion

`CliActionHints` gains `topLevel?: string`. The CLI adapter hoists any action carrying it to a top-level command (name = the field's value) that dispatches through the identical core path with flags derived from the same Zod schema — zero adapter behavior (INV-2). Stamps: `ps`→`ps`, `wait`→`wait`, `export`→`export`, `inspect`→`describe` (epic UX preserved without touching the GA'd schema-describe). A build-time collision guard fails fast if a `topLevel` name collides with a tool name, alias, or another promotion. The subcommand forms (`exarchos view ps`) keep working.

**Acceptance criteria:**
- `exarchos ps|describe <id>|wait <id>|export <id>` all resolve and dispatch.
- Parity fixtures assert byte-identical `ToolResult` across the three invocation paths: top-level CLI, `view <action>` subcommand, and MCP `exarchos_view` — for each promoted verb.
- A registry entry with a colliding `topLevel` name fails the build/registration test, not runtime.
- Visible MCP tool count is unchanged (still 4 composite tools, INV-5d).

#### DR-8: Error handling, failure modes, and edge cases

Cross-cutting failure contract for the verb surface.

**Acceptance criteria:**
- Given `wait --phase <invalid>`, then the error envelope's `validTargets` is populated from the HSM topology **for that workflow's type**.
- Given an unknown featureId on `inspect`/`wait`/`export`, then a side-effect-free error with `expectedShape` returns (cold-probe rule; no stream registration, no events).
- Given a subscription whose consumer disconnects mid-follow (CLI SIGINT, MCP task cancel), then the handle is disposed and the leak test passes.
- Cross-process wait latency is bounded: ≤ one floor interval + one projection fold; the floor default is documented in the subscription contract and surfaced in `_perf`.
- Given concurrent `wait`s on the same stream from two dispatches, then both resolve independently (no shared-handle interference).
- All new paths run on Windows CI (INV-16): no separator string-concat, handles closed before temp-dir removal, `resolveExecutable` for any spawns.

### Technical Design

**New substrate:** `servers/exarchos-mcp/src/event-store/subscriptions.ts` — the listener registry + `SubscriptionHandle`; a post-commit hook point in the append path (`store.ts`/`atomic-appender.ts`) guarded to zero-cost when empty; `data_version` floor helper in `storage/sqlite-backend.ts`.

**Liveness contract:** base schema + pair registry live beside the event schemas (`event-store/schemas.ts`); the generic "in-flight operations" fold becomes a small reusable projection consumed by `ps` — not a new stored projection table.

**Verbs:** new handlers under `src/views/lifecycle/` (ps/inspect/wait/export), routed via `views/composite.ts`; the WLM-6 worktree fold (`orchestrate/worktree/handlers.ts`) is called by the `ps` worktree scope rather than duplicated. `wait` composes: projection precheck → DR-1 subscribe → registry-terminal detection. Registry entries stamp postures, `outputSchema`, annotations, and `cli.topLevel` per DR-7 (#1316 Q7/Q8 land as registration facts, not prose).

**CLI:** promotion loop + errorCode→exitCode map in `adapters/cli.ts`; follow carriers reuse `src/ndjson/` (CLI) and `src/mcp/tasks-methods.ts` (MCP), both fed by DR-1.

**SDK-lowering mapping (#1599 rule 3):** `wait --phase` lowers as the IR's `awaitPhase(featureId, phase)` combinator; the subscription primitive is the runtime service IR await-nodes bind to; `ps`/`inspect`/`export` are read-side projections with no IR footprint. No edits to `hsm-definitions.ts`/`playbooks.ts`.

**Q11 alignment:** INV-1 (all verbs are folds/subscriptions/emitters — no side stores); INV-2 (parity fixtures per verb); INV-6 (verbs read topology/projections generically — no workflow-type branching); INV-12 (`wait` complements `next_actions`: affordances say what *can* run, `wait` observes what *did*).

### Integration Points

- `servers/exarchos-mcp/src/event-store/store.ts` + `atomic-appender.ts` — post-commit notification hook (guarded, zero-cost empty path)
- `servers/exarchos-mcp/src/event-store/subscriptions.ts` — **new**: registry, handle lifecycle, data_version floor
- `servers/exarchos-mcp/src/event-store/schemas.ts` — `ExecutingStartedBase` + liveness-pair registry; four schema retrofits
- `servers/exarchos-mcp/src/views/composite.ts` — route `ps`(redesigned)/`inspect`(new)/`wait`(redesigned)/`export`(new)
- `servers/exarchos-mcp/src/views/lifecycle/` — **new**: verb handlers
- `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts` — worktree fold consumed as `ps` scope; WLM-6 wait kernel absorbed into generic `wait`
- `servers/exarchos-mcp/src/registry.ts` — action defs, postures, outputSchemas, `CliActionHints.topLevel`
- `servers/exarchos-mcp/src/adapters/cli.ts` — top-level promotion, exit-code map, follow carrier wiring
- `servers/exarchos-mcp/src/ndjson/` + `src/mcp/tasks-methods.ts` — carriers over the DR-1 contract
- `docs/architecture/runtime.md` §6/§L7 — liveness convention + verb docs

### Exploration

Divergent loop run 2026-07-07 (deep rung; `correlationId: c3c85d7a-8abf-48e4-9121-f96f5e504198`). Grounding: a full codebase sweep of the shipped surface (WLM-6 `ps`/`wait` worktree scoping, absent subscription primitive, ad-hoc INV-10 schemas, no CLI promotion mechanism) plus #1316/#1090/#1599 and the four WLM specs. The `/exarchos:discover` bridge was offered and declined — the sweep plus shipped specs gave sufficient grounding.

- **Option 1 — Formalized bounded poll:** declare polling *is* the #1315 contract; generalize the WLM-6 wait kernel; no event-store changes. Rejected: enshrines the active polling INV-10 exists to replace; latency floor on every wait; O(poll × fold) waste.
- **Option 2 — Two-tier subscription substrate (chosen):** in-process post-commit notify + `data_version` cross-process floor; ephemeral per-dispatch handles (INV-15-safe); one contract, two carriers. Delivers #1315 rather than renaming polling.
- **Option 3 — Uniform process table:** a `liveness@v1` projection folding all INV-10 pairs; workflows and operations as uniform rows. Partially adopted — the generic operations fold (via the DR-2 registry) — but the uniform row shape was rejected: an *operation* (bounded, liveness-paired) and a *workflow* (long-lived, phase-structured) are semantically distinct, and one row shape muddies both.

Owner decisions converged in one iteration: unify (vs coexist) · full pickup (spec through implementation) · break-in-preview (no shims) · build CLI promotion · Option 2 · `wait` emits no events · MCP `inspect` / CLI `describe`.

### Alternatives considered

- **Coexist (freeze WLM-6 verbs, add new names)** — rejected: permanently splits the lifecycle surface and squats the #1090 names on worktree semantics.
- **Compat shims / additive-only schemas** — rejected: the shapes are preview-only; shim debt for zero GA consumers.
- **`wait.started`/`wait.completed`/`wait.timeout` emission (#1316 Q7 original)** — rejected: observation verbs stay pure reads; log noise proportional to observation frequency; Aspire's `wait` does not journal itself. Exit codes 17/18 survive as CLI presentation.
- **Zod-union overload of `describe`** — rejected: known `coerceFlags` CLI-parity break on unions; agent-facing schema ambiguity (INV-5a).
- **Renaming schema-`describe` to free the name** — rejected: breaks a GA'd discovery surface all agents use.
- **OS-level notification (fs-watch on the SQLite WAL, LISTEN/NOTIFY-style IPC)** — rejected: imports watcher/daemon primitives from outside the INV-15 frame; `data_version` polling floor achieves the cross-process bound within it.

### Open Questions

- **Rich `wait` predicates (JSONPath over projection state, any-of/all-of):** deferred — phase/status/until covers S-6 and the v2.12 consumers; file a follow-up when a concrete consumer needs more (per #1316 Q2's own recommendation).
- **MCP `resources/subscribe` exposure of DR-1:** deferred to the #1604 MCP-migration tranche (Z3) — the primitive is transport-agnostic; exposing it remotely is a harness-boundary question (#1599 rule 5).
- **Import/replay tooling for export bundles:** deferred; the round-trip test (DR-6) guarantees replayability, tooling lands with a concrete diagnostic consumer.
- **`shepherd`/`tdd-swarm` liveness conformance:** out of scope per #1316; the DR-2 registry makes each a one-entry addition tracked on their own issues.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.

### Scope

**Target:** Full design (DR-1 … DR-8)
**Excluded:** None — the design's Open Questions are explicitly deferred there with rationale; no DR is partially implemented.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Two-tier subscription primitive (#1315) | 001, 002, 017, 018 |
| DR-2 | ExecutingStartedBase + liveness-pair registry | 003, 004, 018 |
| DR-3 | Generic `ps` (scope-parameterized) | 005, 006, 007 |
| DR-4 | `inspect` workflow-projection describe | 008, 009 |
| DR-5 | Generic `wait` (event-driven gate, no self-journaling) | 010, 011 |
| DR-6 | `export` with INV-13 two-event split | 012, 013 |
| DR-7 | Registry-driven CLI top-level promotion | 014, 015 |
| DR-8 | Error handling, failure modes, edge cases | 011, 016, 017 |

### Tasks

#### Task 001: Subscription registry + post-commit notification hook (Tier 1)

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1

**Files:**
- `servers/exarchos-mcp/src/event-store/subscriptions.ts` (new — registry, `SubscriptionHandle`, filter matching)
- `servers/exarchos-mcp/src/event-store/subscriptions.test.ts` (new)
- `servers/exarchos-mcp/src/event-store/store.ts` (post-commit hook point, guarded zero-cost when empty)
- `servers/exarchos-mcp/src/event-store/atomic-appender.ts` (fire-after-commit ordering)

**Verification:** scoped tests + `check_test_adequacy` + integration suite. Tests: `Subscribe_InProcessAppend_FiresPostCommitWithoutPoll`, `Subscribe_ListenerThrows_AppendUnaffectedAndSiblingsFire`, `Subscribe_DispatchReturns_HandleDisposed`, `Append_ZeroSubscribers_NoListenerWork`.
**testingStrategy:** `propertyTests: true` (property: events delivered to a matching subscriber are exactly the appended events, in sequence order, for arbitrary interleavings of matching/non-matching appends); `benchmarks: true` (SLA: append p99 regression < 5% with zero subscribers vs baseline); `characterizationRequired: true` (append path is existing code).
**Dependencies:** None
**Parallelizable:** Yes

#### Task 002: Cross-process poll floor via `PRAGMA data_version` (Tier 2)

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1

**Files:**
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts` (`dataVersion()` accessor)
- `servers/exarchos-mcp/src/event-store/subscriptions.ts` (floor loop: re-check data_version, re-read + deliver by sequence only on change)
- `servers/exarchos-mcp/src/event-store/subscriptions.test.ts`

**Verification:** scoped tests + `check_test_adequacy` + integration suite. Tests: `Floor_SecondConnectionAppend_DeliveredInSequenceOrderWithinOneInterval`, `Floor_NoForeignCommit_NoReRead`, `Floor_DefaultInterval_SurfacedInPerf`.
**testingStrategy:** `propertyTests: true` (property: for any split of appends across two connections, the subscriber observes every matching event exactly once, in global sequence order); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 001
**Parallelizable:** No (extends 001's module)

#### Task 003: `ExecutingStartedBase` schema + retrofit of the four surfaces

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `servers/exarchos-mcp/src/event-store/schemas.ts` (base + `merge`/`launch`/`mutation`/`prune` `.executing_started` retrofit via `.extend`)
- `servers/exarchos-mcp/src/event-store/schemas.test.ts` (byte-identity snapshots)

**Verification:** scoped tests + `check_test_adequacy`. Tests: `ExecutingStartedSchemas_Retrofit_EmittedDataByteIdentical` (snapshot per surface), `ExecutingStartedBase_RequiredFields_Validated`.
**testingStrategy:** `propertyTests: true` (property: schema compliance — every payload accepted by a retrofit schema is accepted by the base's field contract; serialization category); `benchmarks: false`; `characterizationRequired: true` (modifies existing schemas).
**Dependencies:** None
**Parallelizable:** Yes

#### Task 004: Liveness-pair registry + conformance test

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `servers/exarchos-mcp/src/event-store/liveness-registry.ts` (new — `{ startType, terminalTypes[] }` per surface)
- `servers/exarchos-mcp/src/event-store/liveness-registry.test.ts` (new)

**Verification:** scoped tests + `check_test_adequacy`. Tests: `LivenessRegistry_EveryExecutingStartedInCatalog_HasEntryWithTerminal` (conformance — fails on unregistered `*.executing_started`), `LivenessRegistry_AddSurface_OneEntryNoVerbCode`.
**testingStrategy:** `propertyTests: false` (registry is a static table; the conformance test is the guarantee); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 003
**Parallelizable:** No (follows 003's schema names)

#### Task 005: `ps` workflows fold (workflow_state ⋈ streams.workflow_type + filters)

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/workflow-fold.ts` (new — rows: featureId, workflowType, phase, status, ageMs; filters: workflowType pushdown, status, phase, all)
- `servers/exarchos-mcp/src/views/lifecycle/workflow-fold.test.ts` (new)

**Verification:** scoped tests + `check_test_adequacy`. Tests: `WorkflowFold_TypeFilter_UsesIndexedStreamsColumn`, `WorkflowFold_Default_ExcludesTerminalStates`, `WorkflowFold_AllFlag_IncludesCompleted`.
**testingStrategy:** `propertyTests: true` (properties: filter idempotence `filter(filter(rows)) === filter(rows)`; filtered set ⊆ unfiltered set; collections category); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** None
**Parallelizable:** Yes

#### Task 006: `ps` operations fold (generic in-flight over the liveness registry)

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/operations-fold.ts` (new — `executing_started` without matching terminal, per registry)
- `servers/exarchos-mcp/src/views/lifecycle/operations-fold.test.ts` (new)

**Verification:** scoped tests + `check_test_adequacy`. Tests: `OperationsFold_StartedWithoutTerminal_ListedInFlight`, `OperationsFold_MutationSurface_ListedGenerically` (DR-3 AC: no mutation-specific code), `OperationsFold_TerminalPresent_Excluded`.
**testingStrategy:** `propertyTests: true` (property: for any event sequence, an operation is listed iff its start event has no later matching terminal — state-machine category); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 004
**Parallelizable:** Yes (after 004)

#### Task 007: `ps` handler redesign — scope parameter, composition, probe gating

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/ps.ts` (new — composes 005 + 006 + the WLM-6 worktree fold)
- `servers/exarchos-mcp/src/views/lifecycle/ps.test.ts` (new)
- `servers/exarchos-mcp/src/views/composite.ts` (route redesigned `ps`)
- `servers/exarchos-mcp/src/registry.ts` (redesigned schema: `scope`, filters; `outputSchema`; annotations)
- `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts` (worktree fold consumed, not duplicated)

**Verification:** scoped tests + `check_test_adequacy` + integration suite (redesigns a shipped preview surface; parity baselines updated). Tests: `Ps_DefaultScope_All_ReturnsWorkflowsAndOperationsSections`, `Ps_WorkflowScopeWithProbe_RejectedInvalidInput`, `Ps_WorktreeScope_PreservesWlm6Capabilities`.
**testingStrategy:** `propertyTests: false` (composition wiring; folds carry the PBT in 005/006); `benchmarks: false`; `characterizationRequired: true` (WLM-6 worktree behavior pinned before redesign).
**Dependencies:** 005, 006
**Parallelizable:** No

#### Task 008: `inspect` handler — composite workflow projection

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/inspect.ts` (new — state via `resolveWorkflowState`/rehydration, recent events + correlation tuple, artifacts, task progress)
- `servers/exarchos-mcp/src/views/lifecycle/inspect.test.ts` (new)
- `servers/exarchos-mcp/src/views/composite.ts` (route `inspect`)
- `servers/exarchos-mcp/src/registry.ts` (action def + `outputSchema` + `readOnlyHint`)

**Verification:** scoped tests + `check_test_adequacy`. Tests: `Inspect_UnknownFeatureId_WorkflowExistsFalseNoSideEffect` (event-count invariance), `Inspect_KnownWorkflow_ReturnsStateEventsArtifacts`, `Inspect_SchemaDescribe_ByteUnchanged`.
**testingStrategy:** `propertyTests: false` (projection composition; no transformation core); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** None
**Parallelizable:** Yes

#### Task 009: `--follow` carriers — NDJSON (CLI) + Tasks (MCP) over the subscription

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4

**Files:**
- `servers/exarchos-mcp/src/adapters/cli.ts` (`inspect` joins the follow set; carrier wiring)
- `servers/exarchos-mcp/src/cli/follow-loop.ts` (subscription-fed source replacing pure poll for `inspect`)
- `servers/exarchos-mcp/src/mcp/tasks-methods.ts` (Tasks arm over the same DR-1 contract)
- `servers/exarchos-mcp/src/views/lifecycle/inspect.follow.test.ts` (new)

**Verification:** scoped tests + `check_test_adequacy` + integration suite across the CLI/MCP seam. Tests: `InspectFollow_AppendedEvents_NdjsonFramesDedupedBySequence`, `InspectFollow_SilentGap_HeartbeatFrames`, `InspectFollow_McpTasks_SharesSubscriptionContract`.
**testingStrategy:** `propertyTests: true` (property: NDJSON frame stream contains each event sequence exactly once, monotonically — dedup roundtrip; data-transformation category); `benchmarks: false`; `characterizationRequired: true` (follow-loop is existing code).
**Dependencies:** 001, 002, 008
**Parallelizable:** No

#### Task 010: Generic `wait` — reached-or-passed precheck + subscription resolution

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/wait.ts` (new — projection precheck; DR-1 subscribe on `workflow.transition` + registry terminals; `phase`/`status`/worktree `until` predicates; structured `WAIT_TIMEOUT`/`WAIT_FAILED`)
- `servers/exarchos-mcp/src/views/lifecycle/wait.test.ts` (new)
- `servers/exarchos-mcp/src/views/composite.ts` (route redesigned `wait`)
- `servers/exarchos-mcp/src/registry.ts` (redesigned schema + `readOnlyHint`/`idempotentHint`)
- `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts` (WLM-6 wait kernel absorbed)

**Verification:** scoped tests + `check_test_adequacy` + integration suite. Tests: `Wait_PhaseAlreadyPassed_ReturnsImmediatelyWithoutSubscribing`, `Wait_InProcessTransition_ResolvesWithoutPollInterval`, `Wait_Timeout_StructuredWaitTimeout`, `Wait_WorkflowCancelledMidWait_WaitFailed`, `Wait_AllPaths_AppendZeroEvents` (event-count invariance).
**testingStrategy:** `propertyTests: true` (property: for any transition sequence, `wait --phase P` resolves iff P appears at-or-before now or arrives before timeout — state-machine category); `benchmarks: false`; `characterizationRequired: true` (absorbs shipped worktree kernel).
**Dependencies:** 001, 002, 004
**Parallelizable:** No

#### Task 011: S-6 stuck-executing recovery — acceptance north-star

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-5, DR-8

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/s6-recovery.acceptance.test.ts` (new — real store, real handlers, no mocks)

**Verification:** the acceptance walkthrough from DR-5: seed `merge.executing_started` with no terminal (simulated crash); `wait <id> --phase delegate --timeout` resolves on `merge.recovered` and times out (17) without it; `inspect` shows the unpaired start; grep-assert no merge-specific code in `wait.ts`/`operations-fold.ts`.
**testingStrategy:** `propertyTests: false`; `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 008, 010
**Parallelizable:** No

#### Task 012: `export.requested` / `export.executed` event schemas

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `servers/exarchos-mcp/src/event-store/schemas.ts` (two event types + emission-registry entries, idempotency-keyed per INV-8)
- `servers/exarchos-mcp/src/event-store/schemas.test.ts`

**Verification:** scoped tests + `check_test_adequacy`. Tests: `ExportEventSchemas_RequestedExecutedPair_RegisteredWithEmissionSource`, `ExportRequested_CarriesResolvedPathIntent`.
**testingStrategy:** `propertyTests: true` (schema-compliance property; serialization category); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** None
**Parallelizable:** Yes

#### Task 013: `export` handler — zip bundle + INV-13 precheck + replay round-trip

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/export.ts` (new — events.jsonl / state.json / metadata.json / artifacts/; requested→write→executed; crash precheck)
- `servers/exarchos-mcp/src/views/lifecycle/export.test.ts` (new)
- `servers/exarchos-mcp/src/views/composite.ts` (route `export`)
- `servers/exarchos-mcp/src/registry.ts` (action def, `task-isolated` posture, `openWorldHint: true`)

**Verification:** scoped tests + `check_test_adequacy` + integration suite. Tests: `Export_Bundle_ReplayEventsJsonlEqualsStateJson` (round-trip), `Export_CrashBetweenPair_PrecheckCompletesWithoutDuplicateIntent`, `Export_InvalidOutputPath_SuggestedFixNoEvents`, `Export_UnknownFeatureId_ExpectedShapeNoZip`. Windows: POSIX zip entries, handles closed before temp-dir removal (INV-16).
**testingStrategy:** `propertyTests: true` (property: `replay(export(store)) === projection(store)` for arbitrary event sequences — data-transformation round-trip); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 012
**Parallelizable:** No

#### Task 014: CLI top-level promotion mechanism (`CliActionHints.topLevel`)

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-7

**Files:**
- `servers/exarchos-mcp/src/registry.ts` (`CliActionHints.topLevel?: string`)
- `servers/exarchos-mcp/src/adapters/cli.ts` (hoist loop — same dispatch path, flags from the same Zod schema)
- `servers/exarchos-mcp/src/adapters/cli.test.ts` (promotion + collision guard)

**Verification:** scoped tests + `check_test_adequacy` + integration suite. Tests: `Promotion_TopLevelStamp_CommandRegisteredAndDispatches`, `Promotion_CollidingName_FailsRegistrationNotRuntime`, `Promotion_SubcommandForm_StillWorks`.
**testingStrategy:** `propertyTests: false` (adapter wiring; parity fixtures in 015 are the contract check); `benchmarks: false`; `characterizationRequired: true` (modifies CLI generation for every tool).
**Dependencies:** None
**Parallelizable:** Yes

#### Task 015: Stamp promotions + exit-code map + three-path parity fixtures

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-7

**Files:**
- `servers/exarchos-mcp/src/registry.ts` (`ps`→`ps`, `wait`→`wait`, `export`→`export`, `inspect`→`describe`)
- `servers/exarchos-mcp/src/adapters/cli.ts` (generic errorCode→exitCode map: `WAIT_TIMEOUT`→17, `WAIT_FAILED`→18 — presentation only)
- `servers/exarchos-mcp/src/parity/lifecycle-verbs.parity.test.ts` (new)

**Verification:** scoped tests + `check_test_adequacy`. Tests: `Parity_EachPromotedVerb_ByteIdenticalToolResultAcrossThreePaths`, `ExitCodeMap_WaitTimeout_17`, `ExitCodeMap_WaitFailed_18`, `ExitCodeMap_Success_0`.
**testingStrategy:** `propertyTests: false`; `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 007, 008, 010, 013, 014
**Parallelizable:** No

#### Task 016: Error-envelope edge cases across the verb surface

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-8

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/wait.ts` (`validTargets` from HSM topology for the workflow's type)
- `servers/exarchos-mcp/src/views/lifecycle/errors.test.ts` (new — consolidated edge-case suite)

**Verification:** scoped tests + `check_test_adequacy`. Tests: `Wait_InvalidPhase_ValidTargetsFromTopologyForWorkflowType`, `Verbs_UnknownFeatureId_SideEffectFreeExpectedShape` (inspect/wait/export; event-count invariance), `Ps_ProbeOutsideWorktreeScope_InvalidInputWithSuggestedFix`.
**testingStrategy:** `propertyTests: false`; `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 007, 008, 010, 013
**Parallelizable:** Yes (after deps)

#### Task 017: Subscription lifecycle hardening — disposal, cancellation, concurrency

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1, DR-8

**Files:**
- `servers/exarchos-mcp/src/event-store/subscriptions.test.ts` (leak + concurrency suites)
- `servers/exarchos-mcp/src/cli/follow-loop.ts` (SIGINT disposal)
- `servers/exarchos-mcp/src/mcp/tasks-methods.ts` (task-cancel disposal)

**Verification:** scoped tests + `check_test_adequacy`. Tests: `Follow_ConsumerDisconnect_HandleDisposedRegistryZero`, `TasksCancel_MidFollow_HandleDisposed`, `Wait_ConcurrentSameStream_BothResolveIndependently`.
**testingStrategy:** `propertyTests: true` (concurrency category — property: any interleaving of N concurrent subscribe/dispose/append operations leaves the registry consistent and delivers each subscriber only its matches); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 009, 010
**Parallelizable:** Yes (after deps)

#### Task 018: Documentation — liveness convention + subscription contract + verb surface

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-1, DR-2

**Files:**
- `docs/architecture/runtime.md` (§6 liveness convention: base schema + pairing rule + registry as enforcement; §L7 verbs updated to the shipped shape)

**Verification:** static analysis + `verify_doc_links`. The #1315 subscription contract is this spec's DR-1; runtime.md links here.
**testingStrategy:** `propertyTests: false`; `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 010
**Parallelizable:** Yes (after 010)

### Parallelization

**Critical path:** 001 → 002 → 010 → 011 (S-6 acceptance) and 010 → 015 (parity closure).

| Wave | Tasks (parallel within wave) |
|---|---|
| 1 | 001, 003, 005, 008, 012, 014 |
| 2 | 002, 004, 013 |
| 3 | 006, 007 (after 005+006), 009, 010 |
| 4 | 011, 015, 016, 017, 018 |

No two parallel tasks in the same wave modify the same file (`registry.ts`/`composite.ts`/`cli.ts` touches are serialized across waves 3–4 via dependencies; wave-1 tasks touch disjoint modules).

### Completion checklist

- [x] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [x] Every task `Implements:` a DR-N that exists in this document
- [x] Every task carries a `riskTier` stamp
- [x] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [x] Open questions are resolved OR explicitly deferred with rationale
- [ ] Ready for `plan-review`

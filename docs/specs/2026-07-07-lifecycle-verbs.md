# Spec: Process Lifecycle Verbs — generic ps / describe / wait / export over the event log

**Date:** 2026-07-07 (rev. 2: 2026-07-08) · **Feature:** `lifecycle-verbs` · **Depth:** deep
**Inputs:** #1316 (design spike, this spec closes it) · #1090 (epic; children #1103–#1106 absorbed here) · #1315 (subscription primitive — contract defined here) · #1599 roadmap (Z2 critical path, coordination rules 2–4) · `docs/specs/2026-07-03-wlm-6-surface-and-workflow-fixes.md` · `docs/specs/2026-06-26-wlm-operational-core.md` · `docs/architecture/runtime.md` §L7/§6 · `.exarchos/invariants.md` (INV-1/2/5a–d/6/7/8/10/12/13/15/16)

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

Epic #1090 promises generic workflow-lifecycle verbs — `ps` (list), `describe` (project), `wait` (event-driven gate), `export` (diagnostic bundle) — as layer L7 of the runtime: supervisor primitives over the event log, replacing ad-hoc `view pipeline` / `workflow get` polling. What exists today diverges:

- **WLM-6 (PR #1642) shipped worktree-scoped `ps`/`wait`** on `exarchos_view` — a `worktrees@v1` fold (merges/launches/prunes) with `until: merge|idle` polling. Same names as #1090, different semantics. Preview-only (v2.12.0-preview.1), so the shapes are still cheap to change.
- **The workflow-projection `describe` is absent**; the `describe` name on every composite tool is taken by GA'd schema-introspection.
- **`export` is absent.**
- **The #1315 subscription primitive is absent** — every waiter re-folds a projection on a sleep loop.
- **INV-10 is aspirational**: four surfaces emit `<surface>.executing_started`/terminal pairs (merge, launch, mutation, prune) as ad-hoc per-surface schemas with **no shared fields** (three of four record no start time in their data; none carry a uniform instance key) and no generic consumer; `mutation` is observable by nothing. `launch`/`prune` emit to the singleton `worktrees` stream, `merge`/`mutation` to feature streams — any generic design must carry that scoping, not assume it away.
- **Audit S-6 (stuck-`executing` recovery) remains open**: no generic way to wait out or inspect a crashed long-running operation. Note: the original #1090/#1316 sketch (`wait <id> --phase delegate` resolving merge stalls) is **semantically unsound** against shipped reducer behavior — `merge.recovered` folds into the `mergeOrchestrator` sub-view and never produces a phase transition, and merges run while the workflow is already *in* `delegate`. S-6 closure requires an operation-level predicate (DR-5), not a phase predicate.

Without one design, the four implementation issues (#1103–#1106) would diverge on subscription handling, predicate language, output schemas, and postures — exactly what #1316 was filed to prevent.

### Chosen Approach

**Unify under generic verbs on the two-tier subscription substrate** (Exploration, Option 2 — decided with the owner 2026-07-07):

1. **One subscription primitive (DR-1)** — a **cursor-pump**: each subscription holds a sequence cursor and delivery is always a cursor-driven drain; an in-process post-commit hook and a `dataVersion()` cross-process poll floor are merely *wake signals*. Registration atomically captures cursor + floor baseline and schedules an initial drain, so exactly-once, globally sequence-ordered delivery holds by construction. Subscriptions are ephemeral (per-dispatch), so INV-15's no-daemon frame holds by construction.
2. **One liveness contract (DR-2)** — a **descriptor registry** (`startType`, `terminalTypes`, `streamScope`, `instanceKeyOf`; `startedAt` from the envelope) — turns INV-10 from convention into checkable contract, defines the pairing relation the shipped events never had, and gives `ps` its generic operations fold and `wait` its operation predicate (adopted from Exploration Option 3, without its row-shape conflation).
3. **The verbs are pure consumers** — `ps`/`inspect`/`wait` are projections or subscriptions (no writes; `wait` emits no events, revising #1316 Q7); `export` is the one emitter and follows INV-13's two-event split.
4. **CLI promotion (DR-7)** hoists the verbs to `exarchos ps|describe|wait|export` through a registry-driven mechanism, keeping INV-2 parity.

Compatibility posture: **break-in-preview** — the WLM-6 `ps`/`wait` schemas are redesigned freely (no shims); the unified surface lands before v2.12.0 GA. Worktree capabilities (probe/reconcile, merge/idle waits) are preserved as a *scope* of the generic verbs. Event-data changes are **validation-compatible additive only**: every previously stored payload still validates; emitters may gain fields; nothing is migrated.

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: Cursor-pump subscription primitive with two wake tiers (#1315)

The event store exposes `subscribe(filter, onEvent, { fromSequence?, floorMs? }): SubscriptionHandle` where `filter` is `{ streamId?, eventTypes?[] }`. Each subscription holds a **sequence cursor**; delivery is always a **cursor-driven drain** — read matching events after the cursor, deliver in global sequence order, advance the cursor. **Registration contract:** `subscribe()` atomically captures the cursor position (head, or `fromSequence`) together with the Tier-2 floor baseline and schedules an unconditional **initial drain**, so an event committed at any moment relative to registration is delivered exactly once — by the initial drain or a later wake, never lost to a baseline that already included it. Two wake signals trigger drains: **Tier 1** (in-process): a post-commit hook fires after the append transaction commits **and after the per-stream mutex releases** (never inside the lock — the appender's per-stream Promise mutex is non-reentrant, so a listener that itself appends must not deadlock). **Tier 2** (cross-process): a bounded poll floor re-checks `dataVersion()` (near-free) and drains only when a foreign connection has committed. Because both tiers converge on the same cursor drain, a Tier-1 wake at sequence N+1 delivers a not-yet-seen foreign event at sequence N first — no gaps, no double delivery. Listener failures are isolated (never affect an append result or sibling listeners). INV-8 idempotency cache-hits commit nothing and do **not** wake subscriptions. Subscriptions are ephemeral: registered by a dispatch, disposed when it returns (INV-15). `dataVersion(): number` joins the `StorageBackend` interface with **per-backend semantics**: SQLite (`PRAGMA data_version`) changes iff a *foreign* connection committed — the observer's own commits never bump it; `InMemoryBackend` uses a monotonic append counter (own appends bump it; the resulting spurious drains are idempotent by cursor).

**Acceptance criteria:**
- Given a subscription with cursor at sequence N, when matching events N+1…N+k are appended in-process, then the drain delivers them post-commit in order; a listener that throws on N+1 does not affect the append result, sibling listeners, or delivery of N+2…N+k.
- Given interleaved appends from a second connection (sequence N, undrained) and the own process (sequence N+1), then delivery order is N, N+1 — exactly once each (gap-detection property, injectable clock).
- Given a foreign commit landing at any point relative to `subscribe()` (before the head read, between head read and baseline capture, after registration), then it is delivered exactly once — the registration-timing property test varies the registration point among generated appends; the initial drain covers the baseline-already-included case.
- Given a listener that appends to the same stream during delivery, then no deadlock occurs (hook fires outside the per-stream mutex) and the new event arrives in a subsequent drain.
- Given an INV-8 idempotency cache-hit (duplicate append, no new commit), then no wake fires and nothing is re-delivered.
- Given a dispatch that registered subscriptions, when it returns (success or error), then all its handles are disposed — a leak test asserts the registry count returns to zero.
- With zero subscribers, the append hot path executes no listener-related work beyond a single guard check (append benchmark: p99 regression < 5% vs baseline).
- The floor interval has a documented default, honored per-call `floorMs` override (test), and is driven by an injectable clock so floor tests are deterministic (no wall-clock sleeps).
- `dataVersion()` per-backend contract tests: SQLite — foreign-commit-only visibility (second connection bumps it; own commit does not); `InMemoryBackend` — monotonic on every committed append.

#### DR-2: Liveness descriptor registry (INV-10 made checkable)

One registry entry per surface defines the whole liveness contract the verbs consume:

```ts
{ surface, startType, terminalTypes: string[],
  streamScope: 'feature' | 'worktrees',
  instanceKeyOf(data): string }
```

- **`startedAt` derives from the start event's envelope timestamp** — three of four shipped surfaces record no start time in their data; the envelope is the uniform source (no payload change needed).
- **Pairing relation:** an operation is in flight iff a start event's `instanceKeyOf(data)` has no later terminal event with the same key on the same stream. Concurrent operations on one stream (the *normal* case for `launch` on the singleton `worktrees` stream) pair correctly by key, not by type-level ordering.
- **Canonical `instanceId` (additive standardization, owner decision 2026-07-08):** all four emitters gain one canonical `instanceId` field on their start *and* terminal emissions — `merge` → `taskId ?? sourceBranch→targetBranch`; `launch` → `worktreeId`; `prune` → its existing `operationId`; `mutation` → a new `operationId`. `instanceKeyOf` therefore reads `data.instanceId ?? legacyFallback(surface, data)` — the per-surface fallback extractors exist only for events stored before this change. **New surfaces MUST emit `instanceId`** (their registry entries carry no fallback; the conformance test enforces it), so the extractor zoo is a shrinking legacy shim, not a permanent design. `surface` and `startedAt` are deliberately NOT standardized into payloads: the former is derivable from the event type, the latter from the envelope — in-payload copies would be redundant.
- **`streamScope`** records where the surface emits: `merge`/`mutation` → feature streams; `launch`/`prune` → the singleton `worktrees` stream. Verbs use it to decide feature-observability (DR-5).
- **Retrofit posture: validation-compatible additive, never byte-identical emission.** Every previously stored payload still validates against the retrofit schemas; emitters gain the canonical `instanceId` additively; nothing is migrated. Previously-emitted payload shapes are pinned as fixtures.

Adding a surface to the lifecycle plane = one registry entry, zero verb code.

**Acceptance criteria:**
- Fixtures of previously-emitted payload shapes (captured verbatim from the shipped emitters for all four surfaces) validate against the retrofit schemas.
- All four emitters emit the canonical `instanceId` additively on start and terminal events; events stored before the change still validate and pair via the surface's legacy fallback (legacy `mutation` events without any key: treated as a singleton instance).
- A conformance test fails if any `*.executing_started` event type in the emission catalog lacks a registry entry with ≥1 terminal type, a `streamScope`, and an `instanceKeyOf`; a registry entry **without** a legacy fallback requires `instanceId` in its start schema (the new-surface rule).
- Given `start(A)`, `start(B)`, `terminal(B)` on one stream, then A is in flight and B is not (concurrent-pairing property over arbitrary key interleavings).
- `docs/architecture/runtime.md` §6 documents the convention (descriptor registry + pairing rule + envelope-derived `startedAt`) and cites the registry as its enforcement.

#### DR-3: Generic `ps` — scope-parameterized process listing

`exarchos_view { action: 'ps', scope: 'workflow' | 'worktree' | 'all' }` (default `all`). Output has two honestly-shaped sections, never conflated rows: `workflows` (fold of `workflow_state` joined with `streams.workflow_type`: featureId, workflowType, phase, status, ageMs) and `operations` (generic fold over the DR-2 registry: any start whose instance key lacks a terminal — including `mutation`, which today nothing surfaces; `startedAt`/age from envelope timestamps). Filters: `workflowType` (indexed pushdown via a new `listWorkflowSummaries` backend read joining `workflow_state` × `streams`), `status`, `phase`, `all` (include completed/cancelled; default excludes them). The WLM-6 worktree fold (in-flight merges/launches/prunes + `probe` reconciliation) is preserved under `scope: 'worktree' | 'all'`; `probe: true` remains a conditional writer with its existing `LOCAL_MUTATION_IDEMPOTENT` annotation. All new/redesigned action fields come from the shared lifecycle field-shape module (DR-8) so cross-action base types cannot collide.

**Acceptance criteria:**
- Given workflows of mixed types and phases, when `ps --workflow-type feature`, then only `feature` rows return, and the read goes through `listWorkflowSummaries` with the `streams.workflow_type` index (pushdown asserted, not in-memory filtered).
- Given `--status <state>` or `--phase <name>`, then only matching workflow rows return (named tests per filter).
- Given a completed workflow, then default `ps` excludes it and `--all` includes it.
- Given a synthetic `mutation.executing_started` without terminal, then it appears in `operations` with no mutation-specific code in any verb handler (generic-fold test).
- Given two concurrent same-surface operations on one stream where only the second has a terminal, then `ps` lists exactly the first as in flight (instance-key pairing).
- Given `scope: 'workflow'` with `probe: true`, then the input is rejected as `INVALID_INPUT` (probe is a worktree-scope capability).
- Worktree-scope output preserves every WLM-6 capability (in-flight pairs, launches, prunes, probe reconcile) under the redesigned schema.

#### DR-4: `inspect` — the workflow-projection describe

New `exarchos_view` action `inspect(featureId, follow?, limit?)`: composite projection returning workflow state (via the canonical `resolveWorkflowState`/rehydration path — never `.state.json` presence), recent events (with `operationId`/`correlationId`/`causationId`), artifacts, and task progress. Existence signal is `_meta.workflowExists`; a cold probe of an unknown featureId is side-effect-free. `--follow` consumes DR-1 and streams through two carriers per #1316 Q3: NDJSON frames on the CLI (existing encoder/heartbeat, heartbeats on the injectable timer), MCP Tasks (SEP-1686) on the MCP path — one contract, two presentations (INV-5b). Follow disposal is `AbortSignal`-based (SIGINT wired to abort on POSIX and Windows alike — no POSIX-only signal semantics). The MCP action name avoids the GA'd schema-`describe` (no rename, no Zod-union overload — a known CLI-parity hazard); DR-7 maps the CLI top-level verb `exarchos describe <id>` onto it.

**Acceptance criteria:**
- Given an unknown featureId, when `inspect` runs, then it returns `success: true` with `_meta.workflowExists: false` and appends no event — the canonical, side-effect-free cold-probe contract shared with `rehydrate`/`get` (NOT an error envelope).
- Given `--follow`, when events append to the feature's stream (in-process or cross-process), then they appear as NDJSON `event` frames deduplicated by sequence; heartbeat frames cover silent gaps (injected timer).
- The MCP path exposes follow via Tasks (`tasks/get`/`tasks/result`), sharing the DR-1 subscription with the CLI carrier.
- Given abort (CLI SIGINT→AbortSignal, MCP task cancel), the follow loop exits and its subscription handle is disposed.
- Schema-introspection `describe` on **all four** composite tools is byte-unchanged (test enumerates the four).

#### DR-5: Generic `wait` — event-driven gate with phase, status, and operation predicates; no self-journaling

`wait(featureId, phase?, status?, operation?, until?, integrationRef?, timeoutMs)`:

- **`phase`** — reached-or-passed semantics: the projection is checked first, returning immediately if the target phase was already reached (idempotent re-runs, #1316 Q2); otherwise a DR-1 subscription on `workflow.transition` resolves it.
- **`status`** — terminal waits. Resolves **successfully** when the workflow reaches the *requested* terminal status (`completed` / `failed` / `cancelled`); returns immediately if already in it; resolves `WAIT_FAILED` if a *different* terminal status arrives first; `WAIT_TIMEOUT` otherwise.
- **`operation <surface>`** — the **S-6 predicate**, valid for **feature-scoped surfaces only** (DR-2 `streamScope: 'feature'`: `merge`, `mutation`): resolves when the feature's unpaired `<surface>.executing_started` (by instance key) gains a terminal event per the registry; resolves immediately if none in flight. Singleton-stream surfaces (`launch`, `prune`) are **not feature-observable** — they emit to the `worktrees` stream — and remain covered by the retained worktree predicates below; requesting them here returns `INVALID_INPUT` with `validTargets` = the feature-scoped surfaces and a `suggestedFix` pointing at `until`. This — not `--phase` — is how a stuck merge is waited out: `merge.recovered` never transitions the workflow phase (it folds into the `mergeOrchestrator` sub-view), so the original epic sketch is explicitly corrected here.
- **`until: merge|idle` + `integrationRef`** — the WLM-6 worktree predicates, retained as the worktree scope of the same action.

`wait` emits **no events** (revises #1316 Q7): posture read-only, `readOnlyHint: true`, `idempotentHint: true` — the log records domain facts, not observations of them. Timeout/failure return structured `WAIT_TIMEOUT` / `WAIT_FAILED` envelopes; the CLI adapter maps them to exit codes 17/18 as pure presentation (a generic errorCode→exitCode map, INV-2-safe).

**Acceptance criteria:**
- Given a workflow already past `--phase plan-review`, when `wait --phase plan-review` runs, then it returns success immediately (exit 0) without subscribing.
- Given an in-process `workflow.transition` to the target phase, then `wait` resolves on the Tier-1 wake (injected clock; no floor tick consumed).
- Given a foreign-connection event satisfying the predicate, then `wait` resolves within one floor tick (injected clock) and the floor interval is surfaced in `_perf` (verb-level Tier-2 test).
- Given no matching event within `timeoutMs`, then `WAIT_TIMEOUT` is returned and the CLI exits 17.
- Given the workflow enters `failed`/`cancelled` while waiting on a phase, then `WAIT_FAILED` is returned and the CLI exits 18.
- Given `wait --status completed` on a workflow that later completes, then it resolves successfully; given the workflow is already `completed`, it returns immediately; given the workflow instead reaches `cancelled`, then `WAIT_FAILED` (exit 18); given nothing terminal, `WAIT_TIMEOUT` (exit 17).
- Given an unpaired `merge.executing_started`, when `wait --operation merge` runs, then it resolves when a registry terminal for that instance key lands (e.g. `merge.recovered`, `merge.executed`); given none in flight, it returns immediately; given no terminal within `timeoutMs`, exit 17.
- Given `wait <id> --operation launch` (a `worktrees`-scoped surface), then `INVALID_INPUT` with `validTargets` = feature-scoped surfaces and `suggestedFix` referencing `until`.
- Worktree retention: `Wait_WorktreeScope_PreservesWlm6Capabilities` — `until: merge` (with `integrationRef`) and `until: idle` behave per the WLM-6 contract under the redesigned schema.
- **S-6 closure walkthrough:** given `merge.executing_started` with no terminal (simulated crash), `wait <id> --operation merge --timeout 10m` resolves when `merge.recovered` lands, or exits 17 on timeout; `inspect` shows the unpaired `executing_started`; no merge-specific code exists in `wait.ts` or `operations-fold.ts` (grep-asserted; behavioral assertions carry the adequacy).
- `wait` appends zero events across all paths (event-count invariance in tests).

#### DR-6: `export` — event-log bundle with the INV-13 two-event split

`export(featureId, output?)`: writes a zip containing `events.jsonl` (full stream extract), `state.json` (projection snapshot), `metadata.json` (version, eventCount, phase, exportedAt), and `artifacts/` (referenced artifact files that exist on disk; missing references tolerated and listed in metadata). Zip writing uses **`yazl`** (pure-JS, pinned) — no zip capability exists in the repo today, and a hand-rolled binary format is riskier than a small mature dependency; the single-file bun bundle must still build and export must work from it. Writing outside `.exarchos/` is a non-idempotent external side effect, so export follows INV-13: `export.requested` (intent + resolved path) before the write, `export.executed` (result + content hash) after. Crash between the two → the next invocation runs an idempotent precheck (zip exists + hash matches manifest) to re-emit or skip. Posture `task-isolated`, `openWorldHint: true`. Default output `./<featureId>-export.zip`; invalid paths return `suggestedFix` with the default.

**Acceptance criteria:**
- Given an exported bundle, when `events.jsonl` is replayed through the reducers, then the result equals `state.json` (round-trip test) — the event log **is** the export.
- `Export_Success_AppendsExactlyRequestedExecutedPair` — every successful export appends exactly one `export.requested`/`export.executed` pair, idempotency-keyed per INV-8; re-running export produces a new pair for the new zip, never a duplicate of a prior intent.
- Given a crash simulated between the pair, when export re-runs, then the precheck detects the existing/partial zip and completes without duplicating the `requested` intent.
- Given referenced artifacts where some paths are missing on disk, then existing ones are bundled under `artifacts/` and missing ones are listed in `metadata.json` without failing the export.
- Given an invalid `--output` path, then a structured error with `suggestedFix` (default location) returns and no events are appended.
- Zip entry names are POSIX-normalized (`path.posix` for entry names; `path.join` only for filesystem paths); tests close SQLite handles before temp-dir removal (INV-16); `npm run build` still produces a working single-file bundle containing the zip writer.

#### DR-7: Registry-driven CLI top-level promotion

`CliActionHints` gains `topLevel?: string`. The CLI adapter hoists any action carrying it to a top-level command (name = the field's value) that dispatches through the identical core path with flags derived from the same Zod schema — zero adapter behavior (INV-2). Stamps: `ps`→`ps`, `wait`→`wait`, `export`→`export`, `inspect`→`describe` (epic UX preserved without touching the GA'd schema-describe). A build-time collision guard fails fast if a `topLevel` name collides with a tool name, alias, or another promotion. The subcommand forms (`exarchos view ps`) keep working.

**Acceptance criteria:**
- `exarchos ps|describe <id>|wait <id>|export <id>` all resolve and dispatch.
- Parity fixtures assert byte-identical `ToolResult` across the three invocation paths — top-level CLI, `view <action>` subcommand, MCP `exarchos_view` — for each promoted verb, with volatile fields (`_perf`, timestamps, `ageMs`) normalized per the existing parity-harness conventions (injected clock where needed).
- A registry entry with a colliding `topLevel` name fails the build/registration test, not runtime.
- `Registry_VisibleCompositeCount_RemainsFour` — the visible MCP tool count stays 4 (INV-5d); extend/cite the existing visible-count fence in `registry.test.ts`.

#### DR-8: Error handling, failure modes, and edge cases

Cross-cutting failure contract for the verb surface.

**Acceptance criteria:**
- Given `wait --phase <invalid>`, then the error envelope's `validTargets` is populated from the HSM topology **for that workflow's type**; given `--operation <unknown-or-non-feature-scoped-surface>`, `validTargets` lists the registry's **feature-scoped** surfaces.
- Given an unknown featureId on the read verbs `inspect`/`export`, then a side-effect-free `success: true` result with `_meta.workflowExists: false` returns — the canonical cold-probe contract shared with `rehydrate`/`get` (NOT an error envelope); no stream registration, no events. `wait` on an unknown featureId is likewise side-effect-free (no stream registration, no events): its predicate simply never holds, resolving through the normal `WAIT_TIMEOUT`/`WAIT_FAILED` path rather than a `workflowExists` envelope.
- Given a subscription whose consumer disconnects mid-follow (CLI abort, MCP task cancel), then the handle is disposed and the leak test passes.
- Given concurrent `wait`s on the same stream from two dispatches, then both resolve independently (no shared-handle interference).
- Cross-process `wait` latency is bounded by one floor interval + one drain — verified at the **verb level** by DR-5's foreign-connection test (Task 010), deterministically via the injected clock; the floor default is documented and surfaced in `_perf`.
- **Registration integrity:** the composed `exarchos_view` registration schema — including every new/redesigned lifecycle field — constructs without `buildRegistrationSchema` throwing (the documented same-field-name/different-base-type THROW class). All lifecycle actions source shared field names from one field-shape module; a construction test guards the composed registry.
- **Windows (INV-16):** Task 017 owns the hardening mechanics and the mid-feature audit (through wave 5): the poll floor holds no open SQLite statement across ticks (handle-close class, #1620); two-connection tests set an explicit `busy_timeout` posture; follow disposal is AbortSignal-based (no POSIX-only signal semantics); all timing tests use the injectable clock (no wall-clock sleeps — the #1641 nondeterminism class). **Final discharge rides the last wave:** Tasks 015 and 016 each complete only with the `test-windows` CI lane green on the integration tip and a zero-new-`skipIf(win32)` grep over the **full feature diff** (new CLI-path tests are the documented win32 `.cmd`-shim class, #1623).

### Technical Design

**New substrate:** `servers/exarchos-mcp/src/event-store/subscriptions.ts` — subscription registry, `SubscriptionHandle`, the **cursor pump** (per-subscription `lastDeliveredSeq`; wake → drain matching events after cursor in global order → advance), atomic registration (cursor + floor baseline captured together, immediate initial drain), and the Tier-2 floor loop on an **injectable clock**. The Tier-1 hook point lands in the append path (`store.ts`/`atomic-appender.ts`) and fires **after commit and after the per-stream mutex releases** — listener-initiated appends re-enter the normal append path without deadlock; the hook is a single guard check when no subscribers exist. INV-8 cache-hit short-circuits (pre-transaction, no commit) never wake. `dataVersion()` joins `StorageBackend` (`storage/backend.ts`): SQLite = `PRAGMA data_version` (foreign-commit-only visibility); `InMemoryBackend` = monotonic append counter (spurious drains idempotent by cursor).

**Liveness contract:** the descriptor registry (`event-store/liveness-registry.ts`) carries `{ startType, terminalTypes, streamScope, instanceKeyOf }` per surface; `startedAt` comes from the start event's **envelope timestamp**. Schema retrofits in `event-store/schemas.ts` are validation-compatible additive (fixtures pin previously-emitted shapes); all four emitters gain the canonical `instanceId` (merge/launch/prune copy their natural keys; mutation mints one), so `instanceKeyOf` is `data.instanceId ?? legacyFallback` and new surfaces need no fallback at all. The generic "in-flight operations" fold pairs starts to terminals **by instance key** and is a small reusable module consumed by `ps` and by `wait --operation` — not a new stored projection table.

**Backend read surface:** `listWorkflowSummaries({ workflowType?, status?, phase?, includeTerminal? })` joins `workflow_state` × `streams` with the `workflow_type` index (SQLite pushdown; in-memory filter on `InMemoryBackend`) — the `ps` workflows fold consumes it instead of loading all states.

**Verbs:** new handlers under `src/views/lifecycle/` (ps/inspect/wait/export), routed via `views/composite.ts`; the WLM-6 worktree fold (`verbs/worktree/handlers.ts`) is called by the `ps` worktree scope rather than duplicated; the WLM-6 wait kernel is absorbed by generic `wait`. All lifecycle action schemas import field definitions from `src/views/lifecycle/schema-fields.ts` (one canonical Zod shape per field name — `scope`, `status`, `phase`, `workflowType`, `all`, `follow`, `limit`, `output`, `operation`) so `buildRegistrationSchema`'s same-name/different-base-type THROW is unrepresentable; a registry-construction test enforces it. Registry entries stamp postures, `outputSchema`, annotations, and `cli.topLevel` (#1316 Q7/Q8 land as registration facts, not prose).

**CLI:** promotion loop + errorCode→exitCode map in `adapters/cli.ts`; follow carriers reuse `src/ndjson/` (CLI) and `src/mcp/tasks-methods.ts` (MCP), both fed by DR-1; follow lifecycle is AbortSignal-driven.

**SDK-lowering mapping (#1599 rule 3):** `wait --phase` lowers as the IR's `awaitPhase(featureId, phase)` combinator and `wait --operation` as `awaitOperationIdle(featureId, surface)`; the subscription primitive is the runtime service IR await-nodes bind to; `ps`/`inspect`/`export` are read-side projections with no IR footprint. No edits to `hsm-definitions.ts`/`playbooks.ts`.

**Q11 alignment:** INV-1 (all verbs are folds/subscriptions/emitters — no side stores); INV-2 (parity fixtures per verb); INV-6 (verbs read topology/projections generically — no workflow-type branching); INV-12 (`wait` complements `next_actions`: affordances say what *can* run, `wait` observes what *did*).

### Integration Points

- `servers/exarchos-mcp/src/event-store/store.ts` + `atomic-appender.ts` — post-commit notification hook (outside the per-stream mutex; guarded, zero-cost empty path; no wake on idempotency cache-hits)
- `servers/exarchos-mcp/src/event-store/subscriptions.ts` — **new**: registry, cursor pump, atomic registration + initial drain, handle lifecycle, injectable-clock floor
- `servers/exarchos-mcp/src/storage/backend.ts` + `sqlite-backend.ts` + `memory-backend.ts` — `dataVersion()` contract + `listWorkflowSummaries` read
- `servers/exarchos-mcp/src/event-store/schemas.ts` + `liveness-registry.ts` — validation-compatible retrofits; descriptor registry; `export.*` events
- `servers/exarchos-mcp/src/verbs/run-mutation.ts` (or the mutation emission site) — additive `operationId`
- `servers/exarchos-mcp/src/views/composite.ts` — route `ps`(redesigned)/`inspect`(new)/`wait`(redesigned)/`export`(new)
- `servers/exarchos-mcp/src/views/lifecycle/` — **new**: verb handlers + `schema-fields.ts` shared shapes
- `servers/exarchos-mcp/src/verbs/worktree/handlers.ts` — worktree fold consumed as `ps` scope; WLM-6 wait kernel absorbed
- `servers/exarchos-mcp/src/registry.ts` — action defs, postures, outputSchemas, `CliActionHints.topLevel`
- `servers/exarchos-mcp/src/adapters/cli.ts` — top-level promotion, exit-code map, follow carrier wiring
- `servers/exarchos-mcp/src/ndjson/` + `src/mcp/tasks-methods.ts` — carriers over the DR-1 contract
- `servers/exarchos-mcp/package.json` — `yazl` (pinned) for DR-6
- `docs/architecture/runtime.md` §6/§L7 — liveness convention + verb docs

### Exploration

Divergent loop run 2026-07-07 (deep rung; `correlationId: c3c85d7a-8abf-48e4-9121-f96f5e504198`). Grounding: a full codebase sweep of the shipped surface (WLM-6 `ps`/`wait` worktree scoping, absent subscription primitive, ad-hoc INV-10 schemas, no CLI promotion mechanism) plus #1316/#1090/#1599 and the four WLM specs. The `/exarchos:discover` bridge was offered and declined — the sweep plus shipped specs gave sufficient grounding.

- **Option 1 — Formalized bounded poll:** declare polling *is* the #1315 contract; generalize the WLM-6 wait kernel; no event-store changes. Rejected: enshrines the active polling INV-10 exists to replace; latency floor on every wait; O(poll × fold) waste.
- **Option 2 — Two-tier subscription substrate (chosen):** in-process post-commit notify + `data_version` cross-process floor; ephemeral per-dispatch handles (INV-15-safe); one contract, two carriers. Delivers #1315 rather than renaming polling.
- **Option 3 — Uniform process table:** a `liveness@v1` projection folding all INV-10 pairs; workflows and operations as uniform rows. Partially adopted — the generic operations fold (via the DR-2 registry) — but the uniform row shape was rejected: an *operation* (bounded, liveness-paired) and a *workflow* (long-lived, phase-structured) are semantically distinct, and one row shape muddies both.

Owner decisions converged in one iteration: unify (vs coexist) · full pickup (spec through implementation) · break-in-preview (no shims) · build CLI promotion · Option 2 · `wait` emits no events · MCP `inspect` / CLI `describe`.

**Plan-review revision 1 (2026-07-08).** A 3-voter fresh-context adversarial panel (coverage / feasibility / adequacy) refuted rev. 0 unanimously. Design-level corrections absorbed: (a) DR-1 re-specified as a **cursor-pump** — the naive "synchronous notify" wording could not jointly satisfy exactly-once and global order across two connections, and left the listener-vs-per-stream-mutex re-entrancy contract undefined; (b) DR-5 gained the **`operation` predicate** after the panel proved the epic's phase-based S-6 walkthrough unsound against shipped reducer semantics (`merge.recovered` never transitions phase); (c) DR-6 pinned the zip dependency (`yazl` — none exists in-repo); (d) DR-8 gained the registration-integrity and Windows/INV-16 criteria with owning tasks (019/017). Decomposition re-waved to eliminate three same-file wave collisions; six tiers raised to match the mechanical derivation.

**Plan-review revision 2 (2026-07-08).** A second fresh 3-voter panel refuted rev. 1 unanimously. Corrections absorbed: (a) DR-2 rebuilt as a **descriptor registry** — the shipped `executing_started` payloads share no fields (no uniform `startedAt`, no instance key), so the rev.-1 required-field base + byte-identical `.extend` retrofit was unimplementable; `startedAt` now derives from the envelope, pairing is by per-surface `instanceKeyOf`, and the retrofit posture is validation-compatible additive (`mutation` gains `operationId`); (b) DR-5's `operation` predicate scoped to **feature-scoped surfaces** (`merge`/`mutation`) — `launch`/`prune` emit to the singleton `worktrees` stream and are not feature-observable (the worktree `until` predicates cover them); (c) DR-1 gained the **registration contract** (atomic cursor+baseline capture, unconditional initial drain) closing a registration-race delivery hole, plus per-backend `dataVersion()` semantics; (d) DR-5's `status` predicate got defined semantics + ACs (it previously shipped as an untested input branch); (e) the `workflowType` pushdown got its missing backend read (`listWorkflowSummaries`) with Task 005 re-sequenced to own it; (f) Windows/INV-16 final discharge moved to the last wave (015/016), Task 019 raised to high (schema-glob surface), the 009→015 `cli.ts` edge added, and benchmark SLAs got numeric targets. **Owner amendment (2026-07-08):** the instance key was standardized — all four emitters gain a canonical additive `instanceId` (not just mutation), demoting the per-surface extractors to a legacy-events-only fallback; `surface`/`startedAt` deliberately stay un-standardized in payloads (derivable from event type and envelope respectively).

### Alternatives considered

- **Coexist (freeze WLM-6 verbs, add new names)** — rejected: permanently splits the lifecycle surface and squats the #1090 names on worktree semantics.
- **Compat shims / additive-only schemas** — rejected: the shapes are preview-only; shim debt for zero GA consumers.
- **`wait.started`/`wait.completed`/`wait.timeout` emission (#1316 Q7 original)** — rejected: observation verbs stay pure reads; log noise proportional to observation frequency; Aspire's `wait` does not journal itself. Exit codes 17/18 survive as CLI presentation.
- **Zod-union overload of `describe`** — rejected: known `coerceFlags` CLI-parity break on unions; agent-facing schema ambiguity (INV-5a).
- **Renaming schema-`describe` to free the name** — rejected: breaks a GA'd discovery surface all agents use.
- **OS-level notification (fs-watch on the SQLite WAL, LISTEN/NOTIFY-style IPC)** — rejected: imports watcher/daemon primitives from outside the INV-15 frame; `data_version` polling floor achieves the cross-process bound within it.
- **Hand-rolled STORE-method zip writer** — rejected in rev. 1: a bespoke binary format is higher-risk than a pinned, tiny, pure-JS `yazl`; bundle-size impact verified in Task 013.
- **Phase-based S-6 recovery (`wait --phase delegate`)** — rejected in rev. 1 (see DR-5): unsound against reducer semantics; replaced by the operation predicate.
- **Required-field `ExecutingStartedBase` + byte-identical `.extend` retrofit** — rejected in rev. 2: the shipped payloads lack the fields (three of four have no start time; none share an instance key); replaced by envelope-derived `startedAt` + the descriptor registry + the additive canonical `instanceId` standard (full payload standardization of `surface`/`startedAt` stays rejected as redundant with the event type and envelope).
- **Feature-scoped `wait --operation launch|prune`** — rejected in rev. 2: those surfaces emit to the singleton `worktrees` stream and are not feature-observable; the retained worktree `until` predicates are their honest waiting surface.

### Open Questions

- **Rich `wait` predicates (JSONPath over projection state, any-of/all-of):** deferred — phase/status/operation/until covers S-6 and the v2.12 consumers; file a follow-up when a concrete consumer needs more (per #1316 Q2's own recommendation).
- **MCP `resources/subscribe` exposure of DR-1:** deferred to the #1604 MCP-migration tranche (Z3) — the primitive is transport-agnostic; exposing it remotely is a harness-boundary question (#1599 rule 5).
- **Import/replay tooling for export bundles:** deferred; the round-trip test (DR-6) guarantees replayability, tooling lands with a concrete diagnostic consumer.
- **`shepherd`/`tdd-swarm` liveness conformance:** out of scope per #1316; the DR-2 registry makes each a one-entry addition tracked on their own issues.
- **Worktrees-stream operation waits (`wait --operation launch` without a featureId):** deferred — the worktree `until` predicates cover today's consumers; a feature-less operation wait needs a schema change (optional featureId) with its own design pass.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.

### Scope

**Target:** Full design (DR-1 … DR-8)
**Excluded:** None — the design's Open Questions are explicitly deferred there with rationale; no DR is partially implemented.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Cursor-pump subscription primitive (#1315) | 001, 002, 017, 018 |
| DR-2 | Liveness descriptor registry | 003, 004, 018 |
| DR-3 | Generic `ps` (scope-parameterized) | 005, 006, 007, 011 |
| DR-4 | `inspect` workflow-projection describe | 008, 009 |
| DR-5 | Generic `wait` (phase/status/operation predicates) | 010, 011 |
| DR-6 | `export` with INV-13 two-event split | 012, 013 |
| DR-7 | Registry-driven CLI top-level promotion | 014, 015 |
| DR-8 | Error handling, failure modes, edge cases | 010, 011, 015, 016, 017, 019 |

### Tasks

#### Task 001: Subscription registry + cursor pump + post-commit wake (Tier 1)

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Acceptance Test Ref:** 011
**Implements:** DR-1

**Files:**
- `servers/exarchos-mcp/src/event-store/subscriptions.ts` (new — registry, `SubscriptionHandle`, cursor pump, atomic registration + initial drain, filter matching, injectable clock seam)
- `servers/exarchos-mcp/src/event-store/subscriptions.test.ts` (new)
- `servers/exarchos-mcp/src/event-store/store.ts` (post-commit hook point — guarded zero-cost when empty)
- `servers/exarchos-mcp/src/event-store/atomic-appender.ts` (wake fired after commit AND after per-stream mutex release; no wake on INV-8 cache-hits)

**Verification:** scoped tests + `check_test_adequacy` + integration suite. Tests: `Subscribe_InProcessAppend_CursorDrainDeliversPostCommitInOrder`, `Subscribe_RegistrationConcurrentWithAppends_InitialDrainNoLoss`, `Subscribe_ListenerThrows_AppendUnaffectedSiblingsAndLaterEventsDelivered`, `Subscribe_ListenerAppendsSameStream_NoDeadlockDeliveredNextDrain`, `Subscribe_IdempotencyCacheHit_NoWakeNoRedelivery`, `Subscribe_DispatchReturns_HandleDisposedRegistryZero`, `Append_ZeroSubscribers_GuardCheckOnly`. INV-16: no wall-clock sleeps (injectable clock); SQLite handles closed before temp-dir removal.
**testingStrategy:** `propertyTests: true` (property: for arbitrary interleavings of matching/non-matching appends, wakes, **and the registration point itself**, each subscriber receives exactly its matches after its registration cursor, exactly once, in global sequence order — concurrency category); `benchmarks: true` (`performanceSLAs: [{ operation: 'event-append-zero-subscribers', metric: 'p99_regression_pct', threshold: 5 }]`; boundary/offline cadence, not the inner vitest loop); `characterizationRequired: true` (append path is existing code).
**Dependencies:** None
**Parallelizable:** Yes

#### Task 002: Tier-2 poll floor — `dataVersion()` backend contract + gap-free drain

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Acceptance Test Ref:** 011
**Implements:** DR-1

**Files:**
- `servers/exarchos-mcp/src/storage/backend.ts` (`dataVersion(): number` joins the interface)
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts` (`PRAGMA data_version`)
- `servers/exarchos-mcp/src/storage/memory-backend.ts` (`InMemoryBackend`: monotonic append counter)
- `servers/exarchos-mcp/src/event-store/subscriptions.ts` (floor loop on the injectable clock; baseline captured atomically at registration; drain only on version change; no open statement held across ticks)
- `servers/exarchos-mcp/src/event-store/subscriptions.test.ts`

**Verification:** scoped tests + `check_test_adequacy` + integration suite. Tests: `Floor_ForeignCommit_DrainedInGlobalOrderNextTick` (injected clock), `Floor_ForeignThenOwnAppend_NoGapNoDoubleDelivery` (foreign seq N + own seq N+1 → delivered N, N+1), `Floor_CommitBetweenHeadReadAndBaseline_DeliveredByInitialDrain`, `Floor_NoForeignCommit_NoReRead`, `Floor_PerCallIntervalOverride_Honored`, `Floor_DefaultInterval_SurfacedInPerf`, `DataVersion_Sqlite_ForeignCommitOnlyVisibility` (second connection bumps; own commit does not), `DataVersion_InMemory_MonotonicOnAppend`. Two-connection tests set explicit `busy_timeout` (INV-16 / SQLITE_BUSY posture).
**testingStrategy:** `propertyTests: true` (property: for any split of appends across two connections, any wake/tick schedule, and any registration point, the subscriber observes every matching post-registration event exactly once in global sequence order); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 001
**Parallelizable:** No (extends 001's module)

#### Task 003: Validation-compatible liveness schema retrofit + canonical `instanceId` on all four emitters

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `servers/exarchos-mcp/src/event-store/schemas.ts` (retrofit the four `*.executing_started` (+terminal) schemas — validation-compatible additive `instanceId`; shared structural helpers only where payloads actually agree)
- `servers/exarchos-mcp/src/event-store/schemas.test.ts` (previously-emitted payload fixtures)
- `servers/exarchos-mcp/src/verbs/run-mutation.ts` (new `operationId` → `instanceId` on the mutation emissions)
- `servers/exarchos-mcp/src/verbs/pure/execute-merge.ts` (additive `instanceId` = `taskId ?? sourceBranch→targetBranch`)
- `servers/exarchos-mcp/src/launcher/liveness.ts` (additive `instanceId` = `worktreeId`)
- `servers/exarchos-mcp/src/verbs/worktree/manager.ts` (prune emissions: additive `instanceId` = existing `operationId`)

**Verification:** scoped tests + `check_test_adequacy` + integration suite (shared-contract surface — schema glob classifies this high mechanically). Tests: `ExecutingStartedSchemas_PreviouslyEmittedPayloadFixtures_StillValidate` (verbatim fixtures per surface), `ExecutingStartedSchemas_RejectMalformedPayload` (negative — carries the revert-probe adequacy), `AllFourEmitters_EmitCanonicalInstanceIdAdditively` (start + terminal emissions), `LegacyPayloadsWithoutInstanceId_StillValidate`.
**testingStrategy:** `propertyTests: true` (property: schema compliance — every fixture-shaped payload, with and without the additive fields, validates; serialization category); `benchmarks: false`; `characterizationRequired: true` (modifies existing schemas + four emitters).
**Dependencies:** None
**Parallelizable:** Yes

#### Task 004: Liveness descriptor registry + conformance test

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `servers/exarchos-mcp/src/event-store/liveness-registry.ts` (new — `{ surface, startType, terminalTypes[], streamScope, instanceKeyOf }` per surface; envelope-derived `startedAt` helper; legacy-mutation fallback key)
- `servers/exarchos-mcp/src/event-store/liveness-registry.test.ts` (new)

**Verification:** scoped tests + `check_test_adequacy` + `check_contract_drift` (this registry is the contract `ps` and `wait --operation` consume). Tests: `LivenessRegistry_EveryExecutingStartedInCatalog_HasEntryWithTerminalScopeAndKey` (conformance — fails on any unregistered or under-specified `*.executing_started`), `LivenessRegistry_InstanceKey_PairsConcurrentOpsCorrectly` (start A, start B, terminal B → A in flight, at the pairing-helper level), `LivenessRegistry_Lookup_ReturnsDescriptorForSurface`. (The "adding a surface needs zero verb code" property is proven by 006's generic-fold test and 011's grep — not assertable here before verbs exist.)
**testingStrategy:** `propertyTests: true` (property: pairing correctness over arbitrary start/terminal key interleavings — state-machine category); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 003
**Parallelizable:** Yes (within wave 2 — disjoint files)

#### Task 005: `listWorkflowSummaries` backend read + `ps` workflows fold

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `servers/exarchos-mcp/src/storage/backend.ts` (`listWorkflowSummaries({ workflowType?, status?, phase?, includeTerminal? })`)
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts` (join `workflow_state` × `streams` using the `workflow_type` index — real pushdown)
- `servers/exarchos-mcp/src/storage/memory-backend.ts` (in-memory equivalent)
- `servers/exarchos-mcp/src/views/lifecycle/workflow-fold.ts` (new — rows: featureId, workflowType, phase, status, ageMs)
- `servers/exarchos-mcp/src/views/lifecycle/workflow-fold.test.ts` (new)

**Verification:** scoped tests + `check_test_adequacy` + integration suite (backend interface change — files ≥ 3, shared contract). Tests: `WorkflowFold_TypeFilter_PushedDownToIndexedColumn` (asserts the SQLite query path, not in-memory filtering), `WorkflowFold_StatusFilter_ReturnsMatchingRows`, `WorkflowFold_PhaseFilter_ReturnsMatchingRows`, `WorkflowFold_Default_ExcludesTerminalStates`, `WorkflowFold_AllFlag_IncludesCompleted`, `ListWorkflowSummaries_BackendContract_SharedAcrossSqliteAndInMemory`.
**testingStrategy:** `propertyTests: true` (properties: filter idempotence `filter(filter(rows)) === filter(rows)`; filtered set ⊆ unfiltered set — generators enumerate all four filters; collections category); `benchmarks: true` (`performanceSLAs: [{ operation: 'workflow-fold-cold-10k-events', metric: 'p95_ms', threshold: 250 }]`; boundary/offline cadence); `characterizationRequired: false`.
**Dependencies:** 002
**Parallelizable:** Yes (wave 3 — disjoint files within the wave)

#### Task 006: `ps` operations fold (generic in-flight, paired by instance key)

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/operations-fold.ts` (new — starts whose `instanceKeyOf` has no later matching terminal, per descriptor registry; envelope-derived age)
- `servers/exarchos-mcp/src/views/lifecycle/operations-fold.test.ts` (new)

**Verification:** scoped tests + `check_test_adequacy`. Tests: `OperationsFold_StartedWithoutTerminal_ListedInFlight`, `OperationsFold_ConcurrentSameStreamOps_PairsByInstanceKey` (start A, start B, terminal B → exactly A listed), `OperationsFold_MutationSurface_ListedGenerically` (DR-3 AC: no mutation-specific code), `OperationsFold_TerminalPresent_Excluded`.
**testingStrategy:** `propertyTests: true` (property: for any event sequence, an operation is listed iff its start's instance key has no later matching terminal — state-machine category); `benchmarks: true` (`performanceSLAs: [{ operation: 'operations-fold-cold-10k-events', metric: 'p95_ms', threshold: 250 }]`; boundary/offline cadence); `characterizationRequired: false`.
**Dependencies:** 004
**Parallelizable:** Yes (wave 3 — disjoint files within the wave)

#### Task 007: `ps` handler redesign — scope parameter, composition, probe gating

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Acceptance Test Ref:** 011
**Implements:** DR-3

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/ps.ts` (new — composes 005 + 006 + the WLM-6 worktree fold; fields from `schema-fields.ts`)
- `servers/exarchos-mcp/src/views/lifecycle/ps.test.ts` (new)
- `servers/exarchos-mcp/src/views/composite.ts` (route redesigned `ps`)
- `servers/exarchos-mcp/src/registry.ts` (redesigned schema: `scope`, filters; `outputSchema`; annotations)
- `servers/exarchos-mcp/src/verbs/worktree/handlers.ts` (worktree fold consumed, not duplicated)

**Verification:** scoped tests + `check_test_adequacy` + integration suite (redesigns a shipped preview surface; parity baselines updated). Tests: `Ps_DefaultScope_All_ReturnsWorkflowsAndOperationsSections`, `Ps_WorkflowScopeWithProbe_RejectedInvalidInput`, `Ps_WorktreeScope_PreservesWlm6Capabilities`.
**testingStrategy:** `propertyTests: false` (composition wiring; folds carry the PBT in 005/006); `benchmarks: false`; `characterizationRequired: true` (WLM-6 worktree behavior pinned before redesign).
**Dependencies:** 005, 006, 010, 019
**Parallelizable:** No (serialized on `registry.ts`/`composite.ts`/`handlers.ts` after 010)

#### Task 008: `inspect` handler — composite workflow projection

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Acceptance Test Ref:** 011
**Implements:** DR-4

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/inspect.ts` (new — state via `resolveWorkflowState`/rehydration, recent events + correlation tuple, artifacts, task progress; fields from `schema-fields.ts`)
- `servers/exarchos-mcp/src/views/lifecycle/inspect.test.ts` (new)
- `servers/exarchos-mcp/src/views/composite.ts` (route `inspect`)
- `servers/exarchos-mcp/src/registry.ts` (action def + `outputSchema` + `readOnlyHint`)

**Verification:** scoped tests + `check_test_adequacy` + integration suite (cold-probe side-effect-free invariant is the 2026-05-30 state-source-integrity RCA class). Tests: `Inspect_UnknownFeatureId_WorkflowExistsFalseNoSideEffect` (event-count invariance), `Inspect_KnownWorkflow_ReturnsStateEventsArtifacts`, `Inspect_SchemaDescribe_AllFourCompositeTools_ByteUnchanged`.
**testingStrategy:** `propertyTests: false` (projection composition; no transformation core); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 014, 019
**Parallelizable:** Yes (wave 2 — disjoint files within the wave)

#### Task 009: `--follow` carriers — NDJSON (CLI) + Tasks (MCP) over the subscription

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4

**Files:**
- `servers/exarchos-mcp/src/adapters/cli.ts` (`inspect` joins the follow set; carrier wiring)
- `servers/exarchos-mcp/src/cli/follow-loop.ts` (subscription-fed source for `inspect`; AbortSignal-based disposal — SIGINT wired to abort, no POSIX-only semantics)
- `servers/exarchos-mcp/src/mcp/tasks-methods.ts` (Tasks arm over the same DR-1 contract; cancel → dispose)
- `servers/exarchos-mcp/src/views/lifecycle/inspect.follow.test.ts` (new)

**Verification:** scoped tests + `check_test_adequacy` + integration suite across the CLI/MCP seam. Tests: `InspectFollow_AppendedEvents_NdjsonFramesDedupedBySequence`, `InspectFollow_SilentGap_HeartbeatFramesOnInjectedTimer`, `InspectFollow_McpTasks_SharesSubscriptionContract`, `InspectFollow_Abort_SubscriptionDisposed`. INV-16: heartbeats/timing on the injected timer; abort path exercised without process signals.
**testingStrategy:** `propertyTests: true` (property: the NDJSON frame stream contains each event sequence exactly once, monotonically — dedup roundtrip; data-transformation category); `benchmarks: false`; `characterizationRequired: true` (follow-loop is existing code).
**Dependencies:** 001, 002, 008
**Parallelizable:** Yes (wave 3 — disjoint files within the wave)

#### Task 010: Generic `wait` — phase/status/operation predicates + subscription resolution

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Acceptance Test Ref:** 011
**Implements:** DR-5, DR-8

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/wait.ts` (new — projection precheck; DR-1 subscription on `workflow.transition` + registry terminals; `phase`/`status`/`operation`/worktree `until` predicates; feature-scope gating for `operation`; structured `WAIT_TIMEOUT`/`WAIT_FAILED`; fields from `schema-fields.ts`)
- `servers/exarchos-mcp/src/views/lifecycle/wait.test.ts` (new)
- `servers/exarchos-mcp/src/views/composite.ts` (route redesigned `wait`)
- `servers/exarchos-mcp/src/registry.ts` (redesigned schema + `readOnlyHint`/`idempotentHint`)
- `servers/exarchos-mcp/src/verbs/worktree/handlers.ts` (WLM-6 wait kernel absorbed)

**Verification:** scoped tests + `check_test_adequacy` + integration suite. Tests: `Wait_PhaseAlreadyPassed_ReturnsImmediatelyWithoutSubscribing`, `Wait_InProcessTransition_ResolvesOnTier1Wake` (injected clock), `Wait_ForeignConnectionEvent_ResolvesWithinOneFloorTick_PerfSurfaced` (verb-level Tier-2 bound, DR-8), `Wait_Timeout_StructuredWaitTimeout`, `Wait_WorkflowCancelledMidWait_WaitFailed` (phase wait interrupted), `Wait_StatusPredicate_ResolvesOnRequestedTerminal`, `Wait_StatusPredicate_AlreadyTerminal_ReturnsImmediately`, `Wait_StatusPredicate_DifferentTerminalArrives_WaitFailed`, `Wait_OperationPredicate_ResolvesOnRegistryTerminalByInstanceKey`, `Wait_OperationPredicate_NoInFlight_ReturnsImmediately`, `Wait_OperationPredicate_NonFeatureScopedSurface_InvalidInputWithSuggestedFix`, `Wait_WorktreeScope_PreservesWlm6Capabilities` (until: merge + integrationRef; until: idle), `Wait_AllPaths_AppendZeroEvents` (event-count invariance).
**testingStrategy:** `propertyTests: true` (property: for any transition/liveness event sequence, `wait` resolves iff its predicate is satisfied at precheck or becomes satisfied before timeout — state-machine category); `benchmarks: false`; `characterizationRequired: true` (absorbs shipped worktree kernel).
**Dependencies:** 001, 002, 004, 008, 019
**Parallelizable:** Yes (wave 3 — disjoint files within the wave)

#### Task 011: S-6 stuck-executing recovery — feature acceptance north-star

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-3, DR-5, DR-8

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/s6-recovery.acceptance.test.ts` (new — real store, real handlers, no mocks)

**Verification:** the corrected acceptance walkthrough from DR-5: seed `merge.executing_started` with no terminal (simulated crash); `ps` lists the stuck merge in `operations` (DR-3 north-star assertion); `wait <id> --operation merge --timeout` resolves when `merge.recovered` is appended, and returns `WAIT_TIMEOUT` (CLI exit 17) without it; `inspect` shows the unpaired start in flight; grep-assert no merge-specific code in `wait.ts`/`operations-fold.ts` (behavioral assertions carry the adequacy — the grep is a fence, not the proof).
**testingStrategy:** `propertyTests: false`; `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 007, 008, 010
**Parallelizable:** Yes (wave 5 — disjoint files within the wave)

#### Task 012: `export.requested` / `export.executed` event schemas

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Acceptance Test Ref:** 015
**Implements:** DR-6

**Files:**
- `servers/exarchos-mcp/src/event-store/schemas.ts` (two event types + emission-registry entries, idempotency-keyed per INV-8)
- `servers/exarchos-mcp/src/event-store/schemas.test.ts`

**Verification:** scoped tests + `check_test_adequacy` + integration suite (schema surface — mechanically high). Tests: `ExportEventSchemas_RequestedExecutedPair_RegisteredWithEmissionSource`, `ExportRequested_CarriesResolvedPathIntent`.
**testingStrategy:** `propertyTests: true` (schema-compliance property; serialization category); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 003
**Parallelizable:** Yes (wave 2 — disjoint files within the wave)

#### Task 013: `export` handler — yazl zip bundle + INV-13 precheck + replay round-trip

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Acceptance Test Ref:** 015
**Implements:** DR-6

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/export.ts` (new — events.jsonl / state.json / metadata.json / artifacts/; requested→write→executed; crash precheck; fields from `schema-fields.ts`)
- `servers/exarchos-mcp/src/views/lifecycle/export.test.ts` (new)
- `servers/exarchos-mcp/src/views/composite.ts` (route `export`)
- `servers/exarchos-mcp/src/registry.ts` (action def, `task-isolated` posture, `openWorldHint: true`)
- `servers/exarchos-mcp/package.json` (pin `yazl`)

**Verification:** scoped tests + `check_test_adequacy` + integration suite. Tests: `Export_Bundle_ReplayEventsJsonlEqualsStateJson` (round-trip), `Export_Success_AppendsExactlyRequestedExecutedPair` (idempotency-keyed; re-run creates a new pair, never duplicates a prior intent), `Export_CrashBetweenPair_PrecheckCompletesWithoutDuplicateIntent`, `Export_ArtifactsDir_IncludedAndMissingRefsListedInMetadata`, `Export_InvalidOutputPath_SuggestedFixNoEvents`, `Export_UnknownFeatureId_ExpectedShapeNoZip`. Windows: zip entry names via `path.posix`, filesystem paths via `path.join`, handles closed before temp-dir removal (INV-16). Build: `npm run build` single-file bundle includes yazl and export runs from it.
**testingStrategy:** `propertyTests: true` (property: `replay(export(store)) === projection(store)` for arbitrary event sequences — data-transformation round-trip); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 007, 012, 019
**Parallelizable:** Yes (wave 5 — disjoint files within the wave)

#### Task 014: CLI top-level promotion mechanism (`CliActionHints.topLevel`)

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Acceptance Test Ref:** 015
**Implements:** DR-7

**Files:**
- `servers/exarchos-mcp/src/registry.ts` (`CliActionHints.topLevel?: string`)
- `servers/exarchos-mcp/src/adapters/cli.ts` (hoist loop — same dispatch path, flags from the same Zod schema)
- `servers/exarchos-mcp/src/adapters/cli.test.ts` (promotion + collision guard)

**Verification:** scoped tests + `check_test_adequacy` + integration suite. Tests: `Promotion_TopLevelStamp_CommandRegisteredAndDispatches`, `Promotion_CollidingName_FailsRegistrationNotRuntime`, `Promotion_SubcommandForm_StillWorks`.
**testingStrategy:** `propertyTests: false` (adapter wiring; parity fixtures in 015 are the contract check); `benchmarks: false`; `characterizationRequired: true` (modifies CLI generation for every tool).
**Dependencies:** None
**Parallelizable:** Yes

#### Task 015: Promotion stamps + exit-code map + three-path parity — acceptance north-star for the CLI surface

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-7, DR-8

**Files:**
- `servers/exarchos-mcp/src/registry.ts` (`ps`→`ps`, `wait`→`wait`, `export`→`export`, `inspect`→`describe`)
- `servers/exarchos-mcp/src/adapters/cli.ts` (generic errorCode→exitCode map: `WAIT_TIMEOUT`→17, `WAIT_FAILED`→18 — presentation only)
- `servers/exarchos-mcp/src/parity/lifecycle-verbs.parity.test.ts` (new)

**Verification:** scoped tests + `check_test_adequacy` + integration suite (this task is the DR-7/INV-2 contract check that 014 defers to). Tests: `Parity_EachPromotedVerb_ByteIdenticalToolResultAcrossThreePaths` (volatile fields — `_perf`, timestamps, `ageMs` — normalized per existing parity-harness conventions, injected clock where needed; setup grep-asserts 007/008/010/013 import `schema-fields.ts`), `ExitCodeMap_WaitTimeout_17`, `ExitCodeMap_WaitFailed_18`, `ExitCodeMap_Success_0`, `Registry_VisibleCompositeCount_RemainsFour` (extend/cite the existing visible-count fence in `registry.test.ts`). **Windows final discharge (DR-8):** completes only with the `test-windows` CI lane green on the integration tip and a zero-new-`skipIf(win32)` grep over the full feature diff.
**testingStrategy:** `propertyTests: false`; `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 007, 008, 009, 010, 013, 014
**Parallelizable:** Yes (wave 6 — disjoint files within the wave)

#### Task 016: Error-envelope edge cases across the verb surface

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-8

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/wait.ts` (`validTargets` from HSM topology for the workflow's type; feature-scoped registry surfaces for `--operation`)
- `servers/exarchos-mcp/src/views/lifecycle/errors.test.ts` (new — consolidated edge-case suite)

**Verification:** scoped tests + `check_test_adequacy` + integration suite (edits `wait.ts`, a high-tier surface) + `check_contract_drift` (error-envelope contract). Tests: `Wait_InvalidPhase_ValidTargetsFromTopologyForWorkflowType`, `Wait_UnknownOperationSurface_ValidTargetsListsFeatureScopedSurfaces`, `Verbs_UnknownFeatureId_SideEffectFreeExpectedShape` (inspect/wait/export; event-count invariance), `Ps_ProbeOutsideWorktreeScope_InvalidInputWithSuggestedFix`. **Windows final discharge (DR-8):** completes only with the `test-windows` CI lane green on the integration tip and a zero-new-`skipIf(win32)` grep over the full feature diff.
**testingStrategy:** `propertyTests: false`; `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 007, 008, 010, 013
**Parallelizable:** Yes (wave 6 — disjoint files within the wave)

#### Task 017: Subscription lifecycle + portability hardening (owns the DR-8 Windows mechanics)

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1, DR-8

**Files:**
- `servers/exarchos-mcp/src/event-store/subscriptions.test.ts` (leak + concurrency + win32 suites)
- `servers/exarchos-mcp/src/cli/follow-loop.ts` (AbortSignal disposal audit)
- `servers/exarchos-mcp/src/mcp/tasks-methods.ts` (task-cancel disposal audit)

**Verification:** scoped tests + integration suite. `check_test_adequacy` applies to any source hunks this task produces (disposal fixes); for the test-only portions the revert-probe is inapplicable by construction — adequacy is instead demonstrated by **killing seeded mutations** of the substrate under test (mutate `subscriptions.ts` disposal/registry logic → the new tests must go red). Tests: `Follow_ConsumerDisconnect_HandleDisposedRegistryZero`, `TasksCancel_MidFollow_HandleDisposed`, `Wait_ConcurrentSameStream_BothResolveIndependently`. **Windows/INV-16 mechanics (through wave 5):** assert the poll floor holds no open SQLite statement across ticks (handle-close class, #1620); audit every new lifecycle test for wall-clock timing and convert to the injected clock (**zero new `skipIf(win32)` entries** in the diff-so-far — final full-diff discharge rides 015/016); confirm two-connection tests carry the `busy_timeout` posture; `test-windows` lane green on the integration tip as of this wave.
**testingStrategy:** `propertyTests: true` (concurrency category — property: any interleaving of N concurrent subscribe/dispose/append operations leaves the registry consistent and delivers each subscriber only its matches); `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 009, 010
**Parallelizable:** Yes (wave 5 — disjoint files within the wave)

#### Task 018: Documentation — liveness convention + subscription contract + verb surface

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-1, DR-2

**Files:**
- `docs/architecture/runtime.md` (§6 liveness convention: descriptor registry + pairing rule + envelope-derived `startedAt` + streamScope; §L7 verbs updated to the shipped shape, including the operation predicate, its feature-scope boundary, and the corrected S-6 story)

**Verification:** static analysis + `verify_doc_links`. The #1315 subscription contract is this spec's DR-1; runtime.md links here.
**testingStrategy:** `propertyTests: false`; `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** 010
**Parallelizable:** Yes (wave 4 — disjoint files within the wave)

#### Task 019: Shared lifecycle field shapes + registration-construction guard

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-8

**Files:**
- `servers/exarchos-mcp/src/views/lifecycle/schema-fields.ts` (new — one canonical Zod definition per lifecycle field name: `scope`, `status`, `phase`, `workflowType`, `all`, `follow`, `limit`, `output`, `operation`; base types checked against existing view-action fields)
- `servers/exarchos-mcp/src/registry.construction.test.ts` (new — composes the current `exarchos_view` registration plus a probe action built from every shared shape and asserts `buildRegistrationSchema` does not throw)

**Verification:** scoped tests + `check_test_adequacy` + integration suite + `check_contract_drift` (this is the shared-contract module every lifecycle verb imports — the schema glob classifies it high mechanically, and its silent breakage is the registry-THROW class). Tests: `RegistryConstruction_WithAllLifecycleFieldShapes_DoesNotThrow`, `SchemaFields_BaseTypes_MatchExistingViewFieldsWhereNamesCollide`. Tasks 007/008/010/013 MUST import from this module (grep-asserted in 015's parity suite setup).
**testingStrategy:** `propertyTests: false`; `benchmarks: false`; `characterizationRequired: false`.
**Dependencies:** None
**Parallelizable:** Yes

### Parallelization

**Critical path:** 001 → 002 → 005/010 → 007 → 013 → 015/016 (the `registry.ts`/`composite.ts` serialization chain).

| Wave | Tasks (parallel within wave; all same-file edits serialized across waves) |
|---|---|
| 1 | 001, 003, 014, 019 |
| 2 | 002, 004, 008, 012 |
| 3 | 005, 006, 009, 010 |
| 4 | 007, 018 |
| 5 | 011, 013, 017 |
| 6 | 015, 016 |

**Same-file serialization (total orders across waves, all edge-enforced):** `registry.ts`: 014 → 008 → 010 → 007 → 013 → 015. `composite.ts`: 008 → 010 → 007 → 013. `worktree/handlers.ts`: 010 → 007. `adapters/cli.ts`: 014 → 009 → 015 (015 depends on 009 directly). `event-store/schemas.ts`: 003 → 012. `storage/backend.ts`/`sqlite-backend.ts`/`memory-backend.ts`: 002 → 005. `subscriptions.ts(.test)`: 001 → 002 → 017. `follow-loop.ts`/`tasks-methods.ts`: 009 → 017. `wait.ts`: 010 → 016. No two tasks within any wave share a file.

### Completion checklist

- [x] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [x] Every task `Implements:` a DR-N that exists in this document
- [x] Every task carries a `riskTier` stamp (rev. 2: 019 raised to high — `schema-fields.ts` hits the schema glob and is the shared-contract module; remaining medium stamps — 004/006 — are single-new-module tasks the mechanical derivation classifies medium; `boundaryTouching: true` stamped wherever `testLayer: integration` would derive it)
- [x] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [x] Open questions are resolved OR explicitly deferred with rationale
- [ ] Ready for `plan-review`

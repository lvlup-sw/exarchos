# Changelog

All notable changes to Exarchos are documented in this file. Organized by semver release.

## [2.10.0-preview.3] - 2026-05-16

### Added

- Correlation tuple indexed columns + telemetry filters ([#1437](https://github.com/lvlup-sw/exarchos/issues/1437), [#1414](https://github.com/lvlup-sw/exarchos/issues/1414))
  - Schema V5→V6: `operation_id`, `correlation_id`, `causation_id` columns on the `events` table with two indexes (`idx_events_correlation`, `idx_events_causation`).
  - Chunked transactional backfill from the `payload` JSON via the `migrateV5ToV6` helper; emits `migration.correlation_backfill_progress` events per chunk.
  - `EventStore.QueryFilters` accepts the three correlation fields; `SqliteBackend` honors them as indexed `WHERE` clauses; `InMemoryBackend` uses a post-fetch JS filter for parity.
  - Six telemetry view actions (`telemetry`, `delegation_timeline`, `code_quality`, `quality_correlation`, `quality_attribution`, `eval_results`) accept the new filter args; `exarchos_view describe` surfaces them.
  - `materializeFiltered` cache-bypass helper prevents cache contamination across filtered/unfiltered calls on the same view.
  - Closes the [#1291](https://github.com/lvlup-sw/exarchos/issues/1291) acceptance criteria (storage layer + telemetry filters + three end-to-end integration tests) that PR [#1428](https://github.com/lvlup-sw/exarchos/pull/1428) deferred. Closes [#1414](https://github.com/lvlup-sw/exarchos/issues/1414) (regression coverage proves the inline fix from #1428's post-merge hardening).

## [2.10.0-preview.2] - 2026-05-11

### Marten primitives + post-DR-4 cleanup (#1312, #1340, #1313, #1284, #1304, #1314, #1341)

This preview lifts the substrate from atomic-append into an event-sourced aggregate model (Marten R-1 + R-2) with reference consumers, and closes the post-v2.11 DR-4 gap that broke the agent-facing artifact-write surface. Six waves, 55 tasks, ~123 new tests.

#### Wave 0 — Restore `exarchos_workflow.update` action (#1340)
- **Added:** public `update` action on `exarchos_workflow`, mapping to the existing internal `workflow.update()` function. Restores the artifact-write path removed in v2.11's DR-4 substrate cut.
- **Rejects `updates.phase`** with `INVALID_INPUT` + `suggestedFix.params.action === 'transition'`. Preserves DR-4's intent (phase changes route through `transition`) while restoring the non-phase mutation surface.
- **Registered:** `WorkflowUpdateOutputSchema` for #1266 envelope-version discipline.
- **Envelope:** `update` returns `_meta.checkpointAdvised`, `next_actions` (HSM-derived for current phase), `_perf` per INV-5b.

#### Wave 1 — R-1: mandatory `workflow_type` column on streams (#1313)
- **Schema migration V3 → V4.** `streams` table gains `workflow_type TEXT NOT NULL` with `'__legacy'` backfill sentinel + `idx_streams_workflow_type` + composite `idx_streams_workflow_type_status`.
- **Sole writer:** `workflow.init` writes the column at stream creation; immutable thereafter. CI grep gate forbids `UPDATE streams SET workflow_type` outside the migration's allowed backfill.
- **Backfill discipline:** primary source is each stream's `workflow.started` event payload (`data.workflowType`); secondary fallback is the workflow-state file. Un-recoverable streams retain `'__legacy'` and emit `migration.workflow_type_unknown` for operator visibility.
- **Validator:** `workflow.init` rejects calls without explicit `workflowType` (Zod validation; previous calls returned vague errors).
- **`PRAGMA busy_timeout = 5000`** added in `applyConnectionPragmas` as a C-layer safety net. Two-tier model: SQLite gets a 5s window to resolve cross-process contention before throwing `SQLITE_BUSY` to the JS-layer's bounded retry budget (`SQLITE_BUSY_RETRY_POLICY`, ~75ms). Audit §F2.2.
- **Read side deferred to v2.12 (#1090)** — filtered `exarchos_view({action: 'ps', workflowType: ...})` lands with the lifecycle verbs.

#### Wave 2A — EventSourcedTaskStore as global projection (#1284)
- **TaskStore is now a reducer** (`task-store@v1`, `scope: 'global'`) folding over all `task.*` events across all streams. No `InMemoryTaskStore` class existed previously — this is greenfield, not a migration. Closes INV-1's stores-as-projections rule for tasks.
- **New primitive:** `readProjection<T>(reducerId)` in `projections/store.ts`. Validates `scope === 'global'`; reads latest snapshot via `readLatestSnapshot` (key: reducer id), folds events since the snapshot, returns final state. Rejects per-stream-scoped reducers with `INVALID_REDUCER_SCOPE`.
- **Migrated readers:** `views/task-detail-view.ts` and `views/workflow-status-view.ts` compose over `task-store@v1` projection instead of folding events directly. Eliminates per-view duplicate folds.
- **BC preserved:** view-layer `TaskDetail.title: string` contract unchanged (projects via `title: record.title ?? ''`).

#### Wave 2B — mergeOrchestrator as per-stream projection (#1304)
- **MergeOrchestratorState** is now a reducer (`merge-orchestrator@v1`, `scope: 'stream'`) folding `merge.*` events on the feature stream. State machine: `idle → preflight → requested → executed → completed`; any phase → `recovering` on `merge.rollback`.
- **New event type registered:** `merge.requested` in `event-store/schemas.ts` (model-emitted, `.describe()` on every field). The `requested` phase is the durable intent captured before the side-effect fires (audit §F1.2 — the canonical two-event-split pattern foundation).
- **Closes the last in-memory side-database** for merge state. INV-1 stores-as-projections satisfied across both task tracking and merge tracking.

#### Wave 2A.1 (shared prerequisite)
- **Added required `scope: 'stream' | 'global'` field** to `ProjectionReducer<State, Event>`. Existing reducers (`rehydration@v1`, `next-action@v1`) declared `scope: 'stream' as const`. Runtime scope-validation in Wave 3 primitives enforces correspondence.

#### Wave 3 — R-2: `decide` / `withSession` / `aggregateStream` primitives (#1314)
- **`decide<TState>(streamId, reducerId, fn, opts?)`** — pure state-machine path. Read events → fold → invoke `fn(state, ctx)` → commit via `appendComputed` with `expectedSequence: tailVersion`. Marten's `FetchForWriting<T>(streamId)` analog.
  - **Single-key-per-call idempotency** (audit §F1.3): when `operationId` supplied, derive ONE key `${streamId}:${reducerId}:${operationId}` and route all returned events through ONE `BEGIN IMMEDIATE` transaction. Crash between transactions is impossible by construction; INV-1 aggregate-as-consistency-boundary preserved.
  - **`alwaysEnforceConsistency` default `true`** — empty-events path re-reads tail and throws `ConcurrencyError` if advanced (Marten's `AlwaysEnforceConsistency` for empty-write OCC). Opt out with `alwaysEnforceConsistency: false`.
  - **Rejects global-scoped reducers** with `INVALID_REDUCER_SCOPE`.
- **`withSession<TState>(streamId, reducerId, fn, opts?)`** — imperative escape hatch. Session object exposes `aggregate`, `version`, `append(evt)`; commits queued events on `fn` resolve. Rolls back on `fn` throw. Session closes after resolve OR throw (`SESSION_CLOSED` on post-resolve `append`).
  - **Idempotency-contract gate** (audit §F1.1): rejects calls that omit BOTH `operationId` AND `allowNonIdempotent: true` — `INVALID_SESSION_OPTIONS` with `suggestedFix` pointing at `decide` or naming both opt-in flags. The runtime check prevents retry storms re-firing pivot transactions inside the closure.
  - **No in-tree consumer in this bundle.** Marten-style "available for the right shape; not the default."
- **`aggregateStream<T>(streamId, reducerId)`** — read-only fold. Returns `{aggregate, version}`. Single SELECT today (WAL gives consistent snapshot via the read transaction's end-mark). Inline note per audit §F2.3: future second-read additions MUST wrap both reads in `db.transaction(fn)`. Rejects global-scoped reducers.
- **Typed `ConcurrencyError`** with `streamId`, `reducerId`, `expectedVersion`, `actualVersion`, `operationId?`. Maps to `CONCURRENCY_CONFLICT` envelope through `wrapError()` with `validTargets: ['retry']` and `_meta.retryable: true`.
- **Typed `StorageBusyError`** (audit §F2.1) with `streamId`, `attempts`, `cause`. Maps to `STORAGE_BUSY` envelope — distinct from `CONCURRENCY_CONFLICT` because the suggested-fix shape differs (back off vs. re-fold).
- **`appendComputed` extended to accept `AppendOptions`** (`expectedSequence`) — sibling primitive change documented in Wave 3.
- **`wrapError(err, meta?, perf?)` added** as a sibling to `wrap()` — preserves `wrap()`'s strong success-only typing while exposing the typed-error → envelope mapping.

#### Wave 4 — Reference migration to two-event split (audit §F1.2)
- **`withStateRetry` recognizes `ConcurrencyError` AND `StorageBusyError`** alongside the legacy `VersionConflictError`. Predicate-based `isRetryable(err)` gate. All three trigger the same bounded exponential-backoff retry path.
- **`orchestrate/merge-orchestrate.ts` migrated** to three-phase shape:
  1. **Phase A** (retryable): `decide` commits `merge.requested` purely. State-check short-circuit: `if state.phase === 'executed' || 'completed' return []`.
  2. **Phase B** (outside retry): `aggregateStream` re-reads state; if not already `executed`/`completed`, fire the side-effect EXACTLY ONCE.
  3. **Phase C** (retryable): `decide` commits `merge.executed` purely. Same short-circuit pattern.
- **`orchestrate/execute-merge.ts` migrated** to the same shape — `vcsMerge` action sits in Phase B, outside any retry boundary.
- **PR-API-non-refire fixture** pins the property: forcing `ConcurrencyError` on Phase A retries the closure but the executor mock receives ZERO calls; Phase B fires it EXACTLY ONCE; Phase C retries don't re-invoke.
- **Concurrency race fixture** pins end-to-end loop: two concurrent invocations on the same feature → one wins, loser retries via `CONCURRENCY_CONFLICT` and state-check short-circuits to `[]`; final stream has exactly ONE `merge.requested` and ONE `merge.executed`; merge mock invoked exactly ONCE.
- **Storage-busy fixture** (audit §F2.1): inject substrate contention via `SqliteBusyExhaustedError` on first invocation → handler retries via `withStateRetry` → eventual success after contention clears.
- **Parity harness fixture** confirms CLI ≡ MCP `ToolResult` byte-equivalence post-migration.

#### Wave 5 — Migrate stale `action: 'set'` references to `update` (#1341)
- **92 sites migrated** to the canonical verb restored in Wave 0:
  - `servers/exarchos-mcp/src/workflow/guards.ts` — 12 `suggestedFix` payloads (closes INV-5b "suggestedFix must be actionable" violation)
  - `servers/exarchos-mcp/src/workflow/playbooks.ts` — 35 PhasePlaybook tool hints + 32 `compactGuidance` prose strings (kept consistent — same conceptual rename)
  - `commands/*.md` + `skills-src/**/*.md` — 109 occurrences across 45 files
  - 102 regenerated runtime variants under `skills/<runtime>/` (build:skills + skills:guard both pass)
- **CI grep gate** (`event-store/grep-gates.test.ts`): forbids `action: ['"]set['"]/` under `commands/`, `skills-src/`, `servers/exarchos-mcp/src/workflow/`. Exemptions documented for `*.test.ts` files (load-bearing negative tests for DR-4 hard-cut rejection) and the event-payload `data: { action: 'set' }` site (replayability for pre-rename event logs).
- **End-to-end smoke** (`__tests__/integration/ideate-update-action.test.ts`): exercises the documented ideate flow `init → update artifacts.design → transition → plan` through the dispatch core.

### Architectural posture

Adopted from Marten (see [`docs/research/2026-05-08-marten-event-store-lessons.md`](docs/research/2026-05-08-marten-event-store-lessons.md)):
- Mandatory stream-type marker (indexed) ✓
- `FetchForWriting<T>(streamId)` single-stream OCC ✓ (as `decide`)
- `AggregateStreamAsync<T>` read-only fold ✓ (as `aggregateStream`)
- `AlwaysEnforceConsistency` for empty-write OCC ✓ (default-on)
- Aggregate = stream consistency boundary ✓ (`scope: 'stream'` enforced)

Explicitly rejected per single-machine cooperative-agents framing:
- `IDocumentSession` multi-stream commit (no use case; substrate stays one-stream-per-tx)
- `FetchForExclusiveWriting` blocking lock (OCC suffices)
- Internal retry on concurrency exception (caller-controlled middleware pattern)
- Async daemon as separate process (out of scope per epic)

### Bug fix included in preview.2

- **Fixed:** `state-store.ts:applyEventToState` was missing a case for `state.patched`, so reconcile silently dropped patches that `runbooks/definitions.ts:46,88` directs callers to emit post-`set` removal. `_eventSequence` advanced but `state.artifacts` stayed null, so HSM guards reading the state file (e.g. `design-artifact-exists`, `plan-artifact-exists`) kept failing forever. Now mirrors the rehydration projection (`workflow-state-projection.ts:277-285`) and deep-merges `data.patch` into state. Surfaced during the preview.2 plan-review session itself.

### Operator notes

- **V3 → V4 schema migration is automatic** on first open of an existing exarchos.db. Pre-V4 streams without recoverable `workflowType` retain `'__legacy'` and emit one `migration.workflow_type_unknown` event each.
- **Recommend stepping through preview.1 before preview.2** so the backfill has accurate `workflowType` data in state files. (Preview.1 had no schema migration; it stabilized the substrate.)
- **No agent-facing breaking changes.** `update` is purely additive (the v2.11 removal of `set` is the breaking change covered by v2.11 release notes); the two-event split is internal to the merge handlers.

### Follow-ups parked in #1342

Thirteen items tracking the architectural leverage opportunities the preview deliberately deferred — `withSession` consumer audit, two-event split rollout to other non-idempotent handlers (`gh pr create`, `gh pr comment`, etc.), `decide` adoption beyond merge-orchestrate, in-memory store audit, snapshot cadence tuning, `merge.completed` registration vs. reducer-phase collapse, `writeStateFile` temp-filename race (production-unaffected fixture-only finding), `handleSet` idempotency-key contract (CAS retries emit extra `state.patched`), reducer-scope discipline docs, two-event split as a documented architecture pattern.

## [2.10.0-preview.1] - 2026-05-10

### Substrate stabilization (Wave α + Wave β)

- **Hardened (constructive — substrate guarantees now reach the merge path):** `merge-orchestrate` and `execute-merge` pass `idempotencyKey` + `expectedSequence` to event appends; crash-replay and concurrent-invocation scenarios no longer duplicate events (#1303). Workflow-handler emission sites migrated to canonical `buildValidatedEvent` + `appendValidated`: 10 / 18 sites covered across `workflow/cancel.ts`, `workflow/hsm-transition-guard.ts`, `workflow/rehydrate.ts`, `workflow/tools.ts`; 8 sites deferred per per-site correlation-ID abort policy (6 → α-08 follow-up, 2 → #1339 latent `state-machine` undefined-compoundStateId bug) (#1325).
- **Removed:** `AgentSpec.capabilities` runtime interface field (#1333) — derivation moves to `capabilities/resolver.ts` keyed on `posture`. `LoadTopologyOptions.emit` vestigial field (#1336 — already absent at scope time, JSDoc scrub only). Stale "Pre-v2.11" doc-comments in `storage/lifecycle.ts` and `cli-commands/subagent-context.ts` (#1335).
- **Refactored:** `prune-stale-workflows` migrated from custom multi-signal heuristic to typed-contract scorer (#1334) — pruning policy now lives in `topology.yaml` `staleness` blocks per phase, not in handler code.
- **Fixed (CI):** Three subprocess-spawning tests refactored to in-process `EventStore`, removing the `bun:sqlite` ESM scheme failure on Node CI runners (#1324). CLI-adapter coverage gap surfaced and tracked as #1337 (non-blocker).
- **Behavior improvement:** Malformed event payloads emitted via the new canonical envelope path are caught at the emission boundary (`EVENT_APPEND_FAILED`) instead of being silently persisted with `undefined` fields — surfaced by the `workflowType` integration test under `__tests__/mcp-tools.integration.test.ts`.
- **Tooling:** Shared `buildMergeOrchestrateIdempotencyKey` helper at `orchestrate/merge-keys.ts`; shared `assertCanonicalEnvelope` test helper at `workflow/test-helpers/canonical-envelope.ts`.
- **No schema migration. No agent-surface changes. No deprecation-shim removal.** This preview is internal-only.

Operator note: upgrading from v2.10.0 main (substrate-cut tip) to v2.10.0-preview.1 is a no-op at the data layer. Stay on this preview through preview.2 — that's where the V3→V4 schema migration lands.

### v2.11 Substrate Cut (Breaking)

Closes #1327 (Tier 2 JSONL rip), #1326 (idempotency-claims bypass — subsumed), #1328 (JSONL batch_append drop — subsumed), #1322 (DR-4 / DR-6 / DR-7 deprecation-shim removals + §5 `_testOnly_` productionization + §6 substrate-stream migration), #1082 (sidecar mode obsolete). Net deletion: ~4900 LOC across 87 files.

#### Breaking — runtime substrate

- **SQLite is mandatory.** `initializeBackend` returns a `SqliteBackend` or throws. The graceful `'better-sqlite3 not available — running in JSONL-only mode'` fallback is removed. Operators on machines without a SQLite driver must install `better-sqlite3` (Node) or run under `bun` (`bun:sqlite`); the error message names both.
- **No upgrade path from v2.10 JSONL state directories.** Starting v2.11 against a state directory containing `*.events.jsonl` and no `events.db` throws with operator-actionable text ("stay on v2.10 or wipe state"). The one-shot JSONL→SQLite hydrator (`storage/hydration.ts`) is deleted; v2.10 remains available on the install URL for users who need to retain JSONL data.
- **JSONL runtime substrate removed.** `AtomicAppender.appendLocked` (the JSONL body), the `backend: 'jsonl' | 'sqlite'` discriminator, `dispatchAppend` branch, `.seq` file machinery, `rebuildCachesFromJsonl`, the JSONL idempotency cache, `replicateBackend`, `writeOutbox`, the JSONL fallbacks in `EventStore.query()` and `listStreamsMatchingPrefix`, `queryMainJsonl`, `readJsonlMaxSequence`, `readSidecarForQuery`, `getEventFilePath`, and `getSeqFilePath` are all deleted. `getReadBackend()` always returns the SqliteBackend (no `undefined` short-circuit). Resolves the Sentry blocker `r3213774862` (#1323).
- **Sidecar mode removed (#1082).** SQLite WAL handles concurrent access natively; `enterSidecarMode`, `getSidecarPath`, `EventStore.sidecarMode`, `writeSidecar`, the sidecar-merge in `query()`, `mergeByTimestamp`, and the `EventAck.sequencePending` field are all deleted. PID-lock contention now hard-throws by default (`waitForLock: true` retains retry).

#### Breaking — agent-facing contracts

- **`workflow.set({ phase })` removed (DR-4).** The v2.10 deprecation rerouting handler is deleted. Agents calling `set` with a `phase` argument now receive a structured `UNKNOWN_ACTION` error envelope listing `validActions: ['transition', ...]`. The `_meta.deprecation` schema slot is retained one more release as a historical marker (drops in v2.12); `set` no longer populates it.
- **Legacy `capabilities[]` arrays in agent specs removed (DR-6).** Specs declaring `capabilities: [...]` now fail validation with a typed error pointing to `posture` as the replacement. The `posture` field (`'read-only' | 'task-isolated' | 'shared-mutating'`) is the only authority over `yaml ⊕ handshake` capability resolution. Four in-tree `AgentSpec` definitions (`IMPLEMENTER`, `FIXER`, `REVIEWER`, `SCAFFOLDER` in `servers/exarchos-mcp/src/agents/definitions.ts`) still carry legacy arrays consumed by runtime adapters at render time — out of scope for this cut, tracked in #1333.
- **Topology phases require `staleness` blocks (DR-7).** `loadTopology()` throws on any phase missing a `staleness` declaration; the v2.10 advisory `phase.contract_missing` event-emission branch is gone. The pruner becomes a pure typed-contract scorer — the single-signal heuristic fallback is deleted. `core/context.ts:loadTopologyIfPresent` swallows the throw so a malformed topology does not block substrate startup; `getTopology()` continues to throw "load before" until a successful load.

#### Productionized

- **`_testOnly_getSqliteBackend` → `getSqliteBackend` (DR-4 §5).** The leak-named helper is renamed; `EventStore.getReadBackend()` calls it via the public name. Verified zero `_testOnly_*` references in production code paths.

#### Operational notes

- **Forensic inspection.** Pre-v2.11 `cat *.events.jsonl` was the human-readable forensic path. Post-v2.11, use `sqlite3 events.db ".dump"` for raw inspection or `exarchos view` for typed queries.
- **Vestigial JSONL read paths removed.** `storage/lifecycle.ts` (`countJsonlLines`, `totalJsonlSizeBytes`, JSONL/seq cleanup in `compactWorkflow`, file-rotation half of `rotateTelemetry`, JSONL-byte-sum size warning in `checkCompaction`) and `cli-commands/subagent-context.ts` (`queryModuleHistory`'s JSONL scan) are deleted in this release. `queryModuleHistory` is retained as a no-op stub returning `[]` to preserve the call shape on the CLI hook hot path; SQLite-backed reimplementations of the historical-intelligence summary and the `policy.maxTotalSizeMB` threshold are tracked as v2.12 follow-ups.

#### Subsumed by construction

- **#1326 (idempotency-claims bypass).** The runtime appender's dual-write `replicateBackend → backend.appendEvent` path that bypassed `idempotency_claims` no longer exists; only the SQLite append path through `idempotency_claims` remains.
- **#1328 (JSONL `batch_append` silently drops events).** The broken JSONL `batch_append` is deleted along with all other JSONL substrate machinery.

### Features
- `preferredFacade` field on every runtime (`mcp` | `cli`) declaring the host's preferred invocation surface (cli-vs-mcp-facade-analysis, DR-1).
- Dual-facade skill rendering foundation: runtime-level declaration wired through loader and renderer (DR-1).
- CLI cold-start benchmark (`servers/exarchos-mcp/src/bench/cli-startup.bench.ts`) with separate telemetry-off (<250ms p95) and telemetry-on (<350ms p95) budgets (DR-5).
- `RemoteMcpAdapter` interface skeleton at `servers/exarchos-mcp/src/adapters/remote-mcp.ts` (DR-6, skeleton only; tracking #1081).
- Stderr `[heartbeat]` lines for `longRunning`-flagged orchestrate actions under `--json` so multi-second operations don't look like hung processes (DR-5). Flagged: `prepare_synthesis`, `assess_stack`, `check_static_analysis`, `pre_synthesis_check`, `post_delegation_check`.
- Waiting PID-lock for concurrent CLI event-store appends — two concurrent `exarchos event append` invocations now serialize onto the main JSONL (DR-5). MCP-server mode preserves first-wins + sidecar semantics so hooks never block.
- Shared parity-harness module (`servers/exarchos-mcp/src/__tests__/parity-harness.ts`) and parametrized CLI↔MCP parity tests across all five composite tools (DR-3).
- Documentation stub `docs/designs/future/remote-mcp-deployment.md` + `CLAUDE.md` Architecture pointer (DR-6 placeholder).
- `{{CALL tool action <json>}}` placeholder macro for facade-agnostic skill authoring — renders to MCP tool_use on MCP-preferred runtimes and `Bash(exarchos ...)` on CLI-preferred runtimes (cli-vs-mcp-facade-analysis, DR-2).
- Placeholder-lint deprecation warning for raw `mcp__…` references in skill sources — authors see a warning during build, CI stays green. Set `EXARCHOS_LINT_STRICT=1` to flip warnings to errors after the transition window closes (DR-2, DR-8).
- CLI rendering path with kebab-case flag mapping: `featureId: "X"` → `--feature-id X`, `dryRun: true` → `--dry-run`, trailing `--json` always appended (DR-2).
- Render-time validation of CALL macros against the `TOOL_REGISTRY` — unknown actions and invalid args fail the build with the source file path and line number (DR-2).
- Migration no-regression check (`src/build-skills.migration.test.ts`) — guards that existing Claude skill renders remain byte-identical after the dual-facade changes (DR-8).

### Breaking (wire-protocol)
- **Malformed arguments now uniformly emit `INVALID_INPUT`** from the dispatch layer (DR-5). Previously divergent across adapters: CLI hard-exited via Commander's `requiredOption`; MCP returned `UNKNOWN_ACTION` (unknown action) or surfaced downstream `EVENT_APPEND_FAILED` (wrong type, no schema validation in dispatch path). External consumers pattern-matching on the old codes for malformed-argument scenarios should switch to `INVALID_INPUT`. Handler-reported errors that pass schema validation (e.g. genuine event-append failures) continue to use their domain-specific codes.

### Removed
- **`create-exarchos` interactive installer deleted.** Prior versions vendored serena, context7, and microsoft-learn as extras installed alongside Exarchos by `npx create-exarchos`. Exarchos no longer ships or configures those MCP servers for you; install them yourself if you want them. The primary install paths are now the Claude Code plugin (`/plugin install exarchos@lvlup-sw`) and the standalone single-file binary, fetched via the bootstrap scripts at `scripts/get-exarchos.sh` (Unix) and `scripts/get-exarchos.ps1` (Windows). Marketplace docs have been updated to drop the stale "Integrations" table rows.

### Breaking (behavior) — Rehydration machinery refactor
- **Auto-resume hooks removed.** `SessionStart` and `PreCompact` no longer run automatically — the corresponding entries are gone from `hooks/hooks.json`, `hooks/session-start.sh` is deleted, and the `pre-compact` / `session-start` dispatch branches are removed from `adapters/hooks.ts`. The implementations (`cli-commands/session-start.ts` ~798 LoC, `cli-commands/pre-compact.ts` ~148 LoC, plus their tests and the `assemble-context.ts` helper) are deleted entirely (~5,500 LoC removed across P5).
- **Two-verb resume model.** Resume is now an explicit user action via `/exarchos:rehydrate <featureId>` (returns the canonical rehydration document — workflow state, phase playbook, recent handoffs, blockers, next actions). Checkpoints are an explicit user action via `/exarchos:checkpoint` (writes a structured handoff into the event store). Migration: anywhere docs previously said "the SessionStart hook handles X automatically", the recipe is now "run `/exarchos:rehydrate <featureId>` and read X from the returned envelope".
- **Rehydration envelope schema bumped v:2 → v:3.** `behavioralGuidance` (vestigial, never populated by any event) is dropped from the stable section; `phasePlaybook` is composed at handler time and carried in the volatile section. The v:2 read-back path still upgrades legacy snapshots in memory (see `upgrade.ts`); writers always emit v:3. `BehavioralGuidanceSchema` is no longer exported.
- **On-disk side-channel files orphaned.** The pre-compact path used to write `<featureId>.checkpoint.json` and assemble context to `<featureId>.context.md`; both behaviors are gone. Pre-existing files on disk are harmless but no longer read or written by any code path. The `commands/reload.md` slash command is also removed (its only flow was the now-deleted hook reload cycle).

## [2.6.0] - 2026-04-12

### Features
- `oneshot` workflow type with pure event-derived choice state (plan → implementing → {completed | synthesize}) (#1010)
- `prune_stale_workflows` orchestrate action for bulk pipeline hygiene (dry-run default, DI-testable safeguards, `workflow.pruned` audit event) (#1010)
- `request_synthesize` + `finalize_oneshot` orchestrate actions for oneshot choice state (#1010)
- `synthesize.requested` + `workflow.pruned` event types (#1010)
- `synthesisPolicy` optional init arg (`always` / `never` / `on-request`) for oneshot workflows, persisted in `workflow.started` event (#1010)
- `/exarchos:oneshot` and `/exarchos:prune` slash command skills with `references/` subdirectories (#1010)
- `OneshotPhaseSchema` enum for type-safe phase validation (#1010)
- Skill layer extensions threading oneshot through workflow-state, cleanup, shepherd, delegation skills (#1010)
- HSM topology introspection via `exarchos_workflow describe` with `topology` parameter (#979)
- Event emission catalog via `exarchos_event describe` with `emissionGuide` parameter (#979)
- CLI `topology [type]` and `emissions` commands for plugin-free introspection (#979)
- Cross-runtime skill rendering pipeline: single-source `skills-src/` → 6 runtime variants under `skills/<runtime>/` (Claude Code, Codex, Copilot CLI, Cursor, OpenCode, generic LCD fallback) (#1071)
- `exarchos install-skills [--agent <runtime>]` CLI with runtime auto-detection from PATH and environment variables (#1071)
- Cursor sequential-fallback mode for runtimes without an in-session subagent primitive (#1071)
- Build pipeline: `npm run build:skills` orchestrator with placeholder substitution, reference copying, override detection, and stale-source cleanup (#1071)

### Bug Fixes
- `handleList` now returns `_checkpoint` so `prune_stale_workflows` threshold filter works in production (caught by integration test; unit tests missed it due to stubbing) (#1010)
- `INITIAL_PHASE` now includes `oneshot → plan` so ES v2 rematerialized oneshot workflows start in the correct phase (#1010)
- `handlePruneStaleWorkflows` no longer double-accounts on event-append failure (caught by CodeRabbit review) (#1010)
- Removed `augmentWithSemanticScore` Phase 4 deprecation stubs and `basileusConnected` parameter plumbing from review triage (#1077)

### Hardening
- Fail-closed validation on malformed `handleList` entries (malformed entries bucketed separately, never reach `candidates` or `pruned`) (#1010)
- Input validation on `thresholdMinutes` (positive integer) and `now` (valid ISO) before batch runs (#1010)
- `oneshotPlanSet` guard tightened to require non-empty `artifacts.plan` (`planSummary` alone is insufficient, whitespace trimmed) (#1010)
- `request_synthesize` runtime phase guard rejects terminal phases (#1010)

### Internal
- `TERMINAL_PHASES` extracted to shared `workflow/terminal-phases.ts` (was duplicated) (#1010)
- `handlePruneStaleWorkflows` decomposed via `prunePruneCandidate` helper (~110 → ~60 lines) (#1010)
- New `adaptArgsWithStateDirAndEventStore` adapter in composite router for handlers needing both `stateDir` and `eventStore` (#1010)

### Documentation
- Comprehensive documentation coverage pass for v2.6.0: new oneshot-workflow guide, updated reference/learn/architecture pages
- Placeholder vocabulary reference (`docs/references/placeholder-vocabulary.md`) and runtime notes (`docs/references/runtime-notes.md`) (#1071)
- Skill authoring guide (`docs/skills-authoring.md`) covering edit workflow, vocabulary, adding runtimes, and CI checks (#1071)

### Tooling
- `npm run skills:guard` CI check — rebuilds skills in-place and fails on `git diff` to catch drift from forgotten rebuilds or direct edits to generated files (#1071)
- Per-runtime snapshot tests at `test/migration/snapshots.test.ts` — 78 baselines pinning every generated SKILL.md (#1071)
- Tier-1 runtime smoke harness at `test/smoke/runtime-smoke.test.ts` — validates per-runtime substitution correctness (Claude unconditional, others gated behind `SMOKE=1`) (#1071)

## [2.5.0] - 2026-03-09

**First public release.** Lazy schema loading, runbook protocol, typed agent specs, and a documentation site — reducing tool registration overhead by 83% while making workflows self-describing.

### Features
- Slim registration mode cutting MCP tool description payload from ~3,045 to ~500 tokens (#972)
- `describe` action on all 4 visible composite tools for on-demand schema loading (#972)
- Runbook protocol: 5 machine-readable orchestration sequences with runtime schema resolution (#972)
- Gate metadata with blocking/advisory classification and convergence dimension (#972)
- Native subagent integration: agent spec registry with `agent_spec()` MCP action and template variable interpolation (#973)
- Resume-aware fixer flow with `agentId`/`agentResumed`/`lastExitReason` on TaskSchema, `subagent-stop` hook, `TASK_FIX` runbook (#973)
- `nativeIsolation` parameter on `prepare_delegation` to skip worktree blockers for native agents (#973)
- Event type schema discovery via `describe(eventTypes)` on `exarchos_event` (#976)
- `mcpServers` allowlist on agent specs restricting subagent MCP access (#976)
- Model inheritance (`'inherit'`) replacing hardcoded `'opus'` on agent specs (#976)

### Bug Fixes
- Activate PID lock and sidecar fallback to prevent concurrent event store corruption (#971)
- Coerce stringified arrays in `fields` parameter
- Restore missing `overhaul-plan-review` transition in docs (#978)
- Add `describe` fallback to runbook annotations, clarify platform tiers
- Sync MCP server version, remove build-time agent generation
- Remove invalid `agents` field from plugin manifest

### Documentation
- VitePress documentation site with 38 pages across 5 sections (#974)
- README refresh for 2.5.0 — typed agents, runbooks, lazy schema

## [2.4.4] - 2026-03-08

### Features
- Open issues consolidation (#968, #952, #350) (#970)

### Bug Fixes
- Use gh api for backfill releases to avoid workflow scope requirement
- Fix release and project-automation workflow failures

### Documentation
- Refactor README for accuracy, add architecture section, hide sync tool

## [2.4.3] - 2026-03-07

### Bug Fixes
- Accept both error codes in concurrent init race test
- Support flexible design/plan formats in validation scripts

### CI
- Add automated release workflow and backfill script

### Chores
- Release hardening — sensitive doc removal, governance, CI guards (#969)

## [2.4.2] - 2026-03-06

### Bug Fixes
- Support flexible design/plan formats in validation scripts
- Redistribute diagram layout after flywheel removal
- Address dogfood findings, update diagram
- Restore skill description guardrails and add workflowType to brainstorming

## [2.4.0] - 2026-03-04

### Features
- Schema-driven CLI surface with config-driven custom workflows (#963)
- New local skills for project-level customization
- README updates and VHS terminal recordings

### Bug Fixes
- Unified binary with explicit `mcp` subcommand
- Integrate hook CLI commands into unified binary

### Refactoring
- Remove project-specific sync-schemas skill
- Reduce plugin token footprint by 57%

### Chores
- Prune plugins and claude/memory files

## [2.3.8] - 2026-03-02

### Features
- Add visual assets for GA release

### Bug Fixes
- Update subagent-context test counts for 5 new orchestrate actions, overhaul README
- Add direct-push completion path for debug hotfixes and tag universal transitions (#957, #958)

### Documentation
- Refresh community-facing README references
- Revise visual asset specs for GA release

## [2.3.7] - 2026-03-02

### Bug Fixes
- Add 5 missing orchestrate actions to registry, add sync test

## [2.3.6] - 2026-03-02

### Features
- Add event emission source registry and boundary data validation (#955)

### Bug Fixes
- Remove stale @planned annotation from team.disbanded (#954)

## [2.3.5] - 2026-03-02

### Bug Fixes
- Remove deprecated `/resume` command, replace with `/rehydrate`

## [2.3.4] - 2026-03-02

### Bug Fixes
- Array-of-objects upsert in deepMerge, harden gate check and review projection

## [2.3.3] - 2026-03-02

### Bug Fixes
- Align phase names with HSM definitions, add phase-name validation

## [2.3.2] - 2026-03-02

### Bug Fixes
- Sync plugin manifest versions to 2.3.1, add version:sync to rebuild
- Sync backend version counter with state._version on seed (#948)

## [2.3.1] - 2026-03-01

### Refactoring
- Namespace all skill references with `exarchos:` prefix

## [2.3.0] - 2026-03-01

### Bug Fixes
- Sequence corruption auto-repair, guard diagnostics, shepherd DX (#947)

### Refactoring
- Make plugin self-contained for marketplace install (#946)

## [2.2.2] - 2026-03-01

### Bug Fixes
- Expand tilde in WORKFLOW_STATE_DIR, remove stale artifacts
- Stale .seq cross-validation, manual evidence gate bypass, completed status alias (#939, #940, #941)

### Documentation
- README restructure, metadata refresh, and copy cleanup

## [2.2.1] - 2026-03-01

### Bug Fixes
- Audit remediation — bound arrays, extract skill body, add overhaul-plan-review (#938)

## [2.2.0] - 2026-03-01

### Features
- Event-driven skill architecture with CQRS readiness projections (#930)
- Add judge calibration pipeline and gold standard dataset
- Activate verification flywheel — remediation events and quality hints
- Add eval-backed feature audit prompt and regression dataset

### Bug Fixes
- Address review feedback and eval regression check (#932)
- Detect default branch dynamically in prepare-synthesis (#934)

### Refactoring
- Remove Graphite integration, adopt GitHub-native PR stacking (#933)
- Consolidate gate-telemetry integration, enforce D2, harden execFileSync

## [2.1.2] - 2026-02-28

### Bug Fixes
- Recognize deferred sections in plan coverage verification (#913) (#927)

## [2.1.1] - 2026-02-27

This was a large release spanning the v2.1.0 milestone, covering session provenance, phase playbooks, verification flywheel closure, and eval framework expansion.

### Features
- Add session provenance — event hardening, types, manifest, transcript parser, lifecycle (#896)
- Add session provenance query layer — projection, view integration (#903)
- Close verification flywheel loop — calibration, capture, signal wiring, integration (#914)
- Add phase playbook module with all workflow entries (#846)
- Add behavioral guidance section to context assembly (#856)
- Add behavioralGuidance field to SessionStartResult (#858)
- Add playbook virtual field to exarchos_workflow get (#860)
- Add `/rehydrate` command and deprecate `/resume` (#861)
- Add `/tag` command and document opt-in tracking philosophy
- Add validate-phase-coverage.sh meta-validation script (#852)
- Wire 4 validation scripts into skills (#845)
- Add compaction-behavioral eval dataset and update reliability suite (#849)
- Add cache hit/miss tracking and thrashing detection to ViewMaterializer (#917)
- Split Zod validation from event construction for hot-path optimization (#918)
- Enforce PR description template with CI validation and configurable overrides (#907) (#909)
- Add write-through .state.json backup and preserve files during migration (#806) (#906)
- Add LLM rubric assertion and dataset to brainstorming eval suite (#792)
- Add quality-aware dataset and llm-similarity assertion to delegation eval suite (#797)
- Add LLM rubric assertion and dataset to implementation-planning eval suite (#795)
- Add LLM rubric assertion and dataset to debug eval suite (#796)
- Add quality_correlation view joining CodeQuality and EvalResults by skill (#800)
- Remove stale @planned annotations and add shepherd event schemas (#781)

### Bug Fixes
- Add iteration limits, spec re-verification, and data handoff protocol to skills (#919)
- Extract gate event emission and add debug/refactor disambiguation (#920)
- Harden PR validation script and CI workflow (#911)
- Update SERVER_VERSION constant and test expectations to 1.1.0 (#912)
- Add max-length constraints to unbounded event payload fields (#916)
- Update pre-synthesis-check.sh for polish track and debug HSM phases (#851)
- Update reconcile-state.sh valid phases to match HSM (#850)
- Update refactor eval datasets to use correct HSM phase names (#848)
- Await async property test, validate stateFile paths, fix checkpoint loop break (#863)
- Populate _events for guard evaluation and skip team guard in subagent mode (#788)

### Refactoring
- Harden event store idempotency and sequence invariants (#822)
- Add HSM transitions for escalation, revision limits, and hotfix (#823)
- Add schema safety constraints and synthesize retry (#824)
- Clean up content layer documentation and scripts (#825)
- Add benchmark infrastructure and always-on CI gate (#826)

### Tests
- Add HSM-playbook coverage and content adequacy property tests (#847)
- Add discovery and parse tests for new eval suites (#785)

## [2.0.8] - 2026-02-23

### Bug Fixes
- Use INSERT OR IGNORE for event hydration to handle duplicate sequences

## [2.0.7] - 2026-02-23

### Features
- Complete eval framework Phase 3 (#773)
- Foundation cleanup and orphan event wiring (#774)
- Add eval suites for brainstorming, planning, refactor, and debug skills (#784)
- Add LLM rubric assertion and dataset to debug eval suite (#796)
- Add LLM rubric assertion and dataset to refactor eval suite (#794)
- Wire regression detector into code quality view + add quality-check CLI (#798)
- Add gate.executed event emission instructions to shepherd, synthesis, and delegation skills (#793)

### Bug Fixes
- Prevent property collision in captureTrace spread ordering
- Initialize explore field in state to prevent guard rejection (#775) (#779)
- Hydrate _events from event store before guard evaluation
- Bundle better-sqlite3 native binary + fix versionless state migration
- Update rebuild

### Refactoring
- Use typed TeamTaskAssignedData schema in CQRS view (#780)

### Tests
- Add E2E round-trip and crash recovery tests for storage layer
- Add lifecycle SQLite + hydration PBT tests
- Add storage E2E validation suite (#772)

### CI
- Switch all workflows to self-hosted runners
- Install gh CLI on self-hosted runners for review gate and project automation

---

## Legacy Changelog (pre-semver)

## 2026-02-09

### Removed Jules MCP Integration

Jules (Google's autonomous coding agent) integration has been removed. It was never used in production and is superseded by the Task tool subagent pattern.

**Removed:**
- `plugins/jules/` — entire MCP server and plugin directory
- `julesSessions` field from workflow state schema and initial state
- `julesSessionId` and `jules` assignee from JSON schema
- Jules permissions, labels, and auto-triage scope detection
- Jules references from delegation skill, delegate command, and documentation

## 2026-01-06

### Workflow Phase Restructuring

Added explicit integration phase and orchestrator constraints:

**New `/integrate` Phase:**
- Merges worktree branches in dependency order
- Runs combined test suite after each merge
- Reports pass/fail with specific failure details
- Auto-chains to `/review` on success, `/delegate --fixes` on failure

**Orchestrator Constraints:**
- Orchestrator no longer writes implementation code
- All fixes delegated to subagents (fixer prompt template)
- Worktree enforcement prevents accidental main project modifications

**Review Updates:**
- Reviews now assess integrated diff (not per-worktree fragments)
- Full picture of combined code quality

**Synthesis Simplification:**
- Merge/test logic moved to `/integrate`
- `/synthesize` now just creates PR from integration branch

**Updated flow:**
```
/ideate -> [CONFIRM] -> /plan -> /delegate -> /integrate -> /review -> /synthesize -> [CONFIRM] -> merge
            ^           (auto)   (auto)      (auto)      (auto)     (auto)           ^
          HUMAN                                                                    HUMAN
                                   ^                        |
                                   +---- --fixes -----------+
```

**Files added:**
- `rules/orchestrator-constraints.md`
- `skills/integration/SKILL.md`
- `skills/integration/references/integrator-prompt.md`
- `skills/delegation/references/fixer-prompt.md`
- 14 test scripts

**Files modified:**
- `skills/delegation/SKILL.md` (worktree enforcement + fix mode)
- `skills/spec-review/SKILL.md`, `skills/quality-review/SKILL.md` (integrated diff)
- `skills/synthesis/SKILL.md` (simplified)
- `docs/schemas/workflow-state.schema.json` (integration object)

---

## 2026-01-04

### PR Feedback Loop & Direct Commits

Added support for human interaction with PRs:

**PR Review Feedback:**
- New `--pr-fixes` flag for `/delegate`
- Fetches PR comments via `gh api`
- Creates fix tasks from review feedback
- Loops back to merge confirmation after fixes

**Direct Commits:**
- Users can commit directly to integration branch
- Workflow syncs (`git pull`) before merge confirmation
- Documented in synthesize command and skill

**Updated flow:**
```
/ideate -> [CONFIRM] -> /plan -> /delegate -> /integrate -> /review -> /synthesize -> [CONFIRM] -> merge
                                            ^                                       |
                                            +----------- --pr-fixes ----------------+
```

---

### Streamlined Auto-Chain Flow

Reduced confirmation prompts in the workflow pipeline:

**New flow:**
```
/ideate -> [CONFIRM] -> /plan -> /delegate -> /integrate -> /review -> /synthesize -> [CONFIRM] -> merge
            ^           (auto)   (auto)      (auto)      (auto)     (auto)           |
            +------------ ON BLOCKED ------------------------------------------------+
                          ON FAIL -> /delegate --fixes (auto)
```

**Changes:**
- `/plan` -> `/delegate`: Now auto-invokes (no confirmation)
- `/delegate` -> `/review`: Now auto-invokes (no confirmation)
- `/review` -> `/synthesize`: Now auto-invokes on PASS (no confirmation)
- `/synthesize` -> merge: Added confirmation before merging PR
- `/review`: Now dispatches to subagents (preserves orchestrator context)

**Files modified:**
- `commands/plan.md`, `commands/delegate.md`, `commands/review.md`, `commands/synthesize.md`
- `skills/spec-review/SKILL.md`, `skills/quality-review/SKILL.md`
- `skills/implementation-planning/SKILL.md`, `skills/delegation/SKILL.md`

---

### Initial Global Configuration

- **Skills (7)**: brainstorming, implementation-planning, git-worktrees, delegation, spec-review, quality-review, synthesis
- **Commands (6)**: ideate, plan, delegate, review, synthesize, tdd
- **Rules (4)**: tdd-typescript, tdd-csharp, coding-standards-csharp, coding-standards-typescript
- **Plugins (1)**: jules (symlinked from workflow/jules-plugin)
- **Settings**: Global permissions for WebSearch, Jules API, GitHub

### Update Policy

Before updating global config:
1. Test changes locally in a project first
2. Validate with `/review` quality checks
3. Document changes in this file
4. Project-level `.claude/` overrides take precedence

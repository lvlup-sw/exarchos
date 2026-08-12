# Durable Event-Store Substrate, Capability Posture, HSM Single-Path, Phase Contract

**Workflow:** `v2-10-next-unit` (feature)
**Date:** 2026-05-08
**Status:** Draft (ideate phase)
**Closes (spike):** #1259
**Structurally closes (substrate):** #1230, #1228, #1241, #1226, #1224, #1220, #1225, #1117 (already surgically closed in v2.9; this design promotes their fixes from invariant-bearing primitives to substrate-level guarantees)
**Cross-cutting:** #1109 (event-sourcing integrity + MCP parity + basileus-forward), #1118 (codify event-sourcing principles), #1139 (capability resolver, shares `EffectiveCapabilities` type)
**Out of scope:** basileus-remote shared store (#1081), `exarchos watch` sideband daemon, multi-author concurrent-checkpoint semantics

## Problem Statement

The v2.9.0 combined-fix PR (`docs/designs/2026-05-06-v29-bug-cluster-combined-fix.md`) closed eight bugs via three invariant-bearing primitives (`AtomicAppender`, `SubagentStreamRouter`, `HSMTransitionGuard.fail_closed`) plus surgical fixes. Those primitives are interface-shaped to be replaceable. The substrate beneath them is unchanged: `AtomicAppender` writes JSONL + `.seq` sidecar; `SqliteBackend` mirrors as a self-healing replica (`servers/exarchos-mcp/src/index.ts:89` — "JSONL files remain the source of truth"); capability arrays are hand-listed; the workflow store still exposes `set({ phase })` as a write surface; the pruner uses single-signal staleness.

This spike investigates substrate swaps that **structurally eliminate** the bug classes the v2.9 PR patched surgically. The five "C-moves" are interface-preserving swaps: three of five require zero consumer changes when swapping in.

## Approaches Considered

Three approaches were audited against design invariants (INV-1..5) and backend quality dimensions (DIM-1..8). All three share a common baseline of structural guards (storage handle injection, cross-stream queries reducing over events, resolver-merged capabilities, typed phase-contract loader, archived-not-deleted JSONL, lock-protected migration, structured event emission for migration steps, schema versioning with tolerant deserialization, transition-failure error envelope, action-surface contract bumps, SQLite atomic transaction with retry).

### Option 1: Approach A — Pure cutover (rejected)

All five C-moves hard-cut in one PR. Tightest invariant posture (INV-1, INV-5b, DIM-5 maximally clean), but provides no envelope-level deprecation channel for external consumers; agents calling deprecated paths get a hard error with no machine-readable migration breadcrumb. Single-PR bundle test fidelity risk (DIM-4).

### Option 2: Approach B — Storage hard-cut, contracts gradually (Chosen — see below)

Storage flips irreversibly; contract surfaces (C4 HSM, C5 capability, C6 phase contract) deprecate via the `_meta.deprecation` envelope field for one release, then v2.11 hard-cuts. Uses INV-5b's spec-aligned output contract as a *migration vehicle*: agents self-correct from the response envelope without human prompting.

### Option 3: Approach C — Vertical with structurally-honest escape hatches (rejected)

All hard-cut, plus a `workflow.repair` action (event-emitting, capability-gated through resolver) and per-phase permissive flags. Invariant-clean but adds three permanent surfaces for an audience (single-developer Claude Code with rare crash recovery) that does not currently need them; DIM-5 hygiene tax.

## Chosen Approach: Approach B — Storage Hard-Cut, Contracts Gradually

- **C1 (storage):** Flip source-of-truth direction. SQLite (`bun:sqlite`) becomes truth; legacy JSONL is archived (one-release retention) and the JSONL writer is deleted. The `AtomicAppender` interface is unchanged; only its body is replaced. Closes the F1 family by physics, not by test discipline.
- **C2 (cross-stream propagation):** Stream IDs become `<feature-id>/<subagent-id>`. The `SubagentStreamRouter` primitive's behavior moves to a query reducing over the `events` table at `team.disbanded` emission time. Generalizes the v2.9 router from explicit emit to derivation-from-events.
- **C4 (HSM API single-path):** `workflow.transition(target)` is the canonical action. `workflow.set({ phase })` is retained one release as a deprecation rerouting surface — the handler routes through the same `dispatch/core/dispatch.ts` and emits the same `workflow.transition` event under the hood. Each invocation emits a `hsm.deprecated_action_invoked` event and surfaces `_meta.deprecation` in the response envelope. v2.11 removes the action.
- **C5 (capability posture):** `AgentPosture = 'read-only' | 'task-isolated' | 'shared-mutating'` is added as a spec field. `capabilities/resolver.ts` derives the full capability set from posture. Specs declaring legacy `capabilities` arrays continue to work for one release with the same deprecation envelope. Resolver remains the only authority over `yaml ⊕ handshake`. v2.11 removes the array path.
- **C6 (phase contract):** Each phase in `topology.yaml` may declare a `staleness` block. Pruner becomes a generic scorer over declared signals. Missing contracts fall back to today's single-signal heuristic and emit a `phase.contract_missing` event at startup. Mandatory v2.11.

## Cross-cutting compliance — invariants and quality dimensions

| Invariant / Dimension | How this design honors it |
|---|---|
| **INV-1** event-sourcing integrity | C1 makes append atomicity a property of physics. C2 reduces over the `events` table (never over derived `workflow_state` fields). C4's deprecated path emits the same event the canonical path emits — no fix-it-up surface. Migration steps (DR-12) are themselves events. |
| **INV-2** facade equivalence | All swaps live below `dispatch/core/dispatch.ts`. Storage handle is injected through `DispatchContext`; no adapter-local cache. Deprecated action handler routes through dispatch core, not adapter shims. |
| **INV-3** basileus-forward | Capability derivation goes through `capabilities/resolver.ts`; `posture` is the YAML half of `yaml ⊕ handshake`, handshake stays authoritative. Storage backend is transport-agnostic; the cross-stream query is a primitive that a future remote store can implement. |
| **INV-4** platform-agnosticity | `bun:sqlite` decision is settled (#1175 → #1176); skill-source content is unaffected. No new `runtimes/*.yaml` tokens needed. |
| **INV-5a** input ergonomics | `set({phase})` action description gains explicit "Do NOT use — use action: 'transition' instead" pointer. Resolver loads phase contracts via typed loader; no free-text YAML at handler call time. |
| **INV-5b** output contract | `_meta.deprecation = { since, removeIn, replacement }` registered in the action's `outputSchema`. Transition guard failures populate `validTargets`, `expectedShape`, `suggestedFix`. The envelope is the migration channel — agents self-correct without human prompting. |
| **INV-5c** Aspire verbs | No new top-level verbs; `workflow.transition` is queryable via existing `describe`. Pruner exposes phase-contract decisions via `view.staleness` (existing `exarchos_view` action). |
| **INV-5d** action discriminator | All changes within existing composite tools. Per-action `describe` entries updated; no new top-level tools. `outputSchema` registered per affected action with envelope version bump. |
| **DIM-1** topology | Storage handle DI'd through `DispatchContext`, not module-global. Cross-stream queries reduce over events (no second source of truth). |
| **DIM-2** observability | Migration steps emit structured events. Deprecation invocations emit `hsm.deprecated_action_invoked`. No `console.log` paths. |
| **DIM-3** contracts | Schema bump to `events` table SCHEMA_VERSION 3 with tolerant deserialization. Action-surface changes bump registered `outputSchema`. |
| **DIM-4** test fidelity | Per-C-move integration tests + bundle test. Parity harness covers deprecated and canonical paths. POC tests use the real `AtomicAppender` interface with both backends. |
| **DIM-5** hygiene | One-release shim weight; v2.11 removal tracked under DR-14. Three structural cleanups (JSONL writer, capabilities array, set-phase action) shrink surface area at the v2.10/v2.11 boundary. |
| **DIM-6** architecture | Capability resolver retains SRP (derives, doesn't enforce). Phase contract scorer is a new dedicated module, not bolted onto the pruner. |
| **DIM-7** resilience | SQLite append wrapped in `BEGIN IMMEDIATE` transaction with `busy_timeout` + bounded retry. JSONL archived (not deleted) for one release as forensic preservation. Migration is locked. |

## Technical Design

```
                  ┌────────────────────────────────────────────────┐
                  │                core/dispatch.ts                │  <- INV-2: shared core
                  │  (DispatchContext { storage, resolver, ... })  │
                  └─────────┬──────────────────────────────┬───────┘
                            │                              │
                ┌───────────▼──────────┐     ┌─────────────▼────────────┐
                │   AtomicAppender     │     │   capabilities/resolver  │
                │   (interface ─ v2.9) │     │   (yaml ⊕ handshake)     │
                │   body: SQLite txn   │     │   posture → capabilities │
                └───────────┬──────────┘     └─────────────┬────────────┘
                            │                              │
                  ┌─────────▼──────────┐     ┌─────────────▼────────────┐
                  │  bun:sqlite events │     │  AgentSpec.posture       │
                  │  + workflow_state  │     │  (yaml side)             │
                  │  + outbox          │     │                          │
                  └────────────────────┘     └──────────────────────────┘

  Cross-stream propagation (C2):
    eventStore.queryByType('task.completed', { streamPrefix: featureId })
         └─ reduces over events; no derived-state lookup (INV-1)

  Phase contract (C6):
    topology.yaml ─ typed loader at startup ─> PhaseContract objects
                                              └─ pruner scorer module
```

The dispatch context is constructed in `lifecycle.ts` and threaded as a parameter; nothing imports `Database` from `bun:sqlite` directly outside the SQLite backend module.

## Requirements

### Storage primitive (C1, Q1)

**DR-1.** SQLite (`bun:sqlite`) is the source of truth for events, workflow state, outbox, view cache, and sequences. JSONL files are no longer written.

**Acceptance criteria:**
- `AtomicAppender.append()` body is replaced; the existing interface (`AppendResult`, per-stream serialization, idempotency-key claim semantics) is unchanged.
- Append is implemented as a single `BEGIN IMMEDIATE` transaction wrapping idempotency-key check + sequence allocation + event INSERT + outbox INSERT (when applicable). Commit-on-success semantics preserved (`ok: true` returned only after `COMMIT` succeeds).
- Replay-determinism property tests (`store.property.test.ts`) pass against the SQLite-backed body.
- Race tests (`store.race.test.ts`) pass under concurrent appenders to the same stream and to different streams.
- No production module under `servers/exarchos-mcp/src/` imports `Database` from `bun:sqlite` outside `storage/sqlite-backend.ts`.

**DR-2.** Storage handle is injected, not ambient.

**Acceptance criteria:**
- `DispatchContext` carries a `storage: StorageBackend` field constructed in `lifecycle.ts`.
- A grep of production code (`servers/exarchos-mcp/src/**/*.ts` excluding `__tests__/` and `__shims__/`) finds zero `import .* from 'bun:sqlite'` outside `storage/`.
- Test-doubles use `MemoryBackend` injected through the same context shape.

### Cross-stream propagation (C2, Q3)

**DR-3.** Subagent stream IDs are namespaced as `<feature-id>/<subagent-id>`. Cross-stream propagation at `team.disbanded` emission time is a query reducing over the `events` table.

**Acceptance criteria:**
- Stream-id validator (`contract/shared/validation.ts`) accepts the namespaced form and rejects malformed inputs with structured error.
- Team-disbanded emission queries `eventStore.queryByType('task.completed', { streamPrefix: featureId })` and reduces; no read of `workflow_state.tasksCompleted` or any other derived-state field.
- The `SubagentStreamRouter` primitive from v2.9 is removed in favor of the query (or kept as a thin wrapper if call sites benefit; documented either way).
- Bundle test exercises a two-worktree scenario where two subagents append concurrently and the parent stream's `team.disbanded` event reflects exactly the two `task.completed` events.

### HSM API single-path (C4, Q4)

**DR-4.** `workflow.transition(target)` is the canonical phase-mutation action. `workflow.set({ phase })` is retained for one release as a deprecation rerouting surface.

**Acceptance criteria:**
- `set({ phase })` handler routes through `dispatch/core/dispatch.ts` and emits a `workflow.transition` event indistinguishable from the canonical path's emission (same event type, same data shape).
- Each invocation emits a `hsm.deprecated_action_invoked` event with `data.action: 'workflow.set.phase'` and `data.invokedBy` populated from `DispatchContext`.
- Response envelope carries `_meta.deprecation = { since: "2.10.0", removeIn: "2.11.0", replacement: "transition" }`.
- `outputSchema` for `exarchos_workflow.set` registers `_meta.deprecation` as a typed field.
- Tool description for `set` action contains the substring "Do NOT use — use action: 'transition' instead".
- `describe` entry for `set` action returns `deprecated: true`.

**DR-5.** Transition guard failures emit a structured error envelope.

**Acceptance criteria:**
- Failed `transition` calls return `success: false` with `error.validTargets[]` populated from the HSM topology, `error.expectedShape` describing the expected `target` value, `error.suggestedFix` referencing the closest valid transition.
- Existing parity harness (`__tests__/parity-harness.ts`) covers a transition-guard-failure fixture for both CLI and MCP carriers.

### Capability posture (C5, Q5)

**DR-6.** Agent specs declare a `posture: 'read-only' | 'task-isolated' | 'shared-mutating'` field. The capability resolver derives the full capability set from posture + runtime profile.

**Acceptance criteria:**
- `AgentSpec` schema in `agents/spec.ts` adds `posture` as an optional field; specs declaring `posture` and `capabilities` together fail spec validation (single source of truth per spec).
- `capabilities/resolver.ts` exposes `resolvePosture(spec, runtime)` returning `EffectiveCapabilities`. Posture-to-capabilities mapping documented in `capabilities/posture-mapping.ts` with a unit test asserting every posture maps to at least one capability and no two postures map to identical sets.
- Resolver continues to merge `yaml ⊕ handshake`; handshake declarations override resolved capabilities (acceptance question 1 of INV-3).
- A spec with `capabilities: [...]` (legacy) emits a `spec.legacy_capabilities_array` event at validation time and surfaces `_meta.deprecation` in any response that consumes it.

### Phase contract (C6, Q6)

**DR-7.** Each phase in `topology.yaml` may declare a `staleness` block. Pruner reads typed `PhaseContract` objects; no YAML parsing at the pruner call site.

**Acceptance criteria:**
- `topology/loader.ts` exposes `loadTopology(): Topology` called once at lifecycle start; returns typed objects.
- `Topology.phases[name].staleness` is `{ expectedMaxDwellMinutes: number; signals: StalenessSignal[]; freshnessRequires: 'all' | 'any' }` or `undefined`.
- Pruner module (`pruner/score.ts`) accepts `PhaseContract | undefined`; when `undefined`, falls back to current single-signal behavior and emits `phase.contract_missing` once at startup per missing phase.
- Schema validation rejects malformed contracts at load time with a structured error referencing the phase name and the specific malformed field.

### Migration plan (Q2, Q8)

**DR-8.** Legacy `~/.claude/workflow-state/*.events.jsonl` files are imported once on startup and archived (not deleted) under `~/.claude/workflow-state/.archive-v210/`.

**Acceptance criteria:**
- Migration runs at lifecycle start when SQLite database has no rows in `schema_version` matching SCHEMA_VERSION 3.
- Each JSONL file is read in append order, events inserted via the same `AtomicAppender` path used at runtime, and the source file moved (not removed) to `.archive-v210/<original-name>` after successful import.
- A SQLite-backed migration lock (single-row `migration_lock` table with `INSERT ... ON CONFLICT DO NOTHING`) ensures concurrent CLI + MCP-server starts converge on a single migration runner; the loser awaits completion.
- Archive retention: explicit cleanup task in v2.11.0 (DR-14) removes the archive folder after one release.

**DR-9.** Migration emits structured events.

**Acceptance criteria:**
- Per-file: `migration.legacy_jsonl_imported` with `data: { sourcePath, eventCount, durationMs }`.
- Terminal: `migration.completed` with totals; `migration.failed` with `data.reason` and the partial-progress totals if any file failed.
- Failures trigger an explicit non-recoverable startup failure with the structured error in the host (CLI or MCP) facade. The lock row is NOT cleared on failure (operator must inspect, then clear via documented procedure).

### Schema versioning (DIM-3, INV-1)

**DR-10.** Events table schema bumps to SCHEMA_VERSION 3.

**Acceptance criteria:**
- `event-store/event-migration.ts` adds a `2 → 3` migration step that runs at startup before any append.
- Tolerant deserialization: events stored under V2 deserialize unchanged when the V3 reader observes them; new events use V3 shape.
- `event-store/schemas.ts` registers any new event types (`hsm.deprecated_action_invoked`, `spec.legacy_capabilities_array`, `phase.contract_missing`, `migration.*`) before first append; the validator rejects unknown types.

### Output-contract registration (INV-5b)

**DR-11.** Each affected action's `outputSchema` is bumped and registered.

**Acceptance criteria:**
- `exarchos_workflow.set` and `exarchos_workflow.transition` `outputSchema` definitions in `registry.ts` register `_meta.deprecation` (optional) as a typed sub-shape.
- Envelope version field (`_meta.envelopeVersion`) bumps where applicable.
- `parity.test.ts` covers byte-equivalence of `_meta.deprecation` across CLI and MCP carriers.
- `describe({ actions: ["set", "transition"] })` returns the updated schemas.

### Failure-mode coverage (DIM-7, error-handling DR per skill rule)

**DR-12.** All substrate failure modes have explicit, observable, recoverable handling.

**Acceptance criteria:**
- SQLite `SQLITE_BUSY` triggers bounded retry (≤5 attempts, exponential backoff capped at 100ms) before returning `AppendResult` failure with `Reason: 'storage_busy'`.
- SQLite `SQLITE_CORRUPT` at startup triggers a structured error with operator-facing remediation (no auto-rebuild); the lifecycle refuses to start.
- Migration failure (DR-9) leaves the lock row claimed; documented operator procedure unlocks after manual inspection.
- Concurrent appenders on the same stream serialize via the per-stream Promise mutex (existing v2.9 primitive); the SQLite transaction is the second-tier guard.
- A POC race test simulates 50 concurrent appends to one stream and asserts: zero duplicate sequences, idempotency-key cache reflects only successful commits, `.archive-v210/` is unchanged.

### POC scope (acceptance criteria of #1259)

**DR-13.** A SQLite-backed `AtomicAppender` body proves the seam holds.

**Acceptance criteria:**
- The POC ships as a feature-flagged code path: `AtomicAppender` constructor accepts a `backend: 'jsonl' | 'sqlite'` arg defaulting to `sqlite` post-cutover.
- Same `AppendResult` shape, same per-stream serialization, same idempotency semantics — verified by running the existing `atomic-appender.test.ts` against both backends parametrically.
- Zero changes required in any of the seven current consumers of `AtomicAppender` (verified by `grep -l AtomicAppender` enumeration; each call site continues to pass the same arguments).
- `store.bench.ts` runs against both backends; SQLite append throughput is documented (target: ≥1000 events/sec/stream on commodity hardware).

### V2.11 cleanup tracking

**DR-14.** Removal of v2.10 deprecation shims is tracked as a single follow-up issue.

**Acceptance criteria:**
- A v2.11.0 issue is opened with title "v2.11 cleanup: remove durable-substrate deprecation shims" referencing this design's DR-4, DR-6, DR-7.
- The issue lists exact removal sites: `set({phase})` action handler + schema, `capabilities[]` legacy spec field, `phase.contract_missing` startup-warning behavior, `.archive-v210/` directory removal.
- Telemetry counts (`hsm.deprecated_action_invoked`, `spec.legacy_capabilities_array`) are reviewed at v2.11 cut to confirm zero in-tree call sites remain.

## Integration Points

The substrate flip touches five integration surfaces. Each is interface-preserving except where noted.

- **`servers/exarchos-mcp/src/event-store/atomic-appender.ts`** — Body replaced; `AppendResult` shape, per-stream serialization, idempotency semantics unchanged. Seven existing call sites (verified via `grep -l AtomicAppender`) require zero changes.
- **`servers/exarchos-mcp/src/storage/sqlite-backend.ts`** — Becomes the source-of-truth backend; `MemoryBackend` retained for tests via `StorageBackend` abstraction.
- **`servers/exarchos-mcp/src/lifecycle.ts`** — Constructs the `DispatchContext` storage handle; runs migration once at startup under SQLite-backed lock.
- **`servers/exarchos-mcp/src/capabilities/resolver.ts`** — Adds `resolvePosture(spec, runtime)` returning `EffectiveCapabilities`; preserves the `yaml ⊕ handshake` merge contract. Coordinates with #1139 on the shared `EffectiveCapabilities` type.
- **`servers/exarchos-mcp/src/registry.ts`** — Per-action `outputSchema` registrations bumped for `exarchos_workflow.set` and `exarchos_workflow.transition`; `_meta.deprecation` registered as a typed sub-shape; `describe` entries updated.
- **`topology/loader.ts` (new)** — Typed phase-contract loader called once at lifecycle start; returns immutable `Topology` object.
- **`pruner/score.ts`** — Accepts `PhaseContract | undefined`; falls back to current single-signal heuristic when contract is undefined.

External integration (consumers outside this repo):

- **Skills/agents calling `workflow.set({phase})`** — Continue to function via the deprecated rerouting handler; observable via `hsm.deprecated_action_invoked` events; removed in v2.11.
- **Specs declaring `capabilities[]`** — Continue to function via `spec.legacy_capabilities_array` deprecation; removed in v2.11.
- **Hooks/scripts grepping `~/.claude/workflow-state/*.events.jsonl`** — Archive folder (`.archive-v210/`) preserves shapes for one release; documented in release notes.

## Testing Strategy

Test fidelity (DIM-4) is the load-bearing concern given the dual-path migration. Strategy spans four layers:

- **Unit (per-C-move):** existing `atomic-appender.test.ts` runs parametrically against both backends to prove seam preservation. New tests cover posture-to-capability mapping, phase-contract loader validation, and migration-event emission shapes.
- **Integration:** `store.race.test.ts` exercises 50 concurrent appends to one stream and across multiple streams under SQLite, asserting zero duplicate sequences. A new `migration.integration.test.ts` walks startup with both fresh-install and legacy-JSONL fixtures, asserting archive folder contents and event emission.
- **Parity (INV-2):** `parity.test.ts` covers byte-equivalence of `_meta.deprecation` across CLI and MCP carriers for both deprecated and canonical action paths.
- **Property (INV-1):** `store.property.test.ts` (replay determinism) runs against the SQLite-backed body to confirm folding the event log produces identical state regardless of substrate.
- **Bench:** `store.bench.ts` documents SQLite append throughput per stream (target: ≥1000 events/sec/stream on commodity hardware); regression gate at v2.11.
- **POC validation gate:** the seven existing `AtomicAppender` consumers are enumerated and their tests run unchanged under both backends; any change required is a HIGH finding against DR-13.

## Migration Shape (Q2 detail)

**Direction:** irreversible cutover (per ideate decision).
**Forensic preservation:** legacy JSONL archived under `.archive-v210/` for one release; v2.11 cleanup task removes the archive.
**Concurrency:** SQLite-backed migration lock; CLI and MCP server compete for the lock at startup; loser awaits.
**Reversibility:** archive folder serves as the only rollback path; restoring requires manual operator action documented in the v2.10 release notes.

## Blast radius (Q8 detail)

- Single-developer machines: typically <50 in-flight workflows; migration completes in <5s on commodity hardware (extrapolation pending POC bench).
- `~/.claude` updates: install-time migration on first MCP `initialize` per `DispatchContext` start; no separate user-action required.
- Hooks/skills that grep JSONL: archive folder remains for one release. Documented in release notes.
- External skills/agents calling `workflow.set({phase})`: continue working through the deprecation envelope; observable via telemetry; v2.11 hard-cuts.

## Open questions deferred to follow-up issues

- **Q3 remote store topology:** explicit defer to #1081. The cross-stream query primitive is transport-agnostic and would generalize to a remote backend that exposes the same `eventStore.queryByType` shape.
- **`workflow.repair` / forced transition:** not introduced. If crash-recovery needs an admin override post-v2.11, opens as a separate design with `posture: 'shared-mutating'`-class scrutiny (per Approach C analysis).
- **Multi-author concurrent checkpoints:** explicit defer per spike's out-of-scope.
- **Posture handshake field:** `EffectiveCapabilities` shape coordination with #1139 — captured as an explicit interface contract; aligns the spike's C5 producer with #1139's consumer.

## References

- Spike issue: #1259
- v2.9 substrate-fix design: `docs/designs/2026-05-06-v29-bug-cluster-combined-fix.md`
- Cross-cutting design constraints: #1109
- Codify event-sourcing principles: #1118
- Capability resolver coordination: #1139
- bun:sqlite decision: #1175 → #1176
- Pattern precedent for spike → wiring follow-ups: #1239 → #1240–#1246
- Design invariants skill: `.claude/skills/design-invariants/`
- Backend quality skill (axiom): `~/.claude/plugins/cache/lvlup-sw/axiom/skills/backend-quality/`

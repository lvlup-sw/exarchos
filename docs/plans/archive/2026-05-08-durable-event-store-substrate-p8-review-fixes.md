# P8 — Review-Fixes Wave (Post-Shepherd Iteration 1)

**Workflow:** `v2-10-next-unit` (continuation)
**Parent design:** [`2026-05-08-durable-event-store-substrate.md`](../designs/2026-05-08-durable-event-store-substrate.md)
**Parent plan:** [`2026-05-08-durable-event-store-substrate.md`](2026-05-08-durable-event-store-substrate.md) (T01–T61 complete)
**PR under shepherd:** [#1323](https://github.com/lvlup-sw/exarchos/pull/1323)
**Date:** 2026-05-09
**Status:** Draft (post plan-review)

## Source

This wave addresses findings surfaced during `/exarchos:shepherd` on PR #1323:

- **2 failing E2E parity tests** (CLI ↔ MCP byte-equal envelope contract)
- **12 Major + 1 Minor** CodeRabbit review findings
- All evaluated against `/design-invariants` (INV-1..INV-5) and `/axiom:backend-quality` (DIM-1..DIM-7)

## Scope

**In scope:**
- Restore CLI ↔ MCP parity (INV-2)
- Fix concurrency races in storage layer (DIM-7)
- Tighten CI gates that have known loopholes (DIM-4)
- Fix-closed semantics where current code fails-open (DIM-7)
- Remove durable event-log dependence on machine-local paths (INV-1 portability)

**Out of scope (defer to v2.10.1 or v2.11):**
- Re-architecting the dual-store transition logic (`appenderBackend` modes)
- Rewriting the JSONL importer (current import is one-shot; idempotency questions are deferred unless they manifest as failing tests in this wave)

## Task Breakdown

### Task 62: Parity bug — route cross-stream queries through `getReadBackend()`

**Goal:** Fix the CLI ↔ MCP read divergence. `EventStore.queryByType` (line 1180) and `listStreamsMatchingPrefix` (line 1244) check `this.backend` directly; when `appenderBackend: 'sqlite'` is configured without an explicit `backend`, both paths skip the SQLite backend the appender owns.

**Phase:** RED → GREEN
**Test Layer:** integration (E2E parity tests already RED)
**Implements:** CR #4, CR #5 — INV-2 + DIM-1
**Existing failing tests:**
- `test/process/parity-event-query.test.ts:158` (CLI=6 events, MCP=3)
- `test/process/parity-workflow-rehydrate.test.ts:192` (`projectionSequence` differs)

**TDD Steps:**
1. [RED] Confirm both parity tests fail (already failing in CI #25590501030)
2. [GREEN] In `event-store/store.ts`, replace `this.backend` with `getReadBackend()` at lines 1180 and 1244; ensure return type and downstream logic still hold
3. [REFACTOR] Extract a single private helper `private getBackendForRead(): StorageBackend | undefined { return this.getReadBackend(); }` so future call sites can't regress

**Verification:** Both parity tests green; `getReadBackend()` is the only authority on backend selection across all read paths.
**Dependencies:** None (independent fix)

---

### Task 63: Serialize lazy SQLite backend init across streams

**Goal:** `AtomicAppender.runExclusive` is per-stream, but `this.sqliteBackend` is a shared field. Two first-time appends on different streams can both pass the `!this.sqliteBackend` check and open separate SQLite handles.

**Phase:** RED → GREEN
**Test Layer:** unit (race)
**Implements:** CR #1 — DIM-7

**TDD Steps:**
1. [RED] In `atomic-appender.test.ts`: dispatch two concurrent `append()` calls to different streams against a fresh appender; assert exactly one SQLite handle was constructed (spy on `getSqliteBackend`)
2. [GREEN] Wrap the lazy init in a Promise-cached singleton: `private sqliteBackendPromise?: Promise<SqliteBackend>` initialized on first call
3. [REFACTOR] Document the singleton invariant on the field

**Verification:** Concurrent first-write to N streams opens 1 backend, not N.
**Dependencies:** None

---

### Task 64: Re-read durable state after SQLite race conflicts

**Goal:** Lines 523–558 of `atomic-appender.ts` translate conflict cases from pre-transaction state. If another writer wins between preflight and `atomicAppend()`, the conflict branch returns the wrong claim/check result.

**Phase:** RED → GREEN
**Test Layer:** integration (race)
**Implements:** CR #2 — DIM-7 + INV-1 (correct outcome reporting on race)

**TDD Steps:**
1. [RED] Construct a race: two appenders preflight against the same idempotency key; one wins; assert the loser's reported result reflects post-commit state, not pre-preflight state
2. [GREEN] On `IdempotencyConflict` from `atomicAppend`, re-read `events` table and `idempotency_claims` to derive the canonical post-conflict result before returning
3. [REFACTOR] Extract conflict-resolution into a named helper

**Verification:** Loser's `AppendResult` matches what a fresh read would observe.
**Dependencies:** Coordinate with T63 (both touch atomic-appender.ts)

---

### Task 65: Make `migration.legacy_jsonl_imported.sourcePath` portable

**Goal:** `sourcePath` is documented absolute. Persisting absolute paths into the source-of-truth event log leaks machine-specific identifiers — replay across hosts breaks. INV-1 says events must be portable.

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** CR #3 — INV-1 portability

**TDD Steps:**
1. [RED] In `event-store/schemas.test.ts`: assert that the `sourcePath` schema rejects absolute paths via Zod refinement
2. [GREEN] Change schema: `sourcePath: z.string().refine(p => !path.isAbsolute(p), 'must be relative to state-dir')`. Update `jsonl-importer.ts` to compute relative path from state-dir before emit
3. [REFACTOR] Document the portability invariant in the schema comment

**Verification:** Migration events serialized to `events.jsonl`/SQLite contain only state-dir-relative paths.
**Dependencies:** None

---

### Task 66: Pruner fail-closed on missing fallback signal

**Goal:** `pruner/score.ts:95` uses `lastActivityMinutes ?? 0`, treating a contractless phase with no computed activity signal as fresh forever. Should fail-closed (mark for pruning consideration) consistent with the design's "missing contract → emit `phase.contract_missing` and degrade explicitly" principle.

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** CR #6 — DIM-7 (fail-closed)

**TDD Steps:**
1. [RED] In `pruner/score.test.ts`: contractless phase with no `lastActivityMinutes` → assert `freshness === 'unknown'` or score returns highest staleness
2. [GREEN] Replace `?? 0` with explicit branch: if signal absent and contract absent, return `{ stale: true, reason: 'no-contract-no-signal' }`
3. [REFACTOR] Add a dedicated unit test for the fail-closed branch

**Verification:** Contractless + signal-less phases are flagged for review, not silently considered fresh.
**Dependencies:** None

---

### Task 67: Tighten forbidden-import regex (CI gate)

**Goal:** `no-legacy-runtime-deps.test.ts` uses `/from\s+['"]bun:sqlite['"]/` which misses side-effect imports (`import 'bun:sqlite'`) and dynamic imports (`import('bun:sqlite')`). The CI gate that enforces INV-2 (storage isolation) has a loophole.

**Phase:** RED → GREEN
**Test Layer:** unit (meta-test of the CI gate)
**Implements:** CR #7 — DIM-4 + INV-2

**TDD Steps:**
1. [RED] Add fixture file with side-effect and dynamic import forms; assert current regex misses them
2. [GREEN] Replace regex with AST-based scanner (use `acorn` or TypeScript compiler API) that catches all import forms
3. [REFACTOR] Extract scanner into a named utility for reuse

**Verification:** Any import form of `bun:sqlite` outside `storage/` triggers the gate.
**Dependencies:** None

---

### Task 68: Surface walker I/O errors loudly

**Goal:** `no-legacy-runtime-deps.test.ts:65` swallows directory/file read failures, allowing the scan to skip files and pass falsely. DIM-2 violation in test infrastructure.

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** CR #8 — DIM-2

**TDD Steps:**
1. [RED] Inject a permission-denied directory; assert the test fails loudly with a clear error
2. [GREEN] Replace `try/catch{}` with `try/catch(err) { throw new Error('walker failed at ${path}: ${err.message}') }`
3. [REFACTOR] None

**Verification:** Walker errors propagate; no silent skips.
**Dependencies:** Coordinate with T67 (both touch the same file)

---

### Task 69: Deterministic migration-lock test cleanup

**Goal:** `migration-lock.test.ts:59` releases lock only on `claimerA`. If `claimerB` wins, the lock leaks and the test can hang/flap.

**Phase:** RED → GREEN (test-only)
**Test Layer:** unit
**Implements:** CR #9 — DIM-4

**TDD Steps:**
1. [RED] Force `claimerB` to win 100 times; assert no test hangs
2. [GREEN] Release whichever claimer holds the lock at end of test (`if (winner === a) { release(a) } else { release(b) }`); set `winnerHasReleased` after release, not before
3. [REFACTOR] Extract `releaseWinner(winner)` helper

**Verification:** Test passes deterministically regardless of winner.
**Dependencies:** None

---

### Task 70: Validate non-empty events array in `SqliteBackend.atomicAppend`

**Goal:** `sqlite-backend.ts:761` accesses `args.events[args.events.length - 1].sequence` without checking for empty array. Throws cryptic `TypeError` instead of validation error.

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** CR #10 — DIM-7

**TDD Steps:**
1. [RED] `atomicAppend({ events: [] })` → assert structured validation error, not `TypeError`
2. [GREEN] Add explicit precondition at function entry: `if (args.events.length === 0) throw new Error('atomicAppend requires non-empty events array')`
3. [REFACTOR] None

**Verification:** Empty-array call returns a usable error.
**Dependencies:** None

---

### Task 71: Mutex around topology first-load

**Goal:** `topology/loader.ts:66` only checks `cached`. Two concurrent `loadTopology()` calls can both parse and emit `phase.contract_missing` before cache assignment, duplicating startup events. INV-1 implication: same trigger should produce the same number of events.

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** CR #11 — DIM-7 + INV-1

**TDD Steps:**
1. [RED] Spawn two concurrent `loadTopology()` calls; assert exactly one `phase.contract_missing` event was appended (spy on event store)
2. [GREEN] Use Promise-cached singleton pattern: `private loadingPromise?: Promise<Topology>`; second caller awaits the first
3. [REFACTOR] Document the single-load invariant

**Verification:** N concurrent first-loads → 1 parse, 1 event emission.
**Dependencies:** None

---

### Task 72: Route deprecation emit through canonical event helper

**Goal:** `workflow/composite.ts:125` uses `eventStore.append(featureId, ...)` directly with hard-coded telemetry labels. This bypasses the namespaced stream-id path (DR-3) and the canonical event emission helpers. INV-1 + INV-5d.

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** CR #12 — INV-1 + INV-5d

**TDD Steps:**
1. [RED] Assert `hsm.deprecated_action_invoked` events are emitted to the canonical workflow stream with full envelope (correlationId, source, etc.) — not as raw appends
2. [GREEN] Replace manual `append` with `emitWorkflowEvent` (or whichever canonical helper exists per the design); ensure metadata fields are populated by the helper
3. [REFACTOR] Audit other manual `append` call sites for the same pattern

**Verification:** Deprecation events match the canonical emission shape; downstream consumers (telemetry, view) see them in the standard stream.
**Dependencies:** None

---

### Task 73: Idempotent phase-transition is a no-op

**Goal:** `workflow/tools.ts:958` delegates to `handleSet()`; same-target / idempotent transition still reaches the checkpoint/timestamp write block. INV-5b says no-op should be no-op (no state mutation, no event emission).

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** CR #13 — INV-5b

**TDD Steps:**
1. [RED] Call `workflow.transition(phase=current)` twice; assert second call returns idempotent envelope without writing checkpoint metadata or emitting `workflow.transition`
2. [GREEN] In `handleSet` (or the transition wrapper), short-circuit when `currentPhase === targetPhase`: return success envelope without state mutation
3. [REFACTOR] Add explicit `idempotent: true` flag in returned envelope

**Verification:** Idempotent transition leaves event log and state file unchanged.
**Dependencies:** None

---

### Task 74: Eliminate dual-import duplicate events at CLI startup (actual parity root cause)

**Goal:** During T62 implementation, an agent discovered the real cause of the parity test failure: **two import paths run on every CLI process startup**, both importing legacy JSONL → SQLite, and they don't coordinate on idempotency.

1. `hydrateAll()` (called from `servers/exarchos-mcp/src/index.ts:288`) imports JSONL into SQLite via `backend.appendEvent()` direct INSERT — **bypasses the `idempotency_claims` table**.
2. `runMigrationIfNeeded()` then re-imports the same JSONL through `appender.append(streamId, [...], idempotencyKey)`. The appender checks `idempotency_claims`, finds nothing (because step 1 didn't record claims), and writes a **new event with a new sequence and new eventId** — duplicating the same logical event.

Result: SQLite ends up with N copies of every event, each with a different `eventId`. The CLI test reads SQLite (sees duplicates); MCP — depending on its `getReadBackend()` resolution — may read JSONL or SQLite (sees the original count). This is **the parity bug** that T62 alone could not fix.

Concurrent observation from the agent's repro: `migration-lock timed out without observing completion` appears in CLI startup logs, putting the migration in degraded mode. This is a separate but related issue.

**Phase:** RED → GREEN
**Test Layer:** integration (E2E parity tests + unit on the dual-import scenario)
**Implements:** Real parity fix; **INV-1** (event-sourcing integrity — same logical event must appear in the log exactly once)

**TDD Steps:**
1. **[RED]** Write a unit test that reproduces the dual-import:
   - Seed state-dir with a JSONL file containing 3 events (no SQLite yet)
   - Call `hydrateAll()` then `runMigrationIfNeeded()` (in this order, mirroring `index.ts` startup)
   - Assert SQLite contains exactly 3 events (currently fails: contains 6)
   - Confirm parity tests are still RED at this point (they're the integration witness)
2. **[GREEN]** Pick **one** import path and remove the other. Recommended: **delete the `hydrateAll`-side direct-insert import** and let `runMigrationIfNeeded` be the sole importer (it already uses the appender, which records idempotency claims). Reasoning:
   - Single source of truth (one importer, one set of idempotency claims)
   - Migration runner is already lock-protected (DR-8)
   - `hydrateAll` becomes a pure projection rebuild from SQLite, which is its semantic purpose
3. **[REFACTOR]** If the migration lock timeout (degraded-mode warning) persists after the dual-import fix, file a separate follow-up issue; do not address in this task.

**Verification:**
- Dual-import unit test GREEN (3 events, not 6)
- Both E2E parity tests GREEN (`parity-event-query`, `parity-workflow-rehydrate`)
- No regressions in `npm run test:run`
- No `migration-lock timed out` appears in startup logs for fresh-state runs

**Dependencies:**
- Independent file from T62 (different files: `index.ts`, `run-migration-if-needed.ts`, possibly `jsonl-importer.ts`)
- Can dispatch in parallel with P8b/c/d/e/f

**Notes:**
- This task supersedes T62 as the actual parity unblock. T62 (already merged) remains correct on its own merits — it's an INV-2 hardening fix unrelated to the dual-import bug.

---

## Parallelization

| Group | Tasks | Notes |
|---|---|---|
| **P8a (parity unblock)** | T62 (DONE), T74 | T62 merged; T74 is the actual parity fix discovered post-T62 |
| **P8b (storage hardening)** | T63, T64, T65, T70 | All in `atomic-appender.ts` + `sqlite-backend.ts` + `schemas.ts` — coordinate to avoid merge conflicts |
| **P8c (CI gate hygiene)** | T67, T68 | Same file (`no-legacy-runtime-deps.test.ts`); single-agent or sequential |
| **P8d (resilience / fail-closed)** | T66, T71 | Independent files; can parallelize |
| **P8e (workflow surface)** | T72, T73 | `workflow/composite.ts` + `workflow/tools.ts`; coordinate if same agent |
| **P8f (test determinism)** | T69 | Standalone |

Estimated 12 tasks; 6 parallel groups (~3 waves with sequencing).

## Acceptance

- All E2E parity tests pass (`test/process/parity-*.test.ts`)
- All MCP server unit + integration tests pass (`servers/exarchos-mcp` test suite)
- CI gate green (CI Gate, E2E Process linux-x64, Exarchos MCP Server)
- CodeRabbit re-review of P8 commits surfaces no new HIGH/MAJOR findings
- Re-run `/exarchos:shepherd` on PR #1323 → recommendation `request-approval`

## Re-shepherd entry conditions

After P8 wave merges into `feature/durable-substrate`:

1. Verify `gh pr checks 1323` shows green
2. Re-run `assess_stack` action
3. If recommendation = `request-approval`, transition to `synthesize` final-stage
4. Otherwise loop with new findings (cap at original shepherd's 5 iterations)

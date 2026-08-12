# v2.11 Substrate Cut — Rip JSONL Runtime Substrate + Remove DR-4/6/7 Deprecation Shims

**Workflow:** `v2-11-substrate-cut` (feature)
**Date:** 2026-05-09
**Status:** Draft (ideate phase)
**Closes:** #1327 (Tier 2 JSONL rip), #1326 (idempotency-claims bypass — subsumed), #1328 (JSONL batch_append drops events — subsumed), #1322 (v2.11 deprecation-shim removal: DR-4 / DR-6 / DR-7 / §5 / §6), #1082 (sidecar mode — obsolete)
**Cross-cutting:** #1109 (event-sourcing integrity, MCP parity), #1259 (parent — substrate flip)
**Out of scope:** #1325 (manual `eventStore.append` sites), #1324 (bun:sqlite ESM CI), #1329, #1330 (workflow-tooling bugs unrelated to substrate)

## Problem Statement

PR #1323 landed the v2.10 substrate flip — SQLite became source-of-truth, JSONL retained as a runtime *alternative* substrate selectable via `AtomicAppender.backend: 'jsonl'` and `EventStore.appenderBackend: 'jsonl'`. The migration auto-import was already removed in #1323. What remains is a dual-substrate codebase carrying ~250 LOC of `appendLocked` JSONL machinery, a sidecar mode (#1082) that exists only because PID-lock contention forced JSONL writers to a side-channel, best-effort `replicateBackend` and `writeOutbox` dual-write paths that exist only because JSONL was primary and SQLite was secondary, and a graceful-degraded `initializeBackend` mode that silently falls back to JSONL when better-sqlite3 fails to load.

That dual-substrate posture has produced concrete defects. #1326: the runtime appender in JSONL mode mirrors to SQLite via `EventStore.replicateBackend → backend.appendEvent`, bypassing the `idempotency_claims` table — different write paths, different idempotency semantics. #1328: v2.9.0 JSONL `batch_append` silently drops events — the broken writer is one of the modules slated for deletion. The dual-write graph cannot be made coherent without collapsing it.

The v2.10 design (`docs/designs/2026-05-08-durable-event-store-substrate.md` DR-14) committed to a one-release deprecation window for three contract surfaces (`workflow.set({phase})` rerouting, legacy `capabilities[]` arrays, advisory `phase.contract_missing`). v2.11 hard-cuts those shims. This design lands the JSONL substrate rip together with the DR-4 / DR-6 / DR-7 removals as one v2.11 substrate-cut PR, because the shared theme — collapsing dual code paths inherited from one-release transition windows — makes the surgery review-coherent.

## Decisions Recorded

**DR-1 (full bundle).** One concerted PR addresses #1327 + subsumed #1326/#1328 + #1322 §1–§6 (DR-4, DR-6, DR-7, §5 productionize `_testOnly_*`, §6 substrate-stream migration interaction). DR-4/6/7 are theme-coherent (one-release-shim removal) and small relative to the JSONL rip; bundling avoids two tightly-coupled PRs against the same files at the same v2.11 boundary.

**DR-2 (telemetry pre-cut gate bypass — solo-dev).** The #1322 pre-cut gate — "all four telemetry counters zero across the install base" — assumes a centralized collector that does not exist in Exarchos. The de-facto install base is the developer's local environment plus any synced installs that the developer controls. The gate is satisfied by (a) auditing this repo's `agents/*.yaml` and `topology` for legacy patterns and (b) documenting the bypass rationale in this design and the PR description. The audit is mechanical; no telemetry network call is implemented or required.

**DR-3 (hard cut, no upgrade migration).** The v2.10 `runJsonlToSqliteMigration` importer (T57) is deleted alongside the JSONL writer. v2.11 starting against a v2.10 JSONL-only state directory aborts startup with a clear error directing the operator to either stay on v2.10 or wipe state. Solo-dev install base + disposable workflow state makes the upgrade story negotiable; the cleaner code surface is worth more than a one-shot importer that itself is the source of #1322 §6 (T58 finding) substrate-stream re-import bug.

**DR-4 through DR-9** are renumbered carry-overs from `2026-05-08-durable-event-store-substrate.md` DR-4 / DR-6 / DR-7 / DR-14 §5 / §6, with v2.10 deprecation envelope language updated to v2.11 hard-error language. See **Phase 5** below.

**DR-10 (staging — phase-decomposed).** Five sequential phases land in one PR with focused commits per phase. Each phase keeps the tree green and CI passing, satisfying TDD gating and bisection-friendliness. Phase order is dependency-driven: deletions before simplifications, substrate before contracts.

## Design Invariants Applied (`/design-invariants`)

| Invariant | How this design honors it |
|---|---|
| **INV-1 event-sourcing integrity** | The rip *strengthens* INV-1. Today's runtime has two append paths (`AtomicAppender.appendLocked` JSONL primary + `replicateBackend → backend.appendEvent` SQLite mirror) with divergent idempotency semantics (#1326). Post-rip, exactly one path exists: SQLite append guarded by `idempotency_claims`. The architectural mismatch evaporates by construction. No event reordering risk during the cut: each phase preserves the existing single-substrate read path until its writer is the one being collapsed. |
| **INV-2 facade equivalence** | `dispatchAppend` currently branches on `backend: 'jsonl' \| 'sqlite'` — two adapter-local code paths beneath a common surface. Inlining `dispatchAppend` into `append`/`appendUnkeyed`/`appendComputed` collapses the branch; both CLI and MCP facades now share one literal code path through `dispatch/core/dispatch.ts`. Strengthens INV-2. |
| **INV-3 basileus-forward** | Unaffected. SQLite substrate is local-only; basileus-remote is tracked under #1081, out of scope. |
| **INV-4 platform-agnosticity** | SQLite has two drivers: `better-sqlite3` (Node) and `bun:sqlite` (Bun). The JSONL fallback in `initializeBackend` exists for "neither driver loaded" scenarios. Hard-cut means: if neither SQLite driver loads, `initializeBackend` throws — runtime is dead. Mitigated by clear error message naming both drivers and resolution paths; the alternative (silent JSONL fallback) is what we are explicitly removing. |
| **INV-5a input ergonomics** | DR-4 removal turns `workflow.set({phase})` from rerouting+envelope into a hard `unknown action` error with `validActions: ['transition']`. DR-6 turns legacy `capabilities[]` into a typed validation error with `replacement: 'posture'`. Both errors carry agent-self-correction breadcrumbs in the response envelope, preserving INV-5a even at the hard-cut boundary. |
| **INV-5b output contract** | The `_meta.deprecation` envelope slot added in #1259 is *retained* in `outputSchema` for one more release as a permanent migration-history marker (registered but never populated post-v2.11), then dropped in v2.12. This avoids a same-release breaking schema bump. |
| **INV-5c Aspire verbs** | No new top-level verbs. `_testOnly_getSqliteBackend()` rename is internal to `atomic-appender.ts`; the public verb surface is unchanged. |
| **INV-5d action discriminator** | `workflow.set` action registration is removed from `registry.ts`. The action discriminator narrows; the per-action `outputSchema` registry shrinks correspondingly. Cleaner. |

## Axiom Quality Dimensions Applied (`/axiom:design`)

| Dimension | How this design honors it |
|---|---|
| **DIM-1 architecture / SOLID** | SRP: `AtomicAppender` becomes single-responsibility (SQLite append only). DIP: `getReadBackend()` collapses from "abstract reader chosen between JSONL fallback and SQLite primary" to "always SQLite" — the abstraction loses its only second concrete and is therefore inlined. The pruner becomes a typed-contract scorer with no fallback branch. |
| **DIM-2 testing** | High-risk dimension. Many tests exclusively exercise JSONL semantics (sidecar-mode tests, JSONL-only fallback tests, `replicateBackend` dual-write tests, JSONL idempotency-cache tests). Plan: each Phase task includes a test-audit step — every test referencing `backend: 'jsonl'` is either (a) deleted if it exclusively asserts JSONL behavior, or (b) migrated to `backend: 'sqlite'` if it asserts general append/read semantics that should now hold on SQLite. Property tests, race tests, and acceptance tests are preserved. Coverage gap risk mitigated by post-rip full-suite run on SQLite-only tree. |
| **DIM-3 resilience** | Hard-fail on SQLite open is *more honest* than degraded mode. Today's "running in JSONL-only mode" log is silent corruption: the operator does not know better-sqlite3 failed to install until events go missing on a later upgrade. Post-rip: explicit `Error: SQLite driver unavailable — install better-sqlite3 or run under bun (bun:sqlite)`. Loss of forensic JSONL trail is a real operational tradeoff: pre-rip, `cat *.events.jsonl` was a debugging path. Mitigation: SQLite WAL provides query-level forensics via `sqlite3 events.db ".dump"` or the existing `exarchos view` tool — document the workflow in CHANGELOG. |
| **DIM-4 distillation** | This PR *is* distillation. Net deletion estimated at ~1500–2000 LOC across `atomic-appender.ts`, `store.ts`, `index.ts`, sidecar machinery, plus dead test files. Acceptance criterion: post-rip `grep` for the JSONL-substrate symbol set returns zero matches in production code. |
| **DIM-5 verification** | Public contract changes: `AtomicAppender` constructor drops `backend?: 'jsonl' \| 'sqlite'` (breaking — internal); `EventStore` constructor drops `appenderBackend?: ...` (breaking — internal); `initializeBackend` return type narrows from `SqliteBackend \| undefined` to `SqliteBackend` (breaking — internal); `_testOnly_getSqliteBackend` renames to `getSqliteBackend` (productionize — §5); `workflow.set` action — removed (breaking — agent-facing, agent-self-correction via error envelope); legacy `capabilities[]` — removed (breaking — spec-author-facing, error envelope). Documented in CHANGELOG and surfaced via per-action `describe` updates. |
| **DIM-6 documentation** | CHANGELOG entry for v2.11 documents every breaking change with migration breadcrumb. Design doc (this file) and follow-up plan are the durable record. No AI-writing tells in CHANGELOG / migration notes — terse, concrete, no inflated symbolism. |
| **DIM-7 operational** | Backup/recovery story changes. Pre-rip: JSONL was human-readable forensic artifact. Post-rip: SQLite WAL only. Operators get `sqlite3 events.db ".dump"` and `exarchos view` as replacements; CHANGELOG documents both. Hard-cut upgrade path (DR-3) is explicitly operator-facing — the error message names the choice ("stay on v2.10 or wipe state"). |
| **DIM-8 security** | Unaffected. SQLite WAL has the same on-disk permissions surface as JSONL. No new credentials or auth boundaries. |

## Phased Execution Plan

Five phases, each a coherent set of TDD tasks landing as focused commits within one PR. The tree compiles and all CI gates pass at every phase boundary.

### Phase 1 — Sidecar removal (#1082)

The simplest deletion: sidecar mode existed only because PID-lock contention forced JSONL writers to a side-channel. SQLite WAL handles concurrent access natively — sidecar mode is dead by construction once SQLite is mandatory. Remove `enterSidecarMode`, `getSidecarPath`, sidecar synthetic-sequence generation, sidecar merge in `query()`, and all sidecar-mode test fixtures. Independent of the rest of the rip; lands first because it is the smallest reviewable unit. Closes #1082.

### Phase 2 — Atomic-appender collapse

Delete `appendLocked` (the ~250-LOC JSONL body). Drop `backend` constructor option. Inline `dispatchAppend` into `append` / `appendUnkeyed` / `appendComputed` — the branch becomes dead. Drop `.seq` file machinery, `rebuildCachesFromJsonl`, the JSONL idempotency cache. Drop `replicateBackend` and `writeOutbox` (dual-write artifacts). Rename `_testOnly_getSqliteBackend()` → `getSqliteBackend()` and re-route the production callsite in `store.getReadBackend()` through it (DR-4 §5). Resolves #1326 by construction (only path now records `idempotency_claims`).

### Phase 3 — Store collapse

Delete `queryMainJsonl`, the JSONL sidecar merge in `query()`, `readJsonlMaxSequence`, `readSidecarForQuery`. Delete the JSONL fallback in `listStreamsMatchingPrefix` (recently landed in #1323; gone here). Delete `getEventFilePath` / `getSeqFilePath`. Drop `appenderBackend` option. `getReadBackend()` collapses to "return the always-present SQLite backend". The Sentry blocker on #1323 (lazy `appenderBackend: 'sqlite'` read-before-write returning `[]`) disappears — there is no lazy path.

### Phase 4 — Init hardening + migration removal

`initializeBackend`: remove the JSONL-only graceful fallback. SQLite open failure becomes fatal. Delete `runJsonlToSqliteMigration`, `run-migration-if-needed`, `jsonl-importer`, `migration-lock` (DR-3). Closes #1322 §6 (T58 finding) — no JSONL writer means no `_substrate.events.jsonl` to re-import. Resolves #1328 by construction (the broken JSONL `batch_append` is deleted along with everything else JSONL-shaped).

### Phase 5 — DR-4 / DR-6 / DR-7 deprecation removals

Independent of the JSONL rip but theme-coherent (one-release-shim retirement at the v2.11 boundary). Three sub-tasks:
- **DR-4**: Delete `workflow.set({phase})` rerouting in `composite.ts:103-156`, the `exarchos_workflow.set` action registration in `registry.ts`, the T35 acceptance test, and the parity DR-11 block in `parity.test.ts`. The action now hard-errors at routing with `validActions: ['transition']`.
- **DR-6**: Delete `capabilities[]` validation/derivation branch in `agents/spec.ts`, the resolver legacy-array fallback in `capabilities/resolver.ts`, and audit `agents/*.yaml` for any remaining declarations (convert to `posture` if found). `posture` becomes the single authority.
- **DR-7**: `topology/loader.ts:88-102` — replace the warn-and-emit branch with a typed validation throw. Pruner becomes a pure typed-contract scorer (delete the single-signal heuristic fallback in `pruner/*`). The `phase.contract_missing` event type stays in `schemas.ts` as a no-longer-emitted-but-historically-registered type (or removed if the audit confirms zero historical consumers).

## Acceptance Criteria

- [ ] No `'jsonl' \| 'sqlite'` discriminator anywhere in production code (grep returns zero matches in `servers/exarchos-mcp/src/**/*.ts` excluding tests).
- [ ] No `getReadBackend()` short-circuit returning `undefined`; backend is always present at runtime.
- [ ] No `*.events.jsonl`, `*.outbox.json`, `*.seq`, `*.snapshot.json`, `*.hook-events.jsonl` files written or read by production code.
- [ ] `initializeBackend` either returns a `SqliteBackend` or throws.
- [ ] No sidecar-mode symbols remain (`enterSidecarMode`, `getSidecarPath`, sidecar-merge in `query()`).
- [ ] No `_testOnly_*` exports are referenced from production code paths.
- [ ] `workflow.set({phase})` returns a structured `unknown action` error directing to `transition`; T35 acceptance test deleted.
- [ ] Specs declaring legacy `capabilities[]` arrays fail validation with structured error; resolver has no array fallback.
- [ ] `loadTopology()` throws on any phase missing a `staleness` block; pruner has no single-signal fallback.
- [ ] Full test suite green on SQLite-only tree (`npm run test:run` and `cd servers/exarchos-mcp && npm run test:run`).
- [ ] Typecheck green (`npm run typecheck`).
- [ ] CHANGELOG documents every breaking-contract change with migration breadcrumb.
- [ ] Design-invariants and axiom dimensions sections of this design document referenced in PR description.

## Risk & Mitigation

| Risk | Mitigation |
|---|---|
| Test-coverage regression — JSONL-exclusive tests deleted without SQLite-equivalent coverage | Each phase task includes a test-audit step; property/race/acceptance tests preserved on SQLite path; post-rip full-suite run + manual coverage diff. |
| Hard-fail on SQLite driver unavailable surprises operators on machines without a build toolchain | Clear error message naming both drivers (`better-sqlite3` and `bun:sqlite`) and resolution paths; CHANGELOG migration note. |
| Hard-cut upgrade path strands v2.10 users with JSONL state directories | DR-3 explicitly accepts this for solo-dev install base; CHANGELOG names the choice; v2.10 release retained on the install URL. |
| Operational forensics regression — JSONL was human-readable | CHANGELOG documents `sqlite3 events.db ".dump"` and `exarchos view` as forensic replacements. |
| Phase 5 (DR-4/6/7) accidentally couples to JSONL-rip phases | Phase 5 lands last and touches different files (`composite.ts`, `registry.ts`, `agents/spec.ts`, `capabilities/resolver.ts`, `topology/loader.ts`); cross-file coupling is structural-only. |

## Out of Scope

- #1325 (manual `eventStore.append` sites bypass `buildValidatedEvent`) — adjacent topic, separate PR.
- #1324 (subprocess+bun:sqlite ESM scheme failures) — CI test infrastructure, separate PR.
- #1329, #1330 (TDD gate blast-radius, check_static_analysis worktree scope) — workflow-tooling bugs unrelated to substrate.
- v2.12 lifecycle verbs (#1316), event-store Marten lessons (#1312–#1315) — future milestone work.
- Centralized telemetry collector — out of v2.11 scope; the DR-2 bypass is documented and accepted.

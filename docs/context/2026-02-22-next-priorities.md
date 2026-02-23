# Next Priorities — Post-Hardening Batch

**Date:** 2026-02-22
**Previous batch:** Hardening, Persistence Validation, and Eval Framework Closure (PRs #772-#774)

## Completed State

- **Storage layer:** Fully validated — backend contract tests, WAL concurrency, crash recovery, schema migration, E2E round-trip, property-based tests. 91.7% coverage.
- **Eval framework:** Phase 3 complete — layer-aware CI gate, regression detection, eval-capture/eval-compare CLI, reliability suite (18 cases). Phase 4 (flywheel) not started.
- **Orphan events:** 5/7 activated (review.finding, review.escalated, quality.regression, quality.hint.generated promoted, team.disbanded guard enforced). 2 remaining: stack.restacked, team.context.injected.
- **Test coverage:** 2,309 tests, 91.65% statements, 96.61% functions.

## Recommended Priority Order

### P0: Stale `@planned` annotation cleanup (quick fix)

Three schemas still carry `@planned` despite having production emitters now: `ReviewFindingData`, `ReviewEscalatedData`, `QualityRegressionData`. Remove the annotations and add promotion tests (like the existing one for `quality.hint.generated`). 15-minute task.

### P1: Eval suite expansion (10+ skills have zero coverage)

Only 3 eval suites exist (delegation, quality-review, reliability). High-value gaps:

| Skill | Why | Effort |
|---|---|---|
| **shepherd** | Operationally complex, no eval suite, event types not in schemas.ts | Medium |
| **spec-review** | Critical gate, no regression coverage | Medium |
| **synthesis** | Merge queue interactions, PR description quality | Low |
| **debug** | Triage accuracy, root cause identification | Medium |

The eval framework is now closed (harness, graders, CI gate, regression detection, capture, compare all work). The bottleneck is dataset creation — use `eval-capture` to build datasets from production traces.

### P2: Shepherd event schema gap

The shepherd skill emits events (`shepherd.started`, `shepherd.iteration`, `shepherd.approval_requested`, `shepherd.completed`) that are not defined in `schemas.ts`. These go through the event store as untyped. Adding schemas enables querying and view materialization.

### P3: Productization Phase 0 — Foundation for user-facing CLI

Per `docs/adrs/productization-roadmap.md`, all phases are "Not started". Phase 0 prerequisites:

- Error taxonomy with recovery strategies
- State migration tooling (schema versioning already works, needs CLI)
- Config validation (Zod schemas for `.claude.json`, hooks config)
- Structured logging (replace console.log with leveled logger)
- Multi-tenant event fields (already designed in ADR, not implemented)

This unlocks Phase 1 (CLI binary: `exarchos init/status/quality`).

### P4: Distributed pipeline Phase 4 — Remote projection

The sync engine has plumbing (stream discovery, outbox drain) but uses a no-op sender. Phase 4 unlocks:

- Basileus HTTP client for real remote delivery
- Outbox sender with retry/backoff
- Task Router with score-based routing

Blocked on Basileus cloud backend availability.

### P5: Remaining orphan events

Low-priority, can bundle with other work:
- `stack.restacked` — wire in shepherd loop after `gt restack`
- `team.context.injected` — wire in delegation prompt composition

## Open Issues

| # | Title | Relevance |
|---|---|---|
| #775 | scope-assessment-complete guard bug | Active bug, should fix soon |
| #604 | Epic: Agentic Coder Dispatch | Phase 4-5 dependent |
| #599-603 | Epics: Distributed pipeline | Phase 4-5 dependent |
| #557-558 | Self-hosted review / label integration | Review system expansion |
| #528 | Semantic scoring (Cohere rerank) | Review triage enhancement |
| #348-353, #340 | Productization phases 1-5 | Long-term roadmap |

## Quick Wins

1. Remove 3 stale `@planned` annotations + add promotion tests
2. Add shepherd event schemas to `schemas.ts`
3. Fix #775 (scope-assessment-complete guard bug)
4. Clean up legacy `team.task.assigned` event handling in CQRS views

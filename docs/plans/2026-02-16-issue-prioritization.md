# Issue Prioritization: Optimal Implementation Order

**Date:** 2026-02-16
**Scope:** All 19 open issues in lvlup-sw/exarchos
**Method:** Dependency graph analysis + value/effort weighting

## Dependency Graph

```
#368 (cleanup events) ─────────────────────────── standalone
#341 (plan schema) ──┬── #342 (PBT enrichment)
                     └── #343 (PBT validation) ── standalone
#344 (benchmark gate) ── #345 (CodeQualityView) ─┐
#354 (eval framework) ────────────────────────────┴── #346 (flywheel)
#355 (CI quality gates) ──────────────────────────── standalone (partial)
#357 (telemetry loop) ────────────────────────────── standalone

#347 (Phase 0) ── #348 (Phase 1) ── #350 (Phase 2) ── #351 (Phase 3) ── #352 (Phase 4) ── #353 (Phase 5)
  └── includes #339 (verification infra parent)                            └── also needs #346

#340 (roadmap parent) ── tracking only
#339 (verification parent) ── tracking only
#8 (Renovate dashboard) ── automated
```

## Tier 1 — Immediate (no dependencies, high ROI)

These issues have zero blockers and deliver immediate value. Items 2-4 can be parallelized.

| Priority | Issue | Title | Effort | Rationale |
|----------|-------|-------|--------|-----------|
| 1 | [#368](https://github.com/lvlup-sw/exarchos/issues/368) | Clean up 16 unused event types | Low | Reduces schema surface before building on it. 7 dead types + dead view branches — pure cleanup that de-risks all downstream event store work |
| 2 | [#341](https://github.com/lvlup-sw/exarchos/issues/341) | Add `testingStrategy` field to plan task schema | Low | Unlocks #342 and #343. Small Zod schema addition to the plan task interface |
| 3 | [#344](https://github.com/lvlup-sw/exarchos/issues/344) | Benchmark regression detection gate | Medium | Unlocks #345 (CodeQualityView). Delivers baselines.json, validation script, `BenchmarkCompleted` event type, and CI gate |
| 4 | [#343](https://github.com/lvlup-sw/exarchos/issues/343) | `check-property-tests.sh` validation script | Low | Standalone script following existing conventions. No downstream blockers but completes the PBT validation chain |
| 5 | [#355](https://github.com/lvlup-sw/exarchos/issues/355) | CI quality gates — CodeRabbit gate only | Medium | Design is complete, scripts partially built (current branch `review-gate/commenting`). Automates the manual synthesis review cycle that currently requires orchestrator intervention |

**Parallelization opportunity:** After #368 completes, dispatch #341 + #344 + #343 simultaneously — they share no dependencies.

## Tier 2 — Depends on Tier 1

These unlock higher-order capabilities once their Tier 1 prerequisites are done.

| Priority | Issue | Title | Effort | Blocked by |
|----------|-------|-------|--------|------------|
| 6 | [#342](https://github.com/lvlup-sw/exarchos/issues/342) | Enrich delegation spawn prompts with PBT patterns | Low | #341 (needs `testingStrategy` field to conditionally inject PBT section) |
| 7 | [#345](https://github.com/lvlup-sw/exarchos/issues/345) | CodeQualityView CQRS projection | Medium | #344 (`BenchmarkCompleted` event type must exist in schema) |
| 8 | [#357](https://github.com/lvlup-sw/exarchos/issues/357) | Close the telemetry feedback loop | Low-Med | No strict blocker, but Tier 2 value — activates dormant telemetry infra. Start with Tier 2 (hook-injected hints) per issue recommendation |

**Parallelization opportunity:** #342 and #345 are on different dependency chains and can proceed concurrently. #357 is fully independent.

## Tier 3 — Significant New Infrastructure

These require substantial new systems and build on Tier 1-2 foundations.

| Priority | Issue | Title | Effort | Blocked by |
|----------|-------|-------|--------|------------|
| 9 | [#354](https://github.com/lvlup-sw/exarchos/issues/354) | SDLC eval framework (Phase 1-2) | High | No strict blocker, but logically follows Tier 1-2 event cleanup. Hard dependency of #346 |
| 10 | [#346](https://github.com/lvlup-sw/exarchos/issues/346) | Verification flywheel with eval integration | High | #345 (CodeQualityView) + #354 Phase 2 (eval infrastructure) |
| 11 | [#347](https://github.com/lvlup-sw/exarchos/issues/347) | Foundation hardening (Phase 0) | Medium | Includes completing #339 (all verification infra children). Also: error taxonomy, state migration, config validation, structured logging |

**Note:** #354 Phase 1 (foundation) can start as early as Tier 2, running in parallel with #345 and #342. However, full completion requires Tier 1-2 to be stable.

## Tier 4 — Productization Pipeline (strictly sequential)

Each phase depends on the prior phase. No parallelization within this chain.

| Priority | Issue | Title | Effort | Blocked by |
|----------|-------|-------|--------|------------|
| 12 | [#348](https://github.com/lvlup-sw/exarchos/issues/348) | CLI and documentation (Phase 1) | Medium | #347 — foundation must be stable before user-facing surface |
| 13 | [#350](https://github.com/lvlup-sw/exarchos/issues/350) | Extension architecture (Phase 2) | High | #348 — CLI must exist before extension management commands |
| 14 | [#351](https://github.com/lvlup-sw/exarchos/issues/351) | AI client abstraction (Phase 3) | High | #350 — extension architecture provides the plugin model for adapters |
| 15 | [#352](https://github.com/lvlup-sw/exarchos/issues/352) | Remote backend integration (Phase 4) | Very High | #351 — AI client abstraction enables non-Claude remote agents |
| 16 | [#353](https://github.com/lvlup-sw/exarchos/issues/353) | Flywheel and team features (Phase 5) | Very High | #352 + #346 — remote infra + local flywheel both required |

## Tracking Issues (no implementation)

These are parent/tracking issues that are resolved when their children complete.

| Issue | Title | Tracks |
|-------|-------|--------|
| [#340](https://github.com/lvlup-sw/exarchos/issues/340) | Productization roadmap | Phases 0-5 (#347, #348, #350, #351, #352, #353) |
| [#339](https://github.com/lvlup-sw/exarchos/issues/339) | Verification infrastructure | Components 1-6 (#341, #342, #343, #344, #345, #346) |
| [#8](https://github.com/lvlup-sw/exarchos/issues/8) | Dependency Dashboard | Renovate-managed, automated |

## Critical Path

The longest dependency chain determines the project timeline:

```
#368 → #344 → #345 → #346 ← #354
                        ↓
                      #347 → #348 → #350 → #351 → #352 → #353
```

**#345 (CodeQualityView)** is the critical junction — it gates both the verification flywheel (#346) and, transitively, the entire productization pipeline. Prioritize unblocking it early.

## Recommended Starting Sequence

1. **Now:** Start #368 (event cleanup) — cleans the schema foundation
2. **After #368:** Parallel dispatch of #341, #344, #343 (all Tier 1, independent)
3. **Concurrent with Tier 1:** Continue #355 CodeRabbit gate (already in progress on current branch)
4. **As Tier 1 completes:** Pick up #342, #345, #357 (Tier 2) based on which blockers clear first
5. **Mid-term:** #354 Phase 1 can overlap with late Tier 2 work
6. **Gate:** #347 (Phase 0) is the checkpoint — all verification infra must be done before productization begins

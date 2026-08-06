# Debloat wave-1 — post-deletion differential baseline (DR-1, DR-8)

Task 005 of the debloat wave-1 feature. Records the reachability-graph state **after** the
001–004 hard-dead deletions (18 modules) and the 014 RESERVED-header stamping (6 stubs), and
disposes **every** remaining dead-in-prod module against the DR-1 bar.

Detector: `scripts/audit/refgraph.mjs` (inbound-reference / reachability targeting, type-import
aware, entry-point aware). "dead-in-prod" = 0 production importers, non-entry.

- **BEFORE** tree: `origin/main` @ `3f5cae66` (pre-001-004).
- **AFTER** tree: integration base @ `0b0613a6` (`integration/debloat-wave1`; has the 18 deletions + 6 RESERVED headers + vendored `scripts/audit/`).
- Scope of detector run: `servers/exarchos-mcp/src`.

## 1. Before / after refgraph counts

| Metric | BEFORE (`3f5cae66`) | AFTER (`0b0613a6`) | Δ |
| --- | ---: | ---: | ---: |
| Prod modules | 467 | 449 | **−18** |
| Dead-in-prod (files) | 37 | 21 | **−16** |
| Dead-in-prod (lines) | 3,895 | 2,227 | **−1,668** |
| …of which dead-but-tested (files) | 34 | 19 | −15 |
| …of which dead-but-tested (code lines) | 3,716 | 2,082 | −1,634 |
| Total prod-module lines | 126,801 | 125,059 | **−1,742** |

Note: total prod-module lines fell by 1,742 = 1,757 (18 deleted prod modules) − 15 (task-014
RESERVED-header comment lines added to the 6 stubs).

## 2. Measured line-count delta of the 001–004 deletions (for the PR body)

`git diff --diff-filter=D --numstat 3f5cae66 0b0613a6 -- servers/exarchos-mcp/src` (deleted `.ts` files only):

| Bucket | Files | Lines removed |
| --- | ---: | ---: |
| Prod modules (the DR-1 eighteen) | 18 | 1,757 |
| Co-located tests / fixtures | 20 | 2,917 |
| **Total** | **38** | **4,674** |

The 18 deleted prod modules: `sync/{conflict,sync-state,config}`, `cli-commands/{checkpoint,run-mutation,run-contract}`,
`session/lifecycle`, `review/{comment-parser,merge-gate}`, `views/{unified-task-view,output-cap}`,
`errors`, `benchmarks/emit-results`, `quality/regression-eval-generator`,
`orchestrate/{detect-test-commands,tools-config}`, `mcp/tools-call-handler`, `telemetry/benchmarks/helpers`.

**Confirmed:** none of the 18 deleted modules appears in the AFTER dead-in-prod list (they are gone,
not merely re-flagged). Verified module-by-module.

## 3. Full disposition table — every AFTER dead-in-prod module (21)

Buckets: **RESERVED** (6 headered stubs, keep) · **CLASS-ALLOWLIST** (test-infra / build-shim /
type-test / test-invoked lint gate, keep) · **CASCADE-ORPHAN → DELETE** (evidenced hard-dead
survivor) · **ESCALATE** (needs its own task; not deleted).

| # | Module | Lines | testIn | Disposition | Evidence / reason |
| --- | --- | ---: | ---: | --- | --- |
| 1 | `mcp/tasks-methods.ts` | 206 | 3 | RESERVED | `RESERVED(#1273 … expires 2027-01-31)` header (task 014). |
| 2 | `orchestrate/vcs/push-with-lease.ts` | 196 | 1 | RESERVED | `RESERVED(#1596 … expires 2027-01-31)` header. |
| 3 | `runtime/command-shim-emitter.ts` | 195 | 1 | RESERVED | `RESERVED(#1590 …; see also #1609)` header. |
| 4 | `projections/diff-states.ts` | 162 | 2 | RESERVED | `RESERVED(#1475 … expires 2027-01-31)` header. |
| 5 | `workflow/depth-proposal.ts` | 131 | 1 | RESERVED | `RESERVED(#1581 … expires 2027-01-31)` header. |
| 6 | `projections/bisect.ts` | 123 | 1 | RESERVED | `RESERVED(#1555 … expires 2027-01-31)` header. |
| 7 | `core/dispatch.economy-seam.ts` | 239 | 1 | CLASS-ALLOWLIST | Test-invoked source-lint enforcement gate (INV-17 Axis-2). Exports `lintDispatchEconomyBypass` / `lintMiddlewareEconomySeam` / `lintEconomySeam`, run by its pin test against `dispatch.ts` / `middleware.ts` source. Not meant for prod import. |
| 8 | `architecture/contract-seam.ts` | 66 | 1 | CLASS-ALLOWLIST | Test-invoked source-lint gate (DR-10). Exports `lintSeamComments`; the sole `invariant-schema.ts` mention is a comment, not an import. |
| 9 | `projections/gwt.ts` | 117 | 1 | CLASS-ALLOWLIST | Given-When-Then test-harness DSL for projection reducers (T044, DR-10). Pure test infra. |
| 10 | `benchmarks/event-factories.ts` | 133 | 2 | CLASS-ALLOWLIST | Benchmark test-data factory (gate/skill event fixtures). Only test importers; benchmark tests still run. |
| 11 | `telemetry/benchmarks/cold-start.ts` | 111 | 2 | CLASS-ALLOWLIST | Benchmark test-data generator (N realistic workflow events). Only test importers; tests run. |
| 12 | `launcher/harness-registry.type-test.ts` | 105 | 0 | CLASS-ALLOWLIST | `*.type-test.ts` compile-time assertion entrypoint (DR-4). Deliberately named to dodge the tsconfig `*.test.ts` exclude so `tsc` gates on it. |
| 13 | `workflow/test-helpers/canonical-envelope.ts` | 68 | 4 | CLASS-ALLOWLIST | Test helper under `test-helpers/`; imported by 4 envelope tests. |
| 14 | `test-helpers/temp-dir.ts` | 50 | 205 | CLASS-ALLOWLIST | Test helper; 205 test importers. |
| 15 | `event-store/decide-fixtures.ts` | 45 | 4 | CLASS-ALLOWLIST | Test fixtures; imported by 4 event-store tests. |
| 16 | `storage/__shims__/bun-sqlite-node.ts` | 40 | 0 | CLASS-ALLOWLIST | Node/vitest runtime shim aliasing `bun:sqlite` → `better-sqlite3` under test. Build-shim class. |
| 17 | `review/findings.ts` | 66 | 1 | **ESCALATE** | **CASCADE-ORPHANED** — sole prod importer was `review/comment-parser.ts` (one of the 18 deleted). BUT emits schema-registered domain events (`review.finding` / `review.escalated`); named as "the existing utility" to wire by two active design/plan docs; auto-emission audit (2026-05-24) calls it *dormant*, not removed. Not unambiguously dead → likely wants a RESERVED header, not deletion. See §4. |
| 18 | `benchmarks/baselines-schema.ts` | 26 | 1 | **ESCALATE** | **CASCADE-ORPHANED** — sole prod importer was `benchmarks/emit-results.ts` (deleted), and it was **type-only** (`import type BaselineEntryType`). Zod validation schema (public-ish surface). Type-only-consumer + public-ish-API are explicit escalate triggers; its co-located test still runs. Belongs to a benchmark-subsystem-scope decision. See §4. |
| 19 | `adapters/remote-mcp.ts` | 49 | 1 | **ESCALATE** | **PRE-EXISTING dead** (dead in BEFORE; not a wave cascade). Intentional future-use interface skeleton for remote-MCP (issue #1081), throwing default impl, "intentionally NOT wired." Functionally a RESERVED stub but lacks the formal `RESERVED(...)` header task-013's gate honors. Recommend header retrofit, not deletion. See §4. |
| 20 | `runbooks/compute.ts` | 24 | 1 | **ESCALATE** | **PRE-EXISTING dead.** Prod-shaped pure util `computeRunbookAutoEmits`; only caller is `runbooks/drift.test.ts`. Either orphaned-and-removable or a wiring gap (should feed runbook validation). Needs own triage. See §4. |
| 21 | `event-store/hook-event-writer.ts` | 75 | 2 | **ESCALATE** | **PRE-EXISTING dead.** Exports `writeHookEvent`; header claims "Used by CLI hook subprocesses (observer hooks)" but **no prod invoker exists anywhere in the repo** — only tests reference it. Either dead or a wiring gap in the hook-event sidecar path. Needs judgment. See §4. |

### Tally

| Disposition | Count |
| --- | ---: |
| RESERVED | 6 |
| CLASS-ALLOWLIST | 10 |
| CASCADE-ORPHAN → DELETED | **0** |
| ESCALATE | 5 |
| **Total** | **21** |

**Zero cascade-orphan deletions.** Both genuine cascade candidates (`review/findings.ts`,
`benchmarks/baselines-schema.ts`) carry ambiguity signals (documented future-adoption intent;
type-only sole consumer / public-ish schema) that exceed the DR-1 "unambiguously dead" bar → escalated,
not deleted, per the task's "when in doubt, ESCALATE" rule. The AFTER dead-in-prod set is therefore
exactly RESERVED (6) ∪ CLASS-ALLOWLIST (10) ∪ Escalations (5); nothing was removed by this task.

## 4. Escalations — each becomes its own decomposition task

### E1 · `review/findings.ts` (cascade-orphaned, 66 lines + `findings.test.ts`)
Sole prod importer was `review/comment-parser.ts` (deleted in 001–004). Now only its co-located
test imports it. **Do not delete blindly:** it emits the schema-registered domain events
`review.finding` and `review.escalated`, and is named as "the existing utility" to wire up by two
still-open design/plan docs — `docs/designs/2026-02-22-hardening-validation-eval-closure.md`
("Feed parsed findings into the existing `emitReviewFindings()` utility … call `emitReviewEscalated()`")
and `docs/designs/2026-02-24-session-provenance-capture.md` (lists both events as PARTIAL). The
2026-05-24 auto-emission audit classes these events as **dormant**, not deleted. Decision needed:
retrofit a `RESERVED(...)` header (consistent with the 6 wave stubs) **or** delete along with the
two design/plan references. Recommend RESERVED-header retrofit.

### E2 · `benchmarks/baselines-schema.ts` (cascade-orphaned, 26 lines + co-located test)
Sole prod importer was `benchmarks/emit-results.ts` (deleted), via a **type-only** import. It is a
Zod validation schema (`BaselineEntry` / `BaselinesFile`) — a public-ish contract surface. Its
co-located test still runs. Its whole reason-for-being (validating the benchmark-emit pipeline) was
removed with `emit-results.ts`; siblings `benchmarks/event-factories.ts` and
`telemetry/benchmarks/cold-start.ts` are the same dormant cluster (kept here as CLASS-ALLOWLIST
because their tests run). Decision needed at **benchmark-subsystem scope**: tear down the dormant
baseline/emit cluster as a unit, or keep the schema as a reserved contract. Not a clean single-file
cascade delete.

### E3 · `adapters/remote-mcp.ts` (pre-existing dead, 49 lines)
DR-6 `RemoteMcpAdapter` interface skeleton + throwing default impl; header says "intentionally NOT
wired … future-use placeholder", tracked at issue #1081. This is a RESERVED stub in all but the
formal header — it lacks the `RESERVED(...)` marker task-013's module-intent gate will honor.
Decision needed: retrofit the header (recommended) or delete. Not caused by this wave.

### E4 · `runbooks/compute.ts` (pre-existing dead, 24 lines)
`computeRunbookAutoEmits(runbook)` — a prod-shaped pure util with only a test caller
(`runbooks/drift.test.ts`). Either an orphaned util to remove, or a wiring gap (it looks like it
should feed runbook auto-emit validation/registration). Needs own triage. Not caused by this wave.

### E5 · `event-store/hook-event-writer.ts` (pre-existing dead, 75 lines)
Exports `writeHookEvent`; header documents it as live CLI-hook-subprocess infra (observer hooks,
sidecar path picked up by `storage/sidecar-merger.ts`). Repo-wide search finds **no production
invoker** — only test files reference `writeHookEvent`. Either genuinely dead or a real wiring gap
in the hook-event sidecar write-path. Needs judgment before any removal. Not caused by this wave.

## 5. Verification

- Root typecheck (`npm run typecheck`) — clean.
- Server typecheck (`cd servers/exarchos-mcp && npm run typecheck`) — clean.
- Server suite (`cd servers/exarchos-mcp && npm run test:run`) — 699 files passed / 5 skipped, 8958 tests passed / 25 skipped, 0 failing. This task makes **no code/test change** (doc-only + zero deletions), so baseline == post by construction.
- Re-run refgraph: unchanged (0 deletions). AFTER dead-in-prod (21) = RESERVED (6) ∪ CLASS-ALLOWLIST (10) ∪ Escalations (5); no module is CASCADE-ORPHAN-DELETED.

## 6. Escalation outcomes (2026-07-17, #1713 disposition)

The five §4 escalations were disposed under issue #1713:

- **E1 `review/findings.ts` — DELETED** (with `findings.test.ts`). The `review.finding` / `review.escalated` schema registrations and projection consumers stay (schema is contract, not emitter); the events are now emitter-less pending the wiring the two archived design docs describe.
- **E2 `benchmarks/baselines-schema.ts` — KEPT**, RESERVED re-pointed to the benchmark-validation epic #1677 (same 2026-10-31 expiry). Not moved into the `benchmark-harness` allowlist class — that class excludes `*-schema.ts` contract surfaces by design.
- **E3 `adapters/remote-mcp.ts` — KEPT**, RESERVED header now cites #1081 (DR-6 remote-MCP design) only; the interim #1713 tracking tail was removed. Same 2026-10-31 expiry.
- **E4 `runbooks/compute.ts` — DELETED**; its two callers in `runbooks/drift.test.ts` (the compute-vs-declared autoEmits cross-checks) were removed with it. The registry-side drift check `RunbookDrift_AutoEmitsMatchEventEmissionRegistry` remains.
- **E5 `event-store/hook-event-writer.ts` — DELETED** (with its test). `storage/sidecar-merger.test.ts` now writes raw sidecar JSONL via a local helper (same pattern `sidecar-scheduler.test.ts` already used), so the merger's coverage of the sidecar wire format is unchanged.

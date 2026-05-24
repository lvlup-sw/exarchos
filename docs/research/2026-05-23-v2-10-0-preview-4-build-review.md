# v2.10.0-preview.4 Build Review — Comprehensive

**Feature ID:** `preview-4-build-review`
**Date:** 2026-05-23
**Scope:** All work landed under the v2.10.0-preview.4 umbrella — the original Wave A/B/C/D feature-freeze bundle (PRs #1405–#1435) plus the entire epic [#1441](https://github.com/lvlup-sw/exarchos/issues/1441) post-bundle polish + correctness debt + the in-bundle invariants-v2 bonus axis (#1458/#1459).
**Source-of-truth issue:** [#1441](https://github.com/lvlup-sw/exarchos/issues/1441) (CLOSED 2026-05-24)
**Related milestone:** [v2.10.0 — Agent Output Contract](https://github.com/lvlup-sw/exarchos/milestone/16)

---

## TL;DR

Preview.4 is **functionally complete on main** — every wave from the original feature-freeze design landed, and the epic-#1441 follow-up debt (3 HIGH TaskStore findings, correlation contract end-to-end, elicitation E2E + a wired-but-not-invoked bug it surfaced, substrate hygiene, invariants audit pair, invariants v2 catalog rewrite) is fully closed across 11 follow-up PRs.

But the release engineering is **not done**. Two concrete drift items:

1. **No `[2.10.0-preview.4]` CHANGELOG section exists.** The CHANGELOG's top entry is dated `[2.10.0-preview.3] - 2026-05-16` but its content actually documents post-bundle correlation work from PRs #1447 / #1449 (which merged 2026-05-17). The preview.4 substrate bundle itself (Waves A/B/C/D, 11 issues) has no narrative changelog entry anywhere.
2. **`package.json` is still pinned to `2.10.0-preview.3`** in both root and `servers/exarchos-mcp/`. The intended bump PR ([#1420](https://github.com/lvlup-sw/exarchos/pull/1420)) shows MERGED in GitHub but its merge commit (`bd7c05f8`) is **not reachable from `origin/main`** — a stacked-PR `--auto --squash` collapse hazard that's already codified in project memory (`feedback_stacked_pr_auto_merge_collapses_granularity`).

The bundle is **merged but not released.** Closing the release engineering gap is the only remaining preview.4 work; everything else is forward motion into v2.10.0-RC1 / v2.11.0.

---

## 1. What "preview.4" actually contains

Three workstreams landed under this umbrella between 2026-05-16 and 2026-05-24, in this order:

| Workstream | Window | PRs | Theme |
|---|---|---|---|
| **A. Feature-freeze bundle** | 2026-05-16 | 11 substrate PRs + cascades (#1405–#1435) | Final v2.10.0 feature surface — Wave A output contract + Wave B correlation + Wave C Tasks dispatch-core + Wave D authoring substrate |
| **B. Epic-#1441 polish + correctness** | 2026-05-17 → 2026-05-18 | #1443, #1444, #1445, #1447, #1449, #1450, #1452, #1455, #1457 | Three HIGH TaskStore findings, correlation contract end-to-end, elicitation E2E + in-bundle Zod-v4 fix, substrate hygiene, invariants audit pair |
| **C. Invariants v2 bonus** | 2026-05-24 | #1458 (discover) + #1459 (impl) | Dev-invariants catalog rewrite (schema v1→v2, gating, 27 entries, INV-7..15) — emerged from #1370 + #1439 closure work, wasn't in original epic scope |

The substrate bundle is the user-visible feature increment. The epic-#1441 polish closes the audit debt that was deliberately deferred to keep preview.4 from blocking on long-tail polish. The invariants v2 work closes the catalog axis that the audit pair (#1370 + #1439) surfaced.

---

## 2. Workstream A — Feature-freeze bundle (substrate)

The reference design [`docs/designs/2026-05-15-v2-10-0-preview-4-feature-freeze.md`](../designs/2026-05-15-v2-10-0-preview-4-feature-freeze.md) clusters 11 issues into 4 waves. All 11 closed; every wave landed on main.

### Wave A — Output contract completion

| Issue | PR | Surface |
|---|---|---|
| [#1238](https://github.com/lvlup-sw/exarchos/issues/1238) | [#1421](https://github.com/lvlup-sw/exarchos/pull/1421) | `next_actions` Zod discriminated unions + fail-closed `safeParse` (no more `Record<string, unknown>` casts in `next-actions-from-result.ts`) |
| [#1262](https://github.com/lvlup-sw/exarchos/issues/1262) | [#1409](https://github.com/lvlup-sw/exarchos/pull/1409) | `output_tokens_high` quality hint via `next_actions` on edge-triggered threshold crossing; threshold reads through `CapabilityResolver` |
| [#1290](https://github.com/lvlup-sw/exarchos/issues/1290) | [#1410](https://github.com/lvlup-sw/exarchos/pull/1410) | Roots-based workspace discovery — capability-gated `featureId` inference; `workspace.resolved {source: 'roots' \| 'cwd'}` events; per-handshake cache invalidated on `roots/list_changed` |
| [#1274](https://github.com/lvlup-sw/exarchos/issues/1274) | [#1424](https://github.com/lvlup-sw/exarchos/pull/1424) | Elicitation form mode for `INVALID_INPUT` — `inputSchema.pick({field: true})` derives the elicitation sub-schema (no drift between validation + elicitation contracts); emits `elicitation.requested` + `elicitation.fulfilled` with `operationId` |

### Wave B — Correlation + event topology

| Issue | PR | Surface |
|---|---|---|
| [#1291](https://github.com/lvlup-sw/exarchos/issues/1291) | [#1428](https://github.com/lvlup-sw/exarchos/pull/1428) | Three-field dispatch-boundary correlation (`operationId` / `correlationId` / `causationId`) threaded via `AsyncLocalStorage`; envelope `_meta` carries all three. **Substantive deferral noted in bundle audit:** SQL columns + telemetry-view filters did NOT land in #1428 — tracked under #1414/#1437 and closed by post-bundle PR #1447 |
| [#1261](https://github.com/lvlup-sw/exarchos/issues/1261) | #1416 (collapsed into #1428's squash) | `dispatch.preflight` per-guard + `stash.detected` events with three-field correlation |
| [#1272](https://github.com/lvlup-sw/exarchos/issues/1272) | #1415 (collapsed into #1428's squash) | `EventSourcedTaskStore` — TaskStore as projection over `task.*` events (no `InMemoryTaskStore` in production); per-task TTL; INV-1 satisfied |

### Wave C — Tasks (SEP-1686) dispatch-core (#1273)

The bundle's most operationally messy slice. C1 / C2 / C3 split per design, but the merge chain went sideways:

| Sub | PR | Surface |
|---|---|---|
| C1 | (no own attributed merge — content rode in under C3's squash; see bundle audit §Wave C) | Tasks-augmented dispatch-core branch — returns `CreateTaskResult` instead of `Envelope<T>`; lifecycle in `EventSourcedTaskStore`; emits `task.created/polled/result/cancelled` |
| C2 | [#1432](https://github.com/lvlup-sw/exarchos/pull/1432) | MCP `tasks/*` methods + `taskSupport` capability handshake |
| C3 | [#1433](https://github.com/lvlup-sw/exarchos/pull/1433) | CLI `--follow` polling loop for tasks dispatch-core |
| C1-fix | [#1435](https://github.com/lvlup-sw/exarchos/pull/1435) | CodeRabbit MAJOR follow-ups — `pollInterval` validity + `task.polled.sequence` deprecation. (Created post-hoc to replay the CodeRabbit-final delta because #1431 went structurally stale and #1432 squash-merged a pre-fix snapshot.) |

### Wave D — Authoring substrate

| Issue | PR | Surface |
|---|---|---|
| [#1260](https://github.com/lvlup-sw/exarchos/issues/1260) | [#1425](https://github.com/lvlup-sw/exarchos/pull/1425) | Machine-readable invariants catalog (`docs/architecture/invariants.md` as YAML-fronted SoT) + vocabulary lint + `/ideate` first-turn surfacing. **This is the v1 catalog**; v2 ships under #1459 (Workstream C). |
| [#1298](https://github.com/lvlup-sw/exarchos/issues/1298) | [#1426](https://github.com/lvlup-sw/exarchos/pull/1426) | Designs/plans machine-readable sidecar (`.sidecar.yml`) + 4 functional fixes. CodeRabbit caught a near-miss: sidecar lookup originally returned `foo.md.sidecar.yml` instead of `foo.sidecar.yml`, which would have made the entire #1298 gate path silently dead. |
| [#1244](https://github.com/lvlup-sw/exarchos/issues/1244) | [#1427](https://github.com/lvlup-sw/exarchos/pull/1427) | Markdown-aware handoff lint at `handleCheckpoint` (DIM-8). Design deviation: plan prescribed `_eventHints` payload but `EventHintsPayload` is strictly typed; PR shipped `result.warnings` + `data.handoffLintFindings` — functionally equivalent. |

### Wave A/B/C/D — stacked-PR artifacts

Four of the eleven issues never produced their own squash commit on main (#1262/PR1422, #1290/PR1423, #1261/PR1429, #1272/PR1430) — their content arrived via their parent's squash, and git blame attributes them to the wrong PR number. Documented in bundle-audit §1.1; the codification of this hazard is in project memory `feedback_stacked_pr_auto_merge_collapses_granularity`.

---

## 3. Workstream B — Epic #1441 polish + correctness

The post-bundle audit (`docs/research/2026-05-16-v2-10-0-preview-4-bundle-audit.md` + `docs/research/2026-05-16-event-sourced-task-store-audit.md`) surfaced 8 net-new findings plus 3 pre-existing issues sharing the same "preview.4 substrate landed, post-release follow-up needed" framing. Rather than block preview.4 release on the long tail, the bundle shipped as-is and the polish was tracked under epic [#1441](https://github.com/lvlup-sw/exarchos/issues/1441).

10/10 substrate-axis sub-issues closed; no deferrals to v2.11.0 on the substrate axis. Two items (Op 3 = workflow-verb wiring through Tasks-augmented dispatch, Op 5 = SSE) were explicitly slipped to v2.12.0 (Process Lifecycle Verbs) under [#1453](https://github.com/lvlup-sw/exarchos/issues/1453) and [#1454](https://github.com/lvlup-sw/exarchos/issues/1454).

### HIGH-severity (TaskStore correctness debt — landed 2026-05-17)

| Finding | PR | Fix |
|---|---|---|
| FINDING-3 (write amplification at 250ms CLI poll cadence) | [#1443](https://github.com/lvlup-sw/exarchos/pull/1443) | `task.polled` emit throttle; unblocks #1440 adoption-expansion without regression |
| FINDING-1 (no OCC on writes — multi-writer correctness gap at INV-3 scale) | [#1445](https://github.com/lvlup-sw/exarchos/pull/1445) | Threads `expectedSequence` through `storeTaskResult` / `updateTaskStatus`; closes the Marten C-2 `fetchForWriting` analog |
| FINDING-2 (cache hits skip stream validation — cross-process staleness) | [#1444](https://github.com/lvlup-sw/exarchos/pull/1444) | Validates cache against stream tail; absorbed 5 CodeRabbit hardening commits (`lastReadSequence` stamping, `expiresAt` derivation, `statusMessage` hygiene in writer mutate closures + projection folds, `completed`/`failed` guard in `updateTaskStatus`) |

### MEDIUM — Correlation contract end-to-end

| Issue | PR | Surface |
|---|---|---|
| [#1437](https://github.com/lvlup-sw/exarchos/issues/1437) + [#1414](https://github.com/lvlup-sw/exarchos/issues/1414) | [#1447](https://github.com/lvlup-sw/exarchos/pull/1447) | **Closes the #1291 acceptance gap.** Schema V5→V6 — `operation_id` / `correlation_id` / `causation_id` indexed columns on `events`; chunked transactional backfill via `migrateV5ToV6` (emits `migration.correlation_backfill_progress`); `QueryFilters` accepts the three fields; six telemetry view actions wired (`telemetry`, `delegation_timeline`, `code_quality`, `quality_correlation`, `quality_attribution`, `eval_results`); `materializeFiltered` cache-bypass helper. F1/F2 regression tests went GREEN on first run, confirming inline-fix hypothesis from #1428's post-merge hardening. |
| [#1448](https://github.com/lvlup-sw/exarchos/issues/1448) items 2–5 | [#1449](https://github.com/lvlup-sw/exarchos/pull/1449) | Consumer-side correlation wiring — `deriveCorrelationFilters` with AsyncLocalStorage default (active dispatch's `correlationId` as fallback); CLI flags `--operation-id` / `--correlation-id` / `--causation-id` on all six telemetry subcommands (auto-generated from each action's Zod schema via `addFlagsFromSchema`); `bypasses` + `correlationFilteredQueries` observability counters; `docs/runbooks/correlation-filters.md`. |

### MEDIUM — Substrate hygiene + view validator

| Sub-finding | PR | Surface |
|---|---|---|
| [#1438](https://github.com/lvlup-sw/exarchos/issues/1438) FINDING-4..8 (operational hygiene) + [#1434](https://github.com/lvlup-sw/exarchos/issues/1434) + [#1446](https://github.com/lvlup-sw/exarchos/issues/1446) + [#1448](https://github.com/lvlup-sw/exarchos/issues/1448) item 1 | [#1450](https://github.com/lvlup-sw/exarchos/pull/1450) | Two-wave bundle: **Views layer** — register `session_provenance` / `provenance` / `ideate_readiness` in `TOOL_REGISTRY`; internal-sentinel skip on `streamId.startsWith('__')` (closes `__migration__` crash on `exarchos_view pipeline`). **Task-store layer** — size-cap reap on `createTask`, `logger.warn` on `request` coerce site, persist `requestId` on `task.created`, F-5+F-6 co-designed Cursor + Hydration subsystem (stable pagination + bounded hydration). |

### MEDIUM — Substrate realization

| Issue | PR | Surface |
|---|---|---|
| [#1436](https://github.com/lvlup-sw/exarchos/issues/1436) (verification gap) + [#1451](https://github.com/lvlup-sw/exarchos/issues/1451) (in-bundle finding) + [#1440](https://github.com/lvlup-sw/exarchos/issues/1440) Op 1/2/4 | [#1452](https://github.com/lvlup-sw/exarchos/pull/1452) | **#1436:** elicitation form-mode E2E smoketest via in-process MCP client+server fixture (`InMemoryTransport`) — three paths (accept/decline/capability-absent), each asserting envelope outcome AND event-store emissions on per-operation stream. **#1451 (caught by #1436):** `extractSingleMissingRequiredField` was over-strict (`received !== 'undefined'` only) and didn't match Zod v4's actual issue shape — every elicitation candidate was rejected; substrate was wired-but-not-invoked in production despite #1424 shipping. Fixed in-bundle. **#1440 Op 1:** `--follow` expansion to `pipeline` / `convergence` / `delegation_timeline`. **Op 2:** `DispatchHints` annotation on `ToolAction` + `describe` projection — four actions annotated with `taskSuitable`/`taskTtlSuggestionMs` (`merge_orchestrate`, `request_synthesize`, `cleanup`, `rehydrate`). **Op 4:** `retry_with_task` next-actions hint at dispatch boundary when one-shot crosses 10s and action is task-suitable. |

### MEDIUM — Invariants audit pair

| Issue | PR | Surface |
|---|---|---|
| [#1439](https://github.com/lvlup-sw/exarchos/issues/1439) | [#1455](https://github.com/lvlup-sw/exarchos/pull/1455) | Invariant content audit — 18 entries audited: 11 keep / 5 sharpen / 2 downgrade / 0 delete. Cost-of-load split: 4 always-load / 12 reference-only / 2 archivable. Three dimension renames to axiom canonical (`vestigial-code → hygiene`, `error-handling → resilience`, `ai-prose-tells → prose-quality`). Currency fixes. Loader gains `loadInvariants(path, { scope: 'core' \| 'all' })` with loud-throw on unknown scope. |
| [#1370](https://github.com/lvlup-sw/exarchos/issues/1370) | [#1457](https://github.com/lvlup-sw/exarchos/pull/1457) | Phase-transition `/design-invariants` audit — 31 findings across 18 commands (6 HIGH, 13 MEDIUM, 12 LOW). Two systemic patterns surfaced: (1) phase-update bug in 5 commands using rejected `update {phase}` instead of canonical `transition`; (2) auto-chain by literal `Skill({...})` instead of consuming `next_actions`. PR closed the 6 HIGH; MEDIUM/LOW spun out to [#1456](https://github.com/lvlup-sw/exarchos/issues/1456) (status:backlog, v2.11.0). Adds `phase-transition-prose.test.ts` + `delegate-prose.test.ts` as canonical-pattern guards. |

---

## 4. Workstream C — Invariants v2 bonus axis (#1458 + #1459)

Not in original epic scope; emerged from #1370 + #1439 closure work. Merged 2026-05-24, providing the dev-invariants substrate that #1442 (Tier B eval, under #1403) will consume.

| PR | Surface |
|---|---|
| [#1458](https://github.com/lvlup-sw/exarchos/pull/1458) (discover) | 5 research artifacts: workload-agnosticism stress test, runtime-invariants research survey + gap analysis, substrate-vs-authoring boundary, v2 spec proposal |
| [#1459](https://github.com/lvlup-sw/exarchos/pull/1459) (impl) | **Schema v1→v2:** required `axis: substrate \| authoring`; optional `citations: string[]`; optional `axiom_overlap: DIM-N`. **Loader:** gating via `.exarchos.yml: invariants.devCatalog: enabled \| disabled` (default **disabled**, no auto-detection); scope expanded to `'core' \| 'substrate' \| 'authoring' \| 'all'`; fail-loud on missing `axis`. **Catalog:** INV-1 split → INV-1 + INV-7 (substrate-serialization) + INV-8 (idempotency-at-the-boundary); INV-5b split → INV-5b + INV-12 (next-actions-as-affordance); 6 new entries (INV-9 HSM-as-state-machine, INV-10 liveness-event-protocol, INV-11 posture-declared-capabilities, INV-13 process-manager-two-event-split, INV-14 native-primitive-first-recovery, INV-15 single-machine-frame); 3 sharpenings (INV-6 elevated to primary workload-agnosticism, INV-1 canonical citations, INV-4 platform-axis vs INV-6 workload-axis). External citations: Mohan ARIES 1992, Bernstein & Goodman 1981, Miller *Robust Composition* 2006, Norman 1999, Akka/Wolverine, anip-protocol. **Total catalog: 27 entries** (10 substrate always-load + 9 substrate reference-only + 7 DIM-* axiom pointers + 1 authoring DIM-8). |

The audience boundary is intentional: this is the **dev** invariants catalog (Exarchos's own designers building the runtime substrate). A separate **consumer-facing SDLC invariants catalog** (for engineers using Exarchos as a plugin) is a future deliverable per the v2 spec §10 and is gated to never auto-surface for consumers (devCatalog default disabled).

---

## 5. CHANGELOG status

### Finding: No `[2.10.0-preview.4]` section exists

The CHANGELOG's top entry is:

```markdown
## [2.10.0-preview.3] - 2026-05-16
### Added
- Correlation tuple indexed columns + telemetry filters (#1437, #1414)
  - Schema V5→V6: operation_id, correlation_id, causation_id columns ...
- Correlation consumer wiring (#1448)
  - deriveCorrelationFilters helper ...
```

This is mislabeled. The content documents PRs #1447 + #1449, both of which merged **2026-05-17** — a day after the preview.3 close-out tag. These PRs are the post-bundle correlation polish under epic #1441 (Workstream B), not preview.3 content. The entry was last touched by PR #1447 itself (commit `4b664e92`, 2026-05-17), but no heading restructure landed.

The actual preview.4 substrate bundle (11 issues across 4 waves, ~20 PRs counting cascades, the Marten-aligned Tasks dispatch-core, the three-field correlation, the EventSourcedTaskStore, the elicitation form-mode, the invariants v1 catalog, the handoff lint, etc.) has **no narrative changelog entry anywhere**.

### Root cause: ghost-merged version bump

PR [#1420](https://github.com/lvlup-sw/exarchos/pull/1420) ("chore: bump version to 2.10.0-preview.4 + CHANGELOG entry") shows MERGED at 2026-05-16T05:40Z in the GitHub UI, with merge commit `bd7c05f828e624cac01b3ce1adc1b9415b614247`. The PR body documents a full preview.4 CHANGELOG section listing all 11 wave issues + 9 new event types + two tracked follow-ups (#1407 regex-fallback removal, #1414 B1 correlation gaps).

**But that merge commit is not in `origin/main`:**

```
$ git merge-base --is-ancestor bd7c05f8 origin/main && echo YES || echo NOT
NOT in main

$ git branch --contains bd7c05f8
(only chore/preview4-version-bump)
```

The companion commit `0a09e9a1 chore: bump version to 2.10.0-preview.4 + CHANGELOG entry` exists in the feature branch but is also unreachable from main.

This matches the project-memory codified hazard ([`feedback_stacked_pr_auto_merge_collapses_granularity`](../../.claude/projects/.../memory/feedback_stacked_pr_auto_merge_collapses_granularity.md)): stacked PRs with `--auto --squash` on the upper PR merge INTO the lower PR's branch when CI passes, collapsing both into one squash when the lower PR lands on main. PR #1420 was the upper PR; when it auto-merged, its commits collapsed into the lower stack, which then squash-landed without #1420's content surviving.

### Consequence: package.json is still preview.3

Both `package.json` and `servers/exarchos-mcp/package.json` declare `"version": "2.10.0-preview.3"`. There is no preview.4 tag, no published release, no plugin marketplace update. Consumers installing today get preview.3 content even though main contains preview.4 substrate + a full epic-#1441 polish layer.

This is consistent with the bundle audit's own observation (`docs/research/2026-05-16-v2-10-0-preview-4-bundle-audit.md` §TL;DR closing paragraph):

> The version is still `2.10.0-preview.3` in both root `package.json` and `servers/exarchos-mcp/package.json`; no preview.4 CHANGELOG entry exists yet. The bundle is **merged but not released.**

The bundle-audit doc framed this as a release-engineering action (recommendation 1) and the epic explicitly listed it as out-of-scope from the start. The epic closed 2026-05-24; the release engineering action has not.

---

## 6. Deferrals carried forward

Tracked outside this epic, not blocking:

| Issue | Target milestone | Reason |
|---|---|---|
| [#1453](https://github.com/lvlup-sw/exarchos/issues/1453) | v2.12.0 — Process Lifecycle Verbs | #1440 Op 3: workflow-verb wiring through Tasks-augmented dispatch. Per-verb cancellation semantics deserve dedicated design. |
| [#1454](https://github.com/lvlup-sw/exarchos/issues/1454) | v2.12.0 — Process Lifecycle Verbs | #1440 Op 5: SSE for `tasks/subscribe`. Design must include a "build now vs. wait for concrete client" decision per original deferral framing. |
| [#1456](https://github.com/lvlup-sw/exarchos/issues/1456) | v2.11.0 | #1370 MEDIUM/LOW residue — 25 phase-transition audit findings that didn't block #1457's HIGH closures. |
| [#1395](https://github.com/lvlup-sw/exarchos/issues/1395) | v2.10.0 (direct) | `_eventHints.missing` auto-emit investigation. Rescoped out of epic #1441 on 2026-05-23 — observability investigation whose scope is the Agent Output Contract itself, not preview.4 post-bundle polish. |

Known LOW follow-ups from #1452 review (captured for visibility, not new sub-issues):

1. Hoist `RETRY_WITH_TASK_THRESHOLD_MS` from inline `dispatch.ts:1011` to module scope; wire `config.dispatch.retryWithTaskHintThresholdMs`.
2. Add `logger.child({ subsystem: 'elicitation' }).warn(...)` to silent catch at `dispatch.ts:869` to match the workspace-discovery observability pattern.
3. Update substrate-realization design §4.3 / §4.4 prose to use canonical registry names (`request_synthesize` not `synthesize`) and `result.next_actions` (top-level, per `format.ts:66`) not `_meta.next_actions`.

---

## 7. Bundle-audit recommendations status

Final reconciliation from epic #1441 §"Bundle-audit Recommendations reconciliation":

| # | Recommendation | Status | Resolution |
|---|---|---|---|
| 1 | Cut the preview.4 release — version bump + CHANGELOG + tag + release workflow | **DEFERRED to release engineering** | Out of epic scope from opening. Belongs to `/release` workflow, not polish tracking. **Still outstanding.** |
| 2 | Close out #1414 before RC1 | **DONE** | Via PR #1447. |
| 3 | Decide SQL columns + telemetry filters from #1291's acceptance | **DONE — RC-eligible** | Via PR #1447 (schema V5→V6 + filters + acceptance trio). |
| 4 | Verify two #1273 acceptance items — `--format json --follow` NDJSON-per-transition matches outputSchema; byte-equal cross-adapter parity for Tasks | **DEFERRED to v2.12.0** | Op 5 (SSE) + broader CLI↔MCP Tasks parity; tracked under #1453 (Op 3) / #1454 (Op 5). |
| 5 | Codify the stacked-PR squash hazard | **DONE** | Captured in `feedback_stacked_pr_auto_merge_collapses_granularity` project memory. |
| 6 | (Optional) Resolve attribution drift for the four stacked PRs | **SKIPPED — optional, low value** | Forward fix is rec 5; `git blame` confusion is real but limited. |

Recommendation 1 is the single remaining preview.4 action. Everything else under the epic is closed.

---

## 8. Architectural posture changes

Preview.4 ships these net-new architectural commitments:

- **INV-1 (event-sourcing integrity) extended to tasks.** EventSourcedTaskStore is a global-scope projection over `task.*` events. The MCP SDK's `InMemoryTaskStore` is asserted absent in production (`production-wiring.test.ts`). Closes the last in-memory side-database for the Tasks substrate; pairs with the merge-orchestrator projection (preview.2) to satisfy INV-1 across all stateful subsystems.
- **Three-field correlation as a first-class substrate.** `operationId` / `correlationId` / `causationId` are threaded via `AsyncLocalStorage` from dispatch entry through every event emission and the envelope `_meta`. Storage and query layers honor them (indexed columns + `WHERE` clauses on SqliteBackend, post-fetch filter on InMemoryBackend for parity). Six telemetry views consume them as filter args.
- **OCC + cross-process cache validation at the TaskStore boundary.** Three HIGH-severity findings from the audit (no OCC, cache hits skipping stream validation, `task.polled` write amplification) are now closed by `expectedSequence` threading + cache-vs-tail validation + emit throttle.
- **Elicitation form-mode as the canonical missing-required-param path.** `inputSchema.pick({field: true})` derives elicitation sub-schemas — no hand-written elicitation schema can drift from the validation schema. End-to-end verified by the #1436 in-process MCP client+server smoketest (which caught #1451's wired-but-not-invoked Zod v4 narrowing bug mid-bundle, the second time the "verify substrate by exercising it" approach validated itself in preview.4).
- **Machine-readable invariants catalog as YAML-fronted markdown.** v1 ships under #1425; v2 (under #1459, post-epic) bumps schema, adds `axis` / `citations` / `axiom_overlap`, gates dev catalog behind explicit opt-in, splits INV-1 and INV-5b along orthogonal axes, and grounds every new entry in external research. The dev catalog is the substrate for the future Tier B `/ideate` behavioral eval (#1442 under eval-suite epic #1403).

---

## 9. Recommendations

### Immediate

1. **Close the release-engineering gap.** Either:
   - **(A)** Open a fresh, non-stacked version-bump PR that ports the #1420 body (preview.4 CHANGELOG section + `package.json` + `package-lock.json` bumps) and lands directly on main, then tag `v2.10.0-preview.4` and run the release workflow. The CHANGELOG section should now reflect the FULL state including the epic-#1441 polish (the original #1420 body didn't cover #1443–#1459 since they hadn't been written yet).
   - **(B)** Skip preview.4 entirely and cut **v2.10.0-RC1** with a consolidated CHANGELOG that folds preview.4 substrate + epic-#1441 polish + invariants v2 into one entry. This avoids re-litigating the heading drift on main but loses the preview cadence signal.
   - Recommendation: **(A)** — preserves the preview cadence and the audit recommendation, and keeps RC1 a clean polish-only line. The CHANGELOG body needs to be rewritten from the #1420 draft to include everything through 2026-05-24.

2. **Fix the mislabeled CHANGELOG heading.** The current `## [2.10.0-preview.3] - 2026-05-16` entry contains preview.4-era polish. Re-label it `## [2.10.0-preview.4] - 2026-05-17` (date of #1447 merge), or fold it into the consolidated entry from action 1.

3. **Verify no other ghost-merged preview.4 PRs.** Grep `git log --all --oneline | grep "preview.4"` against `git merge-base --is-ancestor … origin/main` for every preview.4-titled PR to confirm #1420 is the only collapse victim. The substrate PR squashes (PR1422/1423/1429/1430 collapsing into siblings) are intentional — only #1420's loss is a release-engineering hazard.

### Forward

4. **Build the consumer-facing SDLC invariants catalog.** The dev catalog v2 is now stable and gated. The consumer catalog (different audience, different concerns, no shared entries by design) is the next workload-agnosticism deliverable per the v2 spec §10. File as a discover workflow when ready.

5. **Schedule #1453 + #1454 designs.** Op 3 (workflow-verb wiring) and Op 5 (SSE) sit on `status:backlog` under v2.12.0 with no owner. Substrate-realization design §7 commits to dedicated designs but doesn't schedule them. Risk: they slip past v2.10.0-RC1 without an owner.

6. **Carry forward the audit + realization pattern.** Two case studies in preview.4 substrate cycles (#1436 catching #1451, #1370/#1439 surfacing the invariants v2 axis) validated the "ship substrate, audit immediately, realize via E2E exercising" loop. This is now a templated cadence: substrate + audit + realization across two follow-up sprints. Codify in a process doc or skill if you want it to outlive the conversation.

---

## 10. Source documents

### Designs
- `docs/designs/2026-05-15-v2-10-0-preview-4-feature-freeze.md` — substrate bundle design
- `docs/designs/2026-05-15-v2-10-0-preview-4-feature-freeze.sidecar.yml` — gates sidecar
- `docs/designs/2026-05-16-correlation-indexed-columns.md` — #1447 design
- `docs/designs/2026-05-16-correlation-consumer-wiring.md` — #1449 design
- `docs/designs/2026-05-17-preview-4-substrate-hygiene.md` — #1450 design
- `docs/designs/2026-05-17-preview-4-substrate-realization.md` — #1452 design
- `docs/designs/2026-05-18-preview-4-invariant-audit-pair.md` — #1455/#1457 design

### Plans
- `docs/plans/2026-05-15-v2-10-0-preview-4-feature-freeze.md`
- `docs/plans/2026-05-16-correlation-indexed-columns.md`
- `docs/plans/2026-05-16-correlation-consumer-wiring.md`
- `docs/plans/2026-05-17-preview-4-substrate-hygiene.md`
- `docs/plans/2026-05-17-preview-4-substrate-realization.md`
- `docs/plans/2026-05-18-preview-4-invariant-audit-pair.md`
- `docs/plans/2026-05-20-invariants-catalog-v2-implementation.md`

### Research / audits
- `docs/research/2026-05-16-v2-10-0-preview-4-bundle-audit.md` — substrate bundle post-merge audit
- `docs/research/2026-05-16-event-sourced-task-store-audit.md` — TaskStore audit (8 findings)
- `docs/research/2026-05-18-invariant-content-audit.md` — #1439 audit
- `docs/research/2026-05-18-phase-transition-invariant-audit.md` — #1370 audit
- `docs/research/2026-05-20-runtime-invariants-research-survey.md` — invariants v2 discover
- `docs/research/2026-05-20-runtime-invariants-gap-analysis.md` — invariants v2 discover
- `docs/research/2026-05-20-substrate-vs-authoring.md` — invariants v2 discover
- `docs/research/2026-05-20-workload-agnosticism-stress-test.md` — invariants v2 discover

### Proposals
- `docs/proposals/2026-05-20-invariants-catalog-v2-spec.md`

### Issues & PRs
- Epic: [#1441](https://github.com/lvlup-sw/exarchos/issues/1441) (CLOSED)
- Substrate bundle: #1405, #1406, #1409, #1410, #1413, #1415, #1416, #1417, #1418, #1419, #1420 (ghost-merged), #1421, #1424, #1425, #1426, #1427, #1428, #1432, #1433, #1435
- Epic polish: #1443, #1444, #1445, #1447, #1449, #1450, #1452, #1455, #1457
- Bonus axis: #1458 (discover), #1459 (impl)
- Forward trackers: #1453, #1454, #1456 (active), #1395 (rescoped)

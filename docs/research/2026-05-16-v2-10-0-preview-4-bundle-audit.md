# v2.10.0-preview.4 Bundle Audit — What Landed vs Design Intent

**Feature ID:** `preview4-bundle-audit`
**Date:** 2026-05-16
**Bundle:** PRs #1421–#1435 (between c3a55f44 preview.3 close-out and 77c9d77b HEAD)
**Reference design:** [`docs/designs/archive/2026-05-15-v2-10-0-preview-4-feature-freeze.md`](../designs/archive/2026-05-15-v2-10-0-preview-4-feature-freeze.md)
**Reference plan:** [`docs/plans/archive/2026-05-15-v2-10-0-preview-4-feature-freeze.md`](../plans/archive/2026-05-15-v2-10-0-preview-4-feature-freeze.md)

## TL;DR

All 11 originating issues (#1238, #1244, #1260, #1261, #1262, #1272, #1273, #1274, #1290, #1291, #1298) are **closed**, and the substantive code+content for every wave (A/B/C/D) is on `main`. The bundle delivers the feature-freeze line as scoped.

However, **four drift items** are worth surfacing:

1. **PR-to-content attribution is misleading.** Because the bundle used stacked PR branches, four of the eleven issues (`#1262/PR1422`, `#1290/PR1423`, `#1261/PR1429`, `#1272/PR1430`) never produced their own squash commit on `main` — their content arrived via their parent's squash and is attributed in git log to the wrong PR number.
2. **#1273 Wave C had a process incident.** PR #1432 (C2 MCP adapter) was squash-merged from a pre-CodeRabbit-fix snapshot; PR #1431 went structurally stale; PR #1435 was created post-hoc to replay the CodeRabbit-final fix delta. C1 (Tasks-augmented dispatch-core) never had its own attributed merge — the content rode in under PR #1433 (C3 `--follow`).
3. **#1291 acceptance has two substantive un-met items** — no SQL-column storage layer for `correlation_id`/`causation_id`, and no telemetry-view filters for the three fields. The fields exist on the TS event-factory + envelope; storage and view filters are deferred (#1414 covers two MEDIUM gaps).
4. **#1244 (handoff lint) had a documented design deviation** — the plan prescribed `_eventHints` payload, but `EventHintsPayload` is strictly typed; the PR shipped the existing `result.warnings` + `data.handoffLintFindings` pattern instead. Functionally equivalent, but not the surface the plan named.

Plus a notable functional bug that almost shipped: **PR #1426 B1** (sidecar lookup returned `foo.md.sidecar.yml` instead of `foo.sidecar.yml`) would have made the entire #1298 sidecar gate path silently dead. Caught by CodeRabbit pre-merge.

The version is still `2.10.0-preview.3` in both root `package.json` and `servers/exarchos-mcp/package.json`; no preview.4 CHANGELOG entry exists yet. The bundle is **merged but not released**.

## Bundle Composition — What Actually Landed on Main

Between `c3a55f44` (preview.3 close-out, 2026-05-16T02:02Z) and `77c9d77b` (HEAD, 2026-05-16T23:26Z), `main` received 13 commits. Nine of those are the preview.4 PR squashes plus the design+plan docs and one cleanup fix carried over from preview.3:

| Commit | PR | Wave | Issue | Surface |
|---|---|---|---|---|
| `72bf1823` | #1404 | (preview.3 carry) | — | `fix(merge-orchestrate)`: repoRoot from git top-level |
| `1e48212a` | (chore) | — | — | bump 2.10.0-preview.3 |
| `77048483` | (direct) | — | — | `fix(cli)`: bare `exarchos` UNCAUGHT_EXCEPTION |
| `74adbeda` | #1088 | bundle docs | — | preview.4 design + plan + 2 sidecars |
| `af40ed18` | **#1425** | **D1** | **#1260** | machine-readable invariants + vocabulary lint + `/ideate` first-turn |
| `99aacc4d` | **#1421** | **A1** | **#1238** | next-actions Zod discriminated unions + safeParse fail-closed |
| `ff8a83a4` | **#1426** | **D2** | **#1298** | designs/plans machine-readable sidecar + 4 functional fixes |
| `f7e70a11` | **#1427** | **D3** | **#1244** | markdown-aware handoff lint at `handleCheckpoint` |
| `be4e5a50` | **#1428** | **B1** | **#1291** | three-field correlation + AsyncLocalStorage event threading |
| `08f68ced` | **#1433** | **C3** | **#1273** | CLI `--follow` polling loop |
| `1a2e8b12` | **#1424** | **A4** | **#1274** | Elicitation form mode for INVALID_INPUT |
| `299b902a` | **#1432** | **C2** | **#1273** | `tasks/*` methods + `taskSupport` capability |
| `77c9d77b` | **#1435** | **C1-fix** | **#1273** | pollInterval validity + `task.polled.sequence` deprecation |

**Wave coverage summary:**

| Wave | Theme | Issues | Status |
|---|---|---|---|
| **A** | Output contract completion | #1238 #1262 #1290 #1274 | All 4 landed |
| **B** | Correlation + event topology | #1291 #1261 #1272 | All 3 landed (1261 + 1272 via #1428 squash) |
| **C** | Tasks dispatch-core | #1273 | Landed; C1 + C2 + C3 + post-merge fix |
| **D** | Authoring substrate | #1260 #1298 #1244 | All 3 landed |

## Per-Wave Findings

### Wave A — Output Contract Completion

| Issue | Acceptance summary | Landed | Drift |
|---|---|---|---|
| **#1238** | `nextActionsFromResult` uses `safeParse` over discriminated union; fail-closed; no Record casts. | ✅ via PR #1421 (own squash) | None. |
| **#1262** | `output_tokens_high` hint via `next_actions` on threshold crossing; CLI+MCP envelope parity; configurable via `.exarchos.yml`. | ✅ via #1421's squash (PR #1422 merged-but-not-as-own-commit) | Attribution: file `telemetry/quality-hints.ts` shows up in git blame under #1421's commit, not #1422. |
| **#1290** | Roots capability snapshotted; one-match resolves with `workspace.resolved {source:'roots'}`; multi-match→`INVALID_INPUT`+`validTargets`; cache invalidates on `roots/list_changed`. | ✅ — file `servers/exarchos-mcp/src/workspace/discovery.ts` is in `main` | Attribution: git blame credits this file to **#1428** (Wave B PR1), not #1423. Content semantically intact (signature heuristic + tri-state cache + `roots/list_changed` invalidation present in the file's leading comment). |
| **#1274** | Missing-required-param + `elicitation` declared → `elicitation/create` with `.pick()`-derived schema; events carry `operationId`. | ✅ via PR #1424 (own squash) | None. PR notes `roots > cwd > elicitation > INVALID_INPUT` resolution order, matching design. |

**Wave A verdict: complete; one re-attribution oddity in the squash chain.**

### Wave B — Correlation + Event Topology

| Issue | Acceptance summary | Landed | Drift |
|---|---|---|---|
| **#1291** | `DispatchContext` three fields; thread through every event-emit site; **three new typed SQL columns** (`operation_id` `correlation_id` `causation_id`); telemetry views accept filters for all three; integration tests for inheritance + auto-dispatch + property collision. | ⚠️ partial | **Substantive drift:** TS fields exist (`event-factory.ts`, `atomic-appender.ts`, envelope `_meta`), but `git grep correlation_id\|causation_id` over `servers/exarchos-mcp/` returns 0 SQL columns. Telemetry views (`src/views/`) don't accept the three filters either. PR body explicitly documents two MEDIUM CodeRabbit gaps deferred to **#1414** (preserve inbound `_meta` for built-in tools + `batchAppend` cache-hit operationId preservation). |
| **#1261** | `dispatch.preflight` per-guard + `stash.detected` events with three-field correlation. | ✅ — `event-store/schemas.ts` registers both event types; emitted from `prepare-delegation.ts` | Attribution: PR #1429's content arrived via #1428's squash. |
| **#1272** | `EventSourcedTaskStore` projection over `task.*` events; lifecycle reconstructable from event stream; TTL; no `InMemoryTaskStore` in production. | ✅ — `task-store/event-sourced-task-store.ts` in `main`; `production-wiring.test.ts` asserts the SDK store is absent | Attribution: PR #1430's content arrived via #1428's squash (first appears at `be4e5a50`). |

**Wave B verdict: feature-functional, but #1291 missed the storage-layer column model and the telemetry-filter wiring named in the issue's acceptance list. The two TODOs from CodeRabbit are tracked under #1414.**

### Wave C — Tasks Dispatch-Core (#1273)

The bundle's most operationally messy slice. Split into C1 / C2 / C3 per design; landed as:

| Sub-PR | Surface | Status |
|---|---|---|
| **C1** Tasks-augmented dispatch core (`dispatch/tasks-augmented.ts`) | dispatch-core path returning `CreateTaskResult` | Landed — but no own attribution. First appears in `main` at `08f68ced` (PR **#1433**, C3) |
| **C2** MCP adapter (`mcp/tasks-methods.ts`, `mcp/tools-call-handler.ts`) | `tasks/get` / `tasks/result` / `tasks/cancel`; `taskSupport: 'optional'` | Landed at `299b902a` (PR **#1432**), but from a **stale snapshot** that pre-dated CodeRabbit-final fixes on PR #1431 |
| **C3** CLI `--follow` polling loop (`cli/follow-loop.ts`, `cli/follow-formatter.ts`) | in-process polling against `EventSourcedTaskStore`; SIGINT→cancel parity | Landed at `08f68ced` (PR **#1433**) |
| **C1-fix** post-merge | pollInterval validity + `task.polled.sequence` deprecation + pollInterval REPLAY drift | Landed at `77c9d77b` (PR **#1435**) |

**Process incident (documented in PR #1435 body):**

> PR #1432 (#1273 C2) was squash-merged at 23:06 UTC from a branch snapshot that pre-dated the CodeRabbit-final fixes that landed on PR #1431. PR #1431 is now structurally stale — its diff vs main would *remove* the C2 files it doesn't yet contain. This PR ports just the CodeRabbit fix delta forward to a clean branch off `main`.

The three fixes #1435 had to replay are non-trivial:

1. **pollInterval validity contract alignment** — `0` / negatives / NaN / Infinity / fractional floats could slip past the dispatch boundary and silently fail the durable `TaskCreatedData.pollInterval` schema inside the best-effort emit.
2. **`task.polled.data.sequence` deprecation** — canonical ordering moved to envelope atomic `.sequence`; payload field is redundant.
3. **pollInterval REPLAY drift** — pre-fix, a process restart silently reverted every task to the 1000ms default because cadence was only in the in-memory projection.

The REPLAY drift in particular is an **INV-1 violation** (event-sourcing integrity) that almost shipped. If this had escaped review, every restart would have silently re-defaulted Task cadence — a behavior change invisible to clients but breaking the "projection rebuilt from stream alone" guarantee that #1272 is supposed to enforce.

**Acceptance criteria status (#1273):**

| Criterion | Status |
|---|---|
| Dispatch core Tasks-augmented path returns `CreateTaskResult` | ✅ |
| MCP adapter wires `tools/call+task` → dispatch core; `tasks/get`/`tasks/result`/`tasks/cancel` resolve via `EventSourcedTaskStore` | ✅ |
| CLI adapter `--follow` consumes the same `EventSourcedTaskStore` | ✅ |
| `--format json --follow` emits NDJSON matching registered `outputSchema` per transition | ⚠️ not verified in this audit; PR #1433 body mentions transition formatter but not the NDJSON schema parity test |
| Parity test (same dispatch through both adapters → identical content per transition) | ⚠️ PR #1433 says "INV-2 facade equivalence" via shared `updateTaskStatus` call, but the byte-identical-per-transition test named in the issue is not called out |
| `taskSupport: 'optional'` — clients without Tasks support get one-shot | ✅ |
| First adoption: `exarchos_view --follow workflow` + `--follow shepherd` | ✅ |

**Wave C verdict: feature-functional and shipped; process scar from the stale snapshot is documented and remediated by #1435; two acceptance items (NDJSON outputSchema parity per transition, byte-equal cross-adapter parity test) would benefit from spot-check verification.**

### Wave D — Authoring Substrate

| Issue | Acceptance summary | Landed | Drift |
|---|---|---|---|
| **#1260** | `docs/architecture/invariants.md` with structured frontmatter; `/ideate` first-turn loads + surfaces; vocabulary lint fails CI on undefined `INV-N`/`DIM-N` references. | ✅ via PR #1425 (own squash) — 18 entries, 319 LOC; `vocabulary-lint-cli.ts`; `npm run lint:invariants` | Known follow-up in PR body: 10 existing-file `INV-5` umbrella references without specific sub-discipline. Recommended as a separate issue. |
| **#1298** | Design + plan sidecars; 4 gates consume sidecar when present; regex fallback with deprecation log; tracking issue filed in same PR. | ✅ via PR #1426 (own squash) — backfill sidecars exist for the preview.4 design + plan; regex-fallback removal tracked under **#1407** | **Functional bug caught in review:** B1 — `sidecar-lookup.ts` originally returned `foo.md.sidecar.yml` (mismatch with shipped `foo.sidecar.yml` filenames). Without the fix, the sidecar branch never fired. Also B2 (DAG check stub), B3 (ESM `__dirname`), B4 (`min(1)` references). All four caught and fixed before merge by CodeRabbit. |
| **#1244** | Run `prose-lint.ts` on `handoff.context/nextSteps/suggestions` at `handleCheckpoint`; soft-fail default; hard-fail opt-in via `.exarchos.yml`. | ✅ via PR #1427 (own squash) — `workflow/handoff-lint.ts`; `handoffLint.hardFail?: boolean` config | **Documented design deviation:** plan prescribed `_eventHints: [{kind:'handoff_lint_warning', findings}]` but `EventHintsPayload` is strictly typed; PR shipped existing canonical soft-warning pattern (`result.warnings` + `data.handoffLintFindings`). Functionally equivalent; surface-named deviation explicit in PR body. |

**Wave D verdict: complete; one functional bug pre-empted by review (PR #1426 B1), one explicit plan-vs-implementation surface deviation (PR #1427 handoff lint payload shape).**

## Cross-Cutting Observations

### 1. Stacked-PR attribution drift

The bundle used per-wave integration branches (`feature/preview4-wave-{a,b,c,d}`) with stacked sub-branches. When a stack-base PR squash-merged to `main`, its squash collapsed every stacked child's content into a single commit attributed to the base PR. Consequence: four issues have no own squash commit on `main`:

- **#1262** → content in #1421's squash (or #1428's; first-appearance of `telemetry/quality-hints.ts` warrants verification)
- **#1290** → `workspace/discovery.ts` first appears at #1428's squash
- **#1261** → first appears at #1428's squash
- **#1272** → first appears at #1428's squash

This is not a functional issue, but it makes `git blame`/`git log -- <file>` confusing for anyone trying to trace why a feature exists.

### 2. The #1431 / #1432 / #1435 stale-snapshot incident

PR #1432 was merged from a branch snapshot that pre-dated three CodeRabbit-final fixes on PR #1431. PR #1431 went structurally stale (its diff vs main would *remove* C2 files), and PR #1435 had to be created to replay the fix delta on a clean branch off main. The three fixes covered a real INV-1 violation (pollInterval REPLAY drift). This is a workflow hazard worth memorializing — the [stale-worktree-after-external-push](../../README.md) memory feedback applies, and the stacked-PR discipline memory may need an additional clause: **never squash-merge from a stale snapshot when a sibling PR has post-review fixes pending.**

### 3. Sequencing drift vs design

Design said: "Wave A and Wave D run in parallel; Wave B serial after A+D; Wave C serial after B." Actual merge order: D1 → A1 → D2 → D3 → **B1** → **C3** → **A4** → **C2** → C1-fix. Two minor deviations:

- **A4 (#1424)** merged *after* B1 — Wave A was not fully closed before Wave B started.
- **C3 (#1433)** merged *before* C2 (#1432) — same wave, but reverse the design's "split internally" order.

Neither caused a regression. Sequencing was looser than the design's strict serialization, but disjoint surfaces made it safe.

### 4. Version not yet bumped

Both `package.json` and `servers/exarchos-mcp/package.json` are still `2.10.0-preview.3`. No CHANGELOG entry for preview.4 exists yet. The bundle is **merged-but-not-released**. The design's RC-readiness assertions (no new API surface, no new event types, no new MCP capabilities post-preview.4) are now operative; the version bump + CHANGELOG entry + tag are the remaining steps.

### 5. Conformance the design promised

The design declared PASS or PASS(+) on all 9 INV checks and all 8 DIM checks, with one DIM-5 WATCH (regex-fallback removal scheduled v2.11). The landed code substantiates:

- **INV-1**: ✅ task lifecycle reconstructable from stream (`EventSourcedTaskStore` + #1435 REPLAY fix close the loop)
- **INV-2**: ✅ shared `updateTaskStatus` between CLI SIGINT and MCP `tasks/cancel`
- **INV-5a**: ✅ Roots eliminates "guess featureId"; Elicitation eliminates "trial-and-error which param"; invariants doc surfaces on `/ideate` first turn
- **INV-5b**: ⚠️ partial — three-field correlation does register in envelope `_meta`, but the storage column + telemetry filter halves of the contract are not landed
- **DIM-3**: ✅ Zod discriminated union (#1238); `.pick()`-derived elicitation schemas (#1274); sidecar IS the contract (#1298); invariants doc structured frontmatter (#1260)
- **DIM-5 WATCH**: ✅ regex-fallback deprecation log present; removal tracked under **#1407**

## Recommendations

1. **Cut the preview.4 release.** Bump `package.json` + `servers/exarchos-mcp/package.json`, write the CHANGELOG entry, tag, run the release workflow. Until this happens, the design's RC-readiness assertions are inert.
2. **Close out #1414** before RC1. The two MEDIUM CodeRabbit gaps from #1428 (preserve inbound `_meta`, `batchAppend` cache-hit operationId preservation) are the load-bearing pieces missing from #1291's contract.
3. **Decide whether the SQL columns + telemetry filters from #1291's acceptance are RC-eligible or v2.11.** The acceptance was specific ("Three new typed columns on the events table — `operation_id`, `correlation_id`, `causation_id`. Indexed for telemetry-view queries"). Today's TS-only implementation leaves the wire-format primitive in place but the persistent index is missing. If they're deferred, file a follow-up and amend the design.
4. **Verify the two #1273 acceptance items** that this audit could not confirm: `--format json --follow` NDJSON-per-transition matches the registered outputSchema, and the byte-equal cross-adapter parity test exists for Tasks (not just for one-shot envelopes).
5. **Codify the stacked-PR squash hazard.** Add a clause to the stacked-PR discipline feedback: **before squash-merging the bottom of a stack, confirm no sibling PR has post-review fixes pending against the same branch snapshot.** The #1431 / #1432 / #1435 incident is the canonical example.
6. **(Optional) Resolve the attribution drift for the four stacked PRs.** No functional impact, but `git blame` users will be confused. If the attribution is preserved in PR labels / closing-issue references, that's adequate; if it isn't, consider a documentation note in the CHANGELOG entry.

## Sources

- Design: `docs/designs/archive/2026-05-15-v2-10-0-preview-4-feature-freeze.md`
- Plan: `docs/plans/archive/2026-05-15-v2-10-0-preview-4-feature-freeze.md`
- Plan sidecar: `docs/plans/2026-05-15-v2-10-0-preview-4-feature-freeze.sidecar.yml`
- Issues: #1088 (epic), #1238 #1244 #1260 #1261 #1262 #1272 #1273 #1274 #1290 #1291 #1298
- PRs: #1421 #1422 #1423 #1424 #1425 #1426 #1427 #1428 #1429 #1430 #1432 #1433 #1435
- Preview.3 close-out: PR #1401 (squash `c3a55f44`)
- Follow-ups filed against the bundle: **#1407** (regex-fallback removal, v2.11), **#1414** (two #1291 MEDIUM gaps)

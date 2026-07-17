# Spec: v2.12.0 execution bundle — gate correctness, error contract, lifecycle hardening, quick wins

**Workflow:** `v2-12-bundle` (feature) · **designDepth:** standard · **Date:** 2026-07-17
**Issues:** Wave A #1654 #1692 #1709 #1710 #1694 #1696 #1716 · Wave B #1688 #1278 #1693 #1685 #1691 · Wave C #1644 #1647 #1633 #1645 #1641 · Wave D #1570 #1561 #1245 #1649 #1686 #1545 #1690 #1684 · Stretch #1656 (verify-closes #1537) · Verify-first #1536 #1566-remainder

## Design & Rationale

### Constraints

Anchored to `.exarchos/invariants.md` (always-load baseline + domain-warranted reference-only pulls):

- **INV-1:** The append-only event log is the source of truth; every read-model is a left-fold over events.
- **INV-2:** CLI and MCP are both facades over a single functional dispatch core; same DispatchContext + arguments → same ToolResult; adapters carry zero behavior.
- **INV-5a/5b:** Tool inputs constrained at the schema level; every ToolResult carries the fixed carrier shape (next_actions, _meta, _perf); errors carry validTargets/suggestedFix.
- **INV-6:** The runtime makes no assumption about which workload is executing; workflow-type concerns belong in topology, not hardcoded — the direct anchor for the gate-correctness wave.
- **INV-7/8:** Two-tier concurrency serialization; every append carries an idempotency key.
- **INV-11:** Agent postures (read-only | task-isolated | shared-mutating) merge with the MCP initialize handshake, handshake-authoritative — the direct anchor for DR-8.
- **INV-12:** next_actions publishes runtime affordances; agents dispatch listed verbs, they do not poll.
- **INV-15:** Single-machine event-sourced process manager; no distributed primitives.
- Reference-only pulls: **INV-13** (intent/result event pair — DR-16), **INV-10** (executing_started/terminal liveness — DR-17), **INV-16** (Windows portability — DR-17), **INV-9** (HSM is the sole phase authority — DR-14), **INV-5c** (observation verbs, dry-run defaults — DR-13), **INV-4** (skills source-of-truth at skills-src — DR-7), **INV-17** (token economy — DR-11/DR-12).

### Problem Statement

The v2.12.0 milestone ("Process Lifecycle Verbs", Z2 runtime supervision) carries a triaged execution bundle of ~28 verified-unblocked defects and hardening items, approved 2026-07-17 after a full open-issue audit. Three defect families dominate. **First, the planning gates lie.** The plan-verification parsers reject the canonical unified spec template (NO_DESIGN_SECTIONS), report false test-counts on digit-bearing test names, ignore the `Implements:` field they already parse, and hard-fail asset-only tasks — while two CI grep gates pass vacuously over empty file sets and a skill prescribes event types the catalog rejects. Every false verdict trains operators to ignore the gate, which is the failure mode that makes a gate worse than no gate. **Second, the MCP surface under-delivers its contract.** The caller-posture handshake is stubbed, so every live MCP caller resolves read-only and all shared-mutating verbs are unreachable; error envelopes carry no JSON-RPC mapping or retry-class discrimination; default event-store queries are unbounded; the `ps` hot path issues streams×types sequential queries. **Third, lifecycle hardening debt** from the WLM/launcher wave remains open: no typed spawn/teardown contract, deferred merge-serializer edge cases, win32 liveness fail-open, and a set of small, fully-specified quick wins.

### Chosen Approach

Execute as four dependency-ordered waves plus one stretch item, one worktree-isolated task per issue (a few pairs merged where they share a seam), all under this single workflow for traceability. **Wave A (gate correctness)** lands first: it is small, self-contained, and un-breaks the very gates that verify the later waves — including this spec's own plan-review. Targeted fixes are chosen over the structural parser rewrite (#1657, deferred to v3.0) because each defect is pre-diagnosed with a test plan, and the structural fix belongs with the v3.0 structured-state direction. **Wave B (error contract + MCP surface)** groups the posture handshake, the JSON-RPC error model and retry-class contract (one seam, shipped together), storage-layer query bounding, and the ps query collapse. **Wave C (lifecycle)** ships the launcher contract before its dependent context-rot gate, alongside WLM hardening and the INV-13 stateFingerprint schema bump. **Wave D (quick wins)** is fully parallel. Verify-first items (#1536, #1566 remainder) are budgeted as cheap re-repro probes post-#1697/#1712 — fix if live, close with evidence if not.

**Authoring-shape note (deliberate, self-referential):** this spec is authored in the gate-compatible dual shape — `## Requirements` h2 with `### DR-N` h3 sections and h3 `### Task NNN:` headers — NOT the unified template's `#### DR-N`-under-`## Design & Rationale` shape, because today's parsers reject the latter (the exact defect DR-1 fixes; friction filed on `meta/feedback` 2026-07-09). When DR-1 lands, this workaround class retires.

### Technical Design

The bundle touches five seams, each behind existing module boundaries — no new architecture. (1) **Gate parsers:** `orchestrate/plan-coverage.ts`, `orchestrate/pure/provenance-chain.ts`, `orchestrate/generate-traceability.ts`, `orchestrate/task-decomposition.ts` — dual-shape section/task recognition, `Implements:`-authoritative coverage, regex/allowlist repairs. `task-decomposition.ts` already parses h4 task headers (#1670), narrowing DR-1 to the other three. (2) **CI grep gates:** `scripts/check-withsession-idempotency.sh` gains fail-on-empty-selection semantics (default) with a declared-dormant flag for the current zero-consumer state; new `scripts/check-scope-claim-single-copy.sh` + self-test wired into the blocking grep-gates job, modeled on `check-begin-immediate-substrate.sh`. (3) **MCP adapter + capability resolver:** implement the initialize-handshake posture derivation (INV-11, handshake-authoritative), the ErrorCode→JSON-RPC mapping with `_meta.errorCode`, and a typed `RetryClass` record consumed at the CLI's seven discrimination sites. (4) **Event-store storage contract:** count + LIMIT/OFFSET pushed into both backends behind the same interface (INV-2 parity); `gatherOperationEvents` drops its inner per-type query loop. (5) **WLM/launcher:** typed spawn/teardown envelope with `worktree.created`/`finalized` events and fail-closed tree-hash; merge-serializer hardening per the #1631 review; win32 liveness fail-closed with a deterministic process-table seam (INV-16).

### Alternatives considered

- **Structural parser replacement now (#1657):** replace four markdown parsers with reads of structured task/workflow state. Rejected for this bundle — it races the wave-S enforcement-substrate redesign and belongs with the v3.0 SDK/structured-state direction. Targeted fixes deliver the same operator-facing correctness at a fraction of the blast radius. Deferred with rationale on the issue.
- **Registering `discovery.*` event types instead of deleting the skill section (#1716):** rejected — no projection or guard consumes them; the playbook prescribes zero events; registering types to satisfy stale prose inverts the source-of-truth relationship.
- **One PR per wave vs one PR per task:** per-task branches merged into a per-wave integration branch, following the established delegate/merge-loop pattern; a single monolithic bundle PR was rejected as unreviewable.
- **Including #1646 (gate_reliability projection):** unblocked but builds on the gate-runner substrate being redesigned in wave-S; sequenced after wave-S lands rather than risking rework.

### Out of scope

The #1677 benchmark family (independent epic), all #1701 debloat children (#1704/#1705/#1706/#1711/#1713 — separate program per owner decision), #1646 (sequenced after wave-S), evicted items #1402 (evidence-gated), #1652/#1653 (externally blocked), and v3.0 deferrals #1643/#1629/#1657.

## Requirements

### DR-1: Plan-gate parsers accept the unified spec template shape

`check_plan_coverage`, `check_provenance_chain` (pure parser), and `generate_traceability` must parse the unified `docs/specs/` template — DR-N definitions as `#### DR-N:` under `## Design & Rationale` (and h3 `### DR-N:` variants), tasks as `#### Task NNN:` under `### Tasks` — while retaining the legacy two-file shape unchanged (dual-shape rule). When DR-N sections exist, they are the coverage units; narrative sections (Problem Statement, Technical Design) are not. (#1654)

**Acceptance criteria:**
- Fixture matching `spec-template.md` verbatim: all four gate actions return non-zero DR and task counts with real section names
- Legacy `docs/designs/` + `docs/plans/` pair fixture: byte-identical behavior to current
- Regression: `docs/specs/2026-07-03-wlm-6-surface-and-workflow-fixes.md` parses as 4 DRs / 7 tasks
- `NO_DESIGN_SECTIONS` / `No '### Task' headers` error messages name both accepted shapes

### DR-2: Task-decomposition test detection counts digit-bearing names and real description prose

The MSO test-name regex must tolerate digits in segment bodies (`MigrateV6ToV7_RunTwice_IsIdempotent` counts as 1 test), and the description signal must accept a task's prose body without requiring a literal `**Goal:**`/`**Description:**` introducer. (#1692)

**Acceptance criteria:**
- `MsoPattern_TestNameWithVersionToken_IsCounted` and no-digit regression test both green
- A task whose body is naked prose with no field introducer reports `hasDescription: true` at ≥10 words
- Corpus run over `docs/specs/*.md`: the description column is not uniformly negative

### DR-3: Plan-coverage honors Implements declarations over keyword similarity

`computeCoverage` must treat parsed `**Implements:** DR-N` references as the authoritative section→task mapping; title/keyword matching degrades to a compatibility path for tasks declaring no `Implements:` at all. Both false directions close. (#1709)

**Acceptance criteria:**
- A task declaring `Implements: DR-N` whose title shares zero keywords with DR-N → Covered (today: GAP)
- A task NOT declaring DR-N but sharing ≥2 title keywords → not credited to DR-N (today: Covered)
- Coverage matrix and `check_provenance_chain` agree on the #1709 repro document (18/18)

### DR-4: Task-decomposition file allowlist recognizes asset extensions

`FILE_EXTENSION_ALLOWLIST` gains `svg`, `png`, `jpg`, `jpeg`, `webp`, `ico`, `gif`. (#1710)

**Acceptance criteria:**
- A task declaring only `documentation/public/logo.svg` parses to 1 file and PASSes at low tier
- Dotted-identifier prose tokens remain rejected (existing regression suite green)

### DR-5: Grep gates fail loudly on empty file selection

No grep-gate may pass over an empty file set without saying so. `check-withsession-idempotency.sh` exits non-zero on empty selection by default, with an explicit declared-dormant flag for the current zero-consumer CI step so vacuity is visible configuration, not silent green. This is the error-handling/failure-mode requirement: the defect class is a gate whose failure state is indistinguishable from success. (#1694)

**Acceptance criteria:**
- Default invocation with zero matching files exits non-zero with a "selector matched no files" message
- CI step passes the declared-dormant flag with an explanatory comment; a seeded `withSession` consumer violating the idempotency pattern fails the gate
- Self-test covers both empty-selection modes; existing 11/11 self-tests stay green

### DR-6: One-copy projection-scope claim enforced by grep gate

New `scripts/check-scope-claim-single-copy.sh` (modeled on `check-begin-immediate-substrate.sh`, including its block-comment-prefix fix) greps for the projection-scope guarantee phrasings outside the two allowlisted homes (`projections/types.ts`, `docs/architecture/projections.md`), with a self-test and blocking CI wiring. (#1696)

**Acceptance criteria:**
- Exits 0 on the current tree; exits 1 on a seeded restatement in a non-allowlisted file
- Kill-probe: stubbing the gate to `exit 0` turns the self-test red
- Passes against a pristine `git archive` export of HEAD

### DR-7: Discover skill event emissions align with the registered catalog

The "Event Emissions" section prescribing unregistered `discovery.*` types is deleted from `skills-src/discover/SKILL.md`; rendered runtimes regenerate. (#1716, dogfood triage 2026-07-17)

**Acceptance criteria:**
- `npm run build:skills` + `npm run skills:guard` green after deletion; zero `discovery.*` append examples remain in `skills-src/`
- Stretch: a skills-src lint asserting every `type:` in an `exarchos_event` append example exists in the registered catalog

### DR-8: MCP caller-posture handshake resolves live capability tiers

The stubbed initialize-handshake posture derivation is implemented per INV-11 (handshake-authoritative merge with agent-spec posture), so a live MCP caller declaring a mutating posture can reach `serialize_merge`, `prune_worktrees`, and `merge_orchestrate`; undeclared callers still default read-only. (#1688)

**Acceptance criteria:**
- Integration test: a caller with a shared-mutating handshake invokes `serialize_merge` without CAPABILITY_DENIED
- A caller with no posture declaration remains read-only (regression)
- Posture resolution is logged/queryable for diagnosis (INV-5b carrier fields)

### DR-9: JSON-RPC error model maps the ErrorCode taxonomy

The MCP adapter maps the Exarchos `ErrorCode` taxonomy to JSON-RPC `-32xxx` codes and stamps `_meta.errorCode` on error envelopes, emitting `dispatch.error_surfaced`, with zero handler changes (adapter-only per INV-2). (#1278)

**Acceptance criteria:**
- Every registered ErrorCode has a deterministic JSON-RPC mapping (exhaustiveness test)
- CLI and MCP envelopes carry the same `errorCode` for the same failure (parity test)
- `dispatch.error_surfaced` fires on surfaced errors; retired DIM-*/axiom vocabulary stripped from the issue's framing

### DR-10: Retry-class contract distinguishes transient from conflict errors

A typed `Record<ErrorCodeValue, RetryClass>` distinguishes STORAGE_BUSY (retry with backoff) from CONCURRENCY_CONFLICT (re-read state, re-derive intent), consumed at the CLI's seven discrimination sites. (#1693)

**Acceptance criteria:**
- Exhaustive mapping — a new ErrorCode without a RetryClass fails typecheck
- All seven CLI sites consume the shared map (no local re-derivation); tests cover both classes' guidance text

### DR-11: Event-store default queries bounded at the storage layer

The storage contract gains count + LIMIT/OFFSET so default queries never load whole streams; both backends implement it identically (INV-2, INV-17). (#1685)

**Acceptance criteria:**
- Default query path issues bounded SQL (asserted via query plan or call capture) on both backends
- Pagination metadata (`total`, `hasMore`) preserved; existing consumers green

### DR-12: ps view gathers operation events without per-type sequential queries

`gatherOperationEvents` drops the inner event-type loop; query count is pinned independent of type count. (#1691)

**Acceptance criteria:**
- Query count ≤ number of streams (asserted via instrumented store)
- `ps` output byte-identical on a fixture before/after

### DR-13: Launcher spawn/teardown typed contract with lifecycle events

The launcher's spawn/teardown boundary carries a typed envelope (workspaceRef, rehydrationDoc, posture), fail-closed tree-hash verification, and `worktree.created`/`worktree.finalized` events; no mid-session responsibilities accrue to the launcher (INV-5c, INV-12). Includes the intent-fidelity field audit added 2026-07-06. (#1644)

**Acceptance criteria:**
- Envelope schema registered and validated at spawn and teardown; tree-hash mismatch fails closed with a structured error
- Lifecycle events land on the workflow stream and are queryable via `ps`/`inspect`
- Field audit documented: every envelope field traces to a consuming seam

### DR-14: Context-rot counter gates rehydration at the dispatch seam

A server-side context-rot counter increments at the dispatch seam; soft signal promotes rehydrate via `next_actions`, hard gate (INV-9) applies to phase-mutating verbs only. Depends on DR-13's envelope. (#1647)

**Acceptance criteria:**
- Non-phase-mutating verbs never hard-blocked (regression)
- Phase-mutating verb with rot above threshold → structured error naming the rehydrate affordance
- Counter derivation is a pure fold over events (INV-1)

### DR-15: WLM merge-serializer hardening closes reserve-path modeling gaps

The three deferred #1631 review items land: reserve-path null start-time modeling, `mergeSha` enforcement via two-step superRefine, and the finally-mask guard. (#1633)

**Acceptance criteria:**
- Each item carries a targeted unit test reproducing the review finding
- Merge-serializer suite green; no behavior change on the happy path

### DR-16: stateFingerprint required on the INV-13 intent/result pair

The INV-13 `*.requested`/`*.executed` event pair carries a required `stateFingerprint {treeHash, projectionSequence}` (schema version bump); the WLM tree-hash is the source. (#1645)

**Acceptance criteria:**
- Schema rejects the pair without fingerprint at the new version; old-version events still fold (compatibility test)
- Crash-recovery precheck consumes the fingerprint to detect external-state drift

### DR-17: WLM slice-3 deferrals close win32 liveness and perf gaps

Win32 liveness detection goes fail-closed, the compensation stream-scan gets a perf bound, the prune finally-mask lands, and a deterministic win32 process-table seam un-skips the skipped suites (INV-10, INV-16). (#1641)

**Acceptance criteria:**
- Win32 liveness returns a determinate verdict or a structured failure — never silent fail-open
- Previously `skipIf(win32)` suites run against the deterministic seam
- Compensation scan bounded (measured on a seeded wide stream)

### DR-18: merge.rollback deprecation shim removed

The four dual-emit sites are deleted and `rollbackSha`/`rollbackError` wire fields renamed per the v2.12 cleanup note. (#1570)

**Acceptance criteria:**
- Zero `merge.rollback` emissions remain (grep + event-catalog check); consumers read the successor fields
- Event-store fold over historical `merge.rollback` events still works (INV-1 compatibility)

### DR-19: Subagent token capture proven end-to-end

One live worktree-isolated dispatch with the SubagentStop hook registered produces `subagent.tokens_used`, visible in `team_performance` and `delegation_timeline`. Operational proof run, not code. (#1561)

**Acceptance criteria:**
- The proof run's evidence (event + both views showing non-zero tokens) attached to the issue before close

### DR-20: Checkpoint context accepts @path argument substitution

`workflow checkpoint --context @<path>` reads the file into the handoff context field with path validation, a size cap, and a structured ENOENT error. (#1245)

**Acceptance criteria:**
- Valid path substitutes content; oversize and missing paths return structured errors (INV-5b), not raw exceptions

### DR-21: Conform-and-shrink LOW review follow-ups closed

The five deferred LOW findings from the #1650 review are fixed or individually closed as already-resolved with verification notes (L1 may have been fixed by the M2 malformed-marker fix). (#1649)

**Acceptance criteria:**
- Each of the five findings has a commit or a documented no-op verification

### DR-22: Event-store tool test suites co-located

`__tests__/event-store/tools.test.ts` merges into the co-located suite; the non-co-located file is deleted with no assertion loss. (#1686)

**Acceptance criteria:**
- Test count before == after; `__tests__/event-store/` directory removed

### DR-23: Prune-stale-workflows falls back to built-in topology

When `topology.yaml` is absent, `prune_stale_workflows` uses the built-in TS topology instead of aborting `topology_not_loaded` (root cause at `context.ts:226`). Closes the shared symptom in #1566. (#1545)

**Acceptance criteria:**
- Repo without `topology.yaml`: prune completes and reports; with `topology.yaml`: unchanged
- #1566's prune symptom close-linked; its pipeline-view remainder tracked under DR-27

### DR-24: sync-marketplace standalone populates the new plugin cache

The standalone path populates the new cache dir and updates `installed_plugins.json` instead of pruning-then-silently-reverting. (#1690)

**Acceptance criteria:**
- After a standalone sync, the harness loads the NEW version (verified by version marker), with no silent re-download of the old

### DR-25: MCP test files included in typecheck

Test files enter typecheck via a `tsconfig.test.json` + `typecheck:test` script (folding #1196's plan and re-measured error baseline), burned down in waves, ending with a single `typecheck` covering everything. (#1684)

**Acceptance criteria:**
- `typecheck:test` wired in CI and green at each wave boundary; final state has no test-file excludes
- Baseline re-measured post-#1714 strict flags and recorded on the issue

### DR-26: Phase gates resolve commands through the toolchain resolver

The six gates hardcoding `npm run`/`npx vitest` route through `resolveTestRuntime` (INV-6); output parsing generalizes per toolchain; redundant `prepare_synthesis`/`pre_synthesis_check` merge. The monorepo-root vitest-JSON failure is re-verified and #1537 closed by evidence. (#1656, stretch)

**Acceptance criteria:**
- No gate holds an independent toolchain command literal (grep gate or unit assertion)
- `check_integration_suite` passes at a monorepo root with green suites (the #1537 repro)

### DR-27: Stale-projection defects re-verified post-task-store retirement

#1536 (prepare_synthesis phantom in-progress blockers) and #1566's pipeline-view terminal-event folding are re-reproduced against post-#1697/#1712 main; each is fixed if live or closed with recorded evidence if not. (#1536, #1566 remainder)

**Acceptance criteria:**
- Each defect has either a failing-then-green regression test or a documented non-repro against current main

## Decomposition

### Scope

Full coverage: all 27 DRs decompose to tasks below. No deferrals. Wave A (tasks 001–006) is the critical path for the milestone's gate integrity and un-breaks the parsers verifying this very spec; Waves B (007–011), C (012–016), and D (017–024) are mutually independent; task 025 is the approved stretch; task 026 is evidence-budgeted verification. Tasks sharing a file are serialized via Dependencies and marked non-parallelizable; everything else runs in parallel worktrees per the delegate playbook.

### Traceability matrix (DR-N → tasks)

| DR | Task(s) | | DR | Task(s) |
|----|---------|-|----|---------|
| DR-1 | 001 | | DR-15 | 014 |
| DR-2 | 003 | | DR-16 | 015 |
| DR-3 | 002 | | DR-17 | 016 |
| DR-4 | 003 | | DR-18 | 017 |
| DR-5 | 004 | | DR-19 | 018 |
| DR-6 | 005 | | DR-20 | 019 |
| DR-7 | 006 | | DR-21 | 020 |
| DR-8 | 007 | | DR-22 | 021 |
| DR-9 | 008 | | DR-23 | 022 |
| DR-10 | 009 | | DR-24 | 023 |
| DR-11 | 010 | | DR-25 | 024 |
| DR-12 | 011 | | DR-26 | 025 |
| DR-13 | 012 | | DR-27 | 026 |
| DR-14 | 013 | | | |

### Tasks

Each task carries a `**Risk Tier:**` stamp selecting verification depth per the ladder; tests are judged test-after by adequacy.

### Task 001: Teach plan-gate parsers the unified spec template shape

**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-1
**Verification (high):** scoped tests + kill-probe + gate-fixture integration. Dual-shape section/task recognition in the three h3-only parsers; `task-decomposition.ts` already handles h4 (#1670).
**Files:** `servers/exarchos-mcp/src/orchestrate/plan-coverage.ts`, `servers/exarchos-mcp/src/orchestrate/pure/provenance-chain.ts`, `servers/exarchos-mcp/src/orchestrate/generate-traceability.ts`, `servers/exarchos-mcp/src/orchestrate/plan-coverage.test.ts`
**Expected tests:** `UnifiedSpec_TemplateVerbatim_ParsesDrsAndTasks`, `LegacyPair_TwoFileShape_Unchanged`, `WlmCorpusSpec_UnifiedShape_ParsesFourDrsSevenTasks`
**Dependencies:** None · **Parallelizable:** No (shares `plan-coverage.ts` with 002)

### Task 002: Plan-coverage honors Implements declarations over keyword similarity

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-3
**Verification (medium):** scoped tests + kill-probe. `Implements:` becomes the authoritative mapping in `computeCoverage`; keyword matching degrades to the no-declaration compatibility path.
**Files:** `servers/exarchos-mcp/src/orchestrate/plan-coverage.ts`, `servers/exarchos-mcp/src/orchestrate/plan-coverage.test.ts`
**Expected tests:** `ImplementsDeclared_NoKeywordOverlap_IsCovered`, `KeywordCollision_UndeclaredTask_NotCredited`
**Dependencies:** 001 · **Parallelizable:** No

### Task 003: Task-decomposition digit-tolerant test regex, description prose, asset allowlist

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-2, DR-4
**Verification (medium):** scoped tests + kill-probe + corpus regression over `docs/specs/*.md`.
**Files:** `servers/exarchos-mcp/src/orchestrate/task-decomposition.ts`, `servers/exarchos-mcp/src/orchestrate/task-decomposition.test.ts`
**Expected tests:** `MsoPattern_VersionTokenName_IsCounted`, `ProseBody_NoFieldIntroducer_HasDescription`, `AssetOnlyTask_SvgFile_PassesLowTier`
**Dependencies:** None · **Parallelizable:** Yes

### Task 004: Grep gates fail loudly on empty file selection

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-5
**Verification (medium):** shell self-tests, both empty-selection modes + seeded violating consumer.
**Files:** `scripts/check-withsession-idempotency.sh`, `scripts/check-withsession-idempotency.test.sh`, `.github/workflows/ci.yml`
**Expected tests:** `EmptySelection_DefaultMode_ExitsNonzero`, `EmptySelection_DeclaredDormant_Passes`, `SeededConsumer_ViolatingPattern_FailsGate`
**Dependencies:** None · **Parallelizable:** No (shares `ci.yml` with 005)

### Task 005: One-copy projection-scope claim grep gate

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-6
**Verification (medium):** self-test with seeded restatement, kill-probe, pristine git-archive run.
**Files:** `scripts/check-scope-claim-single-copy.sh`, `scripts/check-scope-claim-single-copy.test.sh`, `.github/workflows/ci.yml`
**Expected tests:** `SeededRestatement_NonAllowlistedFile_ExitsOne`, `KillProbe_StubbedGate_SelfTestRed`, `PristineArchive_CurrentTree_ExitsZero`
**Dependencies:** 004 · **Parallelizable:** No

### Task 006: Delete discover skill event-emissions section

**Risk Tier:** low · **Boundary Touching:** false
**Implements:** DR-7
**Verification (low):** static — `npm run build:skills` + `npm run skills:guard` green; grep proves zero `discovery.` append examples remain.
**Files:** `skills-src/discover/SKILL.md`
**Dependencies:** None · **Parallelizable:** Yes

### Task 007: Implement MCP caller-posture handshake resolution

**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-8
**Verification (high):** medium set + integration across the initialize→capability-resolver seam per INV-11.
**Files:** `servers/exarchos-mcp/src/capabilities/resolver.ts`, `servers/exarchos-mcp/src/adapters/mcp.ts`, `servers/exarchos-mcp/src/capabilities/resolver.test.ts`
**Expected tests:** `SharedMutatingHandshake_SerializeMerge_Executes`, `UndeclaredCaller_PostureDefault_ReadOnly`, `HandshakeMismatch_AgentSpec_HandshakeWins`
**Dependencies:** None · **Parallelizable:** Yes

### Task 008: JSON-RPC error model with meta errorCode mapping

**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-9
**Verification (high):** medium set + CLI↔MCP envelope parity integration (INV-2); adapter-only, zero handler changes.
**Files:** `servers/exarchos-mcp/src/adapters/mcp.ts`, `servers/exarchos-mcp/src/format.ts`, `servers/exarchos-mcp/src/adapters/mcp.test.ts`
**Expected tests:** `ErrorCodeTaxonomy_EveryCode_MapsJsonRpc`, `CliMcpEnvelope_SameFailure_SameErrorCode`, `DispatchErrorSurfaced_OnError_Emitted`
**Dependencies:** None · **Parallelizable:** No (shares `adapters/mcp.ts` with 007)

### Task 009: Retry-class contract for transient versus conflict errors

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-10
**Verification (medium):** scoped tests + kill-probe; exhaustiveness enforced at the type level.
**Files:** `servers/exarchos-mcp/src/errors/retry-class.ts`, `src/cli/error-presentation.ts`, `servers/exarchos-mcp/src/errors/retry-class.test.ts`
**Expected tests:** `RetryClassMap_EveryErrorCode_Exhaustive`, `StorageBusy_RetryClass_BackoffGuidance`, `ConcurrencyConflict_RetryClass_ReReadGuidance`
**Dependencies:** 008 · **Parallelizable:** No

### Task 010: Bound default event-store queries at the storage layer

**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-11
**Verification (high):** medium set + both-backend integration parity (INV-2).
**Files:** `servers/exarchos-mcp/src/event-store/store.ts`, `servers/exarchos-mcp/src/event-store/store.test.ts`
**Expected tests:** `DefaultQuery_BoundedSql_BothBackends`, `Pagination_TotalHasMore_Preserved`
**Dependencies:** None · **Parallelizable:** Yes

### Task 011: ps view gathers operation events with a pinned query count

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-12
**Verification (medium):** scoped tests + fixture byte-comparison.
**Files:** `servers/exarchos-mcp/src/views/ps.ts`, `servers/exarchos-mcp/src/views/ps.test.ts`
**Expected tests:** `GatherOperationEvents_QueryCount_AtMostStreams`, `PsOutput_Fixture_ByteIdentical`
**Dependencies:** None · **Parallelizable:** Yes

### Task 012: Launcher spawn-teardown typed contract with lifecycle events

**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-13
**Verification (high):** medium set + spawn→teardown integration across the launcher seam; fail-closed tree-hash; field audit documented.
**Files:** `src/launcher/contract.ts`, `src/launcher/launcher.ts`, `src/launcher/contract.test.ts`
**Expected tests:** `SpawnEnvelope_TreeHashMismatch_FailsClosed`, `LifecycleEvents_SpawnTeardown_LandOnStream`, `EnvelopeFields_IntentAudit_AllConsumed`
**Dependencies:** None · **Parallelizable:** Yes

### Task 013: Context-rot counter with rehydrate gating at the dispatch seam

**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-14
**Verification (high):** medium set + dispatch-seam integration; hard gate scoped to phase-mutating verbs only (INV-9); counter is a pure fold (INV-1).
**Files:** `servers/exarchos-mcp/src/dispatch/context-rot.ts`, `servers/exarchos-mcp/src/dispatch/context-rot.test.ts`
**Expected tests:** `NonPhaseMutatingVerb_HighRot_NeverBlocked`, `PhaseMutatingVerb_RotAboveThreshold_StructuredError`, `RotCounter_EventFold_Pure`
**Dependencies:** 012 · **Parallelizable:** No

### Task 014: Merge-serializer hardening for reserve-path modeling gaps

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-15
**Verification (medium):** scoped tests reproducing each of the three #1631 review findings + kill-probe.
**Files:** `servers/exarchos-mcp/src/merge-serializer.ts`, `servers/exarchos-mcp/src/merge-serializer.test.ts`
**Expected tests:** `ReservePath_NullStartTime_Modeled`, `MergeSha_SuperRefine_TwoStepEnforced`, `FinallyMask_ErrorPath_Guarded`
**Dependencies:** None · **Parallelizable:** Yes

### Task 015: Require stateFingerprint on the intent-result event pair

**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-16
**Verification (high):** medium set + schema-version compatibility integration (old events still fold, INV-13/INV-8 preserved).
**Files:** `servers/exarchos-mcp/src/event-store/schemas.ts`, `servers/exarchos-mcp/src/event-store/schemas.test.ts`
**Expected tests:** `IntentResultPair_MissingFingerprint_Rejected`, `OldVersionEvents_Fold_Compatible`, `CrashRecovery_FingerprintDrift_Detected`
**Dependencies:** None · **Parallelizable:** Yes

### Task 016: WLM slice-3 win32 liveness fail-closed and perf bounds

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-17
**Verification (medium):** scoped tests against the deterministic win32 process-table seam (INV-16); previously-skipped suites re-enabled; compensation scan measured on a seeded wide stream.
**Files:** `servers/exarchos-mcp/src/worktree-lifecycle/liveness.ts`, `servers/exarchos-mcp/src/worktree-lifecycle/liveness.test.ts`
**Expected tests:** `WinLiveness_IndeterminateEnum_FailsClosed`, `CompensationScan_WideStream_Bounded`, `PruneFinally_ErrorPath_Unmasked`
**Dependencies:** None · **Parallelizable:** Yes

### Task 017: Remove the merge rollback deprecation shim

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-18
**Verification (medium):** scoped tests; historical-event fold compatibility (INV-1); grep proves zero remaining emissions.
**Files:** `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts`, `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.test.ts`
**Expected tests:** `MergeRollback_Emissions_Zero`, `HistoricalRollbackEvents_Fold_Works`
**Dependencies:** None · **Parallelizable:** Yes

### Task 018: Prove subagent token capture end-to-end

**Risk Tier:** low · **Boundary Touching:** false
**Implements:** DR-19
**Verification (low):** operational proof run — one worktree-isolated dispatch with the SubagentStop hook registered; evidence (event + both views) recorded on #1561 before close.
**Files:** `docs/rca/2026-07-17-subagent-token-capture-proof.md`
**Dependencies:** None · **Parallelizable:** Yes

### Task 019: Checkpoint context argument path substitution

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-20
**Verification (medium):** scoped tests + kill-probe; structured errors per INV-5b.
**Files:** `src/cli/checkpoint.ts`, `src/cli/checkpoint.test.ts`
**Expected tests:** `ContextAtPath_ValidFile_Substitutes`, `ContextAtPath_MissingFile_StructuredEnoent`, `ContextAtPath_OversizeFile_StructuredError`
**Dependencies:** None · **Parallelizable:** Yes

### Task 020: Close conform-and-shrink LOW review follow-ups

**Risk Tier:** low · **Boundary Touching:** false
**Implements:** DR-21
**Verification (low):** static analysis; each of the five findings gets a commit or a documented no-op verification (L1 may already be fixed by the M2 malformed-marker fix).
**Files:** `src/harness/conform.ts`, `docs/architecture/harness-conformance.md`
**Dependencies:** None · **Parallelizable:** Yes

### Task 021: Co-locate the event-store tools test suite

**Risk Tier:** low · **Boundary Touching:** false
**Implements:** DR-22
**Verification (low):** static + suite-count equality before/after; non-co-located file deleted.
**Files:** `servers/exarchos-mcp/src/__tests__/event-store/tools.test.ts`, `servers/exarchos-mcp/src/event-store/tools.test.ts`
**Dependencies:** None · **Parallelizable:** Yes

### Task 022: Prune stale workflows falls back to built-in topology

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-23
**Verification (medium):** scoped tests + kill-probe at the `context.ts:226` seam.
**Files:** `servers/exarchos-mcp/src/context.ts`, `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts`, `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.test.ts`
**Expected tests:** `NoTopologyYaml_BuiltinFallback_PruneCompletes`, `TopologyYamlPresent_ExplicitLoad_Unchanged`
**Dependencies:** None · **Parallelizable:** Yes

### Task 023: Sync-marketplace standalone populates the new plugin cache

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-24
**Verification (medium):** shell self-test — standalone sync then version-marker assertion; no silent re-download of the old version.
**Files:** `scripts/sync-marketplace.sh`, `scripts/sync-marketplace.test.sh`
**Expected tests:** `StandaloneSync_NewCache_Populated`, `StandaloneSync_InstalledPluginsJson_Updated`
**Dependencies:** None · **Parallelizable:** Yes

### Task 024: Include MCP test files in typecheck

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-25
**Verification (medium):** `typecheck:test` wired and green at each burn-down wave boundary; baseline re-measured post-#1714 and recorded on #1684.
**Files:** `servers/exarchos-mcp/tsconfig.json`, `servers/exarchos-mcp/tsconfig.test.json`, `servers/exarchos-mcp/package.json`, `.github/workflows/ci.yml`
**Dependencies:** 005 · **Parallelizable:** No (shares `ci.yml` with 004/005)

### Task 025: Route phase gates through the toolchain resolver

**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-26
**Verification (high):** medium set + monorepo-root integration (the #1537 repro); no gate holds an independent command literal; `prepare_synthesis`/`pre_synthesis_check` merged.
**Files:** `servers/exarchos-mcp/src/orchestrate/check-integration-suite.ts`, `servers/exarchos-mcp/src/orchestrate/static-analysis.ts`, `servers/exarchos-mcp/src/config/toolchains.ts`, `servers/exarchos-mcp/src/orchestrate/check-integration-suite.test.ts`
**Expected tests:** `PhaseGates_NoHardcodedCommands_GrepAsserted`, `MonorepoRoot_GreenSuites_IntegrationGatePasses`, `ToolchainResolver_PerGate_ResolvesCommands`
**Dependencies:** None · **Parallelizable:** Yes

### Task 026: Re-verify stale-projection defects post task-store retirement

**Risk Tier:** medium · **Boundary Touching:** false
**Implements:** DR-27
**Verification (medium):** re-repro probes against post-#1697/#1712 main; failing-then-green regression test where live, documented non-repro where not.
**Files:** `servers/exarchos-mcp/src/orchestrate/prepare-synthesis.ts`, `servers/exarchos-mcp/src/views/pipeline.ts`, `servers/exarchos-mcp/src/orchestrate/prepare-synthesis.test.ts`
**Expected tests:** `PrepareSynthesis_PostRetirementFold_NoPhantomBlockers`, `PipelineView_TerminalEvents_Folded`
**Dependencies:** None · **Parallelizable:** Yes

### Parallelization

- **Serialized chains:** 001→002 (plan-coverage.ts), 004→005→024 (ci.yml), 007→008→009 (adapters/mcp.ts + error seam), 012→013 (launcher contract → dispatch gating).
- **Fully parallel:** 003, 006, 010, 011, 014, 015, 016, 017, 018, 019, 020, 021, 022, 023, 025, 026.
- **Wave gating:** Wave A (001–006) merges before Waves B–D dispatch at scale, so later tasks are verified by un-broken gates; 025 (stretch) and 026 (verify-first) float freely.

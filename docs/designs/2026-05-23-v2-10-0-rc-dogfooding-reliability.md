# v2.10.0 RC — Dogfooding-Reliability Hardening

- **Date:** 2026-05-23
- **Feature ID:** `v2-10-0-rc-dogfooding-reliability`
- **Milestone:** v2.10.0 — Agent Output Contract (#16)
- **Current build:** `2.10.0-preview.4`
- **Target:** RC1 (this unit) → optional RC2 (#1395) → GA
- **Skills applied:** `/axiom:design` (DIM-*), `/design-invariants` (INV-*)

## Problem

`v2.10.0` is feature-complete: the milestone's namesake work — the Agent Output
Contract (`outputSchema` + `structuredContent`, #1266–#1271) — has landed, along
with the Marten primitive substrate (preview.2) and four preview builds of
stabilization. 55 issues are closed; 19 remain open. RC discipline says an RC is
feature-complete and admits only bugfixes — a new feature resets the RC clock.

The 19 open issues are not one theme. They split into (a) **orchestration /
dogfooding-reliability bugs**, (b) substrate/contract refinements, and (c)
feature/test-expansion work (description-budget guard #1321, conformance harness
#1169, e2e fixtures #1232–#1234, Windows matrix #1170). Only (a) is GA-blocking:
GA promises that the runtime can be trusted to drive its own SDLC, and (a) is
exactly the set of bugs that has repeatedly corrupted that loop during Exarchos's
own dogfooding (each one is recorded in project memory as a recurring footgun).

This unit fixes the dogfooding-reliability cluster and nothing else. Features and
test-expansion are explicitly deferred to v2.11 so they cannot reset the RC.

## Scope (RC1)

| # | Bug | Invariant / dimension hit |
|---|---|---|
| **#1301** | implementer worktree edits leak into the main worktree's working tree, blocking FF-merge | **INV-11** posture (`task-isolated` write-outside-worktree should be unrepresentable) |
| **#1330** | `check_static_analysis` runs `tsc` in the orchestrator's main worktree, not the agent's worktree — gate is a coin-flip | **DIM-4** test-fidelity; **INV-2** facade-equivalence |
| **#1329** | per-task TDD gates pass while the integration tip cascades (125 files failing to load) — no full-suite check between merges | **DIM-4** test-fidelity |
| **#1339** | state-machine fix-cycle / compound-exit events emit `compoundStateId: undefined`, violating `WorkflowFixCycleData` (`z.string()`); slips through the legacy `EventStore.append` path | **INV-1** event-sourcing integrity |
| **#1292** | SDK pin policy (premise stale — see below) | **INV-5b** output contract (Tasks experimental surface) |

**Optional RC2:** #1395 (promote deterministic model-emitted events to
auto-emitted). Scoped as RC2 because it is an *investigation → migration*, not a
point fix: only if the inventory pass classifies events as cleanly auto-emittable
does a code change land. If it does, it is still bugfix-shaped (drift removal,
**INV-1**), so it does not reset the RC.

**Explicitly deferred to v2.11 (out of this RC):** #1321, #1169, #1234, #1233,
#1232, #1170, #1337, #1299, #1296, #1353, #1352, and the #1088/#1342 epic
trackers. Rationale: features (#1321, #1169), test-expansion (#1232–#1234, #1337,
#1299), independent platform track (#1170), conditional cleanup (#1296), and
substrate refinements already behind a working heuristic guard (#1353 — the
`projections/store.ts:333-348` backdated-event fallback covers the common case;
#1352 — the `create-issue` arm already landed in #1348).

## Discovered during research — design corrections to the issue text

**#1292 premise is stale.** The issue's diff assumes `"@modelcontextprotocol/sdk":
"^1.0.0"` and argues a caret range lets `1.27.x` silently break the experimental
Tasks surface. The dependency is *already* exact-pinned at `1.29.0` (no caret).
So the work is not "add a pin" — it is "ratify the pin policy": confirm `1.29.0`
is the intended floor, replace the floating-exact with an `x`-range or keep exact
with a documented per-minor review note, and record the policy. Trivial, but the
issue must be re-scoped before implementation or the plan will chase a non-bug.

**#1330 root cause confirmed in code.** `static-analysis.ts` resolves
`const repoRoot = args.repoRoot || process.cwd()`. When the orchestrator gate
omits `repoRoot` (or passes `'.'`), `tsc` runs against the orchestrator's working
tree, which does not yet contain the agent's diff. The fix is to make the agent's
worktree path the gate's `repoRoot`, not to change the pure analysis function.

**#1339 site confirmed.** `workflow/state-machine.ts:792` emits the `fix-cycle`
event with `metadata: { compoundStateId: parent?.id }`; `getParentCompound` returns
`undefined` for a non-compound child. The `compound-entry` (line 767, `ancestor.id`)
and `circuit-open` (line 681, guarded by `parent?.maxFixCycles != null`) sites are
safe. Only the optional-chained `parent?.id` is the live defect.

## Constraint analysis (Phase 0 invariants + axiom dimensions)

The dev-invariants catalog is active (`.exarchos.yml: invariants.devCatalog:
enabled`). The load-bearing invariants for this unit:

- **INV-11 (posture, unrepresentable-by-construction).** #1301 is the headline
  invariant hit. "A task-isolated agent cannot write outside its assigned
  worktree" is supposed to be structurally impossible, yet byte-identical edits
  appear in the main worktree. The fix must restore the *by-construction*
  property, not merely detect-and-recover after the fact — though detection is an
  acceptable RC-time defense-in-depth backstop while the root mirroring leak is
  diagnosed.
- **INV-1 (event-sourcing integrity).** #1339 lets an event whose `data` violates
  its declared schema reach the log via the legacy `append` path. The fix routes
  the emission through schema validation (`buildValidatedEvent` /
  `EVENT_DATA_SCHEMAS`) *or* drops the field when there is no parent compound —
  either way the log must never carry a schema-invalid event.
- **INV-2 (facade-equivalence).** The #1330 gate fix changes a dispatch-core
  input (`repoRoot` resolution), not adapter behavior. CLI and MCP must continue
  to produce identical `ToolResult`s for the same `DispatchContext`; the parity
  test suite (`*.parity.test.ts`) must stay green.
- **INV-5b (output contract).** #1292 touches only the SDK that carries the
  Tasks/`structuredContent` surface; pin policy bounds API-stability risk.
- **DIM-4 (test-fidelity, axiom).** #1329 and #1330 are both gate-fidelity bugs —
  the gate does not observe what actually runs. The design's north star is: a
  green gate must mean a green integration tip.
- **DIM-2 / DIM-7 (observability / resilience).** #1395 (RC2) and the #1339 fix
  improve event-stream truthfulness and recovery determinism.

Rejected by **INV-15 (single-machine frame):** no distributed-coordination
primitive is admissible. The #1301 fix is a local worktree/path-resolution
correction, not cross-process locking.

## Option 1 — Detection-and-recover backstop (narrow)

Treat #1301 as unfixable-at-source in this RC (the leak is in the agent harness's
file-tool path resolution, partly outside the MCP server) and instead harden
`verify-worktree-baseline` to detect leaked changes at merge time and auto-discard
them when byte-identical to a committed agent change. Fix #1330/#1329/#1339 as
point fixes.

- **Pros:** Smallest blast radius; ships in one RC; #1301 mitigation matches the
  documented manual workaround (`git checkout -- <path>`).
- **Cons:** Leaves the INV-11 *by-construction* violation in place — we detect a
  symptom rather than make the leak unrepresentable. Recovery heuristic
  ("byte-identical to a committed agent change") has edge cases.
- **Best when:** The root mirroring leak proves to live entirely in the harness
  and cannot be touched from the MCP server before GA.

## Option 2 — Gate-fidelity unification + targeted source fixes (recommended)

Fix each bug at the layer that owns it, unified by one principle — *gates and
isolation must observe the agent's real worktree state*:

1. **#1330 — worktree-aware `repoRoot`.** Thread the agent's worktree path into
   the `task-completion` runbook step's `templateVars` so `check_static_analysis`
   runs `tsc` where the diff actually is. Add a `repoRoot: 'auto'` resolution that
   reads the calling delegation's worktree from `prepare_delegation` state.
2. **#1329 — integration full-suite gate.** Add a `check_integration_suite`
   orchestrate action that runs the full vitest suite against the integration tip
   after each task merges (not the per-task scope), and *counts files that fail to
   load as failures* (vitest's silent "0 failed tests, 1 failed file" mode is the
   trap). Wire it as a post-merge gate in the delegate runbook.
3. **#1339 — schema-valid emission.** Guard the `fix-cycle` emission: omit
   `compoundStateId` when `parent` is undefined (and relax `WorkflowFixCycleData`
   to make it optional for the non-compound case), and route HSM-internal event
   emission through `buildValidatedEvent` so the legacy path can no longer launder
   schema-invalid events.
4. **#1301 — by-construction + backstop.** Diagnose the working-tree mirroring
   leak (path-resolution hypothesis in the issue); the durable fix restores the
   INV-11 property. Pair it with the Option-1 baseline-detection backstop as
   defense-in-depth so a regression is caught at merge even if the root fix
   regresses.
5. **#1292 — ratify pin.** Confirm `1.29.0` floor, document per-minor review
   policy, no functional change.

- **Pros:** Every fix lands at the correct architectural layer; the #1330/#1329
  pair closes the gate-fidelity hole as a unit; #1301 keeps the INV-11 property
  rather than papering over it; all changes are bugfix-shaped (no RC reset).
- **Cons:** #1301 root-cause diagnosis is the long pole and may spill into RC2 if
  the harness layer is implicated; larger surface than Option 1.
- **Best when:** GA must mean "the dogfooding loop is trustworthy by
  construction" — which is the selected RC thesis.

## Option 3 — Full milestone drain

Pull every (a)+(b) issue (add #1353, #1352, #1342 leverage) into the RC for a
maximal-confidence GA.

- **Pros:** Cleanest milestone close.
- **Cons:** #1353/#1352 are refinements behind working guards/partial landings —
  including them widens the RC for marginal correctness gain and risks new
  regressions in stabilization-only territory. Violates RC minimalism.
- **Best when:** No GA time pressure and a desire to zero the milestone.

## Recommendation

**Option 2.** It is the only option that treats #1301 as an INV-11 obligation
(restore the by-construction property, with detection as a backstop rather than a
substitute) while closing the #1329/#1330 gate-fidelity pair as a coherent unit.
It holds the RC to bugfix-only work, defers all features cleanly to v2.11, and
sequences the one open-ended item (#1301 root cause; #1395 investigation) so it
can slip to RC2 without blocking the rest of the RC1 fixes from shipping.

**Sequencing:**
- **RC1:** #1292 (trivial, lands first) → #1339 (isolated, schema) → #1330 →
  #1329 (depends on #1330's worktree-path threading) → #1301 (root fix +
  backstop).
- **RC2 (optional):** #1395 if the event-classification inventory yields a clean
  auto-emit migration; otherwise GA directly from RC1.

## Success criteria

- A green `check_static_analysis` gate provably ran against the agent's worktree
  (verified by a test that asserts a diff present only in the worktree is seen).
- A multi-task refactor that breaks the integration tip is caught by
  `check_integration_suite` before the next dispatch (regression test reproduces
  the #1329 125-files-failing scenario at smaller scale).
- No `compoundStateId: undefined` event can reach the log via any append path
  (#1339 regression test through the legacy path).
- A `task-isolated` agent's edits no longer appear in the main worktree's working
  tree after dispatch (#1301 reproduction green); merge-time backstop catches any
  residual leak.
- `@modelcontextprotocol/sdk` pin policy documented; build/typecheck green on the
  ratified pin.
- All `*.parity.test.ts` stay green (INV-2); no new RC-resetting feature surface.

## Out of scope

Features (#1321, #1169), test-expansion (#1232–#1234, #1337, #1299), Windows CI
matrix (#1170, independent track), conditional cleanup (#1296), substrate
refinements behind working guards (#1353, #1352), and the #1088/#1342 epic
trackers — all → v2.11.

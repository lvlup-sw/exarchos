# Implementation Plan — v2.10.0 RC2 Auto-Emission Audit (#1395)

- **Design:** `docs/designs/2026-05-24-rc2-auto-emission-audit.md`
- **Feature ID:** `v2-10-0-rc2-auto-emission`
- **Iron Law:** No production code without a failing test first.
- **Blast radius (confirmed):** MCP-server only. No `skills-src` references
  `review.routed`, so **no `npm run build:skills`** is required. The migration is
  a pure *source-classification* change — the event is still emitted, validated,
  and consumed identically; only its `EVENT_EMISSION_REGISTRY` source flips.

## Coupling map (why migration is atomic-per-event)

`review.routed` reclassification touches three coupled sites that must change
together or the module throws at load:

1. `event-store/schemas.ts:338` — registry source `'model'` → `'auto'`.
2. `verbs/gates/check-event-emissions.ts` — `PHASE_EXPECTED_EVENTS` lists
   `review.routed` in **4** phases (`review`, `overhaul-review`, `synthesize`,
   `overhaul-update-docs`); a compile-time assertion (`check-event-emissions.ts:65`)
   throws if any listed event is non-`'model'`. Remove from all 4.
3. `verbs/gates/check-event-emissions.ts` `EVENT_DESCRIPTIONS` — dead hint entry
   after removal (hygiene, DIM-5).

Unaffected (stay green — proves behavior is unchanged): `review/tools.ts` emission,
`review/tools.test.ts`, `verify-review-triage.test.ts`,
`workflow-state-projection.test.ts`, the `EVENT_DATA_SCHEMAS` / type-union /
`EventTypes` entries for `review.routed`.

---

### Task 1: A/B/C auto-emission audit (research deliverable — gates migration set)
**Phase:** N/A (documentation; no production code → no RED/GREEN)

1. Inventory every event in every `PHASE_EXPECTED_EVENTS` phase
   (`delegate`, `overhaul-delegate`, `review`, `overhaul-review`, `synthesize`,
   `overhaul-update-docs`) plus the four canonical offenders.
2. Classify each **A** (handler in dispatch core already emits → migratable now),
   **B** (genuinely model-decided → keep + document), or **C** (runtime could
   emit but needs a runbook-executor seam → file follow-up). Cite the emission
   site for each.
3. Write `docs/research/2026-05-24-auto-emission-audit.md` with the table and a
   one-line rationale per event. Confirm `review.routed = A`; confirm
   `team.spawned`/`team.disbanded`/`shepherd.iteration = C`. Enumerate any
   *additional* A events (these feed Task 3).

**Acceptance:** per-phase A/B/C table; the four offenders explicitly addressed.
**Dependencies:** None.
**Parallelizable:** No (gates Tasks 2/3/5).

---

### Task 2: Migrate `review.routed` model → auto (anchor Category-A)
**Phase:** RED → GREEN → REFACTOR

1. [RED] Flip the registry contract test:
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Remove `'review.routed'` from `EventEmissionRegistry_ModelEvents_IncludesTeamAndReview`
     (line ~94); add it to `EventEmissionRegistry_AutoEvents_IncludesWorkflowAndTask`
     (line ~107). Test name intent: `EventEmissionRegistry_ReviewRouted_IsAuto`.
   - Expected failure: registry still returns `'model'`.
2. [RED] Assert it leaves the phase-expected set / hints:
   - File: `servers/exarchos-mcp/src/verbs/gates/check-event-emissions.test.ts`
   - Change line 45 `.toContain('review.routed')` → `.not.toContain('review.routed')`;
     add a hints test for the `review` phase asserting `review.routed` is absent
     from `_eventHints.missing`. Intent: `CheckEventEmissions_ReviewRouted_NotExpectedFromModel`.
   - Expected failure: it is still listed in `PHASE_EXPECTED_EVENTS`.
3. [GREEN] Implement the atomic three-site change:
   - `event-store/schemas.ts:338` — `'review.routed': 'auto'`.
   - `verbs/gates/check-event-emissions.ts` — remove `'review.routed'` from the
     `review`, `overhaul-review`, `synthesize`, `overhaul-update-docs` entries of
     `PHASE_EXPECTED_EVENTS`.
4. [REFACTOR] Remove the now-dead `'review.routed'` entry from `EVENT_DESCRIPTIONS`
   in `check-event-emissions.ts` (DIM-5 hygiene).

**Acceptance:** RED tests pass; `review/tools.test.ts` + `verify-review-triage.test.ts`
+ projection tests remain green (behavior unchanged).
**Dependencies:** Task 1 (confirms `review.routed = A`).
**Parallelizable:** No (shares files with Tasks 3/4).

---

### Task 3: Migrate any additional confirmed Category-A events (conditional)
**Phase:** RED → GREEN (per event)

1. [RED] For each *additional* A event from Task 1's audit, add/flip its registry
   source assertion (model→auto) in `schemas.test.ts` and remove it from the
   relevant `PHASE_EXPECTED_EVENTS` entries in `check-event-emissions.test.ts`.
   - Expected failure: registry/phase-set still list it as model.
2. [GREEN] Apply the same atomic three-site change (registry flip + phase-set
   removal + dead-description cleanup) per event.
   - If Task 1 surfaces **no** additional A events, record "none additional"
     in the audit doc and close this task as a no-op.

**Acceptance:** every audit-confirmed A event resolves to `'auto'` and is absent
from `PHASE_EXPECTED_EVENTS`; emission/consumption tests for each stay green.
**Dependencies:** Task 1, Task 2 (same files — sequence after T-02).
**Parallelizable:** No.

---

### Task 4: Regression guard — assertion path + CLI↔MCP parity (INV-2)
**Phase:** RED → GREEN

1. [RED] Assertion-path test:
   - File: `servers/exarchos-mcp/src/verbs/gates/check-event-emissions.test.ts`
   - Add `PhaseExpectedEvents_AutoEventListed_ThrowsAtModuleLoad` proving the
     compile-time invariant fires if an `'auto'` event is (re)introduced into
     `PHASE_EXPECTED_EVENTS` — the mechanism that forces the three-site change to
     stay consistent. (Use a guarded re-import / direct assertion harness so the
     throw is observable without breaking module load for the suite.)
   - Expected failure: no such guard test exists yet.
2. [RED] Parity test:
   - File: `servers/exarchos-mcp/src/__tests__/parity-harness.ts` (or the
     existing `workflow/parity.test.ts` surface)
   - Assert CLI and MCP produce identical `_eventHints` for a `review`-phase
     fixture after migration. Intent: `Parity_EventHints_ReviewRouted_AutoOnBothFacades`.
3. [GREEN] No new production code expected (the invariant + parity already hold
   post-Task-2); if parity diverges, the fix lands in the shared dispatch core,
   never an adapter (INV-2).

**Acceptance:** assertion-path + parity tests green.
**Dependencies:** Task 2 (and Task 3 if it migrated events).
**Parallelizable:** No.

---

### Task 5: File Category-C follow-ups + document Category-B (RC discipline)
**Phase:** N/A (issue filing + inline documentation)

1. Open one v2.11 sub-issue per Category-C event, each naming the seam:
   - `team.spawned` / `team.disbanded` → auto-emit from the runbook executor when
     it runs the bracketing `native:TeamCreate` / `native:SendMessage` steps in
     `AGENT_TEAMS_SAGA` (`runbooks/definitions.ts`).
   - `shepherd.iteration` → centralize the shepherd loop iteration boundary.
   - Each references this design + #1258 (workflow-SDK IR owns runbook semantics).
2. Add inline comments at the C registry entries (`schemas.ts`) and the
   surviving `PHASE_EXPECTED_EVENTS` entries noting *why they stay model-emitted
   pending instrumentation* (so future audits don't relitigate — DIM-3/DIM-5).
3. Record any Category-B rationale inline per Task 1's findings.

**Acceptance:** C sub-issues filed and linked from #1395; B rationale documented.
**Dependencies:** Task 1.
**Parallelizable:** Yes (docs/issues only — disjoint from Tasks 2/3/4 code files).

---

### Task 6: Integration-suite gate (#1329, RC1) — confirm no cascade
**Phase:** N/A (verification gate)

1. Run `exarchos_orchestrate check_integration_suite` (the full-suite gate added
   in RC1) on the integration tip after migration.
2. Confirm file-load count and test totals match the clean baseline (no
   `failed-to-load` cascade from the contract change).

**Acceptance:** integration suite matches baseline; no regression.
**Dependencies:** Tasks 2, 3, 4.
**Parallelizable:** No (final gate).

---

## Parallelization summary

```
T-01 (audit) ──┬──> T-02 (review.routed migrate) ──> T-03 (additional A) ──> T-04 (guard+parity) ──> T-06 (gate)
               └──> T-05 (C follow-ups + B docs)  [parallel — disjoint files]
```

- **Sequential chain:** T-01 → T-02 → T-03 → T-04 → T-06 (shared files:
  `schemas.ts`, `check-event-emissions.ts`, and their tests).
- **Parallel-safe:** T-05 (research doc + GitHub issues + inline comments) can run
  alongside T-02–T-04.
- **Dispatch shape:** small unit — one implementer for the code chain, optionally
  one scaffolder/implementer for T-05 in parallel. Not a wide fan-out.

## RC-safety check

Only code change that lands: registry reclassification of events the runtime
*already emits from its dispatch core* (drift removal, INV-1). C-event
instrumentation (feature-shaped) is filed, not built. No feature enters v2.10 →
RC clock does not reset → GA unblocked.

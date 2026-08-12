# v2.10.0 RC2 — Auto-Emission Audit (deterministic events: model → auto)

- **Date:** 2026-05-24
- **Feature ID:** `v2-10-0-rc2-auto-emission`
- **Milestone:** v2.10.0 — Agent Output Contract (#16)
- **Current build:** `2.10.0-preview.4` (RC1 = PR #1464 landed)
- **Target:** RC1 → **RC2 (this unit, #1395)** → GA
- **Closes / advances:** #1395 (auto-emission audit + migration scope)
- **Skills applied:** `/axiom:design` (DIM-*), `/design-invariants` (INV-*, dev-catalog active)
- **Scope decision:** audit + migration only. The bolted-on rehydration-report
  optimization *spike* (added to #1395 on 2026-05-16) and the #1301 harness
  root-cause fix are **explicitly out of scope** — both are investigations, not
  point fixes, and would reset the RC clock. Deferred to v2.11.

## Problem

Rehydration envelopes routinely return non-empty `_eventHints.missing`. The
recurring offenders observed across workflows are `team.spawned`,
`team.disbanded`, `review.routed`, and `shepherd.iteration` — every one a
**deterministic state transition the runtime already performs**, not a model
decision. Yet `EVENT_EMISSION_REGISTRY` (`servers/exarchos-mcp/src/event-store/schemas.ts:281`)
classifies all four as `'model'`, so the gate nags the orchestrator to remember
an `exarchos_event.append` for state the runtime already owns.

This is a misplaced trust boundary. INV-12 draws the line precisely: the model
emits what the model *decides*; the runtime emits what the runtime *determines*.
Asking the model to hand-maintain a deterministic event is a redundant trust
boundary — it adds drift risk (broken projections, `_eventHints` noise,
downstream gate failures: cf. `feedback_orchestrator_task_assigned_emission`)
without adding information the runtime didn't already have. The closed
precedents #1179/#1180 fixed specific projection bugs; #1395 is the design layer
above them — whether the model-vs-auto split itself is drawn correctly.

GA promises the runtime can be trusted to drive its own SDLC. A handful of
events the runtime *could* emit but instead delegates to model memory is a
quiet correctness liability sitting on the GA path. This unit narrows the split
to where the model genuinely holds information the runtime lacks.

## Constraint analysis (Phase 0 — invariants + axiom dimensions)

Dev-invariants catalog active (`.exarchos.yml: invariants.devCatalog: enabled`).
Load-bearing for this unit:

- **INV-1 (event-sourcing integrity).** The headline. A read-model is a left-fold
  over the log; if a deterministic transition relies on the model remembering to
  append, the log can diverge from what the runtime actually did. Moving the
  append to the transition site makes the log a faithful fold rather than a
  model-maintained ledger. The migration is *drift removal* — bugfix-shaped,
  RC-safe.
- **INV-12 (next_actions-as-affordance / trust boundary).** The model-vs-auto
  split is the trust boundary itself. `_eventHints.missing` nagging for a
  runtime-determined event is the boundary drawn one notch too far toward the
  model. Reclassification is the corrective.
- **INV-2 (facade-equivalence).** Any emission that moves must land in the shared
  dispatch core (the handler), not in a CLI/MCP adapter, or parity breaks. The
  Category-A event already satisfies this (`review/tools.ts` is core); the
  audit must not introduce adapter-local emission.
- **DIM-3 (contracts, lockstep).** `EVENT_EMISSION_REGISTRY`,
  `PHASE_EXPECTED_EVENTS` (`verbs/gates/check-event-emissions.ts`), and the
  playbook renderer are a coupled contract. `check-event-emissions.ts` carries a
  **compile-time assertion** that every entry in `PHASE_EXPECTED_EVENTS` is
  `source === 'model'`; flipping a registry entry to `'auto'` *without*
  simultaneously removing it from `PHASE_EXPECTED_EVENTS` throws at module load.
  Migration is therefore atomic-per-event across three sites.
- **DIM-2 / DIM-7 (observability / resilience).** Intended-vs-actual event-stream
  drift is silent signal loss; auto-emission removes the class of failure.
- **INV-15 (single-machine frame).** Any instrumentation hook is a local,
  in-process handler-side append at the transition site — no scheduler,
  supervisor, or cross-process coordination.

Schema-v3 extensibility note: `registerEventType({ source })` lets consumers
declare their own model/auto split. Getting the *built-in* split right makes the
runtime a correct exemplar for consumer-registered events.

## Inventory finding — the A/B/C split is already legible in code

The audit categories (#1395): **A** = runtime already performs the transition in
a handler and can emit now; **B** = genuinely model-decided (keep, document why);
**C** = runtime *could* emit but needs new instrumentation. Grounding the four
canonical offenders against the live machinery:

| Event | Where it fires today | Category | Why |
|---|---|---|---|
| `review.routed` | `review/tools.ts:61` — `handleReviewTriage` **already appends it** from the dispatch core, with an idempotency key | **A** | Real MCP handler performs the routing decision and emits. Pure mis-registration: `schemas.ts:338` still says `'model'`. |
| `team.spawned` | `runbooks/definitions.ts:57` — a model-walked `exarchos_event.append` runbook *step* ("emit before TeamCreate") | **C** | The transition is `native:TeamCreate` (a harness tool the MCP server does not own). No in-process handler seam to move the append into without a runbook-executor change. |
| `team.disbanded` | `runbooks/definitions.ts:77` — model-walked step ("emit before SendMessage shutdown") | **C** | Same: bracketing tool is `native:SendMessage`/`TeamDelete`. |
| `shepherd.iteration` | `runbooks/definitions.ts:131` — model-walked step inside the shepherd loop | **C** | No centralized iteration boundary in-process (matches the #1395 hypothesis). |

The decisive structural fact: **A events are emitted by Exarchos MCP handlers;
C events are emitted as runbook steps whose "transition" is a `native:` harness
tool.** Auto-emitting a C event requires the *runbook executor* to fire the
event when it executes the bracketing native step — a new emission seam. That is
a **feature-shaped** change (it touches the runbook IR / workflow-SDK substrate,
#1258), so it does not belong in an RC.

This is exactly why #1395 was scoped "investigation → migration: only if the
inventory classifies events as cleanly auto-emittable does a code change land."
The inventory says: one clean A migration lands now; the C events are filed.

## Approaches considered

**Approach 1 — Reclassify A in-place; file C; document B (recommended).**
Run the full per-workflow-type audit; migrate every Category-A event (at minimum
`review.routed`, plus any other already-handler-emitted-but-`'model'`-registered
event the audit surfaces) by an atomic three-site change; open one v2.11 sub-issue
per C instrumentation gap; record B rationale in the playbook so audits don't
relitigate. *Pros:* bugfix-shaped, RC-safe, closes the worst-offender nag,
delivers the issue's full acceptance criteria (A/B/C table + sub-issues).
*Cons:* C events keep nagging until v2.11 — but now *documented as intentional*.

**Approach 2 — Build the runbook-executor auto-emit seam now (rejected).**
Make the executor fire C events when it runs the bracketing native step, killing
all four nags this RC. *Pros:* eliminates the nag entirely. *Cons:* a new runtime
capability on the runbook IR = feature-shaped → **resets the RC clock**; couples
to #1258 workflow-SDK substrate which owns runbook IR. Violates RC discipline.

**Approach 3 — Suppress `_eventHints` for the four events without reclassifying
(rejected).** Cosmetic mute. *Cons:* lies about the boundary, leaves the registry
contract wrong, and defeats INV-1/INV-12 — the boundary stays misplaced; the
nag just hides.

**Selected: Approach 1.**

## Design

### Migration mechanism (per Category-A event — atomic across 3 sites)

For each A event the audit confirms (anchor case: `review.routed`):

1. **Registry** — flip `EVENT_EMISSION_REGISTRY[<event>]` from `'model'` to
   `'auto'` in `event-store/schemas.ts`.
2. **Phase-expected set** — remove `<event>` from every `PHASE_EXPECTED_EVENTS`
   entry in `verbs/gates/check-event-emissions.ts`. Required: the module's
   compile-time assertion throws if an `'auto'` event remains listed there.
3. **Renderer / hints** — the playbook renderer already separates model-emitted
   `events:` from `autoEmittedEvents:` (`playbooks.ts`); ensure the migrated
   event reads as auto (sibling list) so `_eventHints.missing` stops nagging and
   the rehydrate envelope reports it correctly.

Verification that A is genuinely auto: the handler emission must sit in the
shared dispatch core with an idempotency key (INV-2 + INV-8). `review.routed`
already satisfies this (`featureId:review.routed:<pr>` key). The audit rejects
any candidate whose only emission is an adapter or a model instruction.

### Audit deliverable (issue acceptance criteria)

A per-workflow-type table — `docs/research/2026-05-24-auto-emission-audit.md` —
classifying **every** event currently in any `PHASE_EXPECTED_EVENTS` entry as
A/B/C with one-line rationale and emission-site citation. The four canonical
offenders are explicitly addressed. (Today's `PHASE_EXPECTED_EVENTS` spans the
`delegate`, `overhaul-delegate`, `review`, `overhaul-review`, `synthesize`, and
`overhaul-update-docs` phases — the audit must cover all of them, not just the
four.)

### Category-C follow-ups (filed, not built here)

One v2.11 sub-issue per C event, each naming the runbook-executor seam:
`team.spawned` / `team.disbanded` (bracket `native:TeamCreate` /
`native:SendMessage` in `AGENT_TEAMS_SAGA`), `shepherd.iteration` (centralize the
shepherd loop boundary). Each references this design and #1258 (workflow-SDK IR
owns runbook step semantics). Until then the C events stay `'model'` and remain
in `PHASE_EXPECTED_EVENTS` — the nag persists but is now documented as
*intentional, pending instrumentation*, which is the honest RC-safe state.

### Category-B documentation

If the full audit surfaces any genuinely model-decided event (free-text
annotation, approval intent, qualitative review note — e.g. `review.finding`,
`remediation.attempted`), record *why it stays model-emitted* inline in the
playbook so future audits don't relitigate the line.

## Test strategy (TDD)

- **RED:** a registry-contract test asserting `review.routed` (and each confirmed
  A event) resolves to `'auto'`; a `check-event-emissions` test proving the
  migrated event no longer appears in any `PHASE_EXPECTED_EVENTS` entry and is
  absent from `_eventHints.missing` for the relevant phase.
- **Parity (INV-2):** the existing parity harness must show identical
  CLI↔MCP `_eventHints` after migration.
- **Regression guard:** retain the module-load compile-time assertion — it is the
  mechanism that *forces* the three-site change to stay consistent; the test
  suite must exercise the assert path (an `'auto'` event left in
  `PHASE_EXPECTED_EVENTS` throws).
- **Integration-suite gate (#1329, from RC1):** run the new full-suite gate after
  the migration to confirm the contract change does not cascade.

## Out of scope (deferred to v2.11)

- Rehydration-report optimization spike (token accounting, think-aloud UX,
  envelope reshape) — a `/discover` unit, not a fix.
- #1301 harness path-resolution root fix — RC1's backstop protects GA; root
  cause is the Claude Code file-tool layer (outside this repo).
- The runbook-executor auto-emit seam for Category-C events (feature-shaped,
  #1258 substrate).
- All other v2.11-deferred milestone items (#1321, #1169, #1232–#1234, #1296,
  #1353, #1352, #1088/#1342 epics).

## Why this stays RC-safe

The only code change that lands is a registry reclassification of events the
runtime *already emits from its dispatch core* — drift removal under INV-1, not a
new capability. C-event instrumentation (the feature-shaped work) is filed, not
built. No new feature enters v2.10; the RC clock does not reset; GA is unblocked.

# Auto-Emission Audit — v2.10.0 RC2 (#1395)

- **Date:** 2026-05-24
- **Design:** `docs/designs/2026-05-24-rc2-auto-emission-audit.md`
- **Plan:** `docs/plans/2026-05-24-rc2-auto-emission.md`
- **Scope:** classify every event in any `PHASE_EXPECTED_EVENTS` phase plus the
  four canonical offenders, and enumerate any additional Category-A events
  (model-registered events a dispatch-core handler already emits).

## Method

- `PHASE_EXPECTED_EVENTS` source: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.ts:55`.
  The `delegate` / `overhaul-delegate` entries derive from
  `getRegisteredEventTypes(...)` (`projections/rehydration/reducer.ts:799`),
  filtered to `source === 'model'` via `modelEmittedOnly`.
- Emission-site classification used `grep` for `type: '<event>'` appends across
  `servers/exarchos-mcp/src`, excluding `*.test.ts`. An event is **A** only when
  the append sits in a wired dispatch-core handler (not a runbook step, not an
  adapter, not a dormant utility, not a guard/query, not a playbook descriptor).

## Categories

- **A** = runtime already performs the transition in a wired handler and appends
  the event → migratable now (registry `model` → `auto`, plus removal from any
  `PHASE_EXPECTED_EVENTS` entry to keep the compile-time assertion satisfied).
- **B** = genuinely model-decided (free-text / qualitative / approval / dormant
  utility not wired to a handler) → keep `model`, document why.
- **C** = runtime *could* emit but it is currently a model-walked runbook step
  whose transition is a `native:` harness tool → needs a runbook-executor seam →
  defer to v2.11.

## PHASE_EXPECTED_EVENTS coverage (all six phases)

| Phase | Event | Category | Emission site / rationale |
|---|---|---|---|
| delegate | `task.assigned` | C | Coordination beat; recognised by reducer (`reducer.ts:773`) but emitted as model-walked beat, no handler append. |
| delegate | `team.spawned` | C | `runbooks/definitions.ts:57` — model-walked `exarchos_event.append` step bracketing `native:TeamCreate`. |
| delegate | `team.task.planned` | C | Model-walked planning beat; no handler append. |
| delegate | `team.teammate.dispatched` | C | Model-walked dispatch beat; no handler append. |
| delegate | `team.disbanded` | C | `runbooks/definitions.ts:77` — model-walked step bracketing `native:SendMessage`/`TeamDelete`. (guards.ts only *checks* for it, does not emit.) |
| delegate | `task.progressed` | C | TDD phase-transition beat; model-walked, no handler append. |
| overhaul-delegate | (same set minus `task.progressed`) | C | Mirror of delegate; refactor track runs no TDD. |
| review | `team.spawned` | C | As above. |
| review | `team.task.planned` | C | As above. |
| review | `team.teammate.dispatched` | C | As above. |
| review | `team.disbanded` | C | As above. |
| review | `review.routed` | **A** | `review/tools.ts:60` — `emitRoutedEvents` (called from `handleReviewTriage`, `review/tools.ts:112`) appends with idempotency key `${featureId}:review.routed:${pr}`. Dispatch-core handler. |
| overhaul-review | `team.spawned` / `team.task.planned` / `team.teammate.dispatched` / `team.disbanded` | C | As above. |
| overhaul-review | `review.routed` | **A** | As above. |
| synthesize | `team.spawned` / `team.disbanded` | C | As above. |
| synthesize | `review.routed` | **A** | As above. |
| synthesize | `stack.submitted` | C | No handler appends it (only an `EVENT_DESCRIPTIONS` hint); emitted as a model beat after submitting the PR stack. Could move to a VCS handler later — defer. |
| synthesize | `shepherd.iteration` | C | `runbooks/definitions.ts:131` — model-walked step inside the shepherd loop; no centralized in-process iteration boundary (`assess-stack.ts:358` only *queries* it). |
| overhaul-update-docs | `team.spawned` / `team.disbanded` | C | As above. |
| overhaul-update-docs | `review.routed` | **A** | As above. |

## Four canonical offenders (explicit)

| Event | Category | Verdict |
|---|---|---|
| `review.routed` | **A** | Migrate now (anchor — T-02). |
| `team.spawned` | C | Defer (runbook-executor seam, v2.11). |
| `team.disbanded` | C | Defer (runbook-executor seam, v2.11). |
| `shepherd.iteration` | C | Defer (centralize shepherd loop boundary, v2.11). |

Confirmed: `review.routed = A`; `team.spawned` / `team.disbanded` /
`shepherd.iteration` = C.

## Additional Category-A events (feed T-03)

Audited every other `model`-registered event in `EVENT_EMISSION_REGISTRY` for a
wired handler append:

| Event | Wired handler append? | Category | Site |
|---|---|---|---|
| `ci.status` | **Yes** | **A** | `emitCiStatusEvents` (`orchestrate/assess-stack.ts:313`) called from the assess-stack handler (`assess-stack.ts:483`), idempotency key `${featureId}:ci.status:${pr}:iter-${n}`. |
| `quality.regression` | **Yes** | **A** | `emitRegressionEvents` (`quality/regression-detector.ts:89`) called from `handleViewCodeQuality` (`views/tools.ts:724`), deduped against existing `quality.regression` events. |
| `review.finding` | No (dormant) | B | `emitReviewFindings` (`review/findings.ts:24`) is only reachable via `emitParsedFindings` (`review/comment-parser.ts:100`), which has **no production caller**. Not demonstrably handler-emitted. |
| `review.escalated` | No (dormant) | B | Same — only via `emitParsedFindings`, uncalled. |
| `review.completed` | No | B | `workflow/playbooks.ts:496` is a playbook descriptor advertised to the model, not a handler append. Genuinely model-decided (verdict/summary). |
| `worktree.created` | No | C/B | `gate-utils.ts:131` and `delegation-readiness-view.ts:338` only *query* it; no handler append. Model/runbook emitted. |
| `worktree.baseline` | No | C/B | No handler append; model/runbook emitted. |
| `test.result` | No | C | No handler append; model beat. |
| `typecheck.result` | No | C | No handler append; model beat. |
| `stack.submitted` | No | C | No handler append (see synthesize row). |
| `comment.posted` / `comment.resolved` | No | C | No handler append; model beats. |
| `remediation.attempted` / `remediation.succeeded` | No | C | `runbooks/definitions.ts:134/139` — model-walked runbook steps. |
| `session.tagged` | No | B/C | No handler append; model-decided session annotation. |
| `task.assigned` / `task.progressed` | No | C | Coordination/TDD beats; no handler append. |
| `team.task.assigned/completed/failed` | No | C | Team coordination beats; no handler append. |

### Confirmed additional A events to migrate (T-03)

- **`ci.status`** — assess-stack handler emits deterministically.
- **`quality.regression`** — code-quality view handler emits deterministically.

Neither appears in any `PHASE_EXPECTED_EVENTS` entry, so their migration is a
registry-only flip (the compile-time assertion stays satisfied without a
phase-set edit). They are real dispatch-core appends with dedup/idempotency, so
they belong in the `auto` class under INV-1/INV-12.

## Category-B rationale (kept `model`, documented)

- `review.completed`, `review.finding`, `review.escalated` — qualitative review
  outputs (verdict, finding text, escalation reason). The runtime does not
  determine these; the model does. The finding/escalation emitters exist but are
  dormant (no wired caller), so they are **not** demonstrably handler-emitted and
  stay `model` until a handler actually drives them.
- `session.tagged` — free-text session annotation; model-decided.

## Category-C follow-ups (filed by orchestrator, not built here)

One v2.11 sub-issue per C offender naming the runbook-executor seam:

- `team.spawned` / `team.disbanded` — auto-emit from the runbook executor when it
  runs the bracketing `native:TeamCreate` / `native:SendMessage` steps in
  `AGENT_TEAMS_SAGA` (`runbooks/definitions.ts`).
- `shepherd.iteration` — centralize the shepherd-loop iteration boundary so the
  runtime can emit on each iteration.

Each references this design + #1258 (workflow-SDK IR owns runbook step
semantics). Until then the C events stay `model` and remain in
`PHASE_EXPECTED_EVENTS` — the nag persists but is now documented as intentional,
pending instrumentation.

## Migration set (final)

- **T-02:** `review.routed` (A, in 4 phase-sets).
- **T-03:** `ci.status`, `quality.regression` (A, not in any phase-set — registry
  flip only).
</content>
</invoke>

# Phase-Gate v2.12 Dogfood Remediation Options

- **Date:** 2026-07-23
- **Status:** Discovery report
- **Input:** `2026-07-21-phase-gate-v212-dogfood.md`
- **Research question:** What should Exarchos change so the failures from the
  v2.12 delegation dogfood are fixed without adding another layer of ceremony or
  treating each symptom as an unrelated bug?

## Executive Recommendation

Use a staged stabilization program:

1. **Contain the live friction now.** Correct the task-completion cadence,
   plan-time gate semantics, and documentation examples before another dogfood
   run.
2. **Prove the installed runtime, not just the source tree.** Add build
   provenance to tool responses and run acceptance tests through the packaged
   MCP process. Several reported defects reproduce even though equivalent fixes
   appear in the current source.
3. **Make three contracts structural:** one atomic stream truth, one gate
   evidence/ownership model, and one runtime capability profile.
4. **Add admission checks for degenerate plans.** Planner overrides remain
   authoritative, but blanket risk/boundary metadata and oversized tasks must
   require explicit justification.
5. **Introduce a stop-loss mode.** After repeated infrastructure failures,
   Exarchos should preserve the trace, emit feedback, and recommend a reduced
   direct-execution path instead of encouraging serial workarounds.

This is a hybrid between a patch train and a redesign. It fixes the inexpensive
errors immediately while moving recurrence-prone behavior behind shared
chokepoints.

## What the Current Source Changes About the Dogfood Diagnosis

The dogfood report remains valid as an observed runtime trace. The current
source, however, shows that some findings already have partial or apparent
fixes. That mismatch is itself a finding: Exarchos needs runtime provenance and
live-boundary verification.

| Finding family | Current source evidence | Disposition |
|---|---|---|
| Stream append atomicity (CB-1) | `atomic-appender.ts:967-1040` routes sequence allocation, OCC, event insert, and claim through `SqliteBackend.atomicAppend`; comments describe one `BEGIN IMMEDIATE` transaction. | Do not assume fixed. Prove the packaged MCP composition root uses this path and add a true concurrent, separate-process same-stream test. |
| Wave-scoped readiness (CB-2) | `prepare-delegation.ts:830-884` defines `computeScopedWorktrees`; `:1440-1478` applies it to the supplied wave. | Reproduce against the packaged runtime. If source passes and package fails, file an artifact/provenance bug rather than reopening #1206 as a source regression. |
| Test adequacy (CB-3) | `test-adequacy-handler.ts:150-162` discovers files from `baseRef...HEAD`, but `test-adequacy.ts:175-208` still uses `git checkout <base> -- <source>` and treats an added source path as a revert conflict. `no-new-tests` remains an advisory pass at `:316-339`. | Still partial. Handle task-added source paths and make the no-tests policy tier-aware and evidence-aware. |
| Integration JSON (CB-4) | `integration-suite.ts:106-125` still invokes package-manager scripts with `--reporter=json`; `:162-168` still parses complete stdout with `JSON.parse`. Issue #1537 remains open. | Live defect. Write JSON to a report file or invoke Vitest directly. |
| Completion cadence (CB-5) | `runbooks/definitions.ts:44-58` still records `task_complete` before a full integration suite and runs that full suite per task. | Live policy defect. Move the suite to the wave boundary and complete only after all blocking task gates. |
| Unified spec parsing (CB-6) | `plan-coverage.ts:58-125` recognizes only legacy top-level design headings. | Live defect. Parse the canonical `## Design & Rationale` structure. |
| Task sizing (CB-7) | `task-decomposition.ts` validates descriptions, files, test markers, DAG shape, and file overlap, but has no behavior-count, breadth, time, or historical-size model. | Live design gap. Add calibrated warnings and override rationale. |
| Projection degradation (CB-8) | The inspected paths expose lag and materialization but no blocking state that reconciles event tail, sequence HWM, and projection watermark. | Live resilience gap. Add a first-class degraded state. |
| Plan-time test existence (CB-9) | `spec-coverage-check.ts:153-183` requires planned tests to exist and may execute them immediately. | Live phase-semantics defect. Split plan declaration validation from post-implementation existence/execution. |
| Documentation drift | Delegate still says `prepare_delegation` creates worktrees (`skills-src/delegate/SKILL.md:97-108`); plan still shows `threshold: 80` (`skills-src/plan/SKILL.md:186-195`); merge guidance omits the required execution posture; `.exarchos.yml` still has top-level `mutation`. | Live, inexpensive fixes. Generate or test examples against action/config schemas. |

## Root-Cause Map

The 22 findings collapse into five systemic causes.

### 1. Source Truth Is Not Runtime Truth

The report reproduced wave-scoping and stream-integrity failures while the
current source contains code intended to prevent them. Plausible explanations
include a stale packaged binary, composition-root bypass, alternate append path,
or an incomplete acceptance test.

Without a runtime fingerprint, operators cannot tell whether they are debugging
the current source, a cached plugin, or a different server instance.

### 2. Gate Scope, Owner, and Cadence Are Conflated

The same verification is performed by implementers, the lead, the completion
runbook, and post-merge checks. A gate definition currently says what to run,
but not clearly:

- who owns producing the evidence;
- whether evidence can be reused;
- whether the gate is task-, wave-, review-, or release-scoped;
- whether it is blocking before completion;
- what artifact makes the result authoritative.

The result is duplicate work and unsafe ordering.

### 3. Planner Authority Has No Quality Guardrail

Planner stamps correctly override heuristics, but the system treats
authoritative as synonymous with valid. A degenerate distribution such as
17/17 `high` and 17/17 boundary-touching receives only per-task disagreement
advisories. It is not evaluated as a plan-level anomaly.

Similarly, decomposition checks structural completeness but not likely effort.

### 4. Phase Semantics Leak Across Gates

Several gates ask questions at the wrong lifecycle point:

- plan-time spec coverage requires future test files to exist;
- per-task completion runs the cumulative integration backstop;
- task completion is recorded before its final blocking step;
- legacy design parsing forces compatibility content into the canonical spec.

These are not isolated parser bugs. They indicate that each gate needs an
explicit lifecycle scope.

### 5. Platform Capability Is Documented, Not Negotiated

The merge and worktree paths assume capabilities that vary by harness. When the
caller cannot mutate shared git state or the host owns isolation, the skill
falls back to prose and manual bookkeeping. Documentation cannot safely infer a
live runtime's permissions.

## Options Considered

### Option A: Patch Every Finding Independently

**Shape:** Open one issue for each CB/DOC item and fix in report order.

**Advantages**

- Fastest path to visible closure.
- Small review surfaces.
- Easy ownership assignment.

**Costs**

- Preserves duplicated contracts across skills, action descriptions, runbooks,
  and code.
- Does not explain source/runtime mismatches.
- Likely repeats the v2.8 pattern: mocks prove calls occurred while the live
  store or packaged runtime drops the effect.

**Verdict:** Necessary for containment, insufficient as the program.

### Option B: Pause and Redesign the Whole Phase-Gate System

**Shape:** Replace the current runbooks, evidence model, projections, and
runtime adapters before more dogfood.

**Advantages**

- Maximum conceptual cleanup.
- Can make scope and ownership explicit from first principles.

**Costs**

- Delays straightforward corrections such as `threshold: 0.8`.
- Risks invalidating v2.12 work already landed on durable evidence and gate
  ownership.
- Creates a large migration while the system is operationally degraded.

**Verdict:** Too broad.

### Option C: Staged Stabilization With Three Structural Seams

**Shape:** Land immediate corrections, then concentrate deeper work into:

1. stream/projection integrity;
2. gate evidence ownership and cadence;
3. runtime capability and provenance.

**Advantages**

- Removes current friction quickly.
- Reuses the branch's durable evidence and runner-ownership direction.
- Converts recurrence-prone behavior into shared contracts.
- Produces measurable acceptance criteria for the next dogfood.

**Costs**

- Requires an umbrella stabilization effort, not only isolated bugs.
- Some work spans code, skills, runbooks, and packaging.

**Verdict:** Recommended.

## Recommended Program

### Track 0: Runtime Provenance and Stop-Loss

Make every composite tool result carry a small `_meta.runtime` block:

```json
{
  "packageVersion": "2.12.0-preview.3",
  "buildSha": "<commit>",
  "schemaVersion": 6,
  "runtimeProfile": "copilot",
  "capabilityDigest": "<stable hash>"
}
```

Add a dogfood stop-loss policy:

- first infrastructure failure: retry once with the returned remediation;
- second failure in the same subsystem: emit a friction report and mark the
  subsystem degraded;
- third failure or an integrity mismatch: stop delegation bookkeeping and
  recommend direct local execution with scoped tests;
- never continue by manually recreating every missing lifecycle event.

This directly addresses UE-2 and T-4 while making every later diagnosis
version-aware.

### Track 1: Stream and Projection Integrity

Define and enforce one invariant:

```text
MAX(events.sequence)
  == sequences.sequence
  >= every projection watermark for the stream
```

Recommended mechanics:

1. Keep event insert, sequence advance, and idempotency claim in one
   `BEGIN IMMEDIATE` transaction.
2. Add a startup consistency probe that compares the event tail with the
   sequence row.
3. Repair only a lagging sequence row when the event log is internally dense;
   fail loud for gaps, duplicates, or an ahead-of-log counter.
4. Surface `projection_degraded` when any projection watermark is behind beyond
   the allowed lag or the stream invariant fails.
5. Block state-changing workflow guidance while degraded; permit diagnostics
   and repair.
6. Replace swallowed audit/gate emission failures with awaited writes plus
   explicit error reporting. A gate verdict may remain available, but its
   evidence durability must not be reported as successful.

**Acceptance test:** launch two real MCP child processes against one temporary
state directory, append concurrently to the same hot stream, then assert dense
events, matching HWM, matching projections, and continued appendability after
restart.

The existing `multi-process.test.ts` is sequential and uses two instances in one
process. Keep it, but do not treat it as sufficient for this failure.

### Track 2: Gate Evidence Contract and Cadence

Introduce a shared gate descriptor:

```typescript
interface GateContract {
  owner: "implementer" | "orchestrator" | "reviewer";
  scope: "task" | "wave" | "review" | "release";
  cadence: "once" | "per-change" | "on-demand";
  blockingBefore: "task-complete" | "wave-close" | "review-close";
  evidenceKind: "command-result" | "report-file" | "diff-analysis";
  reusable: boolean;
}
```

Use it to drive runbook order and evidence reuse.

Recommended default:

| Scope | Owner | Required evidence |
|---|---|---|
| Task | Implementer produces; orchestrator validates | Scoped tests or kill probe as selected by tier, plus static analysis |
| Wave | Orchestrator | One cumulative integration suite after all wave merges |
| Review | Reviewer/orchestrator | Combined-diff gates, mutation adequacy when high tier, review verdict |
| Release | Release workflow | Full packaging and distribution checks |

Immediate changes:

- remove `check_integration_suite` from per-task completion;
- run `task_complete` only after all blocking task gates;
- consume implementer command evidence rather than rerunning identical commands;
- permit independent spot checks when evidence is missing, stale, or
  non-authoritative;
- make integration output a framed report file, not package-manager stdout.

### Track 3: Planning Admission and Phase-Correct Gates

Keep planner overrides, but add plan-level diagnostics.

#### Metadata distribution checks

Warn or block for explicit review when:

- more than 80% of tasks share `high`;
- more than 80% share `boundaryTouching: true`;
- every task has the same risk/boundary pair;
- the explicit stamp differs from the heuristic for more than 50% of tasks.

The threshold should initially be advisory and calibrated from dogfood data.
Each override above threshold must include a one-line rationale.

#### Task breadth checks

Estimate breadth from:

- declared file count;
- number of named behaviors/acceptance criteria;
- number of boundaries crossed;
- number of dependencies;
- historical median diff size for the touched modules.

Do not pretend this is a precise time estimate. Report a breadth score and
require rationale above the threshold. The first useful version can be
deterministic and conservative.

#### Split plan and implementation coverage

- **Plan declaration check:** test path/name is declared, path is repo-relative,
  and the requirement/task link is syntactically valid.
- **Implementation evidence check:** the declared test exists and passes after
  the task or wave lands.

#### Canonical spec parsing

Parse design requirements from the unified `## Design & Rationale` structure.
Legacy headings can remain as compatibility inputs, but must not be required.

### Track 4: Capability-Aware Orchestration and Generated Guidance

Use one runtime capability handshake to select the execution path:

```text
worktree: native | launcher | manual
sharedGitMutation: allowed | denied
subagentDurability: durable | session-bound
eventHooks: native | emulated | unavailable
```

From that profile:

- select `serialize_merge` only when shared mutation is allowed;
- otherwise return a concrete local-git merge recipe and the exact events/state
  bookkeeping that remains required;
- distinguish host-owned native isolation from Exarchos-created worktrees;
- never claim `prepare_delegation` creates worktrees unless that action actually
  owns the operation.

Generate skill examples and schema snippets from the action/config schemas.
Add a test that parses fenced JSON/TypeScript examples and validates them
against the registered schema. This should catch `threshold: 80`, missing
`dryRun: false`, and invalid config keys before release.

## Immediate Containment Batch

These changes are low-risk and should land before the next dogfood:

1. Move the integration suite to a wave-boundary runbook and place
   `task_complete` last among task-blocking steps.
2. Update `check_integration_suite` to consume a JSON report file.
3. Teach plan coverage the unified spec structure.
4. Split plan declaration coverage from implementation test existence.
5. Fix task-added source handling in test adequacy.
6. Correct delegate worktree claims, merge invocation guidance, plan threshold,
   and `.exarchos.yml` mutation placement.
7. Add runtime version/build provenance to diagnostics.
8. Add the repeated-infrastructure-failure stop-loss guidance to delegation.

## Issue Disposition

| Existing issue | Recommendation |
|---|---|
| #1537 | Keep open and implement report-file parsing; add an end-to-end package-manager noise fixture. |
| #1206 | Reproduce using the packaged runtime with build fingerprint. Reopen only if that exact source revision still fails; otherwise file packaging/composition drift. |
| #1228 | File a new integrity issue for persisted event-tail/HWM divergence and link #1228 as related, not identical. |
| #1515 | The epic is closed, but use its verification-ladder design as the policy source. File a focused cadence/ownership issue rather than reopening the epic. |
| #1542 | Keep closed if the native-isolation warning holds; add capability-driven fallback work under a new portability issue. |
| #1636 | Keep closed. Add metadata-distribution validation as a new planning-quality issue; it is the inverse problem, not a regression of stamp propagation. |

Recommended umbrella: **Phase-gate stabilization: integrity, evidence cadence,
and runtime provenance**, with child issues for the immediate containment batch
and the three structural seams.

## Next Dogfood Exit Criteria

The next run should not be considered successful merely because all tasks merge.
Require:

1. Tool responses identify the exact runtime build and capability profile.
2. A four-task wave in a 17-task workflow reports exactly four expected
   worktrees.
3. Two real processes can concurrently append to one stream without HWM/event
   divergence, and restart preserves appendability.
4. Task adequacy discovers tests from committed branch diffs and handles newly
   added source paths.
5. The full integration suite runs once per wave, from a structured report file.
6. No task is marked complete before all task-scoped blocking gates pass.
7. The canonical unified spec passes without compatibility headings.
8. Plan-time coverage accepts future test files while validating their declared
   paths and traceability.
9. Blanket risk/boundary metadata produces a visible admission warning.
10. Two repeated infrastructure failures automatically produce a friction event
    and reduced-mode recommendation.
11. No required audit event is silently swallowed.
12. The same trace can be reconstructed from the event store, projections, and
    git without manual arbitration.

## Recommended Follow-On

Start an `/ideate` workflow for:

```text
phase-gate stabilization: unify stream/projection integrity, gate evidence
ownership and cadence, runtime provenance/capability negotiation, plan
admission checks, and repeated-failure stop-loss behavior. Use
docs/research/2026-07-23-phase-gate-v212-dogfood-remediation.md as design input.
```

The implementation should be staged. Do not bundle the immediate documentation
and runbook corrections behind the deeper integrity redesign.

## Sources

- `2026-07-21-phase-gate-v212-dogfood.md`
- `servers/exarchos-mcp/src/event-store/atomic-appender.ts`
- `servers/exarchos-mcp/src/event-store/{multi-process.test.ts,atomic-appender.race.test.ts,atomic-appender.acceptance.test.ts}`
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
- `servers/exarchos-mcp/src/views/delegation-readiness-view.ts`
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`
- `servers/exarchos-mcp/src/orchestrate/{test-adequacy.ts,test-adequacy-handler.ts}`
- `servers/exarchos-mcp/src/orchestrate/{check-integration-suite.ts,pure/integration-suite.ts}`
- `servers/exarchos-mcp/src/runbooks/definitions.ts`
- `servers/exarchos-mcp/src/orchestrate/{plan-coverage.ts,spec-coverage-check.ts,task-decomposition.ts}`
- `skills-src/delegate/SKILL.md`
- `skills-src/plan/SKILL.md`
- `.exarchos.yml`
- `docs/research/2026-06-22-concurrency-guarantees.md`
- `docs/research/2026-06-21-harness-agnosticism-strategy.md`
- `docs/research/2026-06-02-verification-pipeline-recommendations.md`
- `docs/research/2026-06-02-verification-token-efficiency.md`
- `docs/research/2026-04-25-delegation-platform-agnosticity.md`
- `docs/audits/2026-04-18-v2.8.0-dogfood.md`
- GitHub issues #1206, #1228, #1515, #1537, #1542, and #1636, verified
  2026-07-23.

# Phase-Gate v2.12 Delegation Dogfood Report

**Date:** 2026-07-21
**Session:** `ac72a05e-c0f7-488c-925c-af2c53499d2d`
**Workflow:** `phase-gate-v212-proof-substrate`
**Workflow type:** feature
**Status:** Implementation continuing outside the Exarchos workflow at user direction

## Executive Summary

This run was substantially slower and less reliable than equivalent delegation
on other harnesses. The slowdown was not one defect. It was a chain of planning
errors, runtime defects, documentation drift, and harness incompatibilities that
amplified each other.

The most important root cause was explicit metadata, not automatic
classification. The v2.12 child plan stamped all 17 tasks as `high` risk and
`boundaryTouching: true`. The orchestrator passed those values directly to
`prepare_delegation`. The runtime correctly gives planner stamps precedence over
heuristics, so every task selected the maximum verification profile.

That mistake then interacted with an over-expensive task-completion runbook. The
runbook requires test adequacy, contract drift, mock-boundary analysis, static
analysis, task completion, and a full integration suite for every task. Agents
also performed their own tests and typechecks, and the lead repeated targeted
tests after each merge. Verification was therefore executed two or three times
per task.

The Exarchos runtime then added avoidable recovery work:

- `prepare_delegation` ignored wave scoping and waited for all 17 worktrees.
- The delegate skill claimed `prepare_delegation` creates worktrees, but the
  registered action only queries readiness.
- Test adequacy could not revert task-added source files and later returned
  `no-new-tests` for branches that plainly added tests.
- `check_integration_suite` could not parse the npm/Vitest JSON stream.
- `serialize_merge` was unavailable to this read-only Copilot caller.
- Concurrent event appends left the stream sequence row at 235 while event 236
  existed, permanently blocking later task completion, checkpoint, and team
  lifecycle events.
- Four background agents were cancelled mid-edit by the host lifecycle and had
  to be replaced with fresh fixers. This is outside Exarchos MCP scope, but it
  materially increased elapsed time.

Ten merged tasks changed 41 files with 9,585 insertions and 45 deletions. These
were not 2-5 minute tasks. `check_task_decomposition` still reported all 17 as
well decomposed, so the planning gate gave false confidence.

## Summary Metrics

| Metric | Value |
|---|---:|
| Total Exarchos MCP calls | 120 |
| Explicit failed/error completions | At least 25 |
| Observed failure rate | At least 20.8% |
| Workflow events reviewed | 236 |
| Relevant workflows inspected | 2 |
| Views consulted | `pipeline`, `convergence`, `telemetry`, `worktrees` |
| Feedback reports reviewed | 0 |
| Code bugs found | 9 |
| Documentation issues found | 6 |
| Agent/orchestrator errors found | 2 |
| Trace-only findings | 5 |
| Merged implementation at audit time | 10 of 17 tasks |
| Current integrated change size | 41 files, +9,585 / -45 |

The failed-call count is conservative. It counts explicit Exarchos errors and
known failed result envelopes. Some actions returned `success: true` with
`data.passed: false`, so the actual friction rate is higher.

## Debug Trace Summary

### Sources queried

- `exarchos_view pipeline`
- `exarchos_workflow get`
- `exarchos_workflow describe(topology: "feature", playbook: "feature")`
- `exarchos_event query` for the workflow stream
- `exarchos_event describe(emissionGuide: true)`
- `exarchos_orchestrate describe` for ten relevant actions
- `exarchos_orchestrate runbook(id: "task-completion")`
- `exarchos_view convergence`
- `exarchos_view telemetry`
- `exarchos_event query(stream: "meta/feedback")`
- Copilot session-store tool-call counts
- Git history and diff statistics
- Existing GitHub issue search

### State observed

The authoritative workflow state still reports tasks 005, 011, 012, and 014 as
`in_progress`, even though 005, 011, and 014 are locally merged and verified.
The event stream cannot record their completion because appends fail after the
sequence divergence.

The pipeline view reports:

- `phase-gate-v212-proof-substrate`: 7 completed tasks
- `phase-gate-redesign`: still at `plan-review`

Local git reality at the same point was:

- 10 v2.12 tasks merged
- `phase-gate-redesign` explicitly cancelled

The pipeline response reported a projection lag of more than 500 seconds.

## Timeline of Compounding Failures

1. The umbrella roadmap already had nearly blanket high-risk metadata.
2. The split child spec copied that metadata to all 17 v2.12 tasks.
3. The lead explicitly supplied `riskTier: "high"` and
   `boundaryTouching: true` to `prepare_delegation`.
4. `prepare_delegation` returned `high|true` for every task.
5. The task-completion runbook selected the maximum per-task gate chain.
6. `prepare_delegation` rejected a four-task wave because workflow state held
   17 tasks.
7. After all 17 `task.assigned` events were emitted, readiness required all 17
   worktrees.
8. The documented automatic worktree creation did not occur.
9. Seventeen worktrees were created manually and worktree events were manually
   backfilled.
10. Root and MCP dependencies had to be installed after baseline failures.
11. The root full suite exposed unrelated historical failures and timeouts.
12. Test adequacy failed on task-added source files.
13. Two tasks expanded scope to repair the adequacy gate itself.
14. Integration-suite parsing failed despite runnable Vitest suites.
15. `serialize_merge` was capability-denied, so merges were rebased and executed
    manually.
16. Four background agents were cancelled while holding uncommitted changes.
17. Fresh fixers had to inspect and finish those partial worktrees.
18. Concurrent model-emitted progress events produced sequence/version drift.
19. All later workflow completion and checkpoint writes failed.

## Playbook Adherence

| Phase | Tools | Events | Transition criteria | Guards | Verdict |
|---|---|---|---|---|---|
| `plan` | Mostly matched | Matched | Matched | Matched | Partial |
| `plan-review` | User explicitly bypassed adversarial dispatch | No required events | Human approved | Approval state set | Intentional override |
| `delegate` | Matched until runtime failures | All required event classes attempted except final `team.disbanded` | Not reached | Not reached | Runtime-blocked |
| `merge-pending` | Could not use prescribed merge action | Auto merge events absent | Local git used | Capability denied | Violation caused by runtime mismatch |

### Playbook findings

- The delegate playbook expects model-emitted lifecycle events. Those events
  were emitted until the stream sequence diverged. Missing later events are not
  an omission by the operator; appends were rejected.
- The merge-pending playbook assumes a caller that can execute shared-mutating
  actions. Copilot CLI was read-only for `serialize_merge`, and the playbook has
  no capability-aware fallback.
- The plan-review bypass was an explicit human direction. It removed a possible
  opportunity to challenge task sizing, but it did not create the incorrect
  risk stamps.

## Runbook Conformance

| Runbook | Execution | Deviation | Verdict |
|---|---|---|---|
| `task-classification` | Consulted | Explicit planner metadata bypassed heuristics | Conformant but harmful input |
| `dispatch-decision` | Used dependency waves | Runtime readiness ignored wave task list | Runtime defect |
| `task-completion` | Followed for early tasks | Later abandoned after user correction | Runbook itself is over-expensive |

The task-completion runbook is internally inconsistent:

- `check_integration_suite` describes itself as the cumulative regression
  backstop and explicitly says not to use it for a single task.
- The runbook executes it for every task.
- The runbook calls `task_complete` before the integration suite, so a task can
  be recorded complete before the final blocking step fails.

Source:

- `servers/exarchos-mcp/src/runbooks/definitions.ts:44-58`
- `exarchos_orchestrate describe(actions: ["check_integration_suite"])`

## Code Bugs

### CB-1: Event stream sequence and stream-version rows diverge

- **Severity:** HIGH
- **Tools:** `exarchos_event`, `exarchos_orchestrate`,
  `exarchos_workflow`
- **Errors:**
  - `UNIQUE constraint failed: events.streamId, events.sequence`
  - `Expected sequence 236, actual 235`
- **Impact:** Blocks task completion, task failure, checkpoints, team lifecycle
  events, and state reconciliation.
- **Trace evidence:** Event query returned sequence 236. An append with
  `expectedSequence: 236` reported actual sequence 235. Retrying with 235
  attempted to insert an already-existing sequence and failed the primary key.
- **Root cause:** The event row and per-stream sequence/version row are not
  updated atomically across concurrent EventStore instances, or one path is
  bypassing the version update.
- **Related issue:** #1228 is closed and covers a related phantom sequence claim,
  but this is a current reproduction with a different persisted inconsistency.
- **Suggested fix:**
  1. Update the stream version and insert events in one `BEGIN IMMEDIATE`
     transaction.
  2. Add startup repair that compares `streams.version` with
     `MAX(events.sequence)` and fails loud or reconciles.
  3. Add a multi-process test with separate EventStore instances appending to
     the same stream.
  4. Never swallow the append failure on model or gate auto-emission paths.
- **Likely files:**
  - `servers/exarchos-mcp/src/event-store/atomic-appender.ts`
  - `servers/exarchos-mcp/src/storage/sqlite-backend.ts`

### CB-2: `prepare_delegation` still ignores wave scoping

- **Severity:** HIGH
- **Tool:** `exarchos_orchestrate.prepare_delegation`
- **Error:** A four-task wave was rejected because workflow state contained
  17 tasks. After all task assignments were emitted, readiness required 17
  worktrees.
- **Trace evidence:** The readiness view returned:
  - `taskCount: 4`
  - `workflow.tasks: 17`
  - blocker: state-vs-plan desync
  - later: `17 worktrees pending`
- **Root cause:** Readiness derives expected worktrees from all historical
  `task.assigned` events rather than the `tasks` argument for the active wave.
- **Existing issue:** #1206 is closed for this exact behavior. This run is a
  regression reproduction.
- **Suggested fix:** Scope readiness to the canonicalized task IDs supplied to
  the current `prepare_delegation` call. Historical assignments outside that
  set must not affect readiness.
- **Files:**
  - `servers/exarchos-mcp/src/views/delegation-readiness-view.ts:157-220`
  - `servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts`

### CB-3: Test adequacy cannot reliably analyze committed task branches

- **Severity:** HIGH
- **Tool:** `check_test_adequacy`
- **Errors:**
  - `discriminant: "revert-conflict"` when a task added a source file
  - `discriminant: "no-new-tests"` for branches that added test files
- **Impact:** Initially blocked correct tasks, then passed vacuously without
  probing their new tests.
- **Trace evidence:**
  - Task 001 added a fixture and test changes, but the gate could not revert the
    task-added source.
  - Task 016 added `caller-identity.ts`, producing the same conflict.
  - After the source-removal fix, tasks with clearly added test files still
    returned `no-new-tests`.
- **Current branch mitigation:** Tasks 001 and 016 added task-added source
  removal and restoration tests.
- **Suggested fix:**
  1. Land the task-added path handling.
  2. Add an integration test against a committed branch, not only uncommitted
     worktree hunks.
  3. Assert the gate discovers test files from `merge-base..HEAD`.
  4. Treat `no-new-tests` as a failure for medium/high tasks when git reports
     added or modified `*.test.*` files.
- **Files:**
  - `servers/exarchos-mcp/src/verbs/gates/test-adequacy.ts`
  - `servers/exarchos-mcp/src/verbs/gates/test-adequacy.test.ts`

### CB-4: Integration-suite JSON parsing remains unusable

- **Severity:** HIGH
- **Tool:** `check_integration_suite`
- **Error:** `runner produced no parseable vitest JSON`
- **Impact:** The required blocking gate failed even when scoped suites were
  green. It also added a full-suite run to each task.
- **Root cause:** The command path runs through npm, whose preamble and workspace
  output are not a single JSON document accepted by `JSON.parse(raw)`.
- **Existing issue:** #1537 is open and matches this reproduction.
- **Suggested fix:** Invoke the resolved Vitest binary directly or parse a
  framed JSON report file. Do not parse the complete npm stdout as one JSON
  object.
- **Files:**
  - `servers/exarchos-mcp/src/verbs/gates/check-integration-suite.ts`
  - `servers/exarchos-mcp/src/verbs/pure/integration-suite.ts`

### CB-5: Task-completion runbook over-enforces and orders gates unsafely

- **Severity:** HIGH
- **Surface:** `task-completion` runbook
- **Impact:** A full suite runs for every task, after agents have already tested
  their work. `task_complete` executes before the final blocking suite.
- **Trace evidence:** The runbook has six steps. Step 5 is `task_complete`; step
  6 is `check_integration_suite`.
- **Authoritative contradiction:** The integration action description says:
  `Do NOT use for a single task's scoped tests` and describes the action as a
  cumulative post-merge backstop.
- **Suggested fix:**
  1. End per-task completion after scoped adequacy and static analysis.
  2. Run one integration suite at the wave boundary after all wave merges.
  3. Never record task completion before a blocking task-completion step.
- **File:** `servers/exarchos-mcp/src/runbooks/definitions.ts:3-62`

### CB-6: Unified-spec coverage parser does not understand the unified template

- **Severity:** MEDIUM
- **Tool:** `check_plan_coverage`
- **Error:** `NO_DESIGN_SECTIONS`
- **Impact:** Required an artificial second top-level `## Technical Design`
  compatibility section before the gate recognized the document.
- **Root cause:** The parser expected `###` headings under legacy top-level
  design headings, while the current unified template places DR-N and technical
  design beneath `## Design & Rationale`.
- **Suggested fix:** Parse the canonical unified spec shape directly and delete
  the duplicate compatibility-map requirement.

### CB-7: Task decomposition gate gives false confidence on task granularity

- **Severity:** HIGH
- **Tool:** `check_task_decomposition`
- **Observed result:** `17/17 well-decomposed`
- **Actual result:** Ten tasks already produced 41 files and 9,585 insertions.
- **Playbook requirement:** Each task should represent 2-5 minutes of focused
  work.
- **Root cause:** The gate checks presence of descriptions, files, tests, DAG,
  and simple overlap. It does not detect task breadth, likely line volume,
  number of behaviors, or expected execution time.
- **Suggested fix:**
  1. Add warnings for broad file sets and multi-behavior steps.
  2. Flag plans where nearly every task is high risk or boundary-touching.
  3. Estimate task size from named behaviors and historical file-change data.
  4. Require explicit rationale for tasks above the configured size threshold.

### CB-8: Workflow projections silently lag and contradict git/event reality

- **Severity:** HIGH
- **Views:** `pipeline`, workflow state
- **Trace evidence:**
  - The cancelled umbrella workflow still appeared at `plan-review`.
  - The child workflow reported seven complete tasks while ten were merged.
  - Projection lag exceeded 500 seconds.
- **Root cause:** Primarily downstream of CB-1, but the views provide stale data
  without a sufficiently prominent degraded-state signal.
- **Suggested fix:** Surface a blocking `projection_degraded` state whenever
  stream version, event max sequence, and projection sequence disagree.

### CB-9: Spec coverage is incompatible with planning new test files

- **Severity:** MEDIUM
- **Tool:** `spec_coverage_check`
- **Observed result:** Failed because no referenced test files were found.
- **Design conflict:** The plan describes tests that implementation tasks are
  expected to create. A plan-time gate cannot require those files to already
  exist.
- **Suggested fix:** Split the action into:
  - plan syntax validation, which checks test paths and names are declared
  - implementation coverage validation, which checks the declared files exist
    after task completion

## Documentation Issues

### DOC-1: Delegate skill falsely says `prepare_delegation` creates worktrees

- **Severity:** HIGH
- **Skill:** `skills-src/delegate/SKILL.md:96-100`
- **Skill claim:** The composite action creates `.worktrees/task-<id>` and runs
  npm install.
- **Authoritative action description:** `Query delegation readiness and prepare
  quality hints for subagent dispatch`.
- **Observed behavior:** No worktrees were created.
- **Suggested fix:** Remove worktree creation from `prepare_delegation` docs and
  explicitly call `setup_worktree` or declare native isolation.

### DOC-2: Worktree path conventions contradict each other

- **Severity:** MEDIUM
- **Delegate skill convention:** `.worktrees/task-<id>`
- **`setup_worktree` convention:** `.worktrees/<taskId>-<taskName>`
- **Observed impact:** Manually created valid worktrees were not recognized by
  `setup_worktree`, which attempted a second path and failed.
- **Files:**
  - `skills-src/delegate/SKILL.md:98`
  - `servers/exarchos-mcp/src/verbs/team/setup-worktree.ts:556-561`
- **Suggested fix:** One canonical worktree ID/path generator shared by skill,
  setup action, readiness view, and events.

### DOC-3: Plan skill passes an invalid threshold scale

- **Severity:** MEDIUM
- **Skill:** `skills-src/plan/SKILL.md:193`
- **Skill example:** `threshold: 80`
- **Action schema:** number in the range 0 through 1.
- **Observed error:** `Too big: expected number to be <=1`
- **Suggested fix:** Change the example to `0.8` and add a generated schema-doc
  test.

### DOC-4: Merge guidance is incompatible with current action semantics

- **Severity:** HIGH
- **Skill:** `skills-src/delegate/SKILL.md:354-356, 468-479`
- **Problems:**
  1. `serialize_merge` now defaults to dry-run, but the skill example omits
     `dryRun: false`.
  2. The action is declared shared-mutating, so Copilot's read-only caller is
     denied even for the dry-run path.
  3. No capability-aware local-git fallback is documented.
- **Observed impact:** Every merge required manual rebase, merge, and state
  bookkeeping.
- **Suggested fix:** Generate merge instructions from runtime capability
  posture and include the required `dryRun` value.

### DOC-5: Committed `.exarchos.yml` uses an invalid top-level `mutation` key

- **Severity:** MEDIUM
- **File:** `.exarchos.yml:4-11`
- **Observed warning:** `unrecognized_keys: mutation`
- **Schema evidence:** `mutation` is valid under a toolchain's `commands`, not
  as a top-level key.
- **Impact:** Repeated validation noise in agent and gate output obscured real
  failures.
- **Suggested fix:** Move the command into a valid `toolchains` entry or add a
  documented top-level schema if that is the intended design.

### DOC-6: Verification responsibilities are duplicated between agent and lead

- **Severity:** HIGH
- **Skill behavior:** The implementer prompt tells the agent to run tests and
  verification. The lead is then told to rerun the task-completion gate chain.
- **Observed impact:** Agents ran focused tests and typecheck, followed by lead
  adequacy, contract, mock, static, targeted tests, merge, and post-merge tests.
- **Suggested fix:** Define one owner for each verification step. Agent evidence
  should be consumed by the lead, with only independent spot checks and a
  wave-level cumulative gate.

## Agent and Orchestrator Errors

### UE-1: Blanket risk metadata was copied and explicitly forced

- **Severity:** HIGH
- **What happened:** The child plan contains 17 `Risk Tier: high` stamps and 17
  `Boundary Touching: true` stamps. The lead passed those values explicitly to
  `prepare_delegation`.
- **Why this matters:** `prepare_delegation.ts:83-90, 267-311` states that
  planner values always win over heuristics.
- **Root cause:** Feature-level criticality was incorrectly treated as
  per-task blast radius.
- **Correct behavior:** Reclassify each task independently. Pure selectors,
  domain values, and repository scripts are not automatically
  boundary-touching.

### UE-2: The lead continued after the first evidence of systemic mismatch

- **Severity:** HIGH
- **What happened:** The lead worked around readiness, worktree, gate, merge,
  and event-store defects one by one instead of stopping and simplifying the
  execution mode.
- **Impact:** The workflow accumulated manual bookkeeping and repeated
  verification.
- **Correct behavior:** After the first repeated infrastructure defect, pause
  delegation, produce a dogfood trace, and switch to a direct local completion
  path with scoped tests.

## Trace-Only Findings

### T-1: Cancelled parent workflow still appears active

- **Evidence:** `pipeline` reports `phase-gate-redesign` at `plan-review`.
- **Conversation reality:** `exarchos_workflow cancel` returned success.
- **Bucket:** code bug
- **Impact:** Active workflow discovery is unreliable.

### T-2: Current workflow state is materially stale

- **Evidence:** Workflow state reports tasks 005, 011, and 014 as in progress
  after those branches were verified and merged.
- **Bucket:** code bug
- **Impact:** Rehydrate and next-action calculations cannot be trusted.

### T-3: Context economy failed during delegation

- **Evidence:** Convergence view reports D3 `token-budget` failed.
- **Contributing factor:** `prepare_delegation` returned a 14 KB response for 17
  classifications plus prompt material, after repeated readiness retries.
- **Bucket:** code bug
- **Impact:** The orchestration protocol consumed substantial context before
  implementation began.

### T-4: No real-time friction reports were recorded

- **Evidence:** `meta/feedback` contains zero events despite at least 25 explicit
  errors.
- **Bucket:** agent/process error
- **Impact:** Dogfood evidence had to be reconstructed after the fact.
- **Suggested fix:** Skills should call `exarchos_workflow feedback` after a
  repeated or systemic failure.

### T-5: Prior audit already identified the same boundary-testing weakness

- **Evidence:** `docs/audits/2026-04-18-v2.8.0-dogfood.md:169-197` documents
  fire-and-forget event emissions that passed mock-based tests but did not
  persist through a real event store.
- **Bucket:** code bug
- **Impact:** The current sequence/projection failure is consistent with a known
  unresolved class of event-store boundary defects.

## Existing Issue Mapping

| Finding | Existing issue | Status | Assessment |
|---|---:|---|---|
| Wave readiness ignores task filter | #1206 | Closed | Reproduced regression |
| Event sequence phantom claims | #1228 | Closed | Related, current persisted divergence is not fully covered |
| Integration suite cannot parse JSON | #1537 | Open | Exact current reproduction |
| Native isolation readiness | #1542 | Closed | Related worktree family |
| Planner stamps propagate to dispatch | #1636 | Closed | Fix works; bad planner metadata now propagates exactly |
| Verification ladder | #1515 | Open epic | Design source for current gate behavior |
| Delegation docs and diagnostics | #1212 | Closed | Related documentation family |

## Issue Drafts

These are drafts only. They were not filed because dogfood requires explicit
human confirmation before issue creation.

### Draft 1: Event stream version diverges from persisted max sequence

**Title:** `bug: concurrent appends leave streams.version behind events.sequence and permanently brick the stream`

**Labels:** `bug`

**Body:**

```text
## Summary

Concurrent phase-gate-v212-proof-substrate writers persisted event sequence 236
while the per-stream version row remained 235. Every subsequent append failed:

- expectedSequence 236 -> SEQUENCE_CONFLICT, actual 235
- expectedSequence 235 -> UNIQUE(events.streamId, events.sequence)
- task_complete/checkpoint -> UNIQUE constraint failure

## Expected

Event insert and stream-version advance are one SQLite BEGIN IMMEDIATE
transaction. A process crash or competing writer cannot leave either side
ahead.

## Repro evidence

1. Query stream: event 236 exists.
2. Append expectedSequence 236: server reports actual 235.
3. Append expectedSequence 235: duplicate sequence primary-key failure.

## Fix

- Atomically update stream row and insert event batch.
- On startup, compare streams.version with MAX(events.sequence).
- Add a real multi-process test with separate EventStore instances.
- Emit a loud projection-degraded diagnostic instead of allowing permanent
  retries.

Related: #1228, but this is a persisted stream-row divergence.
```

### Draft 2: Reopen #1206 for wave-scoping regression

**Title:** `regression: prepare_delegation again waits for all historical task assignments instead of current wave`

**Labels:** `bug`, `regression`

**Body:**

```text
## Summary

Preparing a four-task wave for a 17-task workflow returned state-vs-plan desync.
After emitting all assignments, readiness required all 17 worktrees.

The `tasks` argument did not scope expected/ready task IDs.

This reproduces closed issue #1206.

## Expected

Readiness is computed only for canonical task IDs supplied in the current
prepare_delegation request.
```

### Draft 3: Fix task-completion runbook gate ownership

**Title:** `bug: task-completion runs full integration suite per task and marks complete before the blocking suite`

**Labels:** `bug`, `performance`

**Body:**

```text
## Summary

The task-completion runbook executes:

test adequacy -> contract drift -> mock boundary -> static analysis ->
task_complete -> full integration suite

The integration action's own description says not to use it for a single task
and calls it a cumulative regression backstop.

## Impact

- Full suite runs once per task.
- Agent verification is duplicated.
- Task completion is recorded before the final blocking step.

## Fix

Keep scoped per-task gates before task_complete. Move the integration suite to
one wave-level post-merge action.
```

### Draft 4: Align delegate worktree documentation with registered actions

**Title:** `docs: delegate says prepare_delegation creates task worktrees but action only queries readiness`

**Labels:** `documentation`

**Body:**

```text
## Summary

skills-src/delegate/SKILL.md says prepare_delegation creates
.worktrees/task-<id> and runs npm install.

The registered action description says it queries readiness and quality hints.
No worktrees were created.

setup_worktree also uses a different on-disk naming convention:
.worktrees/<taskId>-<taskName>.

## Fix

Document the actual call sequence and define one shared worktree path generator.
```

### Draft 5: Validate risk metadata distributions and task size

**Title:** `feat: decomposition gate should reject blanket high/boundary stamps and oversized tasks`

**Labels:** `enhancement`, `quality`

**Body:**

```text
## Summary

check_task_decomposition passed 17/17 tasks. Ten tasks later produced 41 files
and 9,585 insertions. The plan stamped all 17 tasks high risk and
boundary-touching.

## Fix

- Warn when nearly all tasks share the same risk/boundary metadata.
- Flag broad tasks using file count, number of behaviors, and historical size.
- Require rationale for high/boundary overrides.
- Enforce the playbook's 2-5 minute task guidance mechanically.
```

## Patterns and Trends

### 1. Boundary mocks still dominate the failure class

The prior v2.8 audit concluded that tests mocked the boundary they were meant to
exercise. The current run repeated that pattern:

- readiness logic passed tests but did not support real wave dispatch
- event emission paths passed tests but stream state diverged under concurrent
  real writers
- integration parser tests did not make the actual npm/Vitest path usable
- decomposition structure passed while real task size was an order of
  magnitude larger than intended

### 2. Source-of-truth surfaces disagree

The skill, describe output, runbook, playbook, event store, projections, and git
state each told a different story. A governance system cannot require operators
to manually arbitrate among six sources.

### 3. Risk proportionality is correct in principle but unsafe without metadata quality

Planner overrides are necessary. Blindly trusting them is not. The system needs
sanity checks for degenerate distributions and task-size evidence before a
blanket high-risk plan can trigger maximum ceremony for every task.

### 4. Platform agnosticity is incomplete

The workflow assumes native worktree creation, shared-mutating merge
capabilities, durable background agents, and hooks that auto-emit events.
Copilot CLI provided none of those surfaces in the same way. The fallback path
became manual and much slower.

## Recommended Remediation Order

1. Repair CB-1 event stream atomicity and recovery.
2. Move the full integration suite from per-task completion to a wave boundary.
3. Reopen #1206 and restore wave-scoped readiness.
4. Land and strengthen the test-adequacy new-file fix.
5. Fix delegate and plan documentation drift.
6. Add task-size and metadata-distribution checks to decomposition.
7. Add real SQLite-backed integration tests for all auto-emission paths.
8. Add a first-class Copilot capability profile with local-git merge fallback.

## Machine-Readable Summary

```json
{
  "session_summary": {
    "total_tool_calls": 120,
    "failed_tool_calls": 25,
    "failure_rate": "20.8% minimum",
    "debug_trace": {
      "workflows_inspected": 2,
      "events_reviewed": 236,
      "describe_queries": 8,
      "views_consulted": [
        "pipeline",
        "convergence",
        "telemetry",
        "worktrees"
      ],
      "feedback_reports_reviewed": 0,
      "trace_only_findings": 5
    }
  },
  "playbook_adherence": {
    "phases_checked": 4,
    "violations": [
      {
        "phase": "delegate",
        "field": "worktree preparation",
        "expected": "prepare_delegation creates worktrees",
        "actual": "registered action only queried readiness",
        "bucket": "documentation_issue"
      },
      {
        "phase": "merge-pending",
        "field": "merge tool",
        "expected": "serialize_merge",
        "actual": "CAPABILITY_DENIED for Copilot read-only caller",
        "bucket": "documentation_issue"
      }
    ]
  },
  "runbook_conformance": {
    "runbooks_checked": 3,
    "deviations": [
      {
        "runbook": "task-completion",
        "reason": "abandoned after repeated systemic defects and user direction"
      }
    ]
  },
  "buckets": {
    "code_bug": [
      "CB-1",
      "CB-2",
      "CB-3",
      "CB-4",
      "CB-5",
      "CB-6",
      "CB-7",
      "CB-8",
      "CB-9"
    ],
    "documentation_issue": [
      "DOC-1",
      "DOC-2",
      "DOC-3",
      "DOC-4",
      "DOC-5",
      "DOC-6"
    ],
    "user_error": [
      "UE-1",
      "UE-2"
    ]
  },
  "trace_only_findings": [
    "T-1",
    "T-2",
    "T-3",
    "T-4",
    "T-5"
  ]
}
```

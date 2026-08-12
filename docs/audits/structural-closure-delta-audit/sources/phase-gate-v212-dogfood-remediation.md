# Phase-Gate v2.12 Dogfood Remediation Options

- **Date:** 2026-07-23
- **Status:** Discovery report
- **Input:** `2026-07-21-phase-gate-v212-dogfood.md`
- **Visual review:** [`2026-07-23-phase-gate-v212-dogfood-remediation.html`](./2026-07-23-phase-gate-v212-dogfood-remediation.html)
- **Research question:** What should Exarchos change so the failures from the
  v2.12 delegation dogfood are fixed without adding another layer of ceremony or
  treating each symptom as an unrelated bug?

## Executive Recommendation

Do not treat the dogfood as a phase-gate patch backlog. Use it as a concrete
input to a **repository-wide structural closure audit and convergence program**.

The existing
`2026-07-21-structural-principles-codebase-assessment.md` already identifies the
larger pattern: Exarchos has strong local controls, but they do not compose into
one closed proof system. The dogfood failures are examples of that gap:

- contracts are represented by several independently editable resources;
- production effects can bypass or outlive the structure that claims to own
  them;
- targeted registries prove local cardinality but no complete ship-surface
  graph proves global reachability;
- packaged binaries, generated skills, cached installs, and source revisions
  can disagree unless the existing provenance/hash surfaces are captured;
- advisory controls often have no enforced exit condition.

The next program should therefore:

1. inventory every hand-authored boundary, effect path, and driftable resource;
2. classify each as canonical, generated, mechanically checked, advisory, or
   unowned;
3. construct one graph from public action to packaged effect and proof fixture;
4. eliminate parallel editable sources through generation or a single
   structural chokepoint;
5. require every temporary containment patch to add a ratchet or name the
   structural work that will retire it.

The recent phase-gate branch materially advances this direction: durable gate
evidence, a canonical runner, and an ownership census landed after the
structural assessment. The audit should be a **delta assessment against the
latest branch**, not a repeat of the July 21 snapshot.

The roadmap adds one hard constraint: every interim change must state how it
lowers into the standard workflow IR planned by #1258, or why it belongs at a
non-IR runtime chokepoint. `docs/system-design.html` is explicit: a v2.12 change
that cannot become a v3.0 combinator, generated contract, compiled policy, or
runtime enforcement seam is consolidation churn.

## Review Decisions

The Lavish review resolved the program and migration posture:

- **Program:** Option C, repository-wide structural closure audit and
  convergence.
- **Optimization target:** the smallest structurally closed target, not maximum
  backwards compatibility or minimum diff size.
- **Compatibility posture:** intentional breaking changes are acceptable when
  they eliminate parallel editable contracts, bypass paths, or legacy
  registries and include an explicit migration/cutover.
- **Required exhaustive inventories:**
  1. all competing contract sources and generated derivatives;
  2. effect ownership, direct emitters, and shell bypass paths;
  3. public-action-to-packaged-artifact reachability;
  4. cached binaries, plugin installs, generated skills, agents, hooks, and
     runtimes;
  5. v2.12-to-v3.0 workflow-IR lowering and legacy retirement.
- **Supporting analyses:** module dependency/ownership rules and the advisory
  ratchet ledger remain supporting inputs. They should be promoted to top-level
  deliverables only where the five required inventories expose a closure gap.

## What the Current Source Changes About the Dogfood Diagnosis

The dogfood report remains valid as an observed runtime trace. The current
source, however, shows that some findings already have partial or apparent
fixes. That mismatch should first be tested as cached binary/skill or packaged
artifact drift. Exarchos already exposes package/build provenance and plugin
version/hash diagnostics; the dogfood runbook must capture those existing
signals before attributing a failure to current source.

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

### 1. Existing Provenance Was Not Captured at the Failure Boundary

The report reproduced wave-scoping, risk-stamp, and stream-integrity failures
while the current or recent branch contains code intended to prevent them.
Plausible explanations include a stale packaged binary, cached generated skill,
composition-root bypass, alternate append path, or incomplete acceptance test.

The correction is not another provenance mechanism. It is to require the
dogfood trace to record the existing package version, build SHA, plugin version,
and generated-skill hash before the first workflow call, then fail the run early
when those identities do not match the intended revision.

### 2. Gate Scope, Owner, and Cadence Are Conflated

The same verification is performed by implementers, the lead, the completion
runbook, and post-merge checks. The recent branch has already added a durable
gate producer, evidence migration, a canonical gate runner, and
`check-gate-runner-ownership.mjs`. The remaining question is whether that chain
is closed across every enforceable gate and promotion boundary:

- who owns producing the evidence;
- whether evidence can be reused;
- whether the gate is task-, wave-, review-, or release-scoped;
- whether it is blocking before completion;
- what artifact makes the result authoritative.

The result is duplicate work and unsafe ordering whenever an old direct path or
runbook step remains outside the canonical producer.

### 3. Hand-Rolled Contracts Remain Editable in Parallel

The same public behavior may be represented independently by:

- a TypeScript interface;
- a Zod schema;
- handler construction;
- registry metadata;
- runbook ordering;
- CLI rendering;
- skill prose and examples;
- runtime YAML and generated variants;
- configuration examples.

The risk-tier stamping issue should not be elevated into a new policy mechanism
until it reproduces against the recent merged classification/routing work with
matching binary and skill provenance. The broader structural issue is that a
stale skill or cached artifact can still describe or invoke a contract that the
current code no longer owns.

### 4. Local Closure Is Strong; Global Closure Is Weak

Exarchos can prove many local facts:

- every supported gate class has a provider;
- every action has an output schema;
- event-store construction is restricted;
- enforcement scripts have declared CI dispositions.

It still needs one graph that proves:

- every public action reaches exactly one production implementation;
- every implementation reaches an owned effect;
- every effect has a packaged-artifact proof fixture;
- every enforceable result persists subject-bound evidence;
- every generated or cached resource is tied to the same revision.

### 5. Advisory and Temporary Controls Accumulate Without Structural Exit

The repository is honest about advisory controls, but a growing set of
advisories, compatibility paths, and temporary docs still requires model
judgment. Every non-structural control needs an owner, an expiry or promotion
condition, and a CI-visible disposition.

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

### Option B: Structurally Stabilize Phase-Gate Only

**Shape:** Generate or centralize the phase-gate-specific contracts while
leaving the wider repository's contract and integration model unchanged.

**Advantages**

- Better than independent symptom patches.
- Can complete the canonical gate producer and evidence chain.

**Costs**

- Leaves the same drift classes in other workflow and CLI surfaces.
- Adds another targeted closure check instead of one global integration graph.
- Can make phase-gate look structurally sound while the shipped product remains
  only locally closed.

**Verdict:** Still too narrow.

### Option C: Repository-Wide Structural Closure Audit and Convergence

**Shape:** Re-run the seven-principles assessment as a delta against the latest
branch, then produce five exhaustive machine-readable inventories:

1. all competing contract sources and generated derivatives;
2. effect ownership and bypass paths;
3. public-action-to-packaged-artifact reachability;
4. cached binaries, plugin installs, generated skills, agents, hooks, and
   runtimes;
5. v2.12-to-v3.0 workflow-IR lowering and legacy retirement.

Module dependency/ownership rules and the advisory ratchet ledger remain
supporting analyses, promoted to exhaustive deliverables only when these five
inventories expose a closure gap.

**Advantages**

- Addresses the class of defect rather than the report instance.
- Reuses existing registries, output schemas, provenance, gate runner, and
  ownership census.
- Makes missing reachability and drift a graph failure, not a review finding.
- Gives every containment patch a structural retirement path.

**Costs**

- Larger initial discovery surface.
- Requires coordinating the shared workflow-IR contract, the Exarchos action API
  contract, and one ship-surface graph representation.

**Verdict:** Recommended.

## Recommended Program

### Track 0: Delta Structural Audit

Re-run the seven-principles assessment against the latest phase-gate branch and
record what changed after the July 21 snapshot. At minimum, verify the landed
canonical gate runner, durable evidence producer, evidence migrations, and
runner ownership census.

Output a machine-readable inventory for every public surface:

| Field | Meaning |
|---|---|
| `contractSource` | The one editable source, or every competing source if no canonical source exists |
| `generatedArtifacts` | Types, Zod schemas, CLI metadata, docs, skills, bindings |
| `effectOwner` | The module or runner authorized to perform the effect |
| `productionRoot` | The dispatch/composition root that selects the implementation |
| `packagedProof` | The fixture that exercises the shipped binary/artifact |
| `driftGuard` | CI check that fails when source and derivative disagree |
| `disposition` | structural, checked, advisory, temporary, or unowned |
| `exitCondition` | Required for every non-structural disposition |
| `agentPrinciple` | The earliest applicable principle and proof layer |
| `v212Posture` | Characterization, proof substrate, audit, shadow, or containment |
| `v3Lowering` | Workflow IR node, admission-policy field, generated MCP facade, runtime chokepoint, or retirement |

### Track 1: Generate the Shared Boundaries From Canonical Contracts

Do not treat MCP as the full source contract and do not fork the MCP protocol.
Use two generated boundaries:

1. **Workflow semantics:** `Strategos.Contracts` TypeSpec and
   `WorkflowDefinitionV1` from #1247/#1258 generate workflow IR, edge conditions,
   gate declarations, admission policies, and Exarchos Zod.
2. **Exarchos action API:** one action contract generates the internal dispatch
   types/metadata and projects the standard MCP 2026-07-28 `inputSchema`,
   `outputSchema`, structured result, annotations, and CLI presentation.

From those sources, generate:

- static input/output/result types;
- runtime validation;
- handler/provider interfaces;
- CLI metadata and rendering inputs;
- skill/documentation snippets;
- conformance fixtures;
- compatibility reports.

Do not add another synchronization test between editable representations. The
exit condition is that workflow semantics are editable only in the shared IR
contract or builder source, and action semantics only in the Exarchos action
contract.

### The MCP Schema Is a Projection of the Exarchos API Contract

The current `ToolAction` already contains semantics that belong to the internal
dispatch engine and are richer than the MCP wire:

- input and output schemas;
- valid phases and roles;
- gate and auto-emission metadata;
- task-dispatch and economy hints;
- long-running and deprecation posture;
- trusted capability posture;
- server-trusted safety plus MCP advisory annotations.

The target should preserve that distinction:

```text
Exarchos Action Contract
  -> dispatch interfaces and trusted metadata
  -> MCP-standard tool input/output schemas and annotations
  -> CLI/help/docs/skill examples
  -> ship-surface graph nodes and conformance fixtures
```

Exarchos-specific semantics such as effect ownership, phase kind, evidence
subject, idempotency policy, capability posture, or gate provider identity
should live in the generated internal contract/manifest. Project only the
standard subset onto MCP. If an external client does not understand the
Exarchos metadata, it still sees a valid MCP tool; the dispatch core still
receives the complete trusted contract. This avoids both protocol forking and a
facade-only contract that cannot structurally govern internal execution.

### Track 2: Build the Ship-Surface Graph

Generate one graph from existing registries:

```text
authored workflow
-> generated WorkflowDefinitionV1 IR
-> compiled topology / admission policy
-> public action
-> input contract
-> dispatch branch
-> handler
-> domain port
-> provider or adapter
-> event or external effect
-> output contract
-> packaged-artifact fixture
```

Make missing handlers, unreachable implementations, alternate effect paths,
unowned shell commands, and absent packaged proofs fail one closure check.

This graph should subsume targeted reachability checks over time rather than
becoming another independent registry.

### Track 3: Close the Proof-Producing Effect Path

Continue the recent branch direction:

- every enforceable gate routes through the canonical runner;
- the runner persists subject-bound evidence before returning success;
- direct gate emissions and unowned shell execution fail the ownership census;
- admission consumes the evidence reference and distinguishes pass, fail,
  skipped, and indeterminate;
- evidence is reusable only when its subject digest, policy digest, producer,
  and toolchain identity still match.

The owner/scope/cadence question becomes data on the canonical provider, not a
second hand-authored runbook contract.

## Proof-Carrying Feature Work Path

The persisted HTML visualizes this sequence. The report carries the same
normative path for every AI-generated feature:

```text
1. change the authoritative contract, IR node, or module boundary
2. generate compatibility classification plus reverse dependency/effect closure
3. regenerate every derivative: types, validators, providers, CLI, docs, skills,
   fixtures, and manifests
4. assign each affected claim to the cheapest sound proof layer
5. run the derived compiler, structural, conformance, property, and component
   proofs
6. build and benchmark the shipped artifact through a real production-path E2E
7. bind evidence to revision, contract, tools, environment, and artifact digest;
   admit the change, and convert any new defect class into a kill fixture and
   structural ratchet
```

Feature work is not trusted because it accumulates more tests. It is trusted
because the affected obligations are generated from honest boundaries, proved
at the cheapest sound layers, exercised through the packaged composition, and
bound to the exact artifact consumed by admission.

### Track 4: Audit Driftable Resources and Artifact Freshness

Inventory every resource that can outlive or contradict source:

- compiled binary and release asset;
- plugin cache and plugin manifest;
- generated skills, agents, hooks, and runtime embeddings;
- command aliases and CLI schema metadata;
- runbooks and fenced examples;
- user-level installed artifacts.

Use the existing package version, build SHA, plugin-version, and skill-hash
surfaces. The new requirement is a dogfood preflight that records and compares
them. Any mismatch should stop the run as an artifact-freshness failure before
workflow behavior is evaluated.

### Track 5: Ratchet Temporary and Advisory Controls

Every containment patch, advisory check, compatibility parser, or manual
fallback must declare:

- why structural enforcement is not yet possible;
- the owner;
- the measurable promotion or removal condition;
- the CI disposition;
- the date or milestone at which it is re-evaluated.

The repository should fail a manifest check when a temporary control has no exit
condition.

## Convergence on the Workflow IR

The phase-gate redesign already defines the correct milestone cut:

| Milestone | Structural role | Must not do |
|---|---|---|
| **v2.12** | Additive proof substrate: characterization, trusted identity, phase-attempt IDs, immutable evidence subjects/digests, canonical gate runner, durable evidence, supersession/contradiction, reliability projection, ownership census, and shadow disagreement data. | Do not add a second workflow-definition format, freeze a temporary public admission carrier, change transition behavior, or create another closed registry. |
| **v3.0** | Shared IR consolidation: TypeSpec admission models, generated Zod, closed edge-condition AST, requirement resolution, transition admission, generated CLI presentation, built-in workflow migration, enforcement cutover, and legacy guard/HSM/playbook deletion. | Do not preserve hand-written guards or bit-identical legacy objects merely for compatibility. Preserve behavior fixtures and event compatibility instead. |

Every dogfood finding should be assigned one lowering target:

| Dogfood surface | v2.12 structural treatment | v3.0 lowering |
|---|---|---|
| Gate ordering and duplicate verification | Characterize current cadence; route results through the canonical durable producer; record owner and subject. | `GateStep` declarations plus admission requirements define scope, freshness, cardinality, and blocking semantics. |
| Risk tier and boundary status | Verify current packaged classification/routing; freeze resolved inputs in phase-attempt facts and shadow requirement sets. | `RequirementResolver` compiles phase kind, risk, boundary status, policy, and reliability into a versioned requirement set. |
| Legacy transition guards | Capture deterministic allow/deny fixtures and bypass cases; shadow new decisions. | Closed edge-condition AST selects routes; admission policy consumes evidence; `workflow/guards.ts` and custom shell guards are deleted. |
| Mutable pass fields and approvals | Add typed evidence/waiver events and reject reserved generic appends. | Approval and expiring waiver are IR-declared evidence requirements, never patched status. |
| Runbooks, skills, and examples | Mark authoritative versus generated; validate temporary examples against live schemas. | Generate workflow guidance from builder/IR and facade examples from Exarchos action-contract projections; delete closed-form playbook registries. |
| Worktree and merge capability | Enforce at launcher/dispatch chokepoints and record capability/provenance; no workflow-specific shell syntax. | IR may declare capability requirements, but spatial enforcement remains a non-IR runtime seam. |
| Packaged binary or skill drift | Capture existing package/build/plugin/skill identity before dogfood and bind evidence to it. | Compiler and packaging pipeline stamp contract, generator, source, and artifact digests into proof-carrying outputs. |
| Stream/projection disagreement | Preserve as a kill fixture and prove the packaged event-store path. | Runtime substrate invariant, not workflow IR; admission treats missing/corrupt evidence as `indeterminate` and blocks. |

## Seven-Principle Remediation Matrix

| Principle | Application to this dogfood | Primary structural proof |
|---|---|---|
| **1. Generate every boundary** | Generate workflow policy/topology from shared TypeSpec IR; generate dispatch metadata, MCP projections, CLI, and docs from one Exarchos action API contract. | Regenerate and require a clean tree; compatibility diff; generated conformance fixtures. |
| **2. Algebraic behavior, explicit effects** | Replace boolean-plus-optional gate/transition carriers with pass/fail/skipped/indeterminate and allow/deny/indeterminate unions; isolate persistence and shell effects behind ports. | Strict exhaustive compilation plus adapter contract tests. |
| **3. Independently provable modules** | Give condition evaluation, requirement resolution, evidence production, admission policy, caller identity, storage, and artifact resolution narrow contracts and owned effects. | Module ownership/dependency checks and public-boundary component tests. |
| **4. Integration as a graph property** | Prove authored IR reaches compiled topology, public action, handler, owned effect, output, and packaged fixture. | Generated ship-surface graph closure plus a small real binary path test. |
| **5. Cheapest sound proof** | Use generation for representation drift, compiler for unions, graph checks for wiring, contract tests for providers, and E2E only for packaged composition. | Acceptance criteria name one primary proof layer and why cheaper layers are insufficient. |
| **6. Proof-carrying, bounded changes** | Bind gate evidence to subject, source revision, contract/policy/tool versions, artifact digest, and environment; invalidate stale evidence. | Generated impact closure and subject-bound evidence consumed by admission. |
| **7. Structural ratchets** | Preserve every dogfood defect as a kill fixture and enforce the earliest sound guard on every protected path. | Guard fails on the old defect, cannot silently skip, and has explicit scope/resources/expiry. |

## Structural Seam Inventory

The audit should cover at least these seam families:

| Seam | Current drift mode | Existing structure | Closure target |
|---|---|---|---|
| Public action contract | TS, Zod, registry, handler, dispatch metadata, MCP, CLI, and docs remain independently editable. | Output-schema requirement, action annotations, and registry construction checks. | Generate internal dispatch contracts and standard MCP/CLI/docs projections from one Exarchos action API contract. |
| Workflow topology and policy | HSM definitions, guards, playbooks, runbooks, and skills encode overlapping facts. | State machine, phase kinds, transition tests. | Workflow Builder -> WorkflowDefinitionV1 -> generated topology/admission; delete closed registries. |
| Result algebra | `success`, `passed`, skipped, warning, error, and indeterminate can be combined ambiguously. | Typed evidence verdicts and stricter runtime envelope schemas. | Generated exhaustive result/decision unions. |
| Gate execution ownership | Direct emitters, shell paths, and best-effort persistence can bypass the canonical producer. | Gate runner, durable producer, provider registry, ownership census. | Census rejects every alternate path; success requires persisted evidence. |
| Gate scope and cadence | Implementer, task, wave, and review paths may re-prove the same claim. | Risk ladder, phase kinds, evidence subjects. | IR gate declarations and admission requirements own scope/cardinality/freshness. |
| Module effects | Broad contexts permit direct event-store, git, filesystem, or process effects. | Composition-root guard, selected pure/effect seams, dependency rules. | Declared state/effect ownership, typed ports, and graph-enforced direction. |
| Storage and projections | Alternate writers, swallowed failures, HWM drift, and lagging projections can contradict the log. | SQLite WAL, atomic appender, idempotency, pure folds, integrity probe. | One authorized append path, packaged concurrency fixture, fail-closed proof consumption. |
| Runtime capability | Skills may assume worktree, mutation, hook, or durability capabilities the harness lacks. | Capability resolver, standard skills, launcher, runtime profiles. | Standards conformance plus dispatch/MCP and launcher chokepoints. |
| Guidance and examples | Skills, runbooks, aliases, and examples can preserve stale names, defaults, and semantics. | Renderer and generated-drift guards. | Generate guidance from IR and examples from the Exarchos action API contract. |
| Packaging and cache | Binary, plugin, installed skills, and user cache can represent different revisions. | Version/build/plugin/skill identity and compiled-binary fixture. | Artifact manifest binds all digests; preflight blocks mismatches. |
| Advisory controls | Temporary warnings and compatibility paths can become permanent policy. | Enforcer wiring manifest. | Owner, expiry, exit condition, kill fixture, and unfiltered CI path are mandatory. |

## Empirical Acceptance and Benchmark Plan

The structural program needs measured cutover gates, not qualitative claims.
Every benchmark artifact must record source SHA, binary tag, contract and
generator versions, environment, date, and raw samples.

| Obligation | Benchmark / E2E protocol | Acceptance threshold |
|---|---|---|
| Artifact freshness | Build/install one matching set, then independently mutate binary SHA, plugin version, skill hash, and embedded runtime digest. | Matching set proceeds; **4/4** mismatches block before the first workflow call. |
| Generated contract closure | Seed one drift in each generated derivative class: static type, Zod schema, CLI metadata, docs/skill snippet, fixture, compatibility metadata. | Regeneration or conformance CI catches **100%** of seeded drift; generated tree is clean afterward. |
| Ship-surface reachability | Generate the graph for every public action. Seed missing route, missing handler, unselected provider, alternate direct effect, missing output schema, and missing packaged fixture. | **100%** of public actions have a complete path; **6/6** negative controls fail the closure check. |
| Gate evidence durability | For every enforceable gate class, run at least **100** provider invocations with deterministic injected append success/failure and rerun cases. | Zero successful results without an evidence reference; **100%** of append failures return failure/indeterminate; same operation ID produces one canonical evidence record. |
| Same-stream concurrency | Spawn **4 real child processes**, each performing **250** same-stream appends; repeat **3** times and restart between runs. | **3,000/3,000** events are dense and unique; HWM and projections match; zero permanent append failures; p99 latency is no worse than **baseline +20%**. |
| Transition admission performance | Benchmark pure admission with active-evidence sets of 10, 100, and 1,000 records, at least **10,000** decisions per size. | p99 admission latency remains **<15 ms** excluding gate execution and report generation. |
| Shadow cutover | Replay the deterministic legacy corpus and collect live shadow attempts across every phase kind. | Zero unexplained fixture disagreements; at least **20** live attempts cover every phase kind with at least one allow and deny; every intentional disagreement has a typed disposition. |
| Verification economy | Record per task/wave: command digest, subject digest, wall time, tool calls, output bytes/tokens, and failure caught. | Identical command+subject evidence is executed once; full integration runs exactly once per wave; seeded-defect catch rate does not regress from baseline. |
| Packaged production paths | Spawn the compiled binary and exercise real MCP transport, persistence, configuration, and packaging for each observable effect family. | Every effect family has a passing packaged fixture; no fixture may substitute a source-level handler call. |
| Ratchet efficacy | Preserve every accepted dogfood defect as a kill fixture and run its proposed guard with a matched control. | Old defect fails, matched control passes, and guard infrastructure failure cannot report success. |

Performance thresholds that lack an established baseline should begin in
observe mode for one release, but the benchmark and provenance artifact are
required immediately. Promotion to blocking must name the measured baseline,
variance, regression budget, and sample size.

## Immediate Containment Batch

These changes may land before the audit completes, but they are **containment,
not remediation**. Each must either generate its driftable surface, route
through an existing structural owner, or carry an explicit retirement condition:

1. Move the integration suite to a wave-boundary runbook and place
   `task_complete` last among task-blocking steps.
2. Update `check_integration_suite` to consume a JSON report file.
3. Teach plan coverage the unified spec structure.
4. Split plan declaration coverage from implementation test existence.
5. Fix task-added source handling in test adequacy.
6. Correct delegate worktree claims, merge invocation guidance, plan threshold,
   and `.exarchos.yml` mutation placement.
7. Capture the existing package/build/plugin/skill provenance in dogfood
   preflight and stop on mismatch.
8. Add the repeated-infrastructure-failure stop-loss guidance to delegation.

## Issue Disposition

| Existing issue | Recommendation |
|---|---|
| #1537 | Keep open and implement report-file parsing; add an end-to-end package-manager noise fixture. |
| #1206 | Reproduce using the packaged runtime with build fingerprint. Reopen only if that exact source revision still fails; otherwise file packaging/composition drift. |
| #1228 | File a new integrity issue for persisted event-tail/HWM divergence and link #1228 as related, not identical. |
| #1515 | The epic is closed, but use its verification-ladder design as the policy source. File a focused cadence/ownership issue rather than reopening the epic. |
| #1542 | Keep closed if the native-isolation warning holds; add capability-driven fallback work under a new portability issue. |
| #1636 | Keep closed. Verify the recent stamp/classification/routing work through the packaged artifact before proposing any new risk policy. |

Recommended umbrella: **Structural closure: generated contracts, effect
ownership, ship-surface reachability, and artifact freshness**, with the
phase-gate findings attached as concrete failure fixtures and #1258 as the
consolidation target.

## Next Dogfood Exit Criteria

The next run should not be considered successful merely because all tasks merge.
Require:

1. Dogfood preflight records and matches the existing package version, build
   SHA, plugin version, and generated-skill hash.
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
9. Risk-tier behavior is verified against the current packaged artifact and
   recent merged routing changes before any new policy is added.
10. Two repeated infrastructure failures automatically produce a friction event
    and reduced-mode recommendation.
11. No required audit event is silently swallowed.
12. The same trace can be reconstructed from the event store, projections, and
    git without manual arbitration.
13. Every public action appears in the ship-surface graph with one reachable
    implementation, one owned effect path, and one packaged fixture.
14. Every non-structural contract or advisory has a named exit condition.
15. Every v2.12 mechanism names its v3.0 workflow-IR lowering, non-IR runtime
    chokepoint, or deletion milestone.
16. The phase-gate shadow corpus reaches the quantitative cutover criteria
    before admission enforcement replaces legacy guards.
17. A baseline-vs-candidate benchmark artifact records raw samples, provenance,
    variance, and regression budget.

## Recommended Follow-On

Start an `/ideate` workflow for:

```text
structural closure for Exarchos: generate workflow semantics from
Strategos.Contracts WorkflowDefinitionV1 and dispatch semantics from one
Exarchos action API contract; build the authored-workflow-to-packaged-effect
graph; close canonical gate evidence production and admission; inventory
driftable artifacts; and ratchet every temporary/advisory control. Keep v2.12
additive/shadow and reserve enforcement plus legacy deletion for v3.0. Optimize
for the smallest structurally closed target; breaking changes are acceptable
when they retire driftable or bypassable surfaces. Treat the five exhaustive
inventories in the Review Decisions section as required scope. Use
docs/research/2026-07-23-phase-gate-v212-dogfood-remediation.md as design input.
```

The implementation should be staged by structural dependency, not by symptom
severity. Containment fixes may land early, but they do not count as completion
unless the audit records the ratchet or retirement path they add.

## Sources

- `2026-07-21-phase-gate-v212-dogfood.md`
- `2026-07-21-structural-principles-codebase-assessment.md`
- `sol-research.zip:agent-principles.md`
- `sol-research.zip:2026-07-21-phase-gate-transition-admission.md`
- `docs/system-design.html` section 06, "Three zones, converging on one IR"
- GitHub issue #1258, Workflow Builder SDK v3.0.0
- `servers/exarchos-mcp/src/event-store/atomic-appender.ts`
- `servers/exarchos-mcp/src/event-store/{multi-process.test.ts,atomic-appender.race.test.ts,atomic-appender.acceptance.test.ts}`
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
- `servers/exarchos-mcp/src/views/delegation-readiness-view.ts`
- `servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts`
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
- Recent branch commits: `4d514919` (runner ownership census), `e6e837b4`
  (durable ladder evidence), `fd32043d` (phase-gate evidence), and `d139a765`
  (evidence event ownership alignment).
- GitHub issues #1206, #1228, #1515, #1537, #1542, and #1636, verified
  2026-07-23.

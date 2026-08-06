# Unified Structural Closure Remediation Plan

## Purpose

This is the single implementation plan for the structural-closure program. It
combines:

- the seven-program, 61-item structural audit backlog;
- the evidence-backed transition-admission design and its 53 tasks;
- the phase-gate dogfood defects, containment work, and exit criteria;
- the seven structural principles and seam analysis;
- the MCP-to-Exarchos API contract/compiler design; and
- the phase-gate proof-substrate implementation handoff in `implementation/`.

The source documents remain available under `sources/`, but they do not define
independent execution tracks. Their requirements are folded into the work
packages below.

## Program objective

Produce one closed proof system in which:

1. The event log and its projections provide one authoritative, recoverable
   state.
2. Workflow topology selects legal routes while evidence-backed admission
   decides whether a transition may occur.
3. Strategos.Contracts owns shared workflow, evidence, and admission IR.
4. The Exarchos API contract owns actions, envelopes, security, effects,
   compatibility, presentation, and implementation bindings.
5. MCP registration, CLI presentation, Workflow IR references, skills,
   instructions, fixtures, and documentation are generated from those
   authorities.
6. Every effect has one typed owner, idempotency boundary, and repair or
   compensation contract.
7. Every public action reaches one implementation, one owned effect path where
   applicable, one output contract, and one packaged proof.
8. Build, release, install, and cache identity remain bound to the same source
   and contract.
9. Legacy guards, duplicate facades, advisory controls, and manual inventories
   are removed after their generated or enforced replacements prove closure.

## Architectural boundaries

### Shared workflow authority

Strategos.Contracts and `WorkflowDefinitionV1` own:

- workflow topology and stable workflow identifiers;
- closed edge-condition nodes;
- gate declarations and evidence requirement models;
- admission-policy definitions and references;
- waiver and approval wire models; and
- cross-product serialization and compatibility.

The shared IR contains no shell command, arbitrary closure, harness-specific
syntax, or Exarchos implementation binding.

### Exarchos product authority

The Exarchos API contract owns:

- stable ActionIds and action lifecycle;
- total input, output, success, degraded, capped, and error schemas;
- execution, authorization, evidence, effect, cache, task, cancellation,
  economy, compatibility, and presentation policy;
- implementation bindings from ActionIds to handlers and policy hooks;
- API actions, presentation aliases, and host-local command classification; and
- extension admission, isolation, quotas, revocation, and anti-rollback.

MCP is a standards-compliant wire projection of this contract. The CLI is a
generated in-process client over the same MCP contract handler, not a separately
authoritative dispatch facade.

### Runtime enforcement authority

The event store, transition command, launcher, and provider boundaries own
runtime enforcement:

- `AtomicAppender` owns atomic decisions and lifecycle appends.
- The transition command is the sole admission chokepoint.
- The canonical gate runner owns durable evidence production.
- Typed effect providers own filesystem, process, VCS, install, network, and
  compensation effects.
- The launcher owns process lifecycle and top-level placement. Filesystem
  confinement remains a separately reported harness capability.

## Dependency graph

```text
PROGRAM-01 Authoritative state and evidence
  -> PROGRAM-02 Truthful gates and verification
  -> PROGRAM-03 Shared IR and API contract compiler
  -> PROGRAM-06 Transition admission and workflow semantics

PROGRAM-01
  -> PROGRAM-04 Effect ownership and recovery

PROGRAM-03 + PROGRAM-04 + PROGRAM-06
  -> PROGRAM-05 Ship-surface and artifact proof

PROGRAM-01..PROGRAM-06
  -> PROGRAM-07 Migration, ratchets, and retirement
```

PROGRAM-03 and PROGRAM-04 may proceed in parallel after PROGRAM-01. Pure
admission modeling in PROGRAM-06 may begin once shared IR authority is frozen,
but enforcement and public presentation wait for the required PROGRAM-03
contract outputs.

## PROGRAM-01 - Restore authoritative state and evidence

**Outcome:** Event, stream, projection, requirement, evidence, and decision
state is atomic, replayable, subject-bound, authorized, and fail-closed.

| Work package | Unified scope | Source coverage | Exit proof |
|---|---|---|---|
| P01-01 Atomic append and startup repair | Make stream version allocation, event insert, claims, and decision appends one transaction. Detect and repair sequence/version disagreement before accepting new writes. | `EFF-001`; transition tasks 041; dogfood CB-1 and exit criteria 3, 12 | Real multi-process same-stream fixture produces dense unique sequences, consistent high-water marks, and restart-safe appendability. |
| P01-02 Projection degradation and reliability | Compare event tail, stream version, and projection cursor. Publish one durable degraded state consumed by every readiness, workflow, and reliability view. | `EFF-002`, `BASE-002`; transition task 035; dogfood CB-8 | Fault injection makes every consumer return a typed degraded result rather than stale state. |
| P01-03 Evidence and admission algebra | Define exhaustive requirement, evidence, decision, waiver, contradiction, and reassessment types and events. Bind evidence to immutable subjects and content-addressed reports. | Transition tasks 007, 008, 011, 012 | Bare booleans cannot satisfy requirements; malformed subjects or artifact digests are rejected. |
| P01-04 Phase attempts and frozen state | Allocate a stable phase-attempt identity on initial entry and every re-entry. Persist complete requirement sets and decision state in the event fold. | Transition tasks 019, 020, 040 | Replay reconstructs the same active attempt, requirements, evidence, and decision without current-policy or external I/O. |
| P01-05 Canonical evidence production | Route every enforceable gate through one provider registry and durable gate runner. Persist evidence before success and reject alternate direct emitters. | Transition tasks 013-016, 049; dogfood DOC-6 | Ownership census fails on an alternate emitter, unregistered provider, or success without durable evidence. |
| P01-06 Evidence concurrency and contradiction | Define idempotent reruns, supersession chains, contradiction detection, and equivalent concurrent operation behavior. | `EFF-003`; transition task 043 | Concurrent equivalent operations produce one canonical active result; contradictory active evidence denies admission. |
| P01-07 Trusted identity and protected events | Derive principals and capabilities from transport/dispatch context, protect reserved event types, freeze authorization snapshots, and claim idempotency before evaluation. | `EFF-007`; transition tasks 039, 041, 052 | Callers cannot self-assert issuer, role, timestamp, policy, or reserved events; retries return the canonical stored result or typed conflict. |

## PROGRAM-02 - Restore truthful gates and verification

**Outcome:** Delegation, planning, task completion, integration, adequacy, and
native quality gates measure the intended scope at the intended lifecycle point.

| Work package | Unified scope | Source coverage | Exit proof |
|---|---|---|---|
| P02-01 Native gate health | Restore type-debt and module-intent gates and ensure the reliability projection is selected through production composition. | `BASE-001`, `BASE-002` | Repository-native blocking gates pass on the target checkout and fail on seeded violations. |
| P02-02 Wave-scoped delegation | Compute readiness from the requested task wave, not all historical assignments; preserve capability-aware worktree behavior. | `WFQ-002`; dogfood CB-2, DOC-1, DOC-2; exit criterion 2 | A four-task wave in a larger workflow reports exactly four required worktrees. |
| P02-03 Integration ownership and cadence | Consume a structured test report, run the full integration suite once at the wave boundary, and place completion after all blocking task gates. | `WFQ-003`, `WFQ-004`; dogfood CB-4, CB-5, DOC-6; exit criteria 5, 6 | Package-manager noise cannot corrupt parsing; no task-completed event precedes a blocking gate. |
| P02-04 Test adequacy | Discover changes from committed task branches, handle task-added source paths, and apply the verification ladder without false advisory success. | `WFQ-005`; dogfood CB-3; exit criterion 4 | Reverting changed source makes at least one scoped test fail, including tasks that add new source files. |
| P02-05 Plan and coverage semantics | Parse the canonical unified spec and separate plan syntax/traceability checks from post-implementation file existence and execution. | `WFQ-006`, `WFQ-010`; dogfood CB-6, CB-9; exit criteria 7, 8 | Future test paths are valid planning declarations while post-implementation coverage still requires real passing tests. |
| P02-06 Decomposition and risk plausibility | Add calibrated breadth, behavior-count, historical-size, and risk/boundary plausibility signals with explicit override rationale. | `WFQ-007`, `WFQ-009`; dogfood CB-7; exit criterion 9 | Implausible blanket risk stamps or oversized tasks trigger a structured challenge rather than silent acceptance. |
| P02-07 Workflow guidance and toolchain truth | Generate or validate skill examples against live schemas; correct merge capability, config shape, threshold, and runtime/toolchain behavior. | `WFQ-011` through `WFQ-015`; dogfood DOC-1 through DOC-5 | Documentation examples and registered schemas agree; supported workspaces resolve the same intended test runtime and timeout policy. |

## PROGRAM-03 - Compile shared IR and the Exarchos API contract

**Outcome:** Shared workflow semantics and Exarchos product semantics are
separate authoritative inputs to one deterministic generation pipeline.

| Work package | Unified scope | Source coverage | Exit proof |
|---|---|---|---|
| P03-01 Freeze contract authority | Pin Strategos.Contracts, MCP protocol/SDK, ActionId, compatibility, and target invariant decisions before generation. | `CTR-012`, `API-001`; transition task 046 | Floating or unapproved authority digests block generation and release. |
| P03-02 Close envelopes, security, and compatibility | Define total result/error carriers, authenticated request context, replay identity, version negotiation, directional migration, cache, task, cancellation, and response-economy semantics. | `API-002`, `API-006`; transition task 052 | Every protocol, authorization, task, handler, output, and presenter failure maps to a stable contract and CLI exit. |
| P03-03 Build the contract compiler | Compile the Exarchos meta-model into deterministic runtime descriptors, schemas, types, compatibility reports, and proof fixtures. | `API-003` | Repeated generation is byte-stable and rejects missing or incompatible policy/schema fields. |
| P03-04 Generate MCP registration and bindings | Generate tool discovery and registration while checking every ActionId has one exact non-serializable implementation binding. | `API-004` | Missing, duplicate, or stale bindings fail before server startup. |
| P03-05 Generate the CLI client | Generate parsing, help, invocation, rendering, exits, and golden/differential fixtures as an in-process MCP-contract client. | `API-005`; transition tasks 026, 048 | API actions have no direct CLI-to-dispatch path; generated CLI and MCP results agree by construction. |
| P03-06 Extend and consume shared admission IR | Add admission policies, edge conditions, evidence requirements, waivers, and action references to Strategos TypeSpec; generate and consume Exarchos validators and builder lowering. | `API-007`; transition tasks 002, 004-006, 033, 047 | Shared JSON Schema and Exarchos runtime validators round-trip the same fixtures and reject dangling references. |
| P03-07 Emit standard artifacts once | Generate standard Agent Skills, AGENTS.md, MCP instructions, agent principles, and invariant documentation; enumerate only capability-required thin shims. | `API-008`, `CTR-011` | Generated source/package/install/cache outputs agree; shim count never increases without an approved capability reason and expiry. |
| P03-08 Define extension trust | Define signed extension manifests, immutable digests, trust roots, isolation, quotas, revocation freshness, anti-rollback, and TOCTOU-resistant loading. | `API-009` | Untrusted, revoked, stale, rollback, over-quota, or mutated extensions fail closed before execution. |
| P03-09 Add an independent oracle | Independently compare contract declarations with implementation behavior, security checks, effect ownership, outputs, and compatibility. | `API-010` | Seeded incorrect handlers, missing authorization, undeclared effects, malformed outputs, and compatibility breaks are caught even when generated files agree. |

## PROGRAM-04 - Consolidate effect ownership and recovery

**Outcome:** Every shipped effect uses one typed owner and has explicit
idempotency, observability, repair, rollback, or compensation semantics.

| Work package | Unified scope | Source coverage | Exit proof |
|---|---|---|---|
| P04-01 Effect algebra and observable delivery | Classify every static effect occurrence; define typed success/error/dry-run carriers; make post-append hooks and channels explicit. | `BASE-005`, `EFF-013`, `EFF-015`; dogfood exit criterion 11 | The effect ledger has no indeterminate owner and required delivery failures cannot be silently swallowed. |
| P04-02 Cancellation process manager | Record cancellation intent, compensation intent/result, fencing, retries, and manual-intervention states as replayable events. | `EFF-005`; transition task 053 | Restart and takeover never repeat completed compensation and cannot report cancellation before outcomes are recorded. |
| P04-03 Artifact-store containment | Prove digest validation, path containment, atomic publish, concurrent writes, and packaged-entry-point behavior for evidence artifacts. | `EFF-006`; transition task 012 | Traversal, digest mismatch, partial publish, and concurrent collision fixtures fail safely. |
| P04-04 Atomic configuration and installation | Stage and atomically promote CLI/MCP config, generated skills, installers, and onboarding changes with corruption recovery. | `EFF-008`, `EFF-009`, `EFF-012` | Injected failures leave either the old complete state or the new complete state and retries converge. |
| P04-05 VCS and worktree ownership | Route git/worktree mutation through one owner; define provider idempotency keys, fencing, compensation, and capability-aware fallbacks. | `EFF-010`, `EFF-011` | Architecture checks reject direct bypasses; duplicate requests cannot create duplicate PRs, merges, branches, or worktrees. |
| P04-06 Rehydration under degradation | Define deterministic fallback precedence when projections are unavailable or contradictory. | `EFF-004` | Rehydration returns the authoritative event-derived or explicitly summarized state and never silently trusts stale projection data. |

## PROGRAM-05 - Close ship-surface and artifact proof

**Outcome:** Source, contract, generated outputs, built artifacts, installed
caches, and process-level proof form one verifiable identity chain.

| Work package | Unified scope | Source coverage | Exit proof |
|---|---|---|---|
| P05-01 Reproducible source-linked artifacts | Build all supported targets reproducibly, embed source/contract identity, and publish a signed release manifest consumed by installers. | `ART-001`, `ART-002`, `ART-003`, `ART-011`; dogfood exit criteria 1, 17 | Independent builds match expected digests; installer verification rejects source, contract, manifest, or asset mismatch. |
| P05-02 Packaged action and CLI proof | Exercise every API action, presentation alias, host command, error family, cancellation path, and effect family through the compiled process. | `ART-004`, `ART-005`, `ART-014` | Coverage reaches the full registered denominator and a CI ratchet prevents regression. |
| P05-03 Generated projection containment | Prove every generated skill, alias, agent, hook, manifest, instruction, and runtime projection is present and selected in the shipped/installed artifact. | `ART-008` | Removing or replacing any required projection fails packaged containment proof. |
| P05-04 Install and cache freshness | Record event-store schema identity, plugin/cache locations, and installed content digests; block stale or mixed installations. | `ART-006`, `ART-007`, `ART-009`, `ART-013` | Matching installations proceed; independently seeded binary, plugin, skill, schema, and cache mismatches block before workflow execution. |
| P05-05 Generated reachability graph | Generate and gate the graph from authored workflow and ActionId through schemas, dispatch, handler, provider/effect, output, artifact, and packaged fixture. | `CTR-013`; dogfood Track 2 and exit criterion 13 | Every public action has one complete path; seeded missing route, handler, owner, output, or fixture fails closure. |

## PROGRAM-06 - Implement evidence-backed transition admission

**Outcome:** Legal topology, pure route selection, frozen requirements, typed
evidence, policy decisions, waivers, and remediation compose at one atomic
transition chokepoint.

| Work package | Unified scope | Source coverage | Exit proof |
|---|---|---|---|
| P06-01 Characterize and classify legacy behavior | Capture deterministic allow/deny/fix-loop fixtures and classify every legacy guard as route condition, admission requirement, bounded-loop rule, approval, waiver, or obsolete predicate. | Transition tasks 001, 028 | Every built-in transition and known bypass has an expected decision fixture. |
| P06-02 Closed edge-condition evaluator | Define and evaluate a pure, declarative AST that selects a legal edge without policy, evidence collection, remediation, shell, or I/O. | Transition tasks 009, 010 | Unsupported nodes and arbitrary executable expressions are rejected at compile/import time. |
| P06-03 Monotonic requirement resolution | Resolve phase kind, risk, boundary status, policy, gate declarations, and reliability into one complete frozen set with a requirement-strength partial order. | Transition tasks 017, 018, 042 | Higher risk/boundary/reliability uncertainty cannot weaken obligations; unknown risk never becomes low. |
| P06-04 Policy and waiver evaluation | Evaluate active evidence as allow, deny, or indeterminate; model approvals and scoped expiring waivers without rewriting failed evidence. | Transition tasks 021, 022, 044 | Missing, stale, contradictory, malformed, or unauthorized evidence denies; waivers apply only to declared subjects and requirements. |
| P06-05 Atomic transition and cleanup | Fold at an expected version, evaluate route/admission, and append the decision and lifecycle siblings atomically. Route cleanup through the same primitive. | Transition tasks 003, 023, 024, 045 | Partial decision/transition siblings are impossible; retries return the same decision; denied attempts cannot mutate phase. |
| P06-06 Explainable decisions and remediation | Return requirement results, evidence references, policy identity, stable reasons, and schema-constrained `next_actions`. | Transition tasks 025, 026 | No remediation patches pass state; every denial identifies a safe actionable verb or stable terminal reason. |
| P06-07 Reassessment and bootstrap | Bootstrap existing workflows through events and reassess under an explicit policy version without changing historical replay. | Transition task 050 | Existing workflows gain attempts/requirements without mutable backfill; weaker reassessment requires an authorized waiver. |

## PROGRAM-07 - Migrate, prove, and retire legacy structure

**Outcome:** New authorities become the only production path after quantitative
proof, and every temporary mechanism has a finite removal condition.

| Work package | Unified scope | Source coverage | Exit proof |
|---|---|---|---|
| P07-01 Shadow decisions and cutover gate | Run legacy and admission decisions side by side, record typed disagreements, and gate enforcement on deterministic and live evidence. | Transition tasks 027, 051; dogfood exit criterion 16 | Zero unexplained corpus disagreements and at least 20 live attempts cover every phase kind with allow and deny outcomes. |
| P07-02 Migrate built-in workflows | Move feature, debug, refactor, oneshot, and discovery workflows to shared IR conditions, requirements, and admission policies. | Transition tasks 029-032 | Each workflow passes decision fixtures and has no production dependency on a legacy guard. |
| P07-03 Builder lowering and decision parity | Add builder combinators and compare compiled decisions rather than preserving legacy guard object shape. | Transition tasks 033, 034 | Builder output round-trips shared IR and produces the expected decisions for the characterization corpus. |
| P07-04 Import, CTK, replay, and performance | Validate custom workflow references and run shared-contract CTK, replay, cross-runtime, packaged, and admission performance suites. | Transition tasks 036-038 | Invalid references fail with diagnostics; admission p99 is under 15 ms excluding gate execution and report generation. |
| P07-05 Remove legacy and manual authorities | Complete downstream cutover; delete legacy guards, direct pass-state fixes, closed playbook/HSM registries, and manual inventories after replacements gate CI. | `BASE-004`, `CTR-015`; transition task 037 | Reachability and dependency scans prove no production references remain before deletion. |
| P07-06 Strengthen module boundaries | Decompose composition roots and registries; expand allowed-dependency and effect-port rules across modules. | `BASE-003`, `WFQ-016` | Mechanical checks reject forbidden imports, broad effect contexts, cycles, and direct adapter ownership. |
| P07-07 Promote and retire ratchets | Normalize test timeouts, promote advisory controls by measured evidence, and emit friction/stop-and-simplify signals for repeated infrastructure failure. | `WFQ-015`, `WFQ-017`, `WFQ-018`; dogfood exit criteria 10, 14, 15 | Every advisory has an owner, promotion/removal threshold, expiry, kill fixture, and unfiltered CI path. |

## Structural delivery waves

These waves are dependency groups, not release/version tracks.

### Wave A - Truth foundation

- PROGRAM-01 in full.
- PROGRAM-02 native gate, readiness, integration, and completion repairs.
- Characterization fixtures needed by PROGRAM-06.

**Exit:** State can be trusted, blocking gates measure the right scope, and no
later program must build on contradictory projections or false gate results.

### Wave B - Contract and effect foundations

- PROGRAM-03 authority freeze, security/envelope contract, compiler, shared IR,
  MCP bindings, CLI generation, standard artifacts, extensions, and oracle.
- PROGRAM-04 typed effect owners and recovery contracts.
- PROGRAM-06 pure edge conditions and requirement resolution.

**Exit:** All behavior is expressible through stable contracts and typed ports;
no new parallel registry or facade is required.

### Wave C - Admission and workflow integration

- PROGRAM-06 policy, waiver, atomic transition, remediation, reassessment, and
  bootstrap.
- PROGRAM-07 builder lowering and built-in workflow migration in shadow mode.

**Exit:** Every workflow can produce both legacy and admission decisions from
the same operation without changing production behavior.

### Wave D - Packaged proof

- PROGRAM-05 reproducible artifacts, signed identity chain, reachability graph,
  packaged action/CLI/effect proof, and install/cache freshness.
- PROGRAM-07 CTK, replay, performance, and custom import validation.

**Exit:** The exact shipped and installed artifacts prove the same behavior as
the contracts and source.

### Wave E - Enforcement and retirement

- Quantitative shadow cutover.
- Enforcement enablement through an event-sourced decision.
- Legacy deletion, module-boundary strengthening, ratchet promotion, and manual
  inventory retirement.

**Exit:** Generated/enforced authorities are the only production path and every
temporary control has exited.

## Integrated acceptance suite

The program is complete only when all of the following are mechanically true:

1. Native type-debt, module-intent, and structural gates pass and fail on seeded
   violations.
2. Event append, stream version, decision claims, and projection cursors cannot
   silently diverge; startup repair is proven under real concurrency.
3. Projection degradation blocks all consumers from acting on stale state.
4. Evidence is typed, immutable, subject-bound, authorized, durable, reusable
   only under matching identity, and replayable without external I/O.
5. Delegation, integration, completion, adequacy, planning, and coverage gates
   pass the dogfood reproductions without workarounds or duplicate ownership.
6. Shared workflow IR and the Exarchos API contract are the only editable
   semantic authorities.
7. Every API action has one implementation binding; the CLI has no direct
   dispatch path for API actions.
8. Every effectful action passes crash-window, fencing, cancellation, takeover,
   reconciliation, provider-idempotency, and compensation-failure proof.
9. Every public action and generated projection has a complete generated
   reachability path and compiled/installed proof.
10. Build, release, install, cache, source, contract, and generated-output
    identities agree and are verifiable before workflow execution.
11. Transition decisions are explainable, atomic, idempotent, fail-closed, and
    derived from frozen requirements plus active evidence.
12. Shadow evaluation meets the quantitative cutover gate before enforcement.
13. Launcher lifecycle ownership and per-harness spatial-confinement capability
    are reported separately.
14. The static effect ledger has no indeterminate owner.
15. Legacy guards, duplicate facades, manual inventories, and advisory controls
    have been removed or promoted through their measured exit conditions.

## Source coverage

This section proves that the source plans were merged rather than appended as
parallel execution tracks.

### Structural audit backlog

- PROGRAM-01: `EFF-001`, `EFF-002`, `EFF-003`, `EFF-007`
- PROGRAM-02: `WFQ-002`, `WFQ-003`, `WFQ-004`, `BASE-001`, `BASE-002`
- PROGRAM-03: `CTR-012`, `API-001`, `API-002`, `API-003`, `API-004`,
  `API-005`, `API-006`, `API-007`, `API-008`, `API-009`, `API-010`, `CTR-011`
- PROGRAM-04: `BASE-005`, `EFF-004`, `EFF-005`, `EFF-006`, `EFF-008`,
  `EFF-009`, `EFF-010`, `EFF-011`, `EFF-012`, `EFF-013`, `EFF-015`
- PROGRAM-05: `ART-001`, `ART-002`, `ART-003`, `ART-004`, `ART-005`,
  `ART-006`, `ART-007`, `ART-008`, `ART-011`, `ART-013`, `ART-014`
- PROGRAM-06: `WFQ-005`, `WFQ-006`, `WFQ-007`, `WFQ-009`, `WFQ-010`,
  `WFQ-011`, `WFQ-012`, `WFQ-013`, `WFQ-014`
- PROGRAM-07: `BASE-003`, `BASE-004`, `CTR-013`, `CTR-015`, `ART-009`,
  `WFQ-015` through `WFQ-018`

### Transition-admission design

- PROGRAM-01: tasks 007, 008, 011-016, 019, 020, 035, 039-041, 043, 049, 052
- PROGRAM-03: tasks 002, 004-006, 033, 046-048
- PROGRAM-04: tasks 012, 053
- PROGRAM-06: tasks 001, 003, 009, 010, 017, 018, 021-026, 028, 042, 044, 045,
  050
- PROGRAM-07: tasks 027, 029-038, 051

Every transition task 001-053 appears above. Tasks that cross boundaries are
implemented once at the work package that owns their runtime effect or
authoritative contract.

### Dogfood findings and exit criteria

- CB-1 and CB-8: PROGRAM-01
- CB-2 through CB-7 and CB-9: PROGRAM-02
- DOC-1 through DOC-6: PROGRAM-02 and PROGRAM-03 generated guidance
- Root-cause families for parallel contracts and weak global reachability:
  PROGRAM-03 and PROGRAM-05
- Root-cause families for effect ownership and evidence durability: PROGRAM-01
  and PROGRAM-04
- Advisory controls without exits: PROGRAM-07
- All 17 next-dogfood exit criteria are represented by the integrated acceptance
  suite and the work-package exit proofs.

## Planning rule

Implementation specs should select one work package or a dependency-closed set
of work packages. They should copy the relevant detailed evidence and acceptance
criteria from `remediation-backlog.json`, `api-contract-codegen.json`, and the
source design files, but they must not reintroduce a second program sequence.

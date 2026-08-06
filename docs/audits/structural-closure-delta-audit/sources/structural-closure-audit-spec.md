# Spec: Structural Closure Delta Audit

**Date:** 2026-07-23 · **Feature:** `structural-closure-delta-audit` · **Depth:** deep
**Inputs:** candidate-side `docs/audits/2026-07-21-structural-principles-codebase-assessment.md` (discovery correlationId: `structural-principles-codebase-assessment`) · candidate-side `docs/audits/2026-07-21-phase-gate-v212-dogfood.md` · `docs/research/2026-07-23-phase-gate-v212-dogfood-remediation.md` · `docs/research/2026-07-23-phase-gate-v212-dogfood-remediation.html` · baseline `30831d05f67c44b80e45391b67ed29f11dda4276` (`main`) · candidate `13cf9642b9c3ec5dec5a4bcfdbfc5ac6904a75f5` (`feature/phase-gate-v212-proof-substrate`) · authoring HEAD `6985fea1140d04191205b4e0b5d8bcd8b16c47eb`

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks to DR-N within this same document.

> The implementation recommendations produced by this audit are consolidated in
> `../unified-remediation-plan.md`. The decomposition below describes production
> of the audit package, not a second code-remediation sequence.

## Constraints

Anchored to `.exarchos/invariants.md`:

- **INV-1:** The append-only event log is the source of truth; projections are pure deterministic folds, not side databases.
- **INV-2:** CLI and MCP remain presentation-only facades over one dispatch core and one registered output contract.
- **INV-3:** Capability resolution remains handshake-authoritative and no design assumes a local-only MCP transport.
- **INV-4:** Skills and workflow content remain harness-agnostic, with `skills-src/` as the editable source and runtime variants generated.
- **INV-5a / INV-5b:** Inputs are constrained by schemas and every result preserves the structured success/error carrier.
- **INV-5c / INV-5d:** Control-plane behavior remains queryable and dry-run-capable through the four composite tools and their action discriminators.
- **INV-6:** Substrate guarantees apply across workflow types; workflow-specific behavior belongs in topology and playbooks.

The audit is read-only with respect to production code. It may add the spec, report, manifest, and five machine-readable inventories. Temporary collection helpers stay in the session artifact directory. It must not implement containment fixes, edit generated runtime outputs, or create worktrees.

## Scope Amendment: First Baseline Report

This is the first structural-closure report that will drive codebase changes. The
candidate snapshot is therefore the current-state baseline. Commit chronology and
the `30831d05..13cf9642` delta remain evidence provenance, but they are secondary
and belong in an appendix rather than the executive assessment.

The report must add:

- repository-scale metrics for source, tests, large modules, enforcement posture,
  structural gate results, and validation health
- an exhaustive current-state assessment organized by codebase domain rather
  than by commit delta
- a prioritized implementation backlog (`P0` through `P2`) with exact code
  evidence, target files, proposed change, acceptance proof, dependencies, risk,
  and estimated scope
- explicit mapping from systemic findings and non-closed inventory classes to
  implementation initiatives or a documented monitor/no-action disposition
- positive structural patterns worth preserving during remediation

The report is successful when maintainers can select a backlog item and turn it
into an implementation spec without repeating the audit.

### #1608 target-state overlay

The audit must preserve current-catalog compliance as historical evidence while
also assessing the accepted target direction from #1601, #1604, #1606, #1608,
#1258, and `docs/system-design.html`.

- **INV-2:** the CLI becomes a generated presentation client over the MCP
  contract. Parity tests become codegen golden/differential tests rather than
  the primary equivalence mechanism.
- **INV-4:** emit standard Agent Skills, AGENTS.md, and MCP artifacts once.
  Retain only capability-justified thin shims where no standard exists.
- **INV-11:** the launcher owns lifecycle and top-level placement, not
  filesystem write confinement. Spatial isolation is a per-harness capability
  requiring a Bash-covering hook standard or kernel sandbox.

### MCP-to-Exarchos API contract requirement

The MCP protocol schema is necessary but not sufficient as the Exarchos API
contract. The report must define a versioned Exarchos-owned contract compiler
that composes:

1. MCP 2026-07-28 protocol semantics and full JSON Schema 2020-12 tool schemas.
2. Shared Workflow Builder/event/evidence IR from `Strategos.Contracts`.
3. Exarchos-specific action identity, envelope, error, execution, evidence,
   compatibility, extension, and presentation policies.
4. A non-serializable implementation binding from stable action IDs to exact
   handlers and policy hooks.
5. Generated MCP registration, runtime validators/types, CLI client/parser/
   renderer, fixtures, standard artifacts, documentation catalogs, and
   Workflow Builder action references.

The contract must explicitly classify API actions versus host-local commands,
version all compatibility surfaces, model every emittable success/error/
degraded/capped shape, and preserve dry-run, queryability, task/cancellation,
response economy, cache, next-action, and security semantics.

It must also specify:

- stateless multi-client/request context, reverse requests, durable task
  ownership/expiry/tombstones/resumption, cancellation linearization, worker
  leases/fencing, and cross-instance replay claims
- transport-authenticated principals and scopes; request `_meta` remains
  untrusted and cannot authorize work
- total mapping from protocol, method, schema, authorization, task, timeout,
  handler, output, presenter, and internal failures into versioned error
  contracts and CLI exits
- version negotiation/refusal, directional upcasts, input/output variance,
  policy-change compatibility, and canonical contract digests
- generated-output provenance and an independent implementation/security/effect
  oracle so generated declarations cannot self-certify incorrect behavior
- signed extension admission with immutable digests, trust roots, revocation,
  anti-rollback, isolation, quotas, and TOCTOU resistance
- a machine-reconciled proof matrix covering every API action, presentation
  alias, and host command
- a concrete, non-increasing thin-shim baseline with finite expiry and
  source/package/install/cache removal proof

## Design & Rationale

### Problem Statement

The July 21 structural-principles assessment found strong local controls but no closed repository-wide proof system. The phase-gate dogfood then exposed concrete failures at exactly those open seams: independently editable contracts, duplicated gate ownership, source/package disagreement, incomplete reachability, advisory controls without exits, and event/projection uncertainty.

The relevant repository change is the phase-gate branch itself. `30831d05` is the branch point on `main`; `13cf9642` is the 43-commit candidate and already contains the July 21 structural assessment plus the canonical gate runner, evidence migrations, and ownership census. Those artifacts are absent from `main`. The remediation report's chronology implied they landed after the assessment, but git history proves the assessment commit is later than those changes. The audit must therefore compare baseline `30831d05` to candidate `13cf9642`, and separately test the candidate-side assessment's claims against exhaustive evidence.

The audit must distinguish structural closure from local evidence. A registry test, documentation claim, or source-level handler test does not prove that the packaged binary selects the same implementation, owns the effect, persists authoritative evidence, and exposes the same contract through CLI and MCP. Missing proof is `indeterminate` or open, never silently counted as closed.

### Chosen Approach

Run one repository-wide structural closure audit against the pinned baseline and candidate. Use `git show`, `git diff`, `git archive`, current registries/manifests, existing tests, and targeted source inspection. Build five linked inventories: competing contract sources, effect ownership and bypasses, public-action-to-packaged-artifact reachability, driftable/cached artifacts, and v2.12-to-v3.0 lowering. Each row cites evidence and uses `closed`, `partial`, `open`, or `indeterminate`.

The audit proceeds dependency-first. It pins source and artifact identity; enumerates registries, generated derivatives, production roots, effect ports, and proof fixtures; resolves them into a ship-surface graph; compares current evidence with the July 21 snapshot; then re-scores the seven principles without changing the rubric. The recent gate-runner and evidence commits are verified as candidate closures, not assumed closed because the files exist.

The output is a Markdown audit report plus five JSON inventories and a manifest under `docs/audits/`. Production fixes remain out of scope. Findings may recommend containment or convergence work, but each recommendation names its structural owner, proof layer, v3 lowering or runtime chokepoint, and retirement condition where the evidence supports one.

### Requirements (DR-N)

#### DR-1: Pin a reproducible baseline, target, and evidence manifest

The audit records the baseline, candidate, authoring branch, repository status, and material commands or registries used to produce inventory counts.

**Acceptance criteria:**
- The manifest identifies baseline `30831d05f67c44b80e45391b67ed29f11dda4276`, candidate `13cf9642b9c3ec5dec5a4bcfdbfc5ac6904a75f5`, and authoring HEAD `6985fea1140d04191205b4e0b5d8bcd8b16c47eb` separately.
- Evidence commands identify which SHA or checkout they inspected.
- Every inventory records source range, generated timestamp, row count, and evidence references.
- Candidate-side audit/report inputs are read from `13cf9642`; untracked convenience copies are not evidence.

#### DR-2: Exhaustively inventory contract sources and generated derivatives

Enumerate the union of built-in MCP actions (visible and hidden), custom actions from the repository's pinned default configuration subject, standalone CLI commands, workflow definitions, plugin commands/skills, runtime aliases, and generated agent surfaces. Arbitrary consumer-supplied custom configurations are an open extension domain represented by one explicit `open/indeterminate` boundary row, not falsely enumerated. Then identify each editable contract source, competing representation, generated artifact, validation schema, guidance projection, and drift guard in both trees.

**Acceptance criteria:**
- Every member of the declared surface universe has exactly one inventory row or an explicit duplicate-source finding.
- Counts reconcile against registry introspection, CLI help/dispatch enumeration, workflow topology, plugin manifests, runtime YAML, and generated-output manifests in both archived trees.
- Each independently editable TypeScript, Zod, registry, runbook, CLI, skill, or documentation representation is classified as canonical, generated, checked, advisory, temporary, or unowned.
- The inventory declares its included surface classes and records arbitrary consumer custom tools as an open extension boundary.

#### DR-3: Exhaustively inventory effect ownership and bypass paths

Trace event/storage writes, filesystem writes, process/git execution, package/install mutation, network/VCS operations, hooks, and other shipped effects from dispatch to their authorized owner across the declared production roots. Dynamic or unresolved injection is `indeterminate`, never silently absent.

**Acceptance criteria:**
- Every discovered candidate is linked to an owner and production root or marked unowned/indeterminate with evidence.
- The canonical gate runner and durable producers are checked against all direct gate emitters; the ownership census is verified for coverage and fail-closed behavior.
- No effect path remains unclassified, and swallowed or best-effort persistence is reported as an open closure gap.
- The report states search roots and known limitations so comprehensiveness is bounded rather than overstated.

#### DR-4: Build complete public-action-to-packaged-effect reachability

Construct an evidence graph from each public action through input contract, dispatch, handler, optional port/provider/effect segment, output contract, and the strongest available packaged proof.

**Acceptance criteria:**
- Every public action has one selected implementation, owned effect path where applicable, output contract, and packaged proof or an explicit missing-proof finding.
- Projection surfaces such as skills, aliases, agents, and manifests are linked to their source/generator and packaged containment evidence.
- Graph node and edge counts reconcile with action, handler/provider, effect-owner, and packaged-fixture inventories.
- A source-level handler test is not credited as packaged proof; the proof must exercise the built CLI/MCP composition.

#### DR-5: Inventory artifact freshness and cache disagreement

Inventory artifact classes by joining package metadata, build outputs, plugin manifests, bootstrap installers, release workflows/assets, supported platform/runtime matrices, generated resources, install destinations, and accessible user-level caches.

**Acceptance criteria:**
- Every artifact class identifies its source identity, derivative digest/version, comparison mechanism, and mismatch behavior.
- Existing package version, build SHA, plugin-version, and skill-hash surfaces are located and assessed before recommending a new mechanism.
- Missing or inaccessible cache evidence is marked `indeterminate`; it cannot be reported as fresh.
- Existing packaged fixtures and identity diagnostics are assessed; unavailable package/cache proof becomes a finding or `indeterminate` row rather than blocking the audit.

#### DR-6: Assign every v2.12 mechanism a v3.0 lowering or runtime disposition

Enumerate v2.12 from the `30831d05..13cf9642` diff, candidate spec, dogfood findings, and compatibility/deprecation surfaces. Map each identified mechanism to a workflow IR node, admission-policy field, generated action/MCP projection, non-IR runtime chokepoint, explicit retirement, or `unresolved` disposition.

**Acceptance criteria:**
- Every v2.12 mechanism has exactly one primary lowering/disposition and supporting evidence.
- Temporary public carriers, parallel workflow-definition formats, and closed registries are flagged when they would create consolidation churn.
- Breaking retirement is allowed when the row includes migration/cutover evidence and preserves required event or behavior compatibility.
- The audit cites the v3 sources it consulted; unavailable or conflicting authority is reported as `unresolved`.

#### DR-7: Re-score the seven structural principles as a true delta

Apply the original 0-4 maturity rubric to baseline and candidate evidence, then compare the result with the candidate-side July 21 assessment.

**Acceptance criteria:**
- All seven principles have baseline score, current score, delta, evidence, and residual gaps.
- A score increases only when the relevant surface is generated or mechanically enforced across all applicable paths; partial implementations remain partial.
- The report explicitly verifies the canonical runner, durable evidence, migrations, and ownership census rather than citing their commits as sufficient proof.
- Any disagreement with the July 21 assessment is reported as an evidence/chronology correction, not silently normalized.
- Each principle records the evidence and judgment supporting its score; unsupported dimensions remain `indeterminate`.

#### DR-8: Ratchet every advisory or temporary control

For every non-structural disposition exposed by the five inventories, record `owner`, `ciPosture`, `exitCondition`, `reevaluateAt`, and `retirementProof`.

**Acceptance criteria:**
- Every advisory, compatibility path, manual fallback, or containment item has a named owner and measurable exit condition.
- Controls without an exit are reported as closure failures, not documentation debt.
- Module dependency/ownership analysis and the advisory ledger become top-level deliverables only where an exhaustive inventory exposes a gap.

#### DR-9: Fail closed on missing, conflicting, or unavailable evidence

The audit uses `closed`, `partial`, `open`, and `indeterminate` outcomes. Inventory/report reconciliation prevents missing evidence from being presented as closure.

**Acceptance criteria:**
- Every failed probe records the command, error, affected rows, and retry or evidence requirement.
- `indeterminate` rows block a "structurally closed" conclusion and are summarized separately from confirmed defects.
- Final reconciliation checks required fields, duplicate identifiers, dangling references, report totals, and non-structural rows without exit conditions.

#### DR-10: Deliver a reviewable audit package without worktrees or production fixes

Produce one baseline report, five linked inventories, a manifest, and three
structured supporting artifacts (`codebase-metrics.json`,
`remediation-backlog.json`, `api-contract-codegen.json`). The audit may also
update this spec and `docs/system-design.html` where authority contradictions
would otherwise invalidate the report. Production code, generated runtime
outputs, dependencies, refs, and worktree topology remain unchanged.

**Acceptance criteria:**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md` summarizes findings, score deltas, closure gaps, and recommended sequencing.
- `docs/audits/2026-07-23-structural-closure-delta-audit/` contains nine JSON
  artifacts: the manifest, five inventories, codebase metrics, remediation
  backlog, and API-contract codegen target architecture.
- JSON parses cleanly, identifiers/references reconcile, backlog/program DAGs
  are acyclic, API-contract acceptance gates validate, and report totals match
  structured artifacts.
- Repository probes are read-only; any optional build/package experiment runs outside the authoring checkout.
- The manifest records digests/timestamps, authority reconciliation,
  cross-artifact links, validator results, and the intentional
  `docs/system-design.html` documentation-authority correction.
- Before/after status and worktree checks show no production/generated source or worktree changes.

### Technical Design

**Evidence boundary.** Baseline `30831d05` and candidate `13cf9642` are inspected explicitly through git object reads, diffs, and optional non-worktree archives. The authoring checkout is used only to write the audit artifacts. Every conclusion cites repository-relative paths, symbols, commits, commands, tests, or runtime diagnostics.

**Inventory method.** Each of the five inventories declares its included surface classes and search roots. Existing registries, manifests, generated-output guards, architecture checks, and package diagnostics are preferred over new tooling. Static searches produce candidates; targeted source reading classifies them. Anything outside the declared scope or unavailable at runtime is recorded as `indeterminate` or an open extension boundary.

**Reachability and proof.** The ship-surface inventory records the path from public action to dispatch, implementation, effect where applicable, output, and strongest packaged evidence. Missing handler, owner, output, or packaged evidence is the audit result; it is not a prerequisite for running the audit.

**Delta and scoring.** Inventory rows record baseline state, candidate state, evidence, delta, disposition, and exit condition where relevant. The original seven-principle rubric is applied consistently with explicit judgment notes. The July 21 assessment is compared principle by principle, and disagreements remain visible.

**Final reconciliation.** The manifest records the SHAs, inventory row counts, commands, limitations, and failed probes. JSON files are parsed and cross-referenced, report totals are checked against them, and final git status/worktree checks confirm that only audit artifacts changed.

### Integration Points

- Baseline `30831d05` and candidate `13cf9642` archives — the only trees collectors/builds may inspect as audit subjects.
- Candidate `servers/exarchos-mcp/src/registry.ts`, CLI dispatch/help, workflow topology, plugin manifests, runtime YAML, and generated manifests — contract-surface universe.
- Candidate `gate-runner.ts`, `durable-gate-producer.ts`, `check-gate-runner-ownership.mjs`, event store, storage, projections, installers, adapters, hooks, and provider integrations — effect universe.
- Package metadata, build scripts, release workflows, `.claude-plugin/`, bootstrap installers, runtime generation, and install/cache destinations — artifact universe.
- `docs/specs/2026-07-21-phase-gate-v212-proof-substrate.md`, `docs/system-design.html`, roadmap/issue sources, changed symbols, and compatibility/deprecation entries — v2.12/v3 universe.
- Audit manifest, five inventories, and report — persisted evidence and reconciliation.

### Exploration

The provided remediation discovery performed the initial divergent loop. It extends the discovery workflow `structural-principles-codebase-assessment` (`correlationId: structural-principles-codebase-assessment`) and is persisted at `docs/research/2026-07-23-phase-gate-v212-dogfood-remediation.md`, with the HTML review artifact beside it. The first adversarial plan-review panel then refuted the source chronology: the named gate artifacts are candidate-only, and the candidate-side assessment commit is later than those artifacts. This revision preserves Option C but corrects the audited range to `30831d05..13cf9642`.

- **Option A — patch every finding independently:** fast containment, but preserves parallel contracts and source/package ambiguity.
- **Option B — close phase-gate only:** improves the immediate subsystem, but leaves the same drift and reachability classes elsewhere.
- **Option C — repository-wide structural closure delta audit:** chosen, corrected to compare branch-point baseline with the phase-gate candidate in isolated archives.

No new discover bridge is invoked because the supplied report resolves the program, optimization target, compatibility posture, and five required inventories. If plan-review finds an external `Strategos.Contracts` version or roadmap decision that cannot be resolved from repository evidence, that specific uncertainty may be escalated through `discover_bridge`; the audit itself does not auto-escalate.

### Alternatives considered

- **Repeat the July 21 assessment from prose alone:** rejected because it cannot establish exhaustive baseline/candidate row universes.
- **Treat recent commits as proof of closure:** rejected because file presence does not prove production selection, ownership, packaging, or artifact freshness.
- **Implement containment while auditing:** rejected by scope; it mixes observation with mutation and obscures the measured baseline.
- **Create parallel worktrees for inventory tracks:** rejected because the work is read-only, the user requested avoiding worktrees, and separate trees would complicate one pinned target.
- **Probe the live report checkout:** rejected because it is based on `main` and lacks the candidate-only phase-gate artifacts.

### Open Questions

- Public-action, effect, artifact, and v2.12 cardinalities are resolved by the versioned collector universes and negative fixtures, not frozen by prose.
- User-level cache locations may be unavailable; those rows remain `indeterminate` and block a freshness-closed conclusion.
- The authoritative v3 source set is a blocking foundation task. Missing sources yield `unresolved` dispositions rather than fabricated lowering.
- Module dependency rules and a separate advisory ledger are promoted only if the five required inventories expose gaps that cannot be represented in their schemas.

## Superseded Decomposition (rev.0)

### Scope

**Target:** Full read-only delta audit from `13cf9642` to `30831d05`, producing the report, manifest, and five machine-readable inventories.

**Excluded:** Production fixes, containment implementation, dependency changes, generated runtime edits, new enforcement scripts, Git branches, and worktrees. Read-only evidence collection may run concurrently, but repository artifact writes are serialized per output file.

### Traceability matrix (DR-N -> tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Reproducible baseline and evidence manifest | 001, 026 |
| DR-2 | Contract sources and generated derivatives | 002-005 |
| DR-3 | Effect ownership and bypass paths | 006-009 |
| DR-4 | Public-action-to-packaged-effect reachability | 010-013 |
| DR-5 | Artifact freshness and cache disagreement | 014-017 |
| DR-6 | v2.12-to-v3.0 lowering and retirement | 018-021 |
| DR-7 | Seven-principle delta scoring | 023-025 |
| DR-8 | Advisory and temporary control ratchets | 022, 025 |
| DR-9 | Fail-closed evidence handling | 001, 005, 009, 013, 017, 021, 026 |
| DR-10 | Reviewable audit package; no worktrees/fixes | 001, 025, 026 |

### Tasks

#### Rev0 Task 001: Create the pinned audit manifest

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-1, DR-9, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Parse the JSON and confirm baseline, target, report HEAD, repository status, schema version, inventory names, evidence-command ledger, and initial worktree count are present.

**Steps:**
1. Record the three SHAs, branch, tool versions, status, source inputs, and `git worktree list` baseline.
2. Define the shared inventory envelope and required cross-file validation rules in the manifest.
3. Mark failed probes as structured `indeterminate` entries rather than omitting them.

**Dependencies:** None
**Parallelizable:** No

#### Rev0 Task 002: Enumerate registered action contract rows

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Reconcile action rows with `registry.ts`, registry construction tests, and live action descriptions; JSON must parse after the append.

**Steps:**
1. Enumerate every action under the four visible composite tools from mechanical sources.
2. Record input/output schema owners, handler registration, annotations, and competing editable representations.
3. Capture the exact evidence command and cardinality.

**Dependencies:** 001
**Parallelizable:** Yes

#### Rev0 Task 003: Enumerate workflow semantics contract rows

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2, DR-6
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Reconcile built-in workflow, topology, phase-kind, guard, admission, playbook, and runbook counts against current source.

**Steps:**
1. Enumerate every built-in workflow definition and its editable semantic representations.
2. Identify overlaps among topology, guards, admission policy, playbooks, runbooks, and skills.
3. Classify the current canonicality and drift guard for each row.

**Dependencies:** 002
**Parallelizable:** No

#### Rev0 Task 004: Map generated contract derivatives and guidance

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2, DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Generated artifact rows reconcile with renderer inputs, runtime YAML, manifests, aliases, skills, agents, hooks, CLI metadata, and docs/examples.

**Steps:**
1. Link each contract row to generated and hand-authored derivatives.
2. Record generation commands, drift guards, and independently editable guidance.
3. Flag stale examples or compatibility representations as non-structural.

**Dependencies:** 003
**Parallelizable:** No

#### Rev0 Task 005: Reconcile and close the contract inventory

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Reject duplicate IDs, hand-count-only rows, missing dispositions, and non-structural rows without exit conditions; manifest count must equal parsed rows.

**Steps:**
1. Reconcile action and workflow cardinalities against every mechanical source.
2. Resolve duplicate-source findings and classify unresolved conflicts.
3. Update manifest totals and validation status.

**Dependencies:** 004
**Parallelizable:** No

#### Rev0 Task 006: Census event-store and projection effects

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-3
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Every production append, storage mutation, projection materialization, and integrity-repair path is represented with source evidence.

**Steps:**
1. Enumerate authorized append/storage roots and alternate constructors or writers.
2. Record event, stream-version, projection, and repair effects with owners.
3. Mark swallowed, best-effort, or projection-only state paths as candidates for open findings.

**Dependencies:** 001
**Parallelizable:** Yes

#### Rev0 Task 007: Census gate and evidence effect ownership

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-3, DR-7
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** All gate providers, canonical runners, durable producers, direct emitters, and admission consumers are linked or explicitly missing.

**Steps:**
1. Trace phase-gate and ladder-gate evidence from provider to persisted event and returned result.
2. Compare current emitters with the runner-ownership census.
3. Record subject binding, idempotency, failure behavior, and evidence reuse inputs.

**Dependencies:** 006
**Parallelizable:** No

#### Rev0 Task 008: Census filesystem, process, git, and install effects

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-3, DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Candidate shell/process calls and filesystem/package mutations are either linked to an authorized port/root or marked unowned.

**Steps:**
1. Enumerate production process spawn, git mutation, filesystem write, install, and packaging sites.
2. Record capability checks, intent/result event protocols, and bypass paths.
3. Separate test-only and build-only effects from shipped runtime effects.

**Dependencies:** 007
**Parallelizable:** No

#### Rev0 Task 009: Verify effect-owner coverage and bypass disposition

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-3, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Reject unclassified effect rows and confirm the ownership census itself is CI-wired and fail-closed with negative fixtures.

**Steps:**
1. Reconcile static candidates against authorized effect-owner lists and guards.
2. Classify every bypass as closed, partial, open, or indeterminate.
3. Update effect totals and failure records in the manifest.

**Dependencies:** 008
**Parallelizable:** No

#### Rev0 Task 010: Seed ship-surface action and dispatch nodes

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-4
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Public-action, input-contract, dispatch, handler, and output-contract nodes reconcile with the closed contract inventory.

**Steps:**
1. Create graph nodes for every public action and workflow-originating action.
2. Add dispatch, handler, and output-schema edges from current registration.
3. Record missing or multi-selected implementation edges as findings.

**Dependencies:** 005
**Parallelizable:** Yes

#### Rev0 Task 011: Join providers and owned effects into the graph

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-3, DR-4
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Every effectful action path joins to an effects inventory ID; dangling or multiply-owned effect edges fail validation.

**Steps:**
1. Add domain-port, provider/adapter, and effect-owner nodes.
2. Join graph paths to the effects inventory by stable IDs.
3. Record alternate or unreachable paths explicitly.

**Dependencies:** 009, 010
**Parallelizable:** No

#### Rev0 Task 012: Map packaged CLI and MCP proof fixtures

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-4, DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Credited fixtures must spawn or exercise the built CLI/MCP composition; source-level handler tests are labeled insufficient.

**Steps:**
1. Enumerate compiled-binary, stdio transport, parity, packaging, and install fixtures.
2. Link each public action/effect family to the strongest existing packaged proof.
3. Mark absent or source-only proof as a graph closure gap.

**Dependencies:** 011
**Parallelizable:** No

#### Rev0 Task 013: Reconcile ship-surface graph closure

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-4, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Reject dangling references, incomplete required paths, duplicate implementation selection, and totals that disagree with contracts/effects.

**Steps:**
1. Validate every action path from public surface to output and packaged proof.
2. Summarize missing nodes by closure class.
3. Update graph counts and validation status in the manifest.

**Dependencies:** 012
**Parallelizable:** No

#### Rev0 Task 014: Inventory binary, package, and plugin identity

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Each binary/package/plugin row records source identity, derivative identity, comparison mechanism, and mismatch behavior.

**Steps:**
1. Locate package version, build SHA, release asset, plugin manifest, and compatibility checks.
2. Record how the installed or packaged artifact proves its source revision.
3. Distinguish present diagnostics from enforced preflight.

**Dependencies:** 001
**Parallelizable:** Yes

#### Rev0 Task 015: Inventory generated skills, agents, hooks, aliases, and runtimes

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2, DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Generated resource classes reconcile with their source directories, renderer/build commands, hashes, and drift guards.

**Steps:**
1. Enumerate every generated runtime resource and embedded derivative class.
2. Record source path, generator, digest/version surface, and install destination.
3. Flag independently editable or unhashed derivatives.

**Dependencies:** 014
**Parallelizable:** No

#### Rev0 Task 016: Inventory user installs and cache disagreement

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-5, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Accessible install/cache locations record actual identity; inaccessible locations produce structured `indeterminate` rows.

**Steps:**
1. Enumerate installer destinations, plugin caches, generated skill installs, and user-level artifacts.
2. Compare available identities with target source and packaged manifests.
3. Record stop/continue behavior for every mismatch or missing identity.

**Dependencies:** 015
**Parallelizable:** No

#### Rev0 Task 017: Reconcile artifact freshness posture

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-5, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Every artifact class has a freshness outcome; missing evidence cannot be classified as fresh; totals update the manifest.

**Steps:**
1. Reconcile source-to-derivative identity chains.
2. Classify mismatch detection as structural, checked, advisory, temporary, or absent.
3. Summarize preflight gaps and indeterminate cache rows.

**Dependencies:** 016
**Parallelizable:** No

#### Rev0 Task 018: Enumerate v2.12 mechanisms and dogfood findings

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-6
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Every mechanism in the assessed phase-gate branch and every dogfood finding has one row with evidence and current posture.

**Steps:**
1. Seed rows from the proof-substrate spec, dogfood report, and remediation matrix.
2. Link each row to current source or an explicit retired/missing state.
3. Record characterization, proof-substrate, audit, shadow, containment, or enforcement posture.

**Dependencies:** 001
**Parallelizable:** Yes

#### Rev0 Task 019: Map workflow and evidence mechanisms to v3

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-6
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Workflow, requirement, gate, evidence, admission, and transition rows each select one IR/admission target or retirement.

**Steps:**
1. Map topology, phase kind, conditions, gate scope, evidence subjects, and admission decisions.
2. Identify temporary carriers or registries that must not become permanent public contracts.
3. Record migration and compatibility obligations.

**Dependencies:** 005, 009, 018
**Parallelizable:** No

#### Rev0 Task 020: Map facade, artifact, and runtime mechanisms to v3

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-5, DR-6
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Action API, MCP/CLI projections, guidance, packaging, cache, capability, event-store, and projection rows each have one lowering or runtime disposition.

**Steps:**
1. Assign generated action-contract or facade projections where semantics are portable.
2. Assign non-IR runtime chokepoints for storage, packaging, capability, and cache enforcement.
3. Assign deletion milestones for legacy guidance and closed registries.

**Dependencies:** 017, 019
**Parallelizable:** No

#### Rev0 Task 021: Validate lowering uniqueness and cutover evidence

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-6, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Reject rows with zero or multiple primary dispositions, vague future targets, or breaking retirement without migration/event compatibility evidence.

**Steps:**
1. Validate one primary lowering/disposition per row.
2. Reconcile row coverage against the dogfood and remediation source lists.
3. Update lowering totals and validation status in the manifest.

**Dependencies:** 020
**Parallelizable:** No

#### Rev0 Task 022: Ratchet all non-structural inventory rows

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-8, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Every advisory, temporary, compatibility, manual, open, or indeterminate row has owner, CI posture, exit/evidence condition, and re-evaluation milestone.

**Steps:**
1. Join non-structural rows across all inventories.
2. Fill measurable promotion, removal, retry, or evidence conditions.
3. Promote module-ownership or advisory-ledger follow-ups only when the inventory cannot carry the gap.

**Dependencies:** 005, 009, 013, 017, 021
**Parallelizable:** No

#### Rev0 Task 023: Re-score structural principles 1 through 3

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Each principle records baseline score, current score, delta, mechanically supported improvements, and residual closure gaps under the original rubric.

**Steps:**
1. Score generated boundaries, algebraic/effect integrity, and independently provable modules.
2. Separate local controls from repository-wide closure.
3. Cite inventory IDs and current source evidence for every score claim.

**Dependencies:** 005, 009, 013
**Parallelizable:** Yes

#### Rev0 Task 024: Re-score structural principles 4 through 7

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7, DR-8
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Integration graph, proof economy, proof-carrying bounded changes, and ratchets use the same 0-4 rubric and cite inventory evidence.

**Steps:**
1. Verify the recent gate runner, durable evidence, migrations, and ownership census end to end.
2. Score principles 4-7 and record deltas and residual gaps.
3. Refuse score increases supported only by commit presence or source-level tests.

**Dependencies:** 013, 017, 021, 022, 023
**Parallelizable:** No

#### Rev0 Task 025: Synthesize findings and convergence sequencing

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7, DR-8, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Report totals reconcile with inventories and every recommendation names structural owner, proof layer, v3 lowering/runtime seam, and retirement condition.

**Steps:**
1. Summarize confirmed closures, partial closures, open gaps, and indeterminate evidence.
2. Sequence follow-on work by structural dependency, not symptom severity.
3. Keep containment recommendations separate from audit completion.

**Dependencies:** 024
**Parallelizable:** No

#### Rev0 Task 026: Validate and freeze the audit package

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-1, DR-9, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md`
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false

**Verification:** Parse all JSON; validate required fields, unique IDs, cross-file references, exit conditions, manifest/report totals, unchanged worktree count, and a git diff limited to the spec/audit package.

**Steps:**
1. Run deterministic cross-file and JSON validation.
2. Compare final worktree topology and repository diff against Task 001's baseline.
3. Freeze final counts, failed probes, and validation results in the manifest and report.

**Dependencies:** 025
**Parallelizable:** No

### Parallelization

No worktrees are created. After Task 001, four read-only evidence lanes may run concurrently:

- **Contracts:** 002 -> 003 -> 004 -> 005
- **Effects:** 006 -> 007 -> 008 -> 009
- **Artifacts:** 014 -> 015 -> 016 -> 017
- **v3 seed:** 018, then waits for contracts/effects before 019

Ship-surface work (010-013) begins after the contract/effect joins it needs. Lowering work (019-021) joins contracts, effects, and artifact freshness. Tasks 022-026 are the serialized convergence path. If agents are used, evidence collection is read-only and returned to the lead; the lead remains the single writer for each shared audit artifact.

### Completion checklist

- [ ] Every DR-N maps to at least one task and every task `Implements:` an existing DR-N
- [ ] Baseline, target, report HEAD, commands, and worktree topology are pinned
- [ ] Five exhaustive inventories and their manifest parse and cross-reference cleanly
- [ ] Every public action, workflow definition, effect, artifact class, and v2.12 mechanism is accounted for or explicitly indeterminate
- [ ] Every non-structural row has an owner and measurable exit/evidence condition
- [ ] Seven-principle scores use the original rubric and cite current mechanical evidence
- [ ] Report totals match inventory totals
- [ ] No production/generated source, dependency, branch, or worktree change is introduced
- [ ] Ready for `plan-review`

## Superseded Decomposition (rev.1-3)

### Scope

**Target:** Full evidence-producing audit of baseline `30831d05` versus candidate `13cf9642`, executed from SHA-bound non-worktree archives.

**Excluded:** Production fixes, containment implementation, production CI wiring, dependency-manifest edits, generated runtime edits, branch creation, and worktrees. Audit-local tooling under `docs/audits/2026-07-23-structural-closure-delta-audit/` is in scope.

### Traceability matrix (DR-N -> tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Pre-audit snapshot, pinned sources, archives, chronology, and evidence manifest | 099, 101, 104-106, 141 |
| DR-2 | Exhaustive contract-source universe and delta | 107-111 |
| DR-3 | Exhaustive effect-owner universe and delta | 112-116 |
| DR-4 | Typed ship-surface graph and packaged proof | 117-122, 142-143 |
| DR-5 | Artifact/cache universe and freshness delta | 123-127, 142 |
| DR-6 | v2.12 universe and v3 lowering | 128-131 |
| DR-7 | Deterministic seven-principle delta and assessment comparison | 133-140, 146 |
| DR-8 | Ratchets for every non-structural row | 132, 139-140, 144-146 |
| DR-9 | Executable, schema-closed failure and indeterminate semantics | 100-103, 111, 116, 122, 127, 131, 133, 141, 146 |
| DR-10 | Reviewable package; isolated mutation; no worktrees | 099-100, 104-106, 120-121, 126, 140-143, 146 |

### Tasks

#### Superseded Task 099: Capture the pre-audit repository snapshot

**Risk Tier:** low
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-1, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/pre-audit-snapshot.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** Snapshot records status/index/refs/worktrees/tracked-tree and known generated/ignored roots before any Task 100-141 file is created.
**Steps:** Use existing read-only git/filesystem commands, write the snapshot as the first audit artifact, and make every later task depend transitively on it.
**Dependencies:** None
**Parallelizable:** No

#### Superseded Task 100: Configure audit-local test discovery

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-9, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/vitest.config.ts`
- `docs/audits/2026-07-23-structural-closure-delta-audit/test-discovery.test.ts`
- `docs/audits/2026-07-23-structural-closure-delta-audit/kill-probe.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/kill-probe.test.ts`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** `AuditConfig_OneKnownTest_DiscoversExactlyOne`, `AuditConfig_ZeroTests_Fails`, and `KillProbe_ExplicitSourceRemoval_MakesNamedTestFail` prove discovery and adequacy cannot pass vacuously.
**Steps:** Add the dedicated Vitest include, zero-test preflight, and staging-local explicit source/test kill probe used by every medium/high audit task.
**Dependencies:** 099
**Parallelizable:** No

#### Superseded Task 101: Define the audit JSON Schema

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-1, DR-4, DR-8, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/schema.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/schema.test.ts`
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`

**testingStrategy:** propertyTests: true (valid rows round-trip through schema validation), benchmarks: false, characterizationRequired: false
**Verification:** Run the explicit audit Vitest config; valid baseline/candidate rows and the initial manifest pass while malformed enums/references/ratchets fail.
**Steps:** Define common/source-range/evidence/failure/ratchet/report-summary/score records, specialized inventories, graph nodes/edges, and closed enums; create a schema-valid incremental manifest skeleton.
**Dependencies:** 100
**Parallelizable:** No

#### Superseded Task 102: Implement cross-file audit validation

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Acceptance Test Ref:** 103
**Implements:** DR-4, DR-8, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/validate.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/validate-audit.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/validate.test.ts`

**testingStrategy:** propertyTests: true (ID/reference permutation preserves only valid joins), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config scoped tests plus the staging-local kill probe; validate uniqueness, source pairing, graph grammar, proof cardinality, primary lowering, exits, score arithmetic/citations, report-summary totals, and required metadata.
**Steps:** Implement schema loading, incremental mode (missing not-yet-produced files allowed only when declared pending), final mode, cross-file joins, and a fail-closed CLI with attributable diagnostics.
**Dependencies:** 101
**Parallelizable:** No

#### Superseded Task 103: Add validator known-bad fixtures

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** acceptance
**Implements:** DR-4, DR-8, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/fixtures/validator/`
- `docs/audits/2026-07-23-structural-closure-delta-audit/validate-audit.acceptance.test.ts`

**testingStrategy:** propertyTests: true (every single-rule mutation is rejected), benchmarks: false, characterizationRequired: false
**Verification:** Scoped tests plus the staging-local kill probe; each known-bad package fails for exactly the seeded rule.
**Steps:** Seed duplicate IDs, missing source pair, dangling edge, duplicate provider, missing output/proof, family-only proof, missing exit, multiple lowering, malformed failed-probe propagation, conflicting evidence, indeterminate-claimed-closed, report-total mismatch, inaccessible-cache-claimed-fresh, unavailable-v3-source-lowered, retirement-without-migration, invalid score, and unresolved citation fixtures.
**Dependencies:** 102
**Parallelizable:** No

#### Superseded Task 104: Implement SHA-bound source export and command logging

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Acceptance Test Ref:** 105
**Implements:** DR-1, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/source-snapshot.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/source-snapshot.test.ts`
- `docs/audits/2026-07-23-structural-closure-delta-audit/collect-audit.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/collect-audit.test.ts`

**testingStrategy:** propertyTests: true (archive identity always matches requested SHA), benchmarks: false, characterizationRequired: false
**Verification:** Scoped tests plus the staging-local kill probe; exports never use `git worktree` and reject mutating repository-root commands.
**Steps:** Implement `collect-audit.mjs snapshot|collect|probe|score|render|validate`, `git archive` export, archive/file hashes, root command allowlist, per-task ledgers, snapshots, and a `registerCollector` wrapper that automatically applies `assertArchiveRoot` and rejects unregistered collector modules.
**Dependencies:** 100, 101
**Parallelizable:** Yes

#### Superseded Task 105: Prove source isolation and no-worktree behavior

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-1, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/source-isolation.acceptance.test.ts`
- `docs/audits/2026-07-23-structural-closure-delta-audit/fixtures/source-isolation/`

**testingStrategy:** propertyTests: true (arbitrary requested refs export the resolved immutable tree), benchmarks: false, characterizationRequired: false
**Verification:** Tests `ExportTree_RequestedSha_ProducesMatchingArchive`, `Collector_AuthoringCheckoutRoot_Rejects`, `CollectorRegistry_UnwrappedModule_FailsConstruction`, and `RunCommand_MutatingRepoRoot_Rejects`, the staging-local kill probe, and audit integration suite.
**Steps:** Test correct contents, wrong-SHA/root rejection, command logging, snapshots, registration-enforced containment for every collector module, and staging-only mutation.
**Dependencies:** 104
**Parallelizable:** No

#### Superseded Task 106: Export baseline and candidate evidence trees

**Risk Tier:** low
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-1, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/source-snapshot.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** The source-isolation acceptance test passes; evidence records merge-base/ancestry, 43-commit range, assessment/gate artifact introduction commits, both archive hashes/file counts, authoring HEAD, status, refs, and worktree baseline.
**Steps:** Run the tested exporter, persist chronology/source snapshots, and update the manifest with archive hashes, file counts, source SHAs, tool versions, authoring branch, and command-ledger roots before any collector/probe task becomes ready.
**Dependencies:** 105
**Parallelizable:** No

#### Superseded Task 107: Implement the contract-surface universe collector

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/contracts.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/contracts.test.ts`

**testingStrategy:** propertyTests: true (surface union is order-independent and deduplicated by stable ID), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; an independent per-SHA eligible-file/declaration ledger detects omitted roots, omitted classes, unrecognized eligible declarations, and coordinated row/count omissions.
**Steps:** Assert archive root/SHA, enumerate the complete eligible tree independently of extractors, then extract visible/hidden/custom MCP, CLI-only, workflow, plugin, runtime alias, and generated-agent surfaces.
**Dependencies:** 101, 105, 106
**Parallelizable:** Yes

#### Superseded Task 108: Collect MCP action contract rows

**Risk Tier:** low
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** Visible, hidden sync, and configured custom action counts reconcile with baseline/candidate registry introspection and descriptions.
**Steps:** Populate action rows with schemas, annotations, dispatch/handler owners, and baseline/candidate delta.
**Dependencies:** 107
**Parallelizable:** No

#### Superseded Task 109: Collect CLI workflow plugin and runtime surfaces

**Risk Tier:** low
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** CLI help/dispatch, workflow topology, plugin manifests, runtime YAML, aliases, commands, skills, and agents reconcile.
**Steps:** Append non-MCP public surfaces and link aliases/projections to their owning contract.
**Dependencies:** 108
**Parallelizable:** No

#### Superseded Task 110: Collect competing representations and derivatives

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2, DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** TypeScript, Zod, registry, runbook, CLI, skill, docs/example, generated derivative, and drift-guard evidence is present for each surface.
**Steps:** Classify canonical/generated/checked/advisory/temporary/unowned representations in both trees.
**Dependencies:** 109
**Parallelizable:** No

#### Superseded Task 111: Reconcile the contract inventory and omissions

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/contracts.test.ts`

**testingStrategy:** propertyTests: true (removing any universe member creates a detected count mismatch), benchmarks: false, characterizationRequired: false
**Verification:** Collector tests and full audit validator pass; hidden-action, CLI-only, workflow, alias, omitted-root, omitted-class, unrecognized-eligible-file, and coordinated row/count omissions fail.
**Steps:** Reconcile mechanical counts, resolve duplicates, and freeze contract row totals.
**Dependencies:** 103, 110
**Parallelizable:** No

#### Superseded Task 112: Define the independent production-effect ledger

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/effects.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/effects.test.ts`
- `docs/audits/2026-07-23-structural-closure-delta-audit/fixtures/effects/`
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/effect-invocations.json`

**testingStrategy:** propertyTests: true (alias/import rewrites preserve effect classification), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; ledgers fail on omitted JS/MJS/CJS roots/classes, unrecognized files, and one omitted invocation among multiple sinks in the same file.
**Steps:** Assert archive root/SHA; enumerate every eligible source file and every syntactic call/command candidate losslessly before category extraction; require each invocation ID be consumed once or indeterminate.
**Dependencies:** 101, 105, 106
**Parallelizable:** Yes

#### Superseded Task 113: Collect event storage and projection effects

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/effects-event-storage.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/effects-event-storage.test.ts`

**testingStrategy:** propertyTests: true (alias/import rewrites preserve event/storage classification), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; all append, stream-version, storage write, projection, repair, and alternate-constructor candidates classify.
**Steps:** Implement only event/storage extraction and populate baseline/candidate rows with owners, protocols, idempotency, and failure behavior.
**Dependencies:** 112
**Parallelizable:** No

#### Superseded Task 114: Collect filesystem process git and install effects

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3, DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/effects-process-fs.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/effects-process-fs.test.ts`

**testingStrategy:** propertyTests: true (alias/import rewrites preserve filesystem/process classification), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; filesystem, process, git, package-manager, installer, and build candidates classify.
**Steps:** Implement filesystem/process/git/install extraction and append runtime/installer/build/staging classifications.
**Dependencies:** 113
**Parallelizable:** No

#### Superseded Task 115: Collect network VCS hook and dynamic effects

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/effects-network-dynamic.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/effects-network-dynamic.test.ts`

**testingStrategy:** propertyTests: true (aliases and injected functions cannot disappear from candidate output), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; fetch/HTTP, GitHub/VCS, hook, open-world, injected-function, and unresolved dynamic candidates classify or become indeterminate.
**Steps:** Implement network/hook/dynamic extraction and append capability, owner, production-root, and limitation evidence.
**Dependencies:** 114
**Parallelizable:** No

#### Superseded Task 116: Reconcile effect owners bypasses and negative controls

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/effects.test.ts`

**testingStrategy:** propertyTests: true (removing an owner or sink rule makes reconciliation fail), benchmarks: false, characterizationRequired: false
**Verification:** Collector fixtures and audit validator pass; omitted roots/classes, coordinated row/count omission, unclassified candidates, swallowed persistence, and ownership-census omissions fail.
**Steps:** Join owners/roots, verify gate-runner census coverage in the candidate, and freeze effect totals.
**Dependencies:** 103, 115
**Parallelizable:** No

#### Superseded Task 117: Implement ship-surface graph construction

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/graph.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/graph.test.ts`

**testingStrategy:** propertyTests: true (valid path permutations retain reachability; broken links never do), benchmarks: false, characterizationRequired: false
**Verification:** Scoped tests plus the staging-local kill probe; executable effectful/effect-free and projection containment/consumer-resolution grammars are enforced.
**Steps:** Build nodes/edges from contracts/effects, classify each surface executable or projection, and emit the corresponding per-surface proof obligation.
**Dependencies:** 101
**Parallelizable:** Yes

#### Superseded Task 118: Build surface dispatch handler and output graph nodes

**Risk Tier:** low
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** Every contract surface has input, dispatch, selected handler, and output nodes in baseline/candidate.
**Steps:** Populate graph roots and flag missing/multi-selected handlers or outputs.
**Dependencies:** 111, 117
**Parallelizable:** No

#### Superseded Task 119: Join ports providers and effects into the graph

**Risk Tier:** low
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3, DR-4
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** Effectful paths join to exactly one selected provider/effect row; effect-free paths are explicitly typed.
**Steps:** Add port/provider/effect nodes and alternate/unreachable path findings.
**Dependencies:** 116, 118
**Parallelizable:** No

#### Superseded Task 120: Implement pristine probe sandboxing

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-4, DR-5, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/probe-sandbox.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/probe-sandbox.acceptance.test.ts`
- `docs/audits/2026-07-23-structural-closure-delta-audit/fixtures/packaged-proof/`

**testingStrategy:** propertyTests: true (proof identity always binds to requested archive SHA), benchmarks: false, characterizationRequired: false
**Verification:** Tests `ProbeSandbox_LiveRoot_Rejects`, `ProbeSandbox_DirtyOutputRoot_Rejects`, and `ProbeSandbox_UndeclaredSourceMutation_Rejects`, staging kill probe, and integration suite pass.
**Steps:** Implement only fresh extraction, isolated HOME/TMP/npm/Bun/native caches, empty-output preflight, dependency/tool hashes, and pre/post content manifests.
**Dependencies:** 105, 117
**Parallelizable:** No

#### Superseded Task 142: Implement actual tarball build and installation

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-4, DR-5, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/package-install.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/package-install.acceptance.test.ts`

**testingStrategy:** propertyTests: true (installed digest always maps to one archive SHA and tarball digest), benchmarks: false, characterizationRequired: false
**Verification:** Tests `PackageInstall_DryRunOnly_Rejects`, `PackageInstall_TarballDigest_BindsArchive`, and `PackageInstall_CodegenMutation_IsDeclared`, staging kill probe, and integration suite pass.
**Steps:** Build from the sandbox, create/hash the actual tarball, install to a separate prefix, record declared codegen changes, and reject undeclared mutations.
**Dependencies:** 120
**Parallelizable:** No

#### Superseded Task 143: Implement executable and projection proof adapters

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-4, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/surface-proof.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/surface-proof.acceptance.test.ts`

**testingStrategy:** propertyTests: true (every surface kind selects exactly one allowed proof grammar), benchmarks: false, characterizationRequired: false
**Verification:** Tests `ExecutableSurface_InstalledInvocation_BindsDigest`, `ProjectionSurface_PackagedContainment_ResolvesConsumer`, and `FamilyProof_PerSurfaceMissing_RemainsOpen` pass.
**Steps:** Implement CLI/MCP installed execution adapters and skill/alias/agent/manifest containment plus consumer-resolution adapters.
**Dependencies:** 117, 142
**Parallelizable:** No

#### Superseded Task 121: Execute baseline and candidate packaged proofs

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Acceptance Test Ref:** 120
**Implements:** DR-4, DR-5, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/packaged-proof.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/packaged-proof.acceptance.test.ts`

**testingStrategy:** propertyTests: true (captured proof subject equals archive SHA/artifact digest), benchmarks: false, characterizationRequired: false
**Verification:** Acceptance tests `ExecuteProof_PerSurfacePath_BindsArtifactDigest`, `ResolveProjection_PackagedManifest_BindsConsumer`, and `ExecuteProof_FamilyOnlyFixture_RemainsOpen`, the staging-local kill probe, and integration suite pass in staging.
**Steps:** For each tree/proof group, create a fresh extraction and isolated environment, reject undeclared source/codegen mutations, install the actual tarball into a separate prefix, execute or resolve each surface from that installation, and record missing coverage.
**Dependencies:** 106, 119, 143
**Parallelizable:** No

#### Superseded Task 122: Reconcile ship-surface closure

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/graph.test.ts`

**testingStrategy:** propertyTests: true (any required-node deletion breaks closure), benchmarks: false, characterizationRequired: false
**Verification:** Full validator and graph tests pass; every baseline/candidate surface is closed, open, or indeterminate with attributable missing nodes.
**Steps:** Reconcile counts with contracts/effects/proofs and freeze graph deltas.
**Dependencies:** 103, 121
**Parallelizable:** No

#### Superseded Task 123: Define the independent artifact authority ledger

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/artifacts.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/artifacts.test.ts`

**testingStrategy:** propertyTests: true (manifest order/format changes preserve the same artifact IDs), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; independent tree/package/module ledgers fail on omitted manifest/build/release/runtime/installer roots, omitted classes, and unrecognized eligible files.
**Steps:** Assert archive root/SHA and define authoritative metadata sources, platform/runtime matrices, install destinations, cache classes, and precedence without populating rows.
**Dependencies:** 101, 105, 106
**Parallelizable:** Yes

#### Superseded Task 124: Collect package plugin build and release rows

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/artifacts-package.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/artifacts-package.test.ts`

**testingStrategy:** propertyTests: true (manifest ordering preserves artifact IDs), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; package files/bin, manifests, build outputs, release workflows/assets, and bootstrap installers reconcile.
**Steps:** Implement package/build/plugin/release extraction, populate rows, and test omitted-root/class/coordinated-count failures.
**Dependencies:** 123
**Parallelizable:** No

#### Superseded Task 125: Collect generated runtime install and cache rows

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/artifacts-generated.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/artifacts-generated.test.ts`

**testingStrategy:** propertyTests: true (generated source-to-derivative mapping is order-independent), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; skills, agents, hooks, aliases, runtimes, platforms, destinations, and caches are represented; omissions fail.
**Steps:** Implement generated/runtime/install/cache extraction and record structured indeterminate evidence.
**Dependencies:** 121, 124
**Parallelizable:** No

#### Superseded Task 126: Execute isolated pack build and identity checks

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-5, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifact-identity.acceptance.test.ts`
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/artifact-identity.json`

**testingStrategy:** propertyTests: true (artifact digest/version resolves to exactly one source SHA), benchmarks: false, characterizationRequired: false
**Verification:** Acceptance tests `BuildIdentity_MismatchedDigest_Fails` and `PackManifest_DeclaredFiles_MatchArchive`, the staging-local kill probe, and integration suite pass in staging; no live-root outputs change.
**Steps:** After Task 121, use new fresh extractions to compare declared package contents with actual tarballs/installations, record dependency/tool hashes and post-build mutations, and run mismatch negative controls.
**Dependencies:** 105, 121, 123, 125
**Parallelizable:** No

#### Superseded Task 127: Reconcile artifact freshness delta

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/artifacts.test.ts`

**testingStrategy:** propertyTests: true (missing identity never maps to fresh), benchmarks: false, characterizationRequired: false
**Verification:** Validator and artifact tests pass; every authority-ledger item is consumed exactly once and every class is fresh, mismatched, open, or indeterminate with evidence.
**Steps:** Join static/runtime evidence, classify preflight enforcement, and freeze artifact deltas.
**Dependencies:** 103, 126
**Parallelizable:** No

#### Superseded Task 128: Implement the lossless v2.12 source-item ledger

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/lowering.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/lowering.test.ts`

**testingStrategy:** propertyTests: true (changed-source order does not change mechanism IDs), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; every changed file/symbol, spec task, dogfood finding, event/schema addition, and compatibility/deprecation item persists before grouping.
**Steps:** Assert archive root/SHA; define parsers and a lossless source-item ledger with stable IDs, provenance, consumed-by links, and omitted-root/class controls.
**Dependencies:** 101, 105, 106
**Parallelizable:** Yes

#### Superseded Task 129: Enumerate the complete v2.12 mechanism universe

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-6
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/lowering-group.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/lowering-group.test.ts`

**testingStrategy:** propertyTests: true (source-item order does not change explicit grouping), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; every source item maps to one-or-more explicit mechanisms and omitted/multi-mechanism fixtures behave correctly.
**Steps:** Implement auditable grouping grammar, populate mechanisms, and reject unconsumed or silently collapsed source items.
**Dependencies:** 128
**Parallelizable:** No

#### Superseded Task 130: Pin the authoritative v3 source set

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/v3-sources.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-authority.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/lowering.test.ts`

**testingStrategy:** propertyTests: true (authority precedence and snapshot hash are deterministic), benchmarks: false, characterizationRequired: false
**Verification:** Repository and external sources carry immutable revision/update/content hash; omitted/conflicting sources and mutable-unpinned bytes fail, unavailable authority blocks all lowerings as unresolved.
**Steps:** Materialize the fixed design-time authority/precedence policy, bind repository sources to candidate SHA, persist external bytes/metadata, and test omitted/conflicting authority inputs before assigning lowerings.
**Dependencies:** 128, 129
**Parallelizable:** No

#### Superseded Task 131: Assign and validate one v3 disposition per mechanism

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/lowering.test.ts`

**testingStrategy:** propertyTests: true (every mechanism has exactly one allowed primary disposition), benchmarks: false, characterizationRequired: false
**Verification:** Validator and lowering tests pass; every authority-ledger source item is consumed, and vague/multiple/missing dispositions, unresolved authority bypass, and retirement without migration evidence fail.
**Steps:** Assign IR, admission, action-contract, runtime-chokepoint, retirement, or blocking unresolved dispositions.
**Dependencies:** 103, 111, 116, 127, 130
**Parallelizable:** No

#### Superseded Task 144: Add contract and effect ratchets

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-8
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** Every non-structural contract/effect row receives the exact five DR-8 fields and passes the validator.
**Steps:** Populate measurable ownership, CI posture, exit, reevaluation, and retirement evidence for contracts/effects only.
**Dependencies:** 111, 116
**Parallelizable:** Yes

#### Superseded Task 145: Add graph artifact and lowering ratchets

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-8
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** Every non-structural graph/artifact/lowering row receives the five DR-8 fields and passes validation.
**Steps:** Populate ratchets for graph, artifact, and lowering inventories.
**Dependencies:** 122, 127, 131
**Parallelizable:** Yes

#### Superseded Task 132: Reconcile all non-structural ratchets

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-8, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`

**testingStrategy:** propertyTests: true (all non-structural dispositions require the five ratchet fields), benchmarks: false, characterizationRequired: false
**Verification:** Validator rejects any non-structural row missing `owner`, `ciPosture`, `exitCondition`, `reevaluateAt`, or `retirementProof`, including coordinated omissions.
**Steps:** Reconcile Tasks 144-145 against all primary/evidence denominators and freeze ratchet totals.
**Dependencies:** 144, 145
**Parallelizable:** No

#### Superseded Task 133: Score Principle 1 from inventory evidence

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/scores/principle-1.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/assessment-claims.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/scoring.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/scoring.test.ts`

**testingStrategy:** propertyTests: true (scores remain 0-4 and delta equals candidate-baseline), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; every July assessment score/largest/strongest/weakest/gap claim is extracted, partitioned to a principle, consumed once, and compared.
**Steps:** Implement the evaluator and assessment-claim parser, hash the rubric, validate predicates/citations/indeterminate propagation, then score Principle 1.
**Dependencies:** 103, 111, 127
**Parallelizable:** Yes

#### Superseded Task 134: Score Principle 2 from inventory evidence

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/scores/principle-2.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** Score cites complete result/effect evidence and consumes every Principle 2 assessment claim.
**Steps:** Derive Principle 2 for both trees and record every assessment agreement/disagreement.
**Dependencies:** 116, 133
**Parallelizable:** Yes

#### Superseded Task 135: Score Principle 3 from inventory evidence

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/scores/principle-3.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/module-dependency.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/modules.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/modules.test.ts`

**testingStrategy:** propertyTests: true (every eligible module/dependency edge is consumed or indeterminate), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; independent eligible module/edge denominators, omission fixtures, ownership/proof mapping, and all Principle 3 assessment claims are complete.
**Steps:** Build module/dependency ledgers with consume-exactly-once rules, add DR-8 fields to non-structural evidence, derive Principle 3, and propagate unsupported applicability to indeterminate.
**Dependencies:** 111, 116, 133
**Parallelizable:** Yes

#### Superseded Task 136: Score Principle 4 from graph evidence

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/scores/principle-4.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** Score cites complete/missing graph paths, executable/projection proofs, and consumes every Principle 4 assessment claim.
**Steps:** Derive Principle 4 for both trees and record assessment disagreement.
**Dependencies:** 122, 133
**Parallelizable:** Yes

#### Superseded Task 137: Score Principle 5 from proof-layer evidence

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/scores/principle-5.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/claim-proof.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/claims.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/claims.test.ts`

**testingStrategy:** propertyTests: true (every declared claim maps to one cheapest sound proof or indeterminate), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; independent claim-source denominator, omitted-claim/class fixtures, consume-exactly-once proof mappings, and all Principle 5 assessment claims are complete.
**Steps:** Enumerate claims from independent spec/requirement/gate/CI sources, add omission controls and DR-8 fields, build claim-proof mappings, and derive Principle 5.
**Dependencies:** 122, 127, 133
**Parallelizable:** Yes

#### Superseded Task 138: Score Principle 6 from provenance evidence

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/scores/principle-6.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/change-impact.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/impact.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/impact.test.ts`

**testingStrategy:** propertyTests: true (every changed source item maps to reverse dependencies/effects/proofs or indeterminate), benchmarks: false, characterizationRequired: false
**Verification:** Audit-config tests plus the staging-local kill probe; independent changed-item/reverse-edge/proof denominators, omission fixtures, identity/freshness, and all Principle 6 assessment claims are complete.
**Steps:** Enumerate changed items independently, consume every reverse dependency/effect/proof edge, add DR-8 fields, and derive Principle 6.
**Dependencies:** 127, 131, 133
**Parallelizable:** Yes

#### Superseded Task 139: Score Principle 7 and ratchet maturity

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7, DR-8
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/evidence/scores/principle-7.json`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** Score cites enforced/missing ratchets, validates the five DR-8 fields across all scoring evidence, and consumes every Principle 7 assessment claim.
**Steps:** Derive Principle 7, validate scoring-evidence ratchets, and finalize assessment-claim consumption across all seven principles.
**Dependencies:** 132, 133
**Parallelizable:** Yes

#### Superseded Task 146: Assemble the complete report model

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-7, DR-8, DR-9, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/report-summary.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/report.mjs`
- `docs/audits/2026-07-23-structural-closure-delta-audit/lib/report.test.ts`

**testingStrategy:** propertyTests: true (every validated finding/recommendation renders one summary entry and vice versa), benchmarks: false, characterizationRequired: false
**Verification:** Audit tests and staging kill probe require every chronology correction, finding, and recommendation to carry owner, proof layer, v3 seam, retirement condition, and cited IDs.
**Steps:** Assemble the complete machine-readable model from inventories, scores, assessment claims, ratchets, and chronology evidence; reject free-standing narrative data.
**Dependencies:** 133, 134, 135, 136, 137, 138, 139
**Parallelizable:** No

#### Superseded Task 140: Render the delta audit report

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** acceptance
**Implements:** DR-7, DR-8, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md`

**testingStrategy:** propertyTests: false, benchmarks: false, characterizationRequired: false
**Verification:** Markdown is byte-generated from the validated summary between generated markers; report parser reproduces the same IDs/totals.
**Steps:** Render the report from Task 146 only; no unvalidated narrative finding or recommendation is appended.
**Dependencies:** 146
**Parallelizable:** No

#### Superseded Task 141: Validate freeze and prove repository non-mutation

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-1, DR-9, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md`
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/`
- `docs/audits/2026-07-23-structural-closure-delta-audit/audit-package.acceptance.test.ts`

**testingStrategy:** propertyTests: true (manifest totals equal parsed artifacts for every inventory), benchmarks: false, characterizationRequired: false
**Verification:** Tests `ValidatePackage_DanglingReference_Fails` and `FinalizeAudit_RepositoryMutation_Blocks`, the explicit audit Vitest suite, staging-local kill probes, audit validator, and only staging-root targeted/integration commands pass; the live root full suite is not invoked.
**Steps:** Finalize per-inventory schemaVersion/timestamp/rowCount/collectorVersion/evidenceCommands plus tool versions and authoring branch in the manifest; validate cross-file rules, score/report summaries, failed/indeterminate propagation, and compare repository snapshots.
**Dependencies:** 103, 106, 132, 140
**Parallelizable:** No

### Parallelization

No worktree is created. Task 100 establishes executable test discovery; foundation tasks 101-106 are sequential where required. After the two archives exist:

- contract tooling/collection: 107-111;
- effect tooling/collection: 112-116;
- artifact tooling/collection: 123-127;
- lowering tooling/collection: 128-130 until it joins the other inventories at 131;
- graph tooling 117 can run independently, while graph population 118-122 waits for contracts/effects.

Only distinct audit files are written in parallel. Shared inventory writes are dependency-serialized. Every collector asserts archive root/SHA. Each packaged build/install probe receives a fresh extraction; Task 126 follows Task 121, so no mutable staging tree is shared concurrently or reused as pristine input. Principle scoring tasks write distinct evidence files after Task 133 establishes the evaluator; report/manifest writes remain single-writer tasks 140-141.

### Completion checklist

- [ ] Baseline `30831d05` and candidate `13cf9642` archives are hash-bound and command-logged
- [ ] Audit-local Vitest discovery is explicit and zero-test collection fails
- [ ] Staging-local kill probes use explicit source/test inputs and never mutate the authoring checkout
- [ ] Contract/effect/artifact/v2.12 universes have independent eligible-item ledgers and omitted-root/class/coordinated-count fixtures
- [ ] Arbitrary consumer custom tools are represented as an open extension domain, not falsely enumerated
- [ ] Five inventories validate against committed schema and cross-file rules
- [ ] Every public surface has a typed graph path or attributable open/indeterminate finding
- [ ] Every credited packaged proof is per-surface and bound to the archive SHA/artifact digest
- [ ] Every non-structural row has owner, CI posture, exit condition, milestone, and retirement proof
- [ ] Seven baseline/candidate scores are evaluator-derived; Principles 3/5/6 use module, claim-proof, and impact evidence universes
- [ ] Every July assessment score/gap claim is consumed and compared
- [ ] Builds, installs, and package probes occurred only in non-worktree staging
- [ ] Repository status, index, refs, worktrees, tracked tree, and generated/ignored roots are unchanged outside audit artifacts
- [ ] Ready for `plan-review`

## Decomposition

### Scope

**Target:** Comprehensive, bounded, read-only audit of baseline `30831d05` versus candidate `13cf9642`.

**Excluded:** Production fixes, new enforcement infrastructure, dependency changes, generated runtime edits, arbitrary consumer custom-tool configurations, branches, and worktrees. Unavailable evidence is reported as `indeterminate`.

### Traceability matrix (DR-N -> tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Pin source range and evidence manifest | 001, 018 |
| DR-2 | Contract sources and derivatives | 002-004 |
| DR-3 | Effect ownership and bypasses | 005-007 |
| DR-4 | Action-to-effect/package reachability | 008-009 |
| DR-5 | Artifact and cache freshness | 003, 006, 009-011 |
| DR-6 | v2.12-to-v3 disposition | 012-013 |
| DR-7 | Seven-principle delta | 015-017 |
| DR-8 | Advisory/temporary exits | 014, 017 |
| DR-9 | Missing/conflicting evidence handling | 004, 007, 010-011, 013, 018 |
| DR-10 | Reviewable package; no worktrees/fixes | 001, 017-018 |

### Tasks

### Task 001: Pin the audit range and repository baseline

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-1, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`

**Verification:** Record merge-base, baseline/candidate/authoring SHAs, branch chronology, initial status, and worktree list.
**Steps:** Capture the corrected `30831d05..13cf9642` range and the candidate-only assessment/gate-artifact chronology.
**Dependencies:** None
**Parallelizable:** No

### Task 002: Inventory public action contract surfaces

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`

**Verification:** Reconcile built-in visible/hidden MCP actions and CLI commands against registries, descriptions, and dispatch/help surfaces.
**Steps:** Record baseline/candidate schemas, handlers, annotations, and an explicit open boundary for arbitrary consumer custom tools.
**Dependencies:** 001
**Parallelizable:** Yes

### Task 003: Inventory workflow and generated contract derivatives

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2, DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`

**Verification:** Reconcile workflow topology, guards, playbooks, runbooks, plugin entries, runtime YAML, skills, aliases, agents, and generated outputs.
**Steps:** Link independently editable and generated representations to their owner and drift guard.
**Dependencies:** 002
**Parallelizable:** No

### Task 004: Reconcile the contract inventory

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`

**Verification:** Parse JSON; reject duplicate IDs; ensure every declared surface class is counted or explicitly excluded/indeterminate.
**Steps:** Classify each row as canonical, generated, checked, advisory, temporary, unowned, or indeterminate.
**Dependencies:** 003
**Parallelizable:** No

### Task 005: Inventory event store gate and projection effects

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-3
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`

**Verification:** Inspect append/storage/projection paths, gate runner, durable producers, direct emitters, and ownership census evidence.
**Steps:** Record owners, roots, persistence/failure behavior, and baseline/candidate delta.
**Dependencies:** 001
**Parallelizable:** Yes

### Task 006: Inventory filesystem process network and install effects

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-3, DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`

**Verification:** Search declared TS/JS/MJS/CJS/Bash/PowerShell production and installer roots for filesystem, process/git, package, hook, and network/VCS effects.
**Steps:** Classify runtime, build, installer, test-only, and unresolved dynamic effects.
**Dependencies:** 005
**Parallelizable:** No

### Task 007: Reconcile effect ownership and bypass findings

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-3, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`

**Verification:** Every discovered effect has an owner/root or an explicit open/indeterminate finding; swallowed persistence is surfaced.
**Steps:** Compare discovered paths with architecture checks and ownership manifests, then freeze totals and limitations.
**Dependencies:** 006
**Parallelizable:** No

### Task 008: Build the public-action reachability inventory

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-4
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`

**Verification:** Each built-in action links to input contract, dispatch, handler, optional owner/effect, and output contract or an explicit missing edge.
**Steps:** Join contract and effect IDs into baseline/candidate action paths.
**Dependencies:** 004, 007
**Parallelizable:** No

### Task 009: Assess packaged proof coverage

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-4, DR-5
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`

**Verification:** Locate existing compiled-binary, stdio, parity, packaging, install, and generated-containment evidence; source-only proof is labeled as such.
**Steps:** Link the strongest available proof to each action/projection and record missing packaged proof as a finding.
**Dependencies:** 008
**Parallelizable:** No

### Task 010: Inventory package plugin and generated artifacts

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-5, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`

**Verification:** Reconcile package metadata, build outputs, plugin manifests, release workflows, installers, generated resources, and supported runtimes/platforms.
**Steps:** Record source identity, derivative identity, comparison mechanism, and mismatch behavior.
**Dependencies:** 001
**Parallelizable:** Yes

### Task 011: Assess installed artifact and cache freshness

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-5, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`

**Verification:** Inspect existing package/build/plugin/skill identity diagnostics and accessible install/cache locations; inaccessible evidence remains indeterminate.
**Steps:** Distinguish diagnostics, advisory comparison, enforced preflight, mismatch, and unavailable evidence.
**Dependencies:** 010
**Parallelizable:** No

### Task 012: Inventory v2.12 mechanisms and findings

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-6
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`

**Verification:** Reconcile changed files/commits, candidate spec tasks, dogfood findings, event/schema additions, and compatibility/deprecation surfaces.
**Steps:** Create one row per identified mechanism with baseline/candidate posture and evidence.
**Dependencies:** 001
**Parallelizable:** Yes

### Task 013: Assign v3 lowering or unresolved disposition

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-6, DR-9
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`

**Verification:** Each mechanism has one evidenced IR/admission/action-contract/runtime/retirement disposition or explicit unresolved authority.
**Steps:** Cite consulted system-design, contract, and roadmap sources; do not invent missing authority.
**Dependencies:** 012
**Parallelizable:** No

### Task 014: Add exits for non-structural controls

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-8
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`

**Verification:** Every advisory, temporary, compatibility, open, or indeterminate row has owner/evidence need and measurable exit or re-evaluation condition.
**Steps:** Add the smallest useful ratchet metadata without requiring new enforcement code.
**Dependencies:** 004, 007, 009, 011, 013
**Parallelizable:** No

### Task 015: Score structural principles 1 through 3

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md`

**Verification:** Apply the original rubric consistently and cite inventory rows for generated boundaries, algebra/effects, and module ownership.
**Steps:** Record baseline, candidate, delta, residual gaps, and assessment disagreements; use indeterminate where evidence is insufficient.
**Dependencies:** 004, 007, 011
**Parallelizable:** Yes

### Task 016: Score structural principles 4 through 7

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md`

**Verification:** Cite graph/proof/freshness/lowering/ratchet evidence for integration, proof economy, proof-carrying changes, and structural ratchets.
**Steps:** Record baseline, candidate, delta, residual gaps, and assessment disagreements.
**Dependencies:** 009, 011, 013, 014, 015
**Parallelizable:** No

### Task 017: Synthesize findings and recommendations

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-7, DR-8, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md`

**Verification:** Report totals match inventory counts and findings distinguish confirmed, partial, open, and indeterminate evidence.
**Steps:** Summarize chronology corrections, score deltas, closure gaps, and dependency-ordered recommendations without implementing fixes.
**Dependencies:** 014, 015, 016
**Parallelizable:** No

### Task 018: Reconcile and freeze the audit package

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-1, DR-9, DR-10
**Files:**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md`
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/`

**Verification:** Parse all JSON, check required fields/IDs/references/counts, and compare final status/worktree list with Task 001.
**Steps:** Record limitations and failed probes, confirm only spec/audit artifacts changed, and freeze final row counts.
**Dependencies:** 017
**Parallelizable:** No

### Parallelization

No worktrees are created. After Task 001, the contract lane (002-004), effect lane (005-007), artifact lane (010-011), and v2/v3 lane (012-013) may gather evidence concurrently because they write distinct inventory files. Reachability follows contracts/effects. Tasks 014-018 are the serialized synthesis path. The lead remains the only writer when a task touches multiple inventory files.

### Completion checklist

- [ ] Correct baseline/candidate chronology recorded
- [ ] Five declared-scope inventories completed with explicit limitations
- [ ] Missing or inaccessible evidence is indeterminate, not silently closed
- [ ] Every non-structural row has an evidence need and exit/re-evaluation condition
- [ ] All seven principle scores cite evidence and compare with the July 21 assessment
- [ ] Report totals reconcile with inventory totals
- [ ] No production/generated source, dependency, branch, or worktree change
- [ ] Human-approved for execution

### Baseline expansion tasks

### Task 019: Derive contract and public-surface remediation backlog

Inspect the current snapshot's action contracts, CLI/MCP surfaces, workflow
definitions, config schemas, runbooks, commands, skills, aliases, agents, hooks,
manifests, and documentation authorities. Produce implementation-ready backlog
items with exact target files and acceptance proof.

### Task 020: Derive event projection and effect remediation backlog

Convert event-store, projection, compensation, gate evidence, filesystem,
process, installer, worktree, VCS, onboarding, and dynamic-effect gaps into
prioritized structural changes.

### Task 021: Derive artifact packaging and proof remediation backlog

Convert package, binary, plugin, generated-output, installed-cache, release, and
packaged-action proof gaps into implementation-ready changes.

### Task 022: Derive workflow gate and module remediation backlog

Convert dogfood failures, test infrastructure gaps, module/dead-code findings,
advisory controls, and workflow guidance defects into concrete code changes.

### Task 023: Synthesize exhaustive current-state baseline report

Rewrite the report around the audited snapshot's current condition. Add codebase
metrics, systemic findings, positive patterns, a prioritized backlog, dependency
waves, and acceptance gates. Keep commit-delta chronology in an appendix.

### Task 024: Reconcile expanded report and implementation backlog

Validate backlog IDs, evidence paths, dependencies, priority counts, report
totals, structured artifacts, and unchanged repository topology.

### Invariant and API-contract expansion tasks

### Task 025: Define the aggressive #1608 target-state overlay

Separate current-catalog compliance from target-state conformance. Reframe INV-2
as generated client equivalence, INV-4 as standards conformance plus thin shims,
and INV-11 as lifecycle ownership plus a distinct spatial-capability fork.

### Task 026: Specify the MCP-to-Exarchos API contract compiler

Define the authority layers, complete action/envelope/error/policy meta-model,
host-command exceptions, implementation bindings, generated outputs,
compatibility rules, security model, migration phases, and measurable
acceptance gates. The MCP protocol schema alone is not an acceptable substitute
for the larger Exarchos product API contract.

### Task 027: Reconcile invariant overlay report and backlog

Update remediation programs and backlog items to the #1608/#1601 target model,
validate codegen dependencies against #1604/#1606/#1258, and ensure every
generated surface and retirement rule is represented in structured evidence.

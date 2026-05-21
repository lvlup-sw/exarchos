# Workload-Agnosticism Stress Test

> **Workflow:** `workload-agnostic-runtime-invariants` (discovery, Phase C per charter)
> **Date:** 2026-05-20
> **Status:** Research deliverable D3 of 5
> **Parent:** epic #1441
> **Companion:** [`docs/research/2026-05-20-runtime-invariants-gap-analysis.md`](2026-05-20-runtime-invariants-gap-analysis.md) (D2)

## 1. Test definition

**Workload-agnostic** (formal): A catalog invariant is workload-agnostic if and only if its statement, scope, and enforcement mechanism are identical across all declared workflow types — and would remain identical if a new workflow type were defined tomorrow.

**Test method:** For each candidate invariant (existing + new from D2), check whether the invariant *names* or *implicitly assumes* any workflow-type-specific concept. The five current workflow types are `feature`, `oneshot`, `debug`, `refactor`, `discovery`. A sixth hypothetical type (`data-pipeline` — a non-SDLC workload) acts as the "stranger workflow" that catches assumptions hidden by the SDLC family.

**Pass criteria:** 
- ✓ **PASS** — statement holds verbatim across all six workflow types
- ⚠ **PASS-with-narrowing** — holds with explicit scope-narrowing (e.g., "applies to workflow types that emit `task.*` events")
- ✗ **FAIL** — bakes in a workflow-type-specific assumption; demote to **topology-level** (per-workflow `topology.yaml`) rather than **catalog-level**

## 2. Candidate stress test

### 2.1 Existing entries

| ID | Statement (summary) | feature | oneshot | debug | refactor | discovery | data-pipeline | Verdict |
|---|---|---|---|---|---|---|---|---|
| INV-1 | Event log is source of truth; reducers are pure folds | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** |
| INV-2 | CLI and MCP are facades over single dispatch core; parity asserted | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** |
| INV-3 | No design presumes MCP is local-only; handshake-authoritative; remote-MCP throws-not-degrades | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** |
| INV-4 | Platform-agnosticity — 6 runtimes first-class; tokenization + guards; skills-src/ source-of-truth | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** |
| INV-5a | Tool inputs constrained at schema level; "do NOT use for" guidance; <15 visible tools | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** |
| INV-5b | ToolResult carries next_actions, _meta, _perf; errors carry validTargets/expectedShape/suggestedFix | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** |
| INV-5c | Queryable, dry-run-capable, JSON-explicit Aspire verbs; observation verbs + mutating verbs default to --dry-run | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** |
| INV-5d | 4 visible composite tools with action discriminator; per-action annotations | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** |
| INV-6 (v1) | Skill body grep for workflow-typed literals (`feature/`, `delegate`, `synthesize`) | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ✗ | **FAIL (as currently scoped)** — grep targets are SDLC-specific |
| INV-6 (sharpened) | "The runtime makes no assumption about which workload is executing" | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** (after sharpening per D2 §9) |
| DIM-1..7 | Axiom-owned cross-link entries | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** (axiom dimensions are workload-orthogonal) |
| DIM-8 | Prose-quality — archivable; axiom:humanize-owned | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** (but see substrate-vs-authoring split in D4) |
| basileus-boundary | Cross-product coordination via Ontology MCP Server | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** (forward-looking, no SDLC assumption) |

**Existing entries outcome:** Every existing catalog entry passes the stress test **except INV-6 in its current v1 scope.** The fix is documented in D2 §9: elevate INV-6 to the primary workload-agnosticism statement and demote the grep-targets to operational projection.

### 2.2 New candidates (from D2)

| ID | Statement | feature | oneshot | debug | refactor | discovery | data-pipeline | Verdict |
|---|---|---|---|---|---|---|---|---|
| INV-7 | Substrate-serialization — two-tier (in-process StreamLockManager + cross-process WAL `BEGIN IMMEDIATE` + composite PK) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** — names storage/concurrency primitives, no workflow concepts |
| INV-8 | Idempotency-at-the-boundary — unique idempotency keys at append; appendComputed collapses duplicates | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** — universal append-layer primitive |
| INV-9 | HSM-as-state-machine — per-workflow-type guarded transitions; transition is the only phase mutator | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | **PASS-with-narrowing** — names "workflow-type" but each type has its own HSM; the invariant is "*every* workflow type ships its own HSM," not "every workflow looks like X" |
| INV-10 | Liveness-event-protocol — long-running ops emit `<surface>.executing_started` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** — `<surface>` is the variable; the protocol is universal |
| INV-11 | Posture-declared-capabilities — agent declares `read-only \| task-isolated \| shared-mutating`; handshake-authoritative | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** — posture is workflow-orthogonal |
| INV-12 | Next-actions-as-affordance — agents read affordances from envelopes; runtime makes valid transitions perceptible; agents do not poll | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** — affordance protocol, not workflow-shape |
| INV-13 | Process-manager-two-event-split — non-idempotent side effects emit `*.requested` → `*.executed` with idempotent precheck on recovery | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** — pattern applies to any handler doing external side effects |
| INV-14 | Native-primitive-first-recovery — `git X --abort` then `--keep` then never `--hard`; recoveryError discriminator | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | **PASS-with-narrowing** — `git` is named; the *rule* generalizes to "any tool's native recovery primitive first, then substrate-level undo, never destructive overwrite." Reword INV-14's wording to remove the `git` specifically. |
| INV-15 | Single-machine-frame — no distributed-consensus, no leader election, no vector clocks, no BFT; cooperation via OCC + WAL | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **PASS** — framing statement, workflow-orthogonal |

**New candidates outcome:** All 9 candidates pass. Two (INV-9, INV-14) require minor wording adjustments to remove implicit specificity (INV-9 names "workflow-type" as a variable, not a constraint; INV-14 removes the `git` example into a reference, not the rule text).

## 3. The data-pipeline thought experiment

The hypothetical sixth workflow type — `data-pipeline` — is deliberately non-SDLC. Imagine a workflow that: (a) ingests a CSV from S3, (b) validates against a JSON schema, (c) transforms to parquet, (d) loads into a warehouse, (e) emits a notification. Five phases, each gated, no PR/branch concepts, no review/synthesis.

Walk every invariant against this workload:

| Invariant | Holds for data-pipeline? | Why |
|---|---|---|
| INV-1 | ✓ | The 5 phases emit events to a stream; reducers fold them into projection state. Same shape. |
| INV-2 | ✓ | CLI: `exarchos data-pipeline submit <csv-url>`. MCP: `exarchos_workflow init featureId=… workflowType=data-pipeline`. Same dispatch core. |
| INV-3 | ✓ | The data-pipeline workflow can run against a remote MCP transport equally — no local-only assumption. |
| INV-4 | ✓ | The data-pipeline runs over any of the 6 first-class runtimes; the skill body for `data-pipeline-ideate` (if any) is tokenized. |
| INV-5a | ✓ | The data-pipeline composite-tool action set is schema-constrained. |
| INV-5b | ✓ | Each transition emits a `ToolResult` with `next_actions: ["transform", "load"]` etc. |
| INV-5c | ✓ | `dry-run` for the validate step; `describe` queries the state. |
| INV-5d | ✓ | The workflow lives under `exarchos_workflow` action discriminator like any other. |
| INV-6 (sharpened) | ✓ | The runtime makes no assumption that data-pipeline exists; the topology declares it. |
| INV-7 substrate-serialization | ✓ | Concurrent ingestion runs across worktrees use the same WAL + PK serialization. |
| INV-8 idempotency-at-the-boundary | ✓ | Idempotency keys ensure re-submission of a CSV-URL doesn't trigger duplicate transforms. |
| INV-9 HSM-as-state-machine | ✓ | data-pipeline's HSM declares its own phases (ingest/validate/transform/load/notify). |
| INV-10 liveness-event-protocol | ✓ | `transform.executing_started` event lets v2.12 `wait` block on the slow phase. |
| INV-11 posture-declared-capabilities | ✓ | The data-pipeline agent declares `shared-mutating` (writes to S3 + warehouse); a validator sub-agent declares `read-only`. |
| INV-12 next-actions-as-affordance | ✓ | The validator's terminal event puts `transform` into next_actions; the transformer agent picks it up without polling. |
| INV-13 process-manager-two-event-split | ✓ | `load.requested` → idempotent precheck against warehouse (does row-batch X already exist?) → `load.executed`. |
| INV-14 native-primitive-first-recovery (re-worded) | ✓ | If the load fails, prefer the warehouse's native rollback first; fall back to substrate-level undo (e.g., delete the inserted batch via batch-ID). Never overwrite. |
| INV-15 single-machine-frame | ✓ | data-pipeline is single-machine in this scenario; the runtime substrate doesn't need distributed consensus. |
| DIM-1..7 | ✓ | Topology, observability, contracts, etc. apply equally. |
| DIM-8 | ✓ | (Only relevant if the data-pipeline workload produces user-facing documents — which it might, if the notification phase generates a report.) |

**All invariants pass the data-pipeline thought experiment.** This is the strongest signal that the v2 catalog is workload-agnostic: **a completely non-SDLC workload reads the catalog and recognizes every entry as applicable to itself, without modification.**

## 4. Failure modes — what would fail

For completeness, document what a *failing* candidate would look like. None of the v2 candidates fail this way, but anchoring the negative examples sharpens future-author intuition.

**Hypothetical fail-INV-A: "Every workflow must emit `pr.opened` before synthesis"**
- Bakes in SDLC concepts (`pr.opened`, `synthesis`)
- data-pipeline has no PR
- Verdict: ✗ FAIL. This is topology-level (only the `feature` HSM emits `pr.opened`), not catalog-level.

**Hypothetical fail-INV-B: "Phase transitions must run a TDD red→green→refactor sequence"**
- TDD is workflow-type-specific (specifically: `feature` and `oneshot` workflows)
- `discovery` workflow exempts the Iron Law explicitly
- Verdict: ✗ FAIL. Belongs in `feature` workflow's playbook, not in the catalog.

**Hypothetical fail-INV-C: "Every workflow ends with a `cleanup` phase"**
- discovery ends with `synthesizing → completed` — no cleanup
- Verdict: ✗ FAIL. Per-HSM, not universal.

Compared against these fail modes, every D2 candidate uses *primitive* vocabulary (events, streams, sequences, postures, idempotency keys, affordances) rather than *workflow-shape* vocabulary. That's the distinguishing pattern: workload-agnostic invariants name the runtime's *substrate operations*; workflow-shape statements name *phase transitions specific to one HSM*.

## 5. Triage — survivors and demotions

**v2 catalog admits (after stress test):**

All 9 new candidates (INV-7..INV-15) plus all 13 existing entries (INV-1..INV-6 + DIM-1..DIM-8 + basileus-boundary, minus DIM-8 archivable handling).

**v1 → v2 sharpenings required (no demotion, just wording):**

- **INV-6** — elevate "workload-agnosticism" from skill-grep operational projection to primary catalog statement. The grep stays as one enforcement tool among several (e.g., new-workflow-type-onboarding checklist).
- **INV-9** — reword "per-workflow-type" to make the *generality* clear: every workflow type ships an HSM; no workflow-type-specific shape is assumed.
- **INV-14** — remove the `git`-specific text from the rule; move to references as an example.

**Demotions (catalog → topology):**

None. The cross-walk did not surface any workflow-type-specific invariants currently masquerading as catalog-level.

**Documentation moves (catalog → operational skill):**

- INV-14 (native-primitive-first-recovery) — pending citation backfill (per D1 §8), this may be downgraded from "catalog invariant" to "operational pattern documented in a skill body." D5 will rule.

## 6. Workload-agnosticism as a positive property

The stress test reveals a structural pattern: **workload-agnostic invariants form a coherent vocabulary about agent-runtime substrate.** The vocabulary set is:

- **Storage primitives** — event log, stream, sequence, append, projection, snapshot
- **Concurrency primitives** — OCC, WAL, idempotency key, expectedSequence
- **Capability primitives** — posture, handshake, authority, reference
- **Process-manager primitives** — *.requested/*.executed split, idempotent precheck, terminal event
- **Lifecycle primitives** — `<surface>.executing_started`, next_actions affordance, transition

None of these are SDLC concepts. They're agent-runtime concepts. The convergent designs surfaced in D1 §9 (anip-protocol, AWP, Harn) use the same vocabulary independently — corroborating evidence that this is the load-bearing vocabulary for agent-runtime invariants generally, not Exarchos-specific framing.

The v2 catalog should lead with this vocabulary as the **agnosticism statement**: "Every entry in this catalog uses runtime-substrate vocabulary, not workflow-shape vocabulary. Workflow-shape concerns belong in `topology.yaml`."

### 6.1 Caveat — applicability ≠ audience

This section's "positive property" finding is about *applicability*: the invariants hold across every workflow type that could run over Exarchos's runtime. **It is not a finding about audience suitability.**

The two are distinct. An invariant can apply universally to every workload yet still be inappropriate to surface to a given audience. Concretely:

- **Applicability** — does INV-7 (substrate-serialization) hold for a data-pipeline workload? Yes (the WAL + PK substrate serializes data-pipeline appends just like SDLC appends). This is what §3's data-pipeline thought experiment demonstrates.
- **Audience suitability** — should a data-pipeline engineer running `/exarchos:ideate` to design their CSV→parquet pipeline see INV-7 at Phase 0? No. They interact with Exarchos's affordances; they do not implement Exarchos's substrate. Surfacing INV-7 to them is noise.

The v2 catalog (D5) addresses this by gating the entire catalog behind `.exarchos.yml: invariants.devCatalog: enabled` (default disabled). The dev catalog is for Exarchos's own designers. A separate consumer-facing catalog — covering SDLC discipline, phase observability, review-gate honesty, branch/PR discipline — is a future deliverable. See D5 §1.1 and §10.

The stress test conclusions in §2–§5 above stand for the dev catalog. Re-running them against a consumer-facing catalog would require a different (broader, SDLC-flavored) candidate list and would not look like this document.

## 7. Recommendation

**Proceed to D4 with the full candidate list.** All 9 new + 13 existing (sharpened where noted) entries are workload-agnostic. The stress test surfaced no demotions and only three wording sharpenings (INV-6, INV-9, INV-14).

The v2 catalog (D5) should encode the workload-agnosticism property structurally:

1. A frontmatter-level field `axis: substrate | authoring` per entry (set up in D4).
2. A catalog-introduction statement: "This catalog uses runtime-substrate vocabulary exclusively. Workflow-type-specific guidance lives in `topology.yaml`."
3. An onboarding checklist for new workflow types: confirm no invariant changes are needed when adding the workflow.

## 8. References

- D2 candidate list: [`docs/research/2026-05-20-runtime-invariants-gap-analysis.md`](2026-05-20-runtime-invariants-gap-analysis.md) §10
- D1 research corpus: [`docs/research/2026-05-20-runtime-invariants-research-survey.md`](2026-05-20-runtime-invariants-research-survey.md)
- Current workflow types: `servers/exarchos-mcp/src/topology.yaml` (feature, oneshot, debug, refactor, discovery)
- Runtime framing: [`docs/architecture/runtime.md`](../architecture/runtime.md) §1 "It is a concurrent system, not a distributed one"

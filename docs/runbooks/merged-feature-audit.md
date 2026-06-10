# Merged Feature Audit

A portable, agent-executed runbook for auditing **completed, merged feature-work**. It takes
heterogeneous GitHub data — issues, epics, PRs, review threads, CI runs, checklists — as
*composite inputs*, reconstructs what was promised versus what actually shipped, **proves** the
delivered code is functional and to spec, and surfaces gaps (claimed-but-absent, partial, broken,
contradicted). At every integration boundary the work introduced or touched, it asks the question
the verification ladder asks at production time: **is the integration constrained by a structural
guarantee the environment enforces, or does it lean on the expensive, tautology-prone procedural
signal the ladder exists to retire?** Seams that lean on the latter — or have nothing at all — are
flagged.

This runbook is repo-agnostic. Point it at any repository and a set of merged PRs / closed issues;
it resolves the target stack from `.exarchos.yml` or by detection.

> **Lineage.** This is the **post-merge mirror of the structural-integration-verification (SIV) gate
> suite** defined in epic [#1515](https://github.com/lvlup-sw/exarchos/issues/1515) Phase 3 and
> `docs/research/2026-06-06-structural-integration-verification.md`. The SIV gates (SIV-1…SIV-7)
> right-size verification at the **integration boundary** *as code is produced*; this audit verifies,
> after merge, that those structural guarantees were actually **established** — and where they were
> not, the remediation it prescribes is the corresponding SIV gate. It does not invent a parallel
> taxonomy; it grades merged work against the one the repo is already building. Two lifecycle moments,
> one framework.

> **Scope discipline.** An audit is not a review and not a vibe check. A reviewer samples and trusts;
> an auditor traces and proves. Every PASS is backed by traced evidence: a `file:line`, a *structural*
> guarantee the compiler/schema enforces, or a *non-tautological* semantic test (one that goes red
> when the implementation is reverted). Anything that cannot be proven is reported as unverified —
> never assumed to pass. See [Operating principles](#5-operating-principles) and the
> [anti-rationalization table](#7-anti-rationalization).

It is the *post-merge* counterpart to `/exarchos:review` (which gates a diff *pre-merge*) and the
*completeness* complement to `/axiom:audit` (which scores code-quality dimensions). Findings use the
axiom finding schema so all three compose.

---

## 1. When to run

- After an epic / milestone / release closes, to certify it actually delivered its scope.
- Before relying on a merged feature downstream, to confirm it is functional, not just merged.
- During incident retro, to find which boundary guarantee was missing at the seam that broke.
- As a periodic conformance pass over recently merged PRs.

Do **not** use this runbook to review an open PR (use `/exarchos:review`) or to plan new work.

---

## 2. Input contract

The runbook accepts **composite GitHub inputs** and resolves them into one canonical scope closure.
Supply any one entry point; Phase 0 expands it.

| Variable | Required | Meaning |
|----------|----------|---------|
| `repo` | yes | `owner/name`. The repository under audit. |
| `entryPoint` | yes | One of: an epic/issue number, a milestone, a label, or an explicit list of merged PR numbers. The seed for scope expansion. |
| `baseRef` | no (default `main`) | The branch the feature-work landed on. |
| `toolchain` | no | Test/build/lint/mutation/contract commands. Resolved from `.exarchos.yml` or detected if omitted. |
| `depth` | no (default `boundary`) | `claim` (completeness only), `boundary` (+ SIV boundary assessment), or `exhaustive` (+ execution proof, kill-probe, full irregularity sweep). |

An input is "composite" because no single GitHub object holds the truth: the **issue/epic** holds the
*intent*, the **PR body and checklists** hold *claims of completion*, the **review threads** hold
*contested decisions*, **CI** holds the *test signal*, and the **merge commit** holds the *actual
delivery*. Phase 0 fuses these into a single claim ledger with provenance.

---

## 3. Output contract

The deliverable is one structured **Audit Report** (`AuditReport`). Findings reuse the axiom finding
schema verbatim (so they compose with `/axiom:audit` and `/exarchos:review`), extended with audit
provenance and a boundary-axis tag drawn from the SIV/DIM vocabularies — never a bespoke one.

```typescript
interface AuditReport {
  feature: string;
  scope: { entryPoints: string[]; prs: number[]; issues: number[]; baseRef: string };
  auditedAt: string;                       // caller-stamped ISO timestamp
  verdict: 'PASS' | 'CONDITIONAL' | 'FAIL';
  completeness: ClaimRow[];                // Phase 2
  functionalProof: ProofRow[];             // Phase 3
  boundaries: BoundaryRow[];               // Phase 4
  findings: Finding[];                     // Phases 2–5
  couldNotVerify: { ref: string; reason: string }[];  // epistemic-honesty ledger
  recommendations: string[];
}

interface ClaimRow {
  claimId: string;                         // C-001, C-002, …
  text: string;                            // the promised behavior
  source: string;                          // issue#/PR#/comment URL
  type: 'functional' | 'nonfunctional' | 'integration' | 'test' | 'doc';
  status: 'DELIVERED' | 'PARTIAL' | 'ABSENT' | 'CONTRADICTED' | 'UNCLAIMED';
  evidence: string[];                      // file:line of implementing code (NOT the checkbox)
}

interface ProofRow {
  claimId: string;
  level: 'E4' | 'E3' | 'E2' | 'E1';        // proof ladder, §5
  method: string;                          // repro steps, test path + kill-probe result, or trace
  result: 'PROVEN' | 'FAILED' | 'UNVERIFIED';
}

interface BoundaryRow {
  boundaryId: string;                      // B-001, …
  from: string; to: string;                // the two sides of the seam
  kind: BoundaryKind;                      // §4.3
  dataCrossing: string;                    // what flows across
  loadBearing: boolean;                    // would a violation cause a HIGH failure?
  // per SIV axis: the strength at which a structural guarantee is present (§4.5)
  siv: Partial<Record<'SIV-2'|'SIV-3'|'SIV-4'|'SIV-5'|'SIV-6'|'SIV-7', Strength>>;
  // residual operational guarantees, in axiom's vocabulary (§4.4)
  dim: Partial<Record<'DIM-1'|'DIM-2'|'DIM-7', Strength>>;
  semanticOracle: 'present-nontautological' | 'present-tautological' | 'absent';
  evidence: string[];
}

// axiom finding schema (findings-format.md) + audit provenance
interface Finding {
  dimension: string;                       // 'SIV-n' | 'DIM-n' | 'COMPLETENESS' | 'FUNCTIONAL' | 'CI'
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  evidence: string[];                      // file:line
  explanation: string;
  suggestion?: string;                     // remediation — names the SIV gate that would prevent recurrence
  skill: 'merged-feature-audit';
  deterministic: boolean;                  // grep/structural vs. qualitative
  phase: number;                           // which phase surfaced it
  claimId?: string; boundaryId?: string;   // links back to the matrices
}
```

### Severity tiers (inherited from axiom)

| Tier | Definition | Action |
|------|-----------|--------|
| **HIGH** | Violates a correctness invariant, risks data loss, or causes silent failure. The work may *appear* complete but is not. | Blocks PASS. |
| **MEDIUM** | Degrades quality, completeness, or operability but doesn't break correctness. | Should fix; may defer with rationale. |
| **LOW** | Polish, minor gaps, redundant assertions, aspirational hardening. | Track; don't block. |

---

## 4. The boundary tier of the verification ladder

This section is the analytical core, and it is **continuous with #1515**, not a fresh invention. The
risk-proportional ladder right-sizes verification on two orthogonal axes:

- **Blast-radius** (R1–R10): a task's `riskTier` (low/medium/high) selects a gate sequence — cheap by
  default, escalate by how much the change can break.
- **Boundary** (SIV-1–SIV-7): a *boundary-touching* task additionally routes through structural
  boundary gates — because an integration boundary is exactly where an agent's verification is most
  dangerous.

This audit assesses the **boundary axis, post-merge**. For each seam the work touched it asks: was the
right structural guarantee established, at the cheapest signal tier that gives it, plus exactly one
non-tautological semantic oracle?

### 4.1 The verification-signal ladder (Tier 0–8)

Raw verification signals ranked by correctness-per-token (`2026-06-02-verification-token-efficiency.md`
§6). The audit grades every guarantee by *which tier of signal enforces it*, and prefers the lowest
(cheapest, strongest, environment-enforced) tier that covers the concern.

| Tier | Signal | Cost | Catches |
|------|--------|------|---------|
| 0 | Compile / build | ~0 | syntax, imports, references, signatures |
| 1 | Typecheck | ~0 | type errors, **contract drift**, high-blast reshapes |
| 2 | Lint / static analysis | ~0–low | anti-patterns, **boundary-parse violations**, dead code |
| 3 | Scoped existing tests | low–med | regressions in the touched surface |
| 4 | One acceptance test | low–med | the requested behavior, end-to-end |
| 5 | PBT / contracts on the pure core | med | edge cases never enumerated |
| 6 | Full TDD with new tests | high | novel-behavior correctness |
| 7 | LLM verifier subagent | high | spec-vs-impl gaps |
| 8 | Full integration / E2E | highest | real multi-service behavior — **reserve for the boundary** |

### 4.2 Structural over procedural (the unifying finding)

> **Agent-authored procedural verification at a boundary calcifies the agent's own wrong assumptions.**

It surfaces in three isomorphic forms, all the same defect — *the agent encodes its assumption as the
oracle, so the oracle can never contradict the assumption*:

1. a **mock of an unowned API** (Hora & Robbes, MSR '26: agents mock in 36% of test commits vs 26% for humans; 95% the brittle `mock` double),
2. a **tautological test** (100% coverage, ~4% mutation score — the R5 failure mode),
3. a **carbon-copy reference model** (LLM tests mirror the code's behavior, not the spec; 85%+ of failing LLM tests fail on wrong assertions).

The consequence for *this audit*: **an integration test is not, by itself, evidence of a boundary
guarantee.** Structure pulled *down* the cost ladder is — a compile error on contract drift (tier 1),
a parse boundary the type-checker collapses (tier 1–2), a drift-diff that breaks the build at zero LLM
cost (tier 2). The audit credits an agent-authored boundary test only after proving it is *not* one of
the three forms above (§5, proof ladder).

> **Necessary, not sufficient.** Structure verifies *syntax, not semantics* (Pact, STVR 2025, Sigdel &
> Baral 2026: schema-first cut interface misuse but *raised* semantic misuse). So structural gates
> shrink the test surface to **exactly one semantic oracle per boundary pathway** — they never
> eliminate it. The audit flags both directions: a boundary with structure but no semantic oracle is a
> gap; a boundary with redundant *shape* assertions the compiler already covers is a LOW cleanup
> ("delete the shape test, keep the one semantic test").

### 4.3 Boundary kinds and SIV axes

An **integration boundary** is any seam where control or data crosses between units that evolve
independently:
`call` · `layer` (controller→service→repo) · `api` (HTTP/RPC) · `cli` · `event` (emit→consume) ·
`queue` · `persistence` (DB/file) · `serialization` (wire/JSON/disk) · `config`→code · `plugin` ·
`ffi` · `concurrency` (shared state / lock).

For each boundary, assess the **structural guarantee** along the SIV axes. Each is a *workload-agnostic
guarantee with a per-runtime implementation* (which is what keeps this runbook portable — the
guarantee is constant, the tool varies):

| Axis | Structural guarantee at the boundary | Signal tier | Prevents | Per-runtime implementation (examples) | Folds in (concern) |
|------|--------------------------------------|-------------|----------|----------------------------------------|-------------------------------|
| **SIV-2** | **Contract drift caught by codegen + typecheck + breaking-diff.** Shape, field-mapping, *and* backward-compat are a compile error on drift, not a hoped-for test. | 0–2 | shape drift; silently broken consumers | proto `buf generate`/`buf breaking`; REST `openapi-typescript`/`oasdiff`; GraphQL `graphql-codegen`/`graphql-inspector` | type-contract + versioning |
| **SIV-3** | **Parse, don't validate at the edge.** Untrusted input is parsed once into a branded type at a single boundary; illegal states are unrepresentable inward. | 1–2 | malformed external data propagating inward | Zod/Effect `.brand()` + import-boundary lint (`eslint-plugin-boundaries`, `dependency-cruiser`); Semgrep/CodeQL taint for non-TS | runtime-validation |
| **SIV-4** | **No agent-authored mock of an unowned dependency.** Doubles of external deps are forbidden; ownership manifest decides. | 2 | mocking your *assumption* of a third party — where the bug lives | mock-identifier diff scan × ownership globs; steer to SIV-5 | contract-test (anti-pattern half) |
| **SIV-5** | **Hermetic real-dependency double** (real > fake > stub/mock). | 3–8 | a double that diverges from reality | Testcontainers (DB), LocalStack (cloud-API), Pact-verified stub (HTTP), fake (owned iface) | contract-test (constructive half) |
| **SIV-6** | **Model-based conformance for stateful boundaries**, with a **spec-grounded** model (never derived from the code). | 5 | implementation-mirroring oracles that catch nothing | `fc.commands`+`modelRun`; Hypothesis `RuleBasedStateMachine` | state-integrity (stateful half) |
| **SIV-7** | **IaC / ephemeral-infra E2E** — *opt-in, workload-keyed only.* Hermetic-first; real-cloud is the exception. | 8 | cloud-coupled pathway breaking only in prod | `terraform plan`-as-diff (agnostic); real provision/teardown (opt-in, offline) | — |

> **SIV-1** is not a guarantee but the **routing axis**: does the work treat the integration boundary
> as a first-class verification target at all? A boundary-touching change that ships with *no* boundary
> gate (relying entirely on the same uniform per-task checks a pure-core change gets) is itself a
> finding — the boundary was never recognized.

### 4.4 Operational guarantees beyond structure (axiom DIMs)

SIV answers "is the integration *structurally constrained*." The other half — "does the boundary *fail
safely*" — stays in axiom's vocabulary, so the audit composes with `/axiom:audit` and does not fork a
taxonomy:

- **DIM-2 (Observability):** failure crosses the seam as a surfaced, typed signal — not swallowed
  (`catch {}`, `.catch(()=>{})`) — and emits a correlated log/metric/trace. Prevents silent and
  invisible failure.
- **DIM-7 (Resilience):** the crossing is all-or-nothing (transaction / saga compensation) and/or safe
  to retry (idempotency key, optimistic concurrency / `expectedSequence`); external calls have
  timeouts and bounded retry. Prevents partial state, duplicate effects, hangs.
- **DIM-1 (Topology):** the boundary preserves single-source-of-truth — no divergent instance of a
  shared resource. This is the canonical *two-instances-of-the-store* failure: both sides green, the
  seam dead.

### 4.5 Guarantee strength (`Strength`, S0–S4)

A guarantee is not binary. Record *how strongly* each present guarantee is enforced — re-anchored to
the signal ladder and the structural-over-procedural axis:

| Strength | Meaning | Signal tier |
|----------|---------|-------------|
| **S4 — Structural** | Compiler / type system / codegen-drift / DB constraint makes violation *impossible*. Strongest **and** cheapest. | 0–2 |
| **S3 — Runtime-structural** | Parse-at-edge into a branded type, or an assertion that fails *loudly* on violation. | 1–3 |
| **S2 — Procedural-tested** | A test would catch it. **At a boundary this is suspect** — credit it only if it is non-tautological (kill-probe red on revert / mutation-backstopped) *and* not a mock of an unowned dep (SIV-4). | 3–8 |
| **S1 — Conventional** | A doc, comment, or naming says so; nothing enforces it. Hope. | — |
| **S0 — Absent** | Nothing. | — |

The epic's inversion, made operational: **for a boundary concern, S2-via-agent-authored-test is weaker
than S3/S4 structural — and more expensive.** "There's an integration test" moves a cell to S2 *only
after* the tautology check; absent that check it is S1 (an assertion of safety, unenforced).

### 4.6 The flag rule

For each boundary, decide which guarantees are **load-bearing** (a violation would cause a HIGH
correctness or data-loss failure). Then:

- A load-bearing guarantee at **S0/S1**, **or** whose *only* assurance is an unverified-for-tautology
  S2 test, **or** that rests on a **mock of an unowned dependency** → **HIGH** finding. The
  `suggestion` names the SIV axis whose structural gate establishes it at a lower tier (e.g. "add the
  SIV-2 `check_contract_drift` gate; delete the redundant shape assertions").
- A load-bearing guarantee at **S2 (verified non-tautological)** → acceptable-but-improvable; note the
  cheaper structural option (MEDIUM if the structural gate plainly exists and was skipped).
- **Missing the one semantic oracle** on a load-bearing pathway → HIGH (structure is necessary, not
  sufficient).
- **Redundant shape assertions** the compiler already covers → LOW cleanup.
- **SIV-7 reliance**: a boundary whose only assurance is real-cloud E2E (no hermetic default) → MEDIUM
  smell (cost, flake, and a workload assumption leaking into what should be hermetic).

The bar is not "every guarantee at every seam." It is: **every load-bearing boundary has its
structural guarantee at S3/S4 where the tier ladder offers one, plus one non-tautological semantic
oracle** — and every place that fails the bar is named, with the SIV remediation attached.

---

## 5. Operating principles

Three rules govern every phase. Violating them produces a confident, wrong audit.

1. **Evidence standard.** A claim is "delivered" only with a traced `file:line`, "proven functional"
   only at proof level **E3 or E4** (below). A checked checkbox, a closed issue, a merged PR, and a
   green CI badge are *claims of completion*, not evidence. They tell you where to look, not what is true.

   **Proof ladder** (record the level each claim reaches):
   - **E4 — Executed.** The behavior was run (endpoint hit, command invoked, or an integration test
     against a **real/hermetic dependency** — SIV-5 fidelity, not a mock) and the spec'd output
     observed. Repro steps recorded.
   - **E3 — Test-covered, tautology-checked.** A test asserts the spec'd *observable* behavior and goes
     **red when the implementation is reverted** (the R3 kill-probe: revert the source hunks → run the
     test → assert red → restore). It does not mock the unit under proof and is not a mock of an unowned
     dep. All three confirmed.
   - **E2 — Path-traced.** You read the full path entry→effect; the logic is correct by inspection; no
     executable proof. Acceptable only when E3/E4 is infeasible, and you record why.
   - **E1 — Present-only.** Code exists; untraced, untested (or tested by a test that survives revert —
     a tautology). **Not proof** → finding.

2. **Epistemic honesty.** Every claim that does not reach E3/E4 goes in the `couldNotVerify` ledger with
   a reason. An audit that hides its blind spots is worse than no audit. "Unverified" is a legitimate,
   reportable outcome; "assumed passing" is not. Never conclude *build-green ⇒ integration correct* —
   structure is syntax (§4.2).

3. **Independent trace, not narration; the oracle is not the agent's.** Do not let the PR description
   tell you what the code does — trace it yourself, entry point to observable effect. And do not let an
   agent-authored test, mock, or reference model stand as the oracle until you have shown it can fail
   (kill-probe) and is grounded in the spec, not the code (the three isomorphic forms, §4.2). The
   canonical failure both rules prevent: 4192 passing tests over a dead seam where producer and consumer
   held different instances of the same store.

---

## 6. Phases

```
0 Provenance      → claim ledger (what was promised, with provenance)
1 Delivery        → delivery ledger (what actually shipped, independent of claims)
2 Reconciliation  → completeness matrix (claim × delivery join)
3 Functional      → proof ladder per claim (prove it; kill-probe the tests)
4 Boundaries      → SIV/DIM boundary matrix (assess every seam, flag the unguarded)
5 Irregularity    → cross-cutting sweep (stubs, dead code, mock-of-unowned, casts, CI honesty)
6 Synthesis       → verdict + Audit Report
```

Phases 0–1 are independent and may run concurrently. Phase 2 joins them. Phases 3–5 consume the join.
For `depth=claim`, run 0–2 and 6. For `depth=boundary`, add 4. For `depth=exhaustive`, run all, execute
to E4 where feasible, and run the kill-probe on every load-bearing claim's test.

### Phase 0 — Provenance & claim ledger

**Goal:** derive the authoritative set of *claims* from the composite GitHub inputs, each with provenance.

1. **Expand scope closure** from `entryPoint`:
   - Epic/issue: `gh issue view <n> --repo <repo> --json title,body,labels,milestone,closedByPullRequestsReferences` — then walk task-list checkboxes (`- [ ]`/`- [x]`) and linked/child issues in the body.
   - Milestone/label: `gh issue list --repo <repo> --milestone "<m>" --state closed --json number,title,body` and `gh pr list --repo <repo> --search "milestone:<m> is:merged" --json number,title,body,mergedAt,mergeCommit`.
   - PR list: take it as given; expand to closing issues per PR.
   - Per PR in closure: `gh pr view <n> --repo <repo> --json title,body,closingIssuesReferences,reviews,reviewThreads,statusCheckRollup,files,commits,mergedAt,mergeCommit,baseRefName`.
2. **Extract claims** from issue bodies (acceptance criteria, "must/should" statements), PR bodies
   ("this PR does X", checklists), and review threads (agreed decisions, "will fix in follow-up"
   deferrals). Capture explicit **out-of-scope** notes — they bound the audit.
3. **Write the claim ledger:** `{claimId, text, source, type, github_status}`. `github_status` records
   what GitHub *asserts* (checked/closed/open) — a pointer, not evidence.

**Decision — closure boundary:**

| Situation | Action |
|-----------|--------|
| Entry is a single PR | Closure = that PR + its closing issues. |
| Entry is an epic with linked PRs | Closure = epic + child issues + every merged PR referencing them. |
| PRs not linked to any issue | Flag as a provenance gap; treat PR bodies as the only claim source; note reduced traceability. |
| Deferrals ("follow-up PR") in threads | Record as out-of-scope with the follow-up reference; do not audit them here. |

**Exit:** claim ledger non-empty; every row has a source URL.

### Phase 1 — Delivery reconstruction

**Goal:** reconstruct *what actually shipped*, independent of the claims (no peeking at the ledger).

1. **Resolve the merge set:** the merge/squash commits of in-scope PRs on `baseRef`.
   `git -C <repo> log <baseRef> --merges --grep "#<pr>"` or per-PR `mergeCommit` from Phase 0.
2. **Build the union diff:** per-PR `gh pr diff <n> --repo <repo>`, or `git diff <base>...<tip>`. Record
   touched files and added/modified/removed symbols.
3. **Inventory new surfaces** (these become Phase 4 boundaries and Phase 5 reachability seeds): new
   public exports, routes/endpoints, CLI commands/actions, event types (emitted *and* consumed), DB
   migrations, config keys, env vars, feature flags, external service calls, **schema/contract artifacts
   and generated clients** (the SIV-2 surface), **parse functions** at IO edges (the SIV-3 surface).
   Use serena: `get_symbols_overview` on changed files, `find_symbol` for new defs; grep for
   route/handler/event registration, migrations, and `*.proto`/`openapi*`/`*.graphql` + codegen config.
4. **Write the delivery ledger:** `{surface, file:line, kind, introduced_by_PR}`.

**Exit:** delivery ledger covers every changed file; new surfaces (incl. contract/parse artifacts) enumerated.

### Phase 2 — Completeness reconciliation

**Goal:** join claim ledger × delivery ledger into the completeness matrix.

For each claim, **locate the implementing code by tracing** (not by trusting PR text) and classify:

| Status | Definition | Finding |
|--------|------------|---------|
| **DELIVERED** | Implementing code found *and* reachable from a production entry point. | — |
| **PARTIAL** | Some, not all, of the claim implemented (happy path only; subset of cases). | MEDIUM (HIGH if a core path) |
| **ABSENT** | Claimed (box checked / issue closed) but no implementing code found. | **HIGH** — claimed-but-absent |
| **CONTRADICTED** | Implementation present but does something different from / opposite to the claim. | **HIGH** |
| **UNCLAIMED** | Delivered behavior with no corresponding claim (scope creep / undocumented). | MEDIUM — flag for spec update |

Columns: `claimId | text | implementing evidence (file:line) | reachable? | status`.

> **Rule:** a checked checkbox is not evidence. Only a traced, reachable code path moves a claim to
> DELIVERED. Code that exists but nothing calls is not delivered — it is dead (→ Phase 5).

**Exit:** every claim has a status; DELIVERED/PARTIAL carry `file:line` evidence.

### Phase 3 — Functional proof

**Goal:** for each DELIVERED/PARTIAL claim, *prove the behavior* — reach E3/E4, or honestly record why not.

1. **Identify covering tests** (by path or symbol reference); run them with the resolved toolchain.
   Record pass/fail and which claim each covers. A claim with no covering test → SIV-related gap (HIGH
   if load-bearing).
2. **Kill-probe each covering test (the E3 gate, = R3 `check_test_adequacy`):** revert the claim's source
   hunks → run the test → it must go **red** → restore. A test that stays green when the implementation
   is gone is a tautology (form 2 of §4.2); it does not count as proof. Also confirm the test asserts
   *observable behavior* (not mock-call counts) and is not a mock of an unowned dep (SIV-4).
3. **Trace the path (E2 floor):** entry → … → observable effect, listing each hop's `file:line`. Every
   boundary crossed feeds Phase 4.
4. **Execute where feasible (E4)** — `depth=exhaustive`: run the command, start a local server and issue
   the request, or run the integration test against a **real/hermetic** dependency (SIV-5), never a
   hand-written mock. Record exact repro. Never execute destructive or outward-facing operations without
   authorization.
5. **Record the proof level** in `functionalProof`. E1 (present-only or tautology-tested) → finding.

> **Anti-rationalization:** "tests pass" is not "proven functional." A passing test proves the behavior
> only if it would *fail* without the behavior. Run the kill-probe before crediting E3.

**Exit:** every DELIVERED/PARTIAL claim has a proof level; sub-E3 claims are in `couldNotVerify`.

### Phase 4 — Integration-boundary & structural-guarantee assessment

**Goal:** classify every boundary the work touched (SIV-1), assess its SIV structural guarantees and DIM
operational guarantees, and flag the unguarded and the procedurally-calcified.

1. **Enumerate boundaries** from Phase 1 surfaces + Phase 3 path traces. One `BoundaryRow` per seam:
   `{boundaryId, from, to, kind, dataCrossing, loadBearing}`. A boundary-touching surface that shipped
   with no boundary gate at all is a SIV-1 finding (the boundary was never recognized).
2. **Assess the SIV matrix:** for each load-bearing boundary, assign S0–S4 (§4.5) per applicable SIV
   axis, with `file:line` evidence:
   - **SIV-2** — is there a resolved contract artifact + codegen, so drift is a compile/diff failure
     (S4), or is field-mapping asserted only by a hand-written test (S2/S1)?
   - **SIV-3** — is external input parsed once at the edge into a branded type (S3/S4), with **no stray
     `as`/`as any`/`!` casts downstream** (the two-part invariant; one stray cast defeats the scheme)?
   - **SIV-4** — does any test **mock an unowned dependency**? (S0 for the guarantee — HIGH.)
   - **SIV-5** — for external deps, is the double hermetic/real (S3) or an agent mock (S0/S1)?
   - **SIV-6** — for stateful boundaries, is there a conformance model, and is it **spec-grounded, not
     code-derived** (else it is theater — S1)?
   - **SIV-7** — does a cloud-coupled pathway rely on real-cloud E2E with no hermetic default (smell)?
3. **Assess the DIM operational guarantees** (§4.4): SIV-2 error-propagation/observability, DIM-7
   atomicity/idempotency/timeout, DIM-1 single-source-of-truth.
4. **Check the one semantic oracle:** per load-bearing pathway, exactly one non-tautological semantic
   test (SIV-2's surviving acceptance/north-star test). Absent → HIGH; redundant shape assertions → LOW.
5. **Apply the flag rule** (§4.6). Every finding's `suggestion` names the SIV gate that would establish
   the guarantee at a lower tier.

**Exit:** boundary matrix complete; every load-bearing S0/S1 or calcified-S2 cell has a finding with a SIV remediation.

### Phase 5 — Irregularity sweep

**Goal:** catch gaps that don't bind to a single claim. Mostly deterministic (grep/structural).

- **Stubs / placeholders:** `TODO|FIXME`, `throw new Error\('?[Nn]ot implemented`, `NotImplementedException`, `unimplemented!\(`, `todo!\(`, `panic!\("todo`, `raise NotImplementedError` in changed files.
- **Mock-of-unowned (SIV-4):** scan agent-authored test diffs for `mock|stub|spy|fake|patch|monkeypatch` identifiers; cross-reference the mocked symbol against first-party ownership globs; flag any double of an external dependency.
- **Boundary-parse leaks (SIV-3):** raw `JSON.parse` / `response.json()` / `req.body` / `fs.read*` whose result reaches domain code without crossing a registered parse function; **and** stray `as Brand` / `as any` / `!` downstream of a parse boundary (compile-time brands are defeated by one cast).
- **Dead / unreachable:** new exports with zero consumers (serena `find_referencing_symbols`); code after unconditional return/throw.
- **Test theater:** `.skip`/`xit`/`it.todo`/early-return/always-true assertions; snapshot-only tests standing in for logic; tests that survive the kill-probe.
- **Error swallowing at seams (DIM-2):** empty `catch {}`, `.catch(()=>{})`, catch-and-default on the changed boundaries.
- **Migration safety (DIM-7):** schema migration without a down/rollback; data migration without idempotency.
- **CI honesty:** did the *relevant* suite run on the merge commit? `gh pr view <n> --json statusCheckRollup` / `gh api repos/<repo>/commits/<sha>/check-runs`. Flag merged-with-failing/skipped-required-checks or checks stale relative to the final commit.
- **Doc/flag debt:** feature flag with no sunset; doc/README claims that contradict the code.

**Exit:** sweep findings appended; deterministic ones marked `deterministic: true`.

### Phase 6 — Synthesis & report

**Goal:** compute the verdict and emit the `AuditReport`.

**Verdict rule:**

| Verdict | Condition |
|---------|-----------|
| **FAIL** | Any HIGH: claimed-but-absent, contradicted, unguarded/calcified load-bearing boundary, mock-of-unowned on a load-bearing seam, missing semantic oracle on a core pathway, functional-proof failure on a core claim, or merged with failing/skipped required checks. |
| **CONDITIONAL** | No HIGH, but MEDIUMs present (partials, unclaimed scope, improvable-but-tested boundaries, SIV-7 smell) **or** ≥1 core claim only reaches E2/E1 (unverified). |
| **PASS** | Every claim DELIVERED at E3/E4 (kill-probe red); every load-bearing boundary at S3/S4 structural where the ladder offers it, plus one non-tautological semantic oracle; no HIGH/MEDIUM; `couldNotVerify` empty of core claims. |

Assemble the report ([template](#11-report-template)): executive summary + verdict; completeness
matrix; functional-proof table (with kill-probe results); boundary matrix (SIV + DIM strengths);
findings grouped by severity (axiom format, SIV/DIM tags); the **`couldNotVerify` ledger**;
recommendations ordered by severity, each naming a SIV/DIM remediation.

**Optional — record for observability:**

```typescript
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append", stream: "<repo>-feature-audit",
  event: { type: "gate.executed", data: { gate: "merged-feature-audit", verdict, high, medium, low,
                                           claims, boundaries, killProbed } }
})
```

---

## 7. Anti-rationalization

Before crediting any PASS, refute the excuse. (Extends `spec-review/references/rationalization-refutation.md`
with the SIV findings.)

| Rationalization | Counter | Do instead |
|-----------------|---------|------------|
| "The checkbox is checked / the issue is closed." | A completion claim is the thing under audit, not evidence for it. | Trace the implementing code; mark DELIVERED only on `file:line`. |
| "The PR was approved and merged." | Review samples; audit traces. Approval means a human looked, not that the seam is sound. | Re-derive delivery independently (Phase 1); don't inherit the conclusion. |
| "CI is green." | Green proves the tests that *ran* passed — not coverage, fidelity, or that the relevant suite ran on the merge commit. | Confirm the suite ran on the final commit; kill-probe the tests. Never conclude build-green ⇒ correct. |
| "There's an integration test for the boundary." | Agent-authored boundary tests calcify the agent's assumption as the oracle — mock-of-unowned, tautology, or carbon-copy model (§4.2). | Prefer a *structural* guarantee (SIV-2 drift gate, SIV-3 parse). Credit the test only after the kill-probe and the SIV-4 check. |
| "The test exists." | Existence is not fidelity. A test that survives reverting the implementation asserts nothing. | Run the kill-probe (R3). Red on revert → E3; green → tautology, E1. |
| "The mock returns what the API returns." | You mocked your *assumption* of an unowned API — exactly where integration bugs live (SIV-4; real > fake > stub/mock). | Replace with a hermetic double (SIV-5: Testcontainers / LocalStack / Pact-verified stub). |
| "The types guarantee it." | Only with no `any`/`as`/`!` at the seam and a real parse at the edge; `.brand()` is compile-time only — one stray cast defeats it (SIV-3). | Confirm the single parse boundary and grep for downstream casts. |
| "The conformance/reference model matches the system." | If it was derived from the code it is a carbon copy that catches nothing (SIV-6; MongoDB's abandoned retrofit). | Require the model grounded in acceptance criteria, kept simpler than the implementation. |
| "It's obviously wired." | The two-instances bug had 4192 passing tests and a dead seam (DIM-1). | Trace producer→consumer; confirm the same instance / real connection. |
| "Verifying X is out of scope / we're behind." | Schedule pressure is when defects escape, and silent omission reads as PASS. | Put X in `couldNotVerify` with a reason. Never let absence look like a pass. |

---

## 8. Worked micro-example

**Input:** `entryPoint = #412` (epic "Add webhook delivery"), `repo = acme/svc`.

- **Phase 0** expands #412 → #413 (HMAC signing), #414 (retry), PRs #420, #421. Claims: C-001 "sign
  payloads with HMAC-SHA256" (#413, box checked), C-002 "retry with backoff, max 5" (#414), C-003
  "expose `POST /webhooks`" (#420), C-004 "out of scope: dead-letter queue" (thread).
- **Phase 1:** `signPayload()` `sign.ts:12`; `deliver()` with retry `deliver.ts:40`; route `routes.ts:88`;
  new external call to subscriber URL; **no OpenAPI artifact for the subscriber contract**.
- **Phase 2:** C-001 DELIVERED. C-002 **PARTIAL** — `maxAttempts` hard-coded to 3, not 5 → MEDIUM.
  C-003 DELIVERED. C-004 out-of-scope.
- **Phase 3:** C-001 `sign.test.ts` asserts a known vector; kill-probe (revert `sign.ts:12`) → red →
  **E3 PROVEN**. C-002 test mocks the clock and asserts call count only; survives partial revert →
  tautology → **E1**, recorded in `couldNotVerify`.
- **Phase 4:** B-001 = `deliver()→subscriber URL` (`api`, external, load-bearing). **SIV-2 S0** (no
  contract artifact, so field-mapping drift is uncaught — would be a compile error with
  `openapi-typescript`+`oasdiff`). **SIV-3 S0** (subscriber response read without an edge parse).
  **SIV-4 S0** → the only "integration test" mocks the subscriber (unowned) → HIGH. **DIM-7 S2** (retry,
  but no idempotency key → duplicate delivery). **DIM-2 S0** (no log/metric on delivery failure).
  Semantic oracle: absent. → **HIGH** (SIV-2/SIV-3/SIV-4 unguarded external seam, no semantic oracle);
  **MEDIUM** (DIM-7 retry without idempotency).
- **Phase 5:** `// TODO: dead-letter` `deliver.ts:71` matches out-of-scope C-004 (fine). CI: required
  `e2e` check **skipped** on #421's merge commit → HIGH.
- **Phase 6:** Verdict **FAIL**. `couldNotVerify: [C-002: test asserts mock calls, survives revert]`.
  Recommendations: "Adopt SIV-2 (`openapi-typescript`+`oasdiff`) for the subscriber contract — deletes
  the mocked shape test; replace the SIV-4 mock with a Pact-verified stub (SIV-5); add one north-star
  acceptance test; add an idempotency key (DIM-7)."

---

## 9. Failure & escalation handling

| Condition | Handling |
|-----------|----------|
| `gh` unauthenticated / repo private | Stop. Surface the auth error; ask the user to `! gh auth login`. Do not fabricate scope. |
| Closure ambiguous (PRs unlinked to issues) | Proceed with PR-bodies-as-claims; record the provenance gap; reduce confidence, don't guess intent. |
| Toolchain unresolved (tests won't run, no codegen tool) | Phase 3 caps at E2; SIV-2 cells gate-skipped-advisory (the documented degrade); every affected claim → `couldNotVerify`; verdict cannot be PASS. |
| Execution would be destructive/outward-facing | Do not execute. Cap at E2/E3; note the limitation. Confirm with the user before any state-changing repro. |
| Audit surfaces an implementation need (fixes wanted) | This runbook is read-only. Hand off: open issues for HIGH findings, or `/exarchos:ideate` / `/exarchos:oneshot` for the fix — and where the gap is a missing boundary gate, the fix *is* the corresponding SIV work (SIV-2…SIV-7, #1515 Phase 3). The audit report is the design input. |

---

## 10. Appendix — command reference

**GitHub composite inputs (`gh`):**

```bash
gh issue view <n> --repo <repo> --json title,body,labels,milestone,closedByPullRequestsReferences
gh issue list --repo <repo> --milestone "<m>" --state closed --json number,title,body
gh pr list  --repo <repo> --search "milestone:<m> is:merged" --json number,title,mergedAt,mergeCommit
gh pr view  <n> --repo <repo> --json title,body,closingIssuesReferences,reviews,reviewThreads,statusCheckRollup,files,commits,mergeCommit,baseRefName
gh pr diff  <n> --repo <repo>
gh api repos/<repo>/commits/<sha>/check-runs        # CI honesty: what actually ran on the merge commit
```

**Code tracing (serena):** `get_symbols_overview` (changed files), `find_symbol` (new defs),
`find_referencing_symbols` (reachability / dead-code), `search_for_pattern` (stub/skip/swallow/mock/cast sweep).

**Toolchain resolution:** read `.exarchos.yml` `toolchains:` for `test`/`typecheck`/`lint`/`mutation`/`contract`;
else detect (Taskfile/just/mise/Makefile, then lockfile). The **kill-probe** (E3 gate) is git-only —
`git revert`/`stash` the source hunks, run the resolved test command, assert red, restore — and works on
any runtime. SIV-2 codegen/diff and SIV-3 taint are per-runtime (`buf`/`oasdiff`/`graphql-inspector`;
`eslint-plugin-boundaries`/Semgrep/CodeQL); where none resolves, the cell is gate-skipped-advisory, not
silently passed.

**exarchos integration:** init a `debug`-type workflow to track the audit; append `gate.executed` events
for observability; reuse the axiom finding schema. Boundary findings map 1:1 to the SIV gates (#1515
Phase 3) so an audit fail names its own fix.

---

## 11. Report template

```markdown
# Feature Audit — <feature> (<repo>)

**Scope:** epics/issues <…>, PRs <…>, base `<baseRef>`  ·  **Audited:** <ISO>  ·  **Depth:** <claim|boundary|exhaustive>
**Verdict:** PASS | CONDITIONAL | FAIL

## Summary
<2–4 sentences: what was promised, what shipped, the load-bearing gaps, the unguarded boundaries.>

## Completeness matrix
| Claim | Source | Status | Evidence |
|-------|--------|--------|----------|
| C-001 … | #413 | DELIVERED | sign.ts:12 |

## Functional proof
| Claim | Level | Method (incl. kill-probe) | Result |
|-------|-------|---------------------------|--------|
| C-001 | E3 | sign.test.ts known-vector; revert sign.ts:12 → red | PROVEN |

## Boundary matrix (SIV structural + DIM operational; S0–S4)
| Boundary | Kind | Load-bearing | SIV-2 | SIV-3 | SIV-4 | SIV-5 | SIV-6 | DIM-2 | DIM-7 | Semantic oracle | Verdict |
|----------|------|--------------|-------|-------|-------|-------|-------|-------|-------|-----------------|---------|
| B-001 deliver→subscriber | api | yes | S0 | S0 | S0 | S0 | – | S0 | S2 | absent | unguarded (SIV-2/3/4) |

## Findings
### HIGH
- **[SIV-4] External subscriber mocked in the only boundary test** (qualitative, B-001)
  - Evidence: `webhook/deliver.test.ts:30`
  - The sole integration test mocks the unowned subscriber API, encoding the agent's assumption as the oracle; it cannot catch a real contract or mapping bug.
  - Suggestion: replace with a Pact-verified stub / Testcontainers double (SIV-5); add an `openapi-typescript`+`oasdiff` contract drift gate (SIV-2) so shape drift is a compile error; keep one north-star acceptance test.
### MEDIUM
- **[DIM-7] Retry without idempotency key** (qualitative, B-001) — duplicate delivery possible; add an idempotency key or dedupe at the consumer.
### LOW

## Could not verify
| Ref | Reason |
|-----|--------|
| C-002 | covering test asserts mock-call count and survives source revert (tautology); not runnable to E4 |

## Recommendations
1. <ordered by severity; each names a SIV/DIM remediation>
```

---

*Continuity: this runbook is the post-merge mirror of the SIV gate suite ([#1515](https://github.com/lvlup-sw/exarchos/issues/1515)
Phase 3; `docs/research/2026-06-06-structural-integration-verification.md`). It assesses the **boundary
axis** of the risk-proportional verification ladder (`2026-06-02-verification-pipeline-recommendations.md`,
R1–R10) using the **Tier 0–8 signal ladder** (`2026-06-02-verification-token-efficiency.md` §6) and the
axiom finding schema. Companion to `/exarchos:review` (pre-merge gate) and `/axiom:audit` (quality
dimensions). It does not invent a taxonomy — it grades merged work against SIV-1…SIV-7 and DIM-1…DIM-8.*

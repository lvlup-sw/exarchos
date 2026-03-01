# Adversarial Convergence Theory: Extending the CMDP Framework

> Specs define *what*. Tests enforce *how*. Adversarial verification ensures *nothing was missed*. Convergence gates ensure all three independently agree before the system advances.

## 1. Motivation

The Exarchos agentic workflow theory (see `agentic-workflow-theory.md`) defines a Constrained MDP framework for orchestrating software development:

$$M = (S, S_0, A, \delta, G, I, L)$$

This framework achieves variance reduction through action-space constraints and guarded transitions. However, the guard predicates $G(s_t, a)$ are **structural** — they check whether artifacts exist and prerequisites are met, not whether artifacts are *sufficient*.

Verified Spec-Driven Development (VSDD) identifies a complementary principle: correctness requires **independent convergence** across multiple quality dimensions, enforced by an **adversarial reviewer** at every stage. This ADR formalizes how VSDD's insights extend our CMDP without replacing it.

### 1.1 What VSDD Contributes

VSDD synthesizes three paradigms into a sequential quality pipeline:

| Layer | Role | Principle |
|-------|------|-----------|
| Spec-Driven | Specifications define *what* | Spec supremacy — all code traces to documented requirements |
| Test-Driven | Tests enforce *how* | Red-before-green — code only materializes after failing tests |
| Verification-Driven | Proofs ensure *nothing was missed* | Pure core / effectful shell — provability shapes design |

Its actors — Architect (human strategy), Builder (AI generating artifacts), Tracker (issue system), Adversary (zero-tolerance reviewer) — map naturally onto our existing roles but with one critical difference: the Adversary is a **persistent, cross-cutting concern**, not a single phase.

### 1.2 What Our CMDP Already Provides That VSDD Does Not

| Exarchos Concept | VSDD Gap |
|---|---|
| Action-space constraints (§2.3) | VSDD relies on human discipline to follow the methodology |
| Budget algebra (§4) | VSDD doesn't address resource constraints |
| Thompson sampling (§2.6) | VSDD assigns roles statically |
| Event sourcing | VSDD doesn't address LLM context window limits |
| HSM formalism (§3) | VSDD trusts actors to follow the process; we make invalid transitions impossible |
| Discriminative selection (§2.4) | VSDD uses generative AI roles without constraining their output space |

The synthesis preserves all existing CMDP machinery while adding three formally defined extensions.

---

## 2. Extended CMDP Definition

The original 7-tuple HSM:

$$M = (S, S_0, A, \delta, G, I, L)$$

becomes:

$$M' = (S, S_0, A, \delta', G, I, L', C_{adv}, D_{conv})$$

Where:
- $\delta'$ = transition function conditioned on both $G$ and $C_{adv}$
- $L'$ = observation function enriched with provenance chains
- $C_{adv}$ = adversarial constraint function (semantic quality evaluation)
- $D_{conv}$ = convergence dimension set (multi-objective terminal condition)

The three extensions are defined below.

---

## 3. C_adv: Adversarial Constraint Function

### 3.1 Definition

The adversarial constraint function evaluates **semantic quality** of artifacts at each phase transition:

$$C_{adv}: S \times A \rightarrow \{pass, fail, blocked\}$$

A transition is allowed if and only if both the structural guard and the adversarial constraint pass:

$$\delta'(s, a) = s' \quad \text{iff} \quad G(s, a) = true \;\wedge\; C_{adv}(s, a) \neq fail$$

When $C_{adv}(s, a) = blocked$, the workflow returns to an earlier phase for redesign. This maps to the feature-audit verdict "BLOCKED — return to design phase."

### 3.2 Distinction from Guard Predicates

| | Guard Predicate $G$ | Adversarial Constraint $C_{adv}$ |
|---|---|---|
| Question answered | "Does the artifact exist?" | "Is the artifact sufficient?" |
| Check type | Structural (boolean) | Semantic (quality evaluation) |
| Implementation | Deterministic state inspection | Eval-backed assessment (scripts + rubrics) |
| Example | "Plan file exists at path" | "Plan covers all design requirements" |
| Failure mode | Transition impossible | Transition blocked with finding report |

### 3.3 Graduated Depth

Not every gate needs the full five-dimension feature audit. The adversarial constraint evaluates a **subset of convergence dimensions** at each gate, with increasing depth as the pipeline progresses:

| Phase Gate | Dimensions Evaluated | Depth |
|---|---|---|
| ideate → plan | D1 (spec fidelity) | Lightweight: design completeness check |
| plan → plan-review | D1 + D5 (spec + determinism) | Medium: plan-to-design coverage, task decomposition quality |
| plan-review → delegate | Human approval | Existing human checkpoint (unchanged) |
| per-task completion | D1 + D2 (spec + patterns) | Medium: TDD compliance, pattern adherence |
| delegate → review | D1 + D4 (spec + resilience) | Medium: all tasks complete, no regressions |
| review → synthesize | D1-D5 (all) | **Full feature audit** — deepest adversarial pass |
| synthesize → cleanup | D4 (resilience) | Lightweight: regression check post-merge |

**Design principle:** Earlier gates are cheap (fast script execution, focused checks). The full adversarial pass concentrates at the review → synthesize boundary, where the cost of finding problems is lowest relative to the cost of shipping them.

### 3.4 Adversarial Posture (Generalized)

The feature-audit already states (Dimension 1):

> "Do NOT trust passing tests as proof of completeness. Passing tests prove what they test — nothing about untested requirements."

This principle generalizes across all gates:

> Do NOT trust passing [phase artifacts] as proof of sufficiency. They prove what they check — nothing about unchecked [quality dimensions].

The adversary's job is to identify what *isn't* checked, not to re-run what is.

### 3.5 Relationship to Existing Critic Persona

The adversarial constraint function extends the existing Critic Persona (§4.4 of `agentic-workflow-theory.md`), which operates at the action-scoring level within a single orchestration loop. $C_{adv}$ operates at the **phase transition level** across the entire pipeline:

| | Critic Persona (§4.4) | Adversarial Constraint ($C_{adv}$) |
|---|---|---|
| Scope | Single action within orchestration loop | Phase transition across pipeline |
| Evaluation | Value/cost ratio of proposed action | Quality of completed phase artifacts |
| Mechanism | Approval threshold ($\geq 0.7$) | Convergence dimension evaluation |
| Time scale | Per-step (seconds) | Per-phase (minutes to hours) |

Both implement adversarial governance; they operate at different granularities.

---

## 4. D_conv: Multi-Objective Convergence

### 4.1 Definition

The convergence dimension set defines **independent quality conditions** that must all be satisfied for the workflow to reach terminal state:

$$D_{conv} = \{d_1, d_2, d_3, d_4, d_5\}$$

Where:
- $d_1$ = Specification Fidelity & TDD Compliance
- $d_2$ = Architectural Pattern Compliance
- $d_3$ = Context Economy & Token Efficiency
- $d_4$ = Operational Resilience
- $d_5$ = Workflow Determinism & Variance Reduction

### 4.2 Terminal Condition

The original HSM defines terminal states as `{COMPLETE, FAILED}` reached via transition guards. The convergence condition strengthens the `COMPLETE` terminal:

$$Terminal_{complete}(s) = \forall d \in D_{conv}: Pass(s, d)$$

A workflow where all phases complete but a convergence dimension fails enters a **remediation loop**, not a terminal state:

$$\delta'(s_{review}, a_{synthesize}) = \begin{cases}
s_{synthesize} & \text{if } \forall d \in D_{conv}: Pass(s, d) \\
s_{remediate} & \text{if } \exists d \in D_{conv}: Fail(s, d) \wedge \neg Blocked(s, d) \\
s_{redesign} & \text{if } \exists d \in D_{conv}: Blocked(s, d)
\end{cases}$$

### 4.3 Verdict Classification as Convergence Check

The existing feature-audit verdict maps directly to convergence outcomes:

```
APPROVED    = ∀d ∈ D_conv: Pass(s, d)        → Terminal(COMPLETE)
NEEDS_FIXES = ∃d: Fail(s, d) ∧ ¬Blocked      → Remediation loop
BLOCKED     = ∃d: Blocked(s, d)               → Return to design phase
```

**Blocked conditions** (from feature-audit):
- Append-only invariant violated (D2)
- State non-derivable from events (D2)
- Terminal states unreachable in HSM (D2)

These represent fundamental architectural failures that cannot be fixed with incremental changes.

### 4.4 Independence Requirement

Convergence dimensions must be evaluated **independently** — a pass in one dimension cannot compensate for a failure in another. This prevents the failure mode where excellent test coverage (D1) masks poor operational resilience (D4).

Formally:

$$\nexists \; w_i: Terminal(s) = \sum_i w_i \cdot Score(s, d_i) \geq \theta$$

Convergence is conjunctive ($\wedge$), not weighted-additive.

### 4.5 Relationship to Budget Constraints

Convergence dimensions interact with the CMDP budget constraint. Dimension D3 (Context Economy) is explicitly a budget dimension:

$$C_3(s_t, a_t) = \text{token cost of action } a_t$$
$$\mathbb{E}\left[\sum_{t} C_3(s_t, a_t)\right] \leq d_{tokens}$$

The other dimensions are quality constraints that bound the **reward function** — they define what counts as a "correct" terminal state, not what counts as an affordable path to get there.

---

## 5. L': Provenance-Enriched Observation Function

### 5.1 Definition

The original observation function maps states to ledgers:

$$L: S \rightarrow (\text{TaskLedger} \times \text{ProgressLedger})$$

The enriched observation function adds a **provenance graph**:

$$L': S \rightarrow (\text{TaskLedger} \times \text{ProgressLedger} \times \text{ProvenanceGraph})$$

### 5.2 Provenance Graph Structure

The provenance graph is a directed acyclic graph (DAG) that traces artifacts through the pipeline:

```
ProvenanceGraph = {
  requirements: [{ id: string, source: "design-doc:§N.M", description: string }],
  tasks:        [{ id: string, implements: requirementId[], branch: string }],
  tests:        [{ name: string, task: taskId, file: string, line: number }],
  code:         [{ file: string, range: [start, end], test: testName }]
}
```

**Edges represent traceability:**
- Requirement → Task: "This task implements this requirement"
- Task → Test: "This test verifies this task"
- Test → Code: "This code is exercised by this test"

### 5.3 Provenance Flow Through the Pipeline

Each pipeline phase enriches the provenance graph:

| Phase | Provenance Contribution |
|-------|------------------------|
| `/ideate` | Design doc defines numbered requirements (DR-1, DR-2, ...) |
| `/plan` | Implementation plan maps tasks to requirements (T-3 implements DR-1, DR-2) |
| `/delegate` | Task prompts carry requirement IDs; tests name their requirement in metadata |
| `/review` | Traceability matrix **generated from provenance graph**, not reconstructed by reviewer |
| `/synthesize` | Coverage query: "Which requirements have no tests?" becomes a deterministic check |

### 5.4 From Qualitative to Deterministic Eval

The feature-audit Dimension 1 currently requires:

> "Build a `Requirement → File:Line → Test` traceability matrix. Every row must have all three columns populated."

With the provenance graph maintained through the pipeline, this becomes a **deterministic check**:

```bash
# Provenance coverage: all requirements must have implementing code and tests
exarchos_view --action provenance_coverage --featureId <id>
# Returns: { covered: ["DR-1", "DR-2"], uncovered: ["DR-3"], coverage: 0.67 }
```

If the provenance graph has gaps, the finding is measurable (which requirement is uncovered), not a judgment call.

### 5.5 Provenance as Event Metadata

Provenance data flows through the existing event stream as metadata on workflow events:

```typescript
// Event emitted when a task completes
{
  type: "task.completed",
  timestamp: "2026-02-28T...",
  correlationId: "feature-123",
  payload: {
    taskId: "T-3",
    branch: "feature/password-reset",
    provenance: {
      implements: ["DR-1"],
      tests: [
        { name: "ResetPassword_ValidToken_ResetsPassword", file: "src/auth/reset.test.ts", line: 15 },
        { name: "ResetPassword_ExpiredToken_Returns401", file: "src/auth/reset.test.ts", line: 42 }
      ]
    }
  }
}
```

This preserves the event-sourcing invariant (append-only, self-describing) while enriching the observation function.

---

## 6. Synthesis: Why This Is Strictly Stronger Than VSDD

VSDD is a **methodology** — it prescribes what actors should do. The extended CMDP is a **control system** — it makes incorrect behavior impossible or detectable by construction.

| VSDD Claim | CMDP Formalization | Why Ours Is Stronger |
|---|---|---|
| "Specs are supreme" | Provenance graph ($L'$) traces every artifact to a requirement | Gaps are detectable by deterministic query, not human review |
| "Red before green" | TDD compliance script + D1 convergence gate | Enforced by executable check, not discipline |
| "Adversary reviews everything" | $C_{adv}$ at graduated depth per gate | Adversarial checks are formal constraint evaluations, not role-playing prompts |
| "Four-dimensional convergence" | $D_{conv}$ with five independent, conjunctive dimensions | Convergence is a defined terminal condition with formal blocking semantics |
| "Full traceability" | Provenance DAG maintained through event metadata | Traceability is a living artifact, not a post-hoc reconstruction |

**The fundamental difference:** VSDD trusts actors to follow the methodology correctly. Our system ensures correct behavior through:
- **Action-space constraints** (invalid transitions impossible)
- **Guard predicates** (structural prerequisites enforced)
- **Adversarial constraints** (semantic quality evaluated)
- **Convergence conditions** (independent dimensions must all pass)
- **Event sourcing** (state survives context loss)

---

## 7. Open Questions

1. **Graduated gate cost**: How much context budget do lightweight adversarial checks consume? Need empirical measurement before committing to checks at every gate.

2. **Provenance automation**: Can requirement IDs be extracted from design docs automatically, or does the human architect need to assign them explicitly during `/ideate`?

3. **Convergence dimension weights**: While dimensions are conjunctive (all must pass), should the severity thresholds within each dimension be calibrated differently for different project types?

4. **Feedback loops**: When $C_{adv}$ fails at an early gate (e.g., plan → plan-review), how far back should the workflow regress? Always to the immediately prior phase, or conditionally to an earlier phase based on the dimension that failed?

---

## 8. References

### This ADR Extends

1. **Agentic Workflow Theory ADR** — `docs/adrs/agentic-workflow-theory.md` (CMDP, HSM, Thompson Sampling, Budget Algebra)
2. **Feature Audit Prompt** — `docs/prompts/feature-audit.md` (5-dimension eval framework)

### External Sources

3. **VSDD (Verified Spec-Driven Development)** — Synthesis of SDD, TDD, and VDD into a coordinated AI-orchestrated pipeline. Source: community methodology document.
4. **Microsoft Learn Event Sourcing & CQRS** — Canonical pattern definitions informing Dimension 2.
5. **Anthropic Skill-Building Best Practices** — Progressive disclosure, trigger testing, functional testing informing Dimensions 3 and 5.

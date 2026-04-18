# Solver-Aided Governance for Agentic Workflows

> "The role of an engineer isn't just to produce something that happens to work on a few inputs. It's to produce something that always works on every input." — Zack Tatlock, CARS Lecture 1

## 1. Problem Statement

Exarchos governs agentic workflows through a Hierarchical State Machine (HSM) with guarded transitions, five safety invariants, and five convergence dimensions (ADR: `agentic-workflow-theory.md`, `adversarial-convergence-theory.md`). Today, these guarantees are enforced by:

- **Guard predicates**: Pure TypeScript functions in `guards.ts` (~30 guards) that check structural prerequisites
- **Property-based tests**: `fast-check` sampling in `state-machine.property.test.ts` and `playbooks.property.test.ts`
- **Convergence gates**: Orchestrate handlers that run deterministic bash scripts and heuristic checks

This leaves three verification gaps:

1. **Exhaustiveness gap.** Property-based tests sample the state space — they find bugs probabilistically, not exhaustively. A guard composition bug that manifests only in a rare state combination may survive thousands of test runs.

2. **Pre-flight gap.** Plans are validated structurally (do tasks exist? do they have dependencies?) but not semantically (is the dependency DAG satisfiable within budget? are there circular dependencies that make completion impossible?).

3. **Intent gap.** The provenance chain (design → plan → task → test → code) is checked by pattern-matching scripts, not by a system that can reason about structural completeness as a satisfiability problem.

These gaps correspond exactly to the three classes of problems SAT/SMT solvers are built to address: exhaustive search over boolean combinations, constraint satisfaction over structured domains, and satisfiability checking over relational structures.

### 1.1 What This Is Not

This is not a replacement for testing, property checking, or runtime monitoring. Following AWS's portfolio approach (Brooker & Desai, "Systems Correctness Practices at AWS", 2025), solver-aided verification is an additional layer in the correctness portfolio:

| Layer | Tool | What It Catches | Cost |
|-------|------|-----------------|------|
| Unit tests | vitest | Implementation bugs | Low, fast |
| Property tests | fast-check | Edge cases in state transitions | Low, fast |
| **Solver verification** | **Z3** | **Exhaustive guard consistency, plan feasibility, invariant violations** | **Medium, seconds** |
| Runtime monitoring | Event store + CQRS views | Actual workflow anomalies | Continuous |
| Adversarial review | C_adv (convergence gates) | Semantic quality gaps | High, minutes |

Each layer catches problems the others miss. Solver verification fills the gap between probabilistic sampling (property tests) and qualitative judgment (adversarial review).

## 2. Design Overview

### 2.1 Architecture

A new `verify` module in the MCP server encodes Exarchos's HSM definitions, guard predicates, and workflow constraints as SMT formulas and queries Z3 for exhaustive answers.

```
servers/exarchos-mcp/src/
  verify/
    encoding.ts          HSM → Z3 formula translation
    guards-smt.ts        Guard consistency verification
    plan-sat.ts          Plan feasibility (SAT/PB/MaxSAT)
    invariants.ts        Safety property BMC
    provenance.ts        Traceability coverage (EUF)
    solver.ts            Z3-WASM lifecycle management
    types.ts             Shared verification types
    index.ts             Public API
  verify/__tests__/
    encoding.test.ts
    guards-smt.test.ts
    plan-sat.test.ts
    invariants.test.ts
    provenance.test.ts
```

### 2.2 CLI Integration

```bash
# Verify guard consistency across all HSM definitions
exarchos verify guards

# Check plan feasibility for a specific workflow
exarchos verify plan --feature solver-aided-governance

# Bounded model check safety invariants (k=20 steps)
exarchos verify invariants --workflow feature --bound 20

# Check provenance coverage
exarchos verify provenance --feature solver-aided-governance

# Run all checks
exarchos verify all --feature solver-aided-governance
```

### 2.3 MCP Integration

Exposed as an orchestrate action for agent consumption:

```typescript
exarchos_orchestrate({
  action: "verify_workflow",
  featureId: "solver-aided-governance",
  checks: ["guards", "plan", "invariants", "provenance"]
})
// Returns: { passed: boolean, results: VerifyResult[] }
```

### 2.4 Dependency Strategy

Z3 is consumed via the `z3-solver` npm package, which ships Z3 as WebAssembly. This means:

- No native binary dependency — works on all platforms Node supports
- No system installation required — `npm install` is sufficient
- Initialization cost: ~200ms cold start (WASM instantiation), amortized across queries
- The dependency lives in `servers/exarchos-mcp/package.json` only — the root installer package remains dependency-free

The Z3 instance is lazily initialized on first use and cached for the process lifetime.

## 3. Verification Layers

### 3.1 Layer 1: Guard Consistency Verification

**CARS foundation:** Propositional logic (Lecture 1), SAT solving (Lecture 2)

**Problem:** Guards in `guards.ts` are composed in `hsm-definitions.ts` to form transition conditions. Several correctness properties must hold:

1. **Mutual exclusion.** For choice states (e.g., `implementing` in oneshot: `synthesisOptedIn` vs `synthesisOptedOut`), exactly one guard must pass for any valid state. If both pass or neither passes, the workflow is ambiguous or stuck.

2. **Progress.** From every non-final state, at least one outgoing transition's guard must be satisfiable. Otherwise, the workflow can get permanently stuck.

3. **Determinism.** When multiple transitions leave a state, their guards must not simultaneously pass (except for explicitly documented nondeterministic states).

**Encoding:** Each guard becomes a boolean variable or boolean function over state variables. The HSM definition becomes a conjunction of implications.

```typescript
// Conceptual encoding (actual implementation uses Z3 API)
//
// For the oneshot HSM choice at 'implementing':
//   synthesisOptedIn(state) XOR synthesisOptedOut(state)
//
// Verify: ¬∃ state: optedIn(state) ∧ optedOut(state)
//   If SAT → bug: both guards can fire simultaneously
//   If UNSAT → proven: mutual exclusion holds for ALL states

function encodeGuardConsistency(hsm: HSMDefinition): Z3Formula {
  const stateVars = declareStateVariables(hsm);
  const guardFormulas = encodeGuards(hsm.transitions, stateVars);

  const checks: Z3Formula[] = [];

  // For each state with multiple outgoing transitions:
  for (const state of nonFinalStates(hsm)) {
    const outgoing = transitionsFrom(hsm, state.id);
    if (outgoing.length <= 1) continue;

    // Check pairwise mutual exclusion where required
    for (let i = 0; i < outgoing.length; i++) {
      for (let j = i + 1; j < outgoing.length; j++) {
        const bothFire = Z3.And(
          guardFormulas[outgoing[i].guard.id],
          guardFormulas[outgoing[j].guard.id]
        );
        // Ask: can both fire? If SAT, we have a problem.
        checks.push(bothFire);
      }
    }
  }

  return checks;
}
```

**What this catches that property tests miss:** Property tests sample random states and check guard behavior. Z3 checks *all possible* states exhaustively. The existing `fast-check` test for `synthesisOptedIn`/`synthesisOptedOut` mutual exclusivity samples ~100 random states. Z3 proves it for the entire (infinite, but finitely parameterized) state space.

**Connection to existing code:** The `state-machine.property.test.ts` already tests properties like "from any non-final state, at least one transition is valid." The solver verification proves these properties exhaustively rather than probabilistically.

**Axiom quality dimension: DIM-6 (Architecture).** Guard consistency is an architectural invariant. Violations indicate structural design defects, not implementation bugs.

### 3.2 Layer 2: Plan Feasibility Checking

**CARS foundation:** SAT encoding (Lecture 2 — package management), pseudo-boolean optimization (Lecture 2 — cost minimization), MaxSAT (Lecture 2 — conflict resolution)

**Problem:** Before `/delegate` begins executing tasks, we should verify:
1. The task dependency DAG is satisfiable (no circular dependencies, no impossible orderings)
2. A valid execution schedule exists within the token budget
3. If infeasible, what's the minimal set of tasks to defer?

This is exactly the package management problem from Lecture 2, domain-shifted:

| Package Management | Exarchos Plan |
|-------------------|---------------|
| Package | Task |
| Dependency edge | Task dependency (`dependsOn`) |
| Conflict | File-level mutex (tasks modifying same files) |
| Already installed | Already-completed tasks |
| Want to install | All tasks marked `pending` |
| Package size | Estimated token cost |

**Encoding:**

```typescript
function encodePlanFeasibility(plan: Plan, budget: number): PlanQuery {
  const solver = new Z3.Optimize();

  // One boolean variable per task: true = scheduled, false = deferred
  const taskVars = plan.tasks.map(t =>
    Z3.Bool(`task_${t.id}`)
  );

  // Dependencies as implications: task_3 → task_1 ∧ task_2
  for (const task of plan.tasks) {
    for (const depId of task.dependsOn ?? []) {
      solver.add(Z3.Implies(taskVars[task.id], taskVars[depId]));
    }
  }

  // File-level mutual exclusion for parallel safety
  for (const [file, tasks] of fileToTaskMap(plan)) {
    if (tasks.length <= 1) continue;
    // At most one task touching this file can be in the same wave
    solver.add(Z3.AtMost(...tasks.map(t => taskVars[t.id]), 1));
  }

  // Budget as pseudo-boolean constraint
  const cost = Z3.Sum(
    ...plan.tasks.map(t =>
      Z3.If(taskVars[t.id], Z3.Int(t.estimatedTokens), Z3.Int(0))
    )
  );
  solver.add(Z3.Le(cost, Z3.Int(budget)));

  // Objective: maximize number of completed tasks
  solver.maximize(Z3.Sum(...taskVars.map(v => Z3.If(v, 1, 0))));

  return solver;
}
```

**Three query modes (mirroring Lecture 2):**

1. **Feasibility (SAT).** "Can all pending tasks complete within budget?" Assert all task variables true. If UNSAT, the plan is infeasible as-is.

2. **Optimization (Pseudo-Boolean).** "What's the maximum set of tasks completable within budget?" Maximize scheduled tasks subject to budget constraint. Returns the optimal subset.

3. **Conflict resolution (MaxSAT).** "If infeasible, what's the minimal set of tasks to defer?" Make each task a soft constraint. MaxSAT returns the maximum satisfiable subset — the complement is the minimal deferral set.

**Integration point:** The `prepare_delegation` orchestrate handler already validates task structure. Plan feasibility adds a solver-backed pre-flight check at the `plan-review → delegate` boundary — the gate specified in adversarial-convergence-theory §3.3.

**Axiom quality dimensions: DIM-1 (Topology), DIM-3 (Contracts).** Dependency DAG validity is a topological concern. Budget-within-constraint is a contract between the orchestrator and the execution environment.

### 3.3 Layer 3: Safety Invariant Verification (Bounded Model Checking)

**CARS foundation:** SMT (Lectures 5-6), program verification (Lectures 7-8), bounded model checking (Armando et al. 2009, KLEE 2008)

**Problem:** The agentic-workflow-theory ADR §3.4 defines five safety invariants:

$$I = \{I_{budget}, I_{progress}, I_{security}, I_{termination}, I_{loop}\}$$

Today these are enforced by guard predicates at individual transitions. But guards are local — they check one transition. Safety invariants are global — they must hold across all possible execution paths.

**Approach:** Bounded model checking (BMC) unrolls the HSM for k steps and asks: "Is there any execution path of length ≤ k that reaches a state violating an invariant?"

```typescript
function boundedModelCheck(
  hsm: HSMDefinition,
  invariant: (state: Z3State) => Z3Bool,
  bound: number
): BMCResult {
  const solver = new Z3.Solver();

  // State at each timestep
  const states: Z3State[] = [];
  for (let t = 0; t <= bound; t++) {
    states.push(declareState(hsm, `t${t}`));
  }

  // Initial state
  solver.add(states[0].phase === hsm.initial);

  // Transition relation at each step
  for (let t = 0; t < bound; t++) {
    solver.add(encodeTransitionRelation(hsm, states[t], states[t + 1]));
  }

  // Negate invariant: look for a violation
  const violation = Z3.Or(
    ...states.map(s => Z3.Not(invariant(s)))
  );
  solver.add(violation);

  const result = solver.check();
  if (result === 'unsat') {
    return { safe: true, bound };
  } else {
    // SAT = found a counterexample execution trace
    const model = solver.model();
    return {
      safe: false,
      bound,
      counterexample: extractTrace(model, states),
    };
  }
}
```

**Invariants encoded:**

| Invariant | SMT Encoding | What Violation Means |
|-----------|-------------|---------------------|
| I_budget | `∀t: steps(t) ≤ STEP_BUDGET` | Execution can exceed budget |
| I_progress | `∀t: phase(t) ≠ phase(t-1) ∨ state_changed(t)` | Workflow can stall silently |
| I_termination | `∃t ≤ k: phase(t) ∈ {completed, cancelled, failed}` | Workflow may never terminate |
| I_loop | `∀t: consecutive_no_progress(t) < THRESHOLD` | Unbounded loops possible |
| I_security | `∀t: tool_calls(t) ⊆ allowed_tools(phase(t))` | Unauthorized tool access possible |

**Counterexample traces:** When BMC finds a violation, it produces a concrete execution trace — a sequence of states and transitions that leads to the invariant violation. This is directly actionable: "Starting from state X, if transition Y fires, then Z fires, the budget invariant is violated at step 7."

**Connection to CDCL (Lecture 2 theory):** The solver's conflict-driven clause learning is what makes BMC tractable. When the solver finds that a particular combination of transitions cannot lead to a violation, it learns a clause that prunes the entire class of similar paths — exactly the "learn from mistakes, don't repeat them" insight from CDCL.

**Axiom quality dimensions: DIM-7 (Resilience), DIM-6 (Architecture).** Invariant violations are resilience failures. Unreachable terminal states are architectural defects.

### 3.4 Layer 4: Provenance Coverage Verification

**CARS foundation:** EUF — Equality with Uninterpreted Functions (Lecture 3), congruence closure

**Problem:** The adversarial-convergence-theory ADR §5 defines a provenance graph:

```
Requirements → Tasks → Tests → Code
```

The current `verify-provenance-chain.sh` script checks that requirement IDs (DR-N) appear in plan tasks. But this is string matching — it doesn't reason about structural coverage.

**Insight from Lecture 3:** EUF lets us reason about relationships without knowing the semantics. We don't need to understand *what* DR-1 means or *what* task T-3 does. We only need to verify the structural property: "every requirement has at least one implementing task, and every task has at least one test."

```typescript
function encodeProvenanceCoverage(provenance: ProvenanceGraph): Z3Formula {
  const solver = new Z3.Solver();

  // Sorts (types)
  const Requirement = Z3.DeclareSort('Requirement');
  const Task = Z3.DeclareSort('Task');
  const Test = Z3.DeclareSort('Test');

  // Uninterpreted functions (relationships)
  const implements_ = Z3.DeclareFunc('implements', Task, Requirement, Z3.Bool);
  const covers = Z3.DeclareFunc('covers', Test, Task, Z3.Bool);

  // Ground facts from the provenance graph
  for (const task of provenance.tasks) {
    const taskConst = Z3.Const(`task_${task.id}`, Task);
    for (const reqId of task.implements) {
      const reqConst = Z3.Const(`req_${reqId}`, Requirement);
      solver.add(implements_(taskConst, reqConst));
    }
  }

  for (const test of provenance.tests) {
    const testConst = Z3.Const(`test_${test.name}`, Test);
    const taskConst = Z3.Const(`task_${test.taskId}`, Task);
    solver.add(covers(testConst, taskConst));
  }

  // Coverage property: every requirement is implemented by some task
  // ∀r ∈ Requirements: ∃t ∈ Tasks: implements(t, r)
  const uncoveredReqs: string[] = [];
  for (const req of provenance.requirements) {
    const reqConst = Z3.Const(`req_${req.id}`, Requirement);
    const hasCoverage = Z3.Or(
      ...provenance.tasks.map(t => implements_(
        Z3.Const(`task_${t.id}`, Task), reqConst
      ))
    );
    // If no task implements this requirement, record the gap
    const check = new Z3.Solver();
    check.add(Z3.Not(hasCoverage));
    if (check.check() === 'sat') {
      uncoveredReqs.push(req.id);
    }
  }

  return {
    covered: provenance.requirements.filter(r => !uncoveredReqs.includes(r.id)),
    uncovered: uncoveredReqs,
    coverage: 1 - (uncoveredReqs.length / provenance.requirements.length),
  };
}
```

**Why EUF over string matching:** String matching catches syntactic gaps ("DR-3 appears in no task's `implements` field"). EUF catches structural gaps ("Task T-5 claims to implement DR-2, but DR-2 was removed from the design doc — the reference is orphaned"). The solver reasons about the *consistency* of the provenance graph, not just the presence of strings.

**Axiom quality dimensions: DIM-3 (Contracts), DIM-4 (Test Fidelity).** Provenance coverage is a contract between the design and implementation. Test-to-task coverage is test fidelity.

## 4. Encoding Quality: Correct Reductions

**CARS foundation:** Encoding quality (Lecture 2 — XOR vs OR), solver sympathy (Lecture 6)

Lecture 2's central lesson: "If you get your reduction wrong, the solver will give you a correct answer to the wrong question." This applies directly to our encodings.

### 4.1 Guard Encoding Fidelity

Each guard in `guards.ts` is a TypeScript function that examines state. To encode it as an SMT formula, we must faithfully represent its logic. Consider `allTasksComplete`:

```typescript
// The actual guard
evaluate: (state) => {
  const tasks = state.tasks as Array<{ status: string }> | undefined;
  if (!tasks || tasks.length === 0) return true;  // vacuously true
  return tasks.every(t => t.status === 'complete');
}

// WRONG encoding: ∀t: status(t) = 'complete'
// Misses the vacuous truth case (empty task list passes)

// CORRECT encoding: tasks.length = 0 ∨ ∀t: status(t) = 'complete'
```

Like the XOR-vs-OR distinction in Lecture 2, getting these edge cases wrong means the solver will verify the wrong property. The encoding module must include **round-trip tests**: encode a guard, evaluate it on concrete states, and assert the Z3 formula agrees with the TypeScript function for those states. This doesn't prove encoding correctness (that would require verifying the encoder itself), but it catches the obvious reduction bugs.

### 4.2 Abstraction Level

Not every guard detail needs encoding. The solver needs to reason about guard *satisfiability*, not guard *implementation*. For guards that check artifact existence (`designArtifactExists`, `planArtifactExists`), the encoding can abstract to a boolean: "does the artifact exist?" The solver doesn't need to know that the artifact is checked via `state.artifacts[field] != null`.

This is the abstraction principle from SMT engineering: encode at the right level of detail. Too concrete and the formula is huge. Too abstract and the verification is vacuous.

### 4.3 Tseitin-Style State Decomposition

For complex guards like `allReviewsPassed` (which iterates reviews, extracts statuses, checks against PASSED_STATUSES), direct encoding produces large formulas. Following the Tseitin transformation from Lecture 1 (introduce auxiliary variables to keep formula size linear), we introduce intermediate variables:

```
review_1_passed ↔ (status_1 ∈ PASSED_STATUSES)
review_2_passed ↔ (status_2 ∈ PASSED_STATUSES)
all_reviews_passed ↔ (review_1_passed ∧ review_2_passed ∧ ...)
```

Each auxiliary variable localizes the encoding, preventing exponential blowup.

## 5. Solver Lifecycle and Performance

### 5.1 Z3 WASM Initialization

```typescript
import { init as initZ3 } from 'z3-solver';

let z3Instance: Awaited<ReturnType<typeof initZ3>> | null = null;

async function getZ3(): Promise<typeof z3Instance> {
  if (!z3Instance) {
    z3Instance = await initZ3();
  }
  return z3Instance;
}
```

Cold start: ~200ms. Subsequent queries against the same Z3 instance: <10ms for guard consistency, <100ms for plan feasibility (typical plan sizes), <1s for BMC at bound 20.

### 5.2 Incremental Solving

For iterative plan refinement (user adjusts plan, re-checks feasibility), Z3 supports incremental solving via `push()`/`pop()`. The base constraints (HSM definition, dependency graph) are asserted once. Each feasibility check pushes a new scope with the current plan state, checks, and pops.

This maps directly to the incremental solving concept from Lecture 2's studio discussion: "checkpoint the solver state, add more constraints, check, then pop back."

### 5.3 Performance Budget

Following the context-economy principle (convergence dimension D3), verification must not be a bottleneck:

| Check | Target Latency | When Run |
|-------|---------------|----------|
| Guard consistency | <500ms | On HSM definition change (dev-time) |
| Plan feasibility | <200ms | Before delegation (per-workflow) |
| BMC (k=20) | <2s | On demand / CI |
| Provenance coverage | <100ms | During review phase |

If any check exceeds its budget, the CLI reports a timeout rather than blocking the workflow.

## 6. Theory Refinement

This design refines the foundational CMDP framework. The extended formalization:

$$M'' = (S, S_0, A, \delta', G_{verified}, I_{checked}, L', C_{adv}, D_{conv}, \Phi_{SMT})$$

Where $\Phi_{SMT}$ is the set of SMT formulas encoding verifiable workflow properties. The key theoretical contributions:

### 6.1 From Probabilistic to Decidable Guards

The agentic-workflow-theory ADR describes guard predicates as structural boolean checks:

$$\delta(s, a, g) = s' \quad \text{iff} \quad g(\text{Context}) = \text{true}$$

With solver verification, we can prove properties about the *composition* of guards across the entire HSM:

$$\forall s \in S_{non-terminal}: \exists a \in A: G(s, a) = \text{true} \quad \text{(progress)}$$
$$\forall s, a_i, a_j: G(s, a_i) \wedge G(s, a_j) \implies a_i = a_j \quad \text{(determinism)}$$

These are currently tested probabilistically (fast-check). With Z3, they become proven properties. This is the shift from testing to verification that de Moura argues for: "Testing provides confidence. Proof provides a guarantee." (de Moura, "When AI Writes the World's Software, Who Verifies It?", 2026)

### 6.2 Budget Algebra as Linear Arithmetic

The budget algebra from §4 of the agentic-workflow-theory ADR defines scarcity levels and cost functions. These are directly expressible in Z3's linear arithmetic theory (LIA):

$$\text{scarcity}(B) = \text{Critical} \iff B.\text{remaining} / B.\text{allocated} \leq 0.1$$

With integer arithmetic in SMT (Lecture 4 — Arithmetic, Arrays, and Bitvectors), the budget algebra becomes mechanically checkable: "Given these task costs and this budget, is there a valid schedule?"

### 6.3 Convergence as Multi-Objective SAT

The convergence condition from adversarial-convergence-theory §4.2:

$$Terminal_{complete}(s) = \forall d \in D_{conv}: Pass(s, d)$$

With the independence requirement (§4.4: convergence is conjunctive, not weighted-additive), this is a conjunction of boolean constraints — exactly a SAT formula. The solver can determine whether the current state *can* reach convergence, and if not, which dimensions are blocking.

### 6.4 Intent Formalization Connection

Lahiri's "Intent Formalization Grand Challenge" (2026) identifies the central problem: the gap between informal requirements and program behavior. Exarchos's provenance graph is a partial intent formalization — it traces informal requirements (DR-N in design docs) through formal tasks and tests. The EUF verification layer (§3.4) makes this traceability mechanically checkable.

This positions Exarchos on the "lightweight formalization" end of Lahiri's spectrum: not full functional specifications, but structured provenance that can be verified by a solver.

## 7. Implementation Requirements

### DR-1: Z3 WASM Integration
Add `z3-solver` as a dependency of `servers/exarchos-mcp/package.json`. Lazy initialization on first verification call. No impact on cold start for non-verification workflows.

### DR-2: Guard Encoding Module
Translate each guard in `guards.ts` to an equivalent Z3 boolean formula. Include round-trip tests comparing Z3 evaluation to TypeScript evaluation on concrete states.

### DR-3: HSM Encoding Module
Translate `hsm-definitions.ts` (all five HSM types: feature, debug, oneshot, discovery, refactor) to Z3 state machine encodings. The encoding reads the HSM definition data structures directly — no manual model maintenance.

### DR-4: Plan SAT Encoder
Encode task dependency DAGs as SAT, with pseudo-boolean budget constraints and MaxSAT for conflict resolution.

### DR-5: BMC Engine
Bounded model checking for the five safety invariants, parameterized by bound depth k. Produces counterexample traces on violation.

### DR-6: Provenance Verifier
EUF-based structural coverage checking for requirement → task → test provenance chains.

### DR-7: CLI Commands
`exarchos verify {guards|plan|invariants|provenance|all}` with structured JSON output for machine consumption and human-readable summary.

### DR-8: Orchestrate Action
`verify_workflow` action in the orchestrate handler registry, returning structured `VerifyResult` for agent consumption.

### DR-9: CI Integration
Guard consistency and BMC checks run in CI on changes to `guards.ts`, `hsm-definitions.ts`, or `state-machine.ts`. Fail the build on safety invariant violations.

## 8. Academic Deliverable

### Mini-Project: "Solver-Aided Governance for Agentic Workflows"

**Abstract:** Agentic workflow orchestration systems use hierarchical state machines with guarded transitions to govern AI agent behavior. We present a solver-aided verification toolkit that applies SAT, SMT, and bounded model checking to prove safety properties of these workflows exhaustively. Our system encodes guard predicates as propositional formulas, plan dependencies as SAT instances, safety invariants as bounded model checking queries, and provenance chains as EUF satisfiability checks. We demonstrate the approach on Exarchos, an open-source agentic governance system with five workflow types, thirty guard predicates, and five safety invariants. The solver finds guard consistency violations in under 500ms and verifies safety invariants for execution traces up to 20 steps in under 2 seconds.

**Structure:**
1. Introduction: The verification gap in agentic workflows
2. Background: CMDP framework, HSM formalism (from ADRs)
3. Encoding: HSM → SAT/SMT (techniques from Lectures 1-6)
4. Verification: Guard consistency, plan feasibility, safety BMC, provenance coverage
5. Implementation: Z3-WASM in TypeScript, CLI integration
6. Evaluation: Performance on Exarchos's five workflow types
7. Related Work: AWS formal methods, Rosette, SpaceSearch, Lahiri intent formalization
8. Conclusion: From probabilistic to decidable workflow governance

**Timeline:**
- Weeks 4-5 (Apr 20 - May 3): Guard encoding + plan SAT encoder
- Week 6 (May 4-10): SMT engineering, performance tuning
- Week 7 (May 11-17): BMC for safety invariants
- Week 8 (May 18-24): Provenance verifier, CLI integration, end-to-end tests
- Week 9 (May 25): Mini-project milestone (working prototype + paper outline)
- Week 10 (Jun 1): Mini-project final (polished paper + merged Exarchos feature)

## 9. References

### CARS Course Materials
1. Tatlock, Z. CSEP590B Lecture 1: SAT Foundations (2026)
2. Tatlock, Z. CSEP590B Lecture 2: SAT Solving and Applications (2026)
3. Tatlock, Z. CSEP590B Lecture 3: Theories and Equality (2026)
4. Tatlock, Z. CSEP590B Lectures 4-8: Arithmetic, SMT, Verification (2026, forthcoming)

### Exarchos ADRs
5. "Agentic Workflow Theory: A Formal Framework" — `docs/adrs/agentic-workflow-theory.md`
6. "Adversarial Convergence Theory: Extending the CMDP Framework" — `docs/adrs/adversarial-convergence-theory.md`

### CARS Library Papers (directly applied)
7. Brooker, M. & Desai, A. "Systems Correctness Practices at AWS." CACM, 2025.
8. Newcombe, C. et al. "How Amazon Web Services Uses Formal Methods." CACM, 2015.
9. de Moura, L. "When AI Writes the World's Software, Who Verifies It?" 2026.
10. Lahiri, S. "Intent Formalization: A Grand Challenge for Reliable Coding in the Age of AI Agents." arXiv:2603.17150, 2026.
11. Torlak, E. & Bodik, R. "Growing Solver-Aided Languages with Rosette." Onward! 2013.
12. Weitz, K. et al. "SpaceSearch: A Library for Building and Verifying Solver-Aided Tools." OOPSLA, 2017.
13. Brooker, M. "Formal Methods Only Solve Half My Problems." 2022.
14. Wayne, H. "The Business Case for Formal Methods." 2019.
15. Armando, A. et al. "Bounded Model Checking of Software Using SMT Solvers." 2009.
16. de Moura, L. & Bjorner, N. "Z3: An Efficient SMT Solver." TACAS, 2008.
17. Leino, K.R.M. "Dafny: An Automatic Program Verifier for Functional Correctness." LPAR, 2010.
18. Mitchell, J. "Vibe Coding Needs Vibe Reasoning." arXiv:2511.00202, 2025.

### Foundational Theory
19. Altman, E. "Constrained Markov Decision Processes." Chapman & Hall/CRC, 1999.
20. Yannakakis, M. "Hierarchical State Machines." Bell Laboratories.

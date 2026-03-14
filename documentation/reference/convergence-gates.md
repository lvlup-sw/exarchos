# Convergence Gates

Convergence gates check five quality dimensions at phase boundaries. Some gates are blocking (must pass to proceed), others are informational (reported but do not block).

Gate results are recorded as `gate.executed` events in the audit trail, enabling trend analysis and regression detection.

## Dimensions

### D1: Specification Fidelity and TDD Compliance

Verifies that design requirements are traced to implementation and tests, and that TDD protocol was followed (test before code).

| Gate Action | Blocking | Description |
|-------------|----------|-------------|
| `check_provenance_chain` | Yes | Trace design requirement IDs (DR-N) from design doc to plan tasks |
| `check_tdd_compliance` | Yes | Verify test-before-code commit ordering per task |
| `check_security_scan` | No | Security pattern scan on diff |
| `check_design_completeness` | No | Verify design document has required sections |
| `check_plan_coverage` | Yes | Verify plan tasks cover all design sections |

### D2: Architectural Pattern Compliance

Checks for lint violations, typecheck errors, and structural invariants.

| Gate Action | Blocking | Description |
|-------------|----------|-------------|
| `check_static_analysis` | Yes | Run lint and typecheck against the codebase |

### D3: Context Economy and Token Efficiency

Checks code complexity that would impact LLM context consumption in future sessions (large functions, deep nesting, excessive parameters).

| Gate Action | Blocking | Description |
|-------------|----------|-------------|
| `check_context_economy` | No | Analyze complexity metrics on changed files |

### D4: Operational Resilience

Checks for patterns that degrade runtime reliability: empty catch blocks, swallowed errors, console.log left in production code.

| Gate Action | Blocking | Description |
|-------------|----------|-------------|
| `check_operational_resilience` | No | Scan for operational anti-patterns |
| `check_post_merge` | No | Post-merge regression check |

### D5: Workflow Determinism and Variance Reduction

Checks for non-deterministic patterns: `.only`/`.skip` in tests, non-deterministic time/random usage, debug artifacts left behind.

| Gate Action | Blocking | Description |
|-------------|----------|-------------|
| `check_workflow_determinism` | No | Scan for non-deterministic patterns in tests and code |
| `check_task_decomposition` | No | Evaluate task decomposition quality |

## Gate execution by phase boundary

Different boundaries run different subsets of gates at varying depth:

| Boundary | Gates Run | Depth |
|----------|-----------|-------|
| ideate to plan | Design completeness (D1) | Lightweight |
| plan to plan-review | Plan coverage + task decomposition (D1, D5) | Medium |
| Per-task completion | TDD compliance + patterns (D1, D2) | Medium |
| delegate to review | Spec fidelity + resilience (D1, D4) | Medium |
| review to synthesize | All 5 dimensions (D1-D5) | Full audit |
| synthesize to cleanup | Post-merge regression (D4) | Lightweight |

The full audit at the review-to-synthesize boundary runs all gate actions across all five dimensions. This is the primary convergence checkpoint before a PR is created.

## Verdicts

The `check_review_verdict` action computes a verdict from finding counts and dimension results:

APPROVED -- All blocking gates pass. Informational findings are acceptable. Workflow proceeds to synthesize.

NEEDS_FIXES -- Blocking gate failures or too many findings. Triggers `/exarchos:delegate --fixes` to address the issues. The fix-review cycle can repeat, with a circuit breaker to prevent infinite loops.

BLOCKED -- Critical failures or architectural dead ends requiring human intervention. Escalates to you for unblock direction.

### Verdict inputs

The verdict is computed from:

```typescript
exarchos_orchestrate({
  action: "check_review_verdict",
  featureId: "my-feature",
  high: 0,      // Critical finding count
  medium: 2,    // Warning count
  low: 5,       // Suggestion count
  dimensionResults: {
    "D1": { passed: true, findingCount: 0 },
    "D2": { passed: true, findingCount: 0 },
    "D3": { passed: false, findingCount: 3 },
    "D4": { passed: true, findingCount: 1 },
    "D5": { passed: false, findingCount: 3 }
  }
})
```

## Convergence status

Query the current convergence status across all dimensions:

```typescript
exarchos_orchestrate({ action: "check_convergence", featureId: "my-feature" })
```

This returns overall pass/fail and per-dimension summaries from `gate.executed` events. The `exarchos_view` convergence action provides a materialized view of the same data.

## Plugin-contributed dimensions

When [companion plugins](/guide/companion-plugins) are installed, they add quality dimensions to the convergence view.

### axiom (backend quality)

| Dimension | What it checks |
|-----------|---------------|
| DIM-1 Topology | Module boundaries, dependency direction, coupling |
| DIM-2 Observability | Logging, metrics, tracing coverage |
| DIM-3 Contracts | API schemas, type safety at boundaries |
| DIM-4 Test Fidelity | Test isolation, assertion quality, coverage gaps |
| DIM-5 Hygiene | Dead code, TODOs, lint suppressions, formatting |
| DIM-6 Architecture | Pattern consistency, layer violations |
| DIM-7 Resilience | Error handling, retry logic, timeout coverage |

### impeccable (design quality)

| Dimension | What it checks |
|-----------|---------------|
| UI consistency | Component reuse, spacing systems, visual rhythm |
| Accessibility | ARIA, keyboard navigation, color contrast |
| Design system compliance | Token usage, component variants |
| Responsive design | Breakpoints, layout shifts, touch targets |

Plugin dimensions are strictly informational. They appear in the convergence view and provide findings for the audit trail, but they do not add new blocking gates. The blocking verdict is computed from native dimensions (D1-D5) only.

Whether a plugin dimension runs depends on two things: the plugin must be installed (`claude plugin add lvlup-sw/axiom`), and it must not be disabled in `.exarchos.yml`. Both conditions are true by default when the plugin is present.

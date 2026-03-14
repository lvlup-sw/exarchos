---
name: feature-audit
description: "Full-arc feature audit evaluating five convergence dimensions (spec fidelity, pattern compliance, context economy, operational resilience, workflow determinism). Use when the user says 'audit feature', 'feature audit', 'convergence check', or runs /review with --audit flag. Runs after delegation completes, before synthesis. Do NOT use for stage-1 spec review or stage-2 quality review — use spec-review and quality-review instead."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: review
---

# Feature Audit Skill

> **DEPRECATION NOTICE:** This monolithic skill is being replaced by the composable [assay plugin](https://github.com/lvlup-sw/assay) for general backend quality (DIM-1 through DIM-7) + a thin exarchos integration layer for domain-specific checks (D1, D2-domain, D3, D5). See `skills/quality-review/references/assay-integration.md` for the migration plan. Assay is now a standalone plugin — install via `claude plugin add lvlup-sw/assay`.

## Overview

Evaluate a completed feature against five independent **convergence dimensions** synthesized from event-sourcing best practices, agentic workflow theory, Anthropic skill-building standards, and operational excellence principles.

A workflow reaches terminal state (APPROVED) only when all five dimensions independently converge — a pass in one dimension cannot compensate for a failure in another.

> **MANDATORY:** Before accepting any rationalization for rubber-stamping, consult `references/rationalization-refutation.md` in the quality-review skill. Every common excuse is catalogued with a counter-argument and the correct action.

## Triggers

Activate this skill when:
- Feature has completed the pipeline (`/ideate` -> `/plan` -> `/delegate` -> `/review`)
- User requests a full convergence audit
- Review phase needs comprehensive D1-D5 evaluation
- Before advancing to `/synthesize`

## Execution Context

This skill runs as a SUBAGENT spawned by the orchestrator during the review phase.

The orchestrator provides:
- State file path (for artifact resolution)
- Diff output from `exarchos_orchestrate({ action: "review_diff" })`
- Feature ID for workflow state queries

The subagent:
- Reads state file for design doc, implementation plan, and artifact paths
- Uses diff output instead of reading full files
- Runs deterministic checks and qualitative assessment
- Returns structured verdict

## Inputs Required

- Feature branch diff (`git diff main...HEAD`)
- Design document path (from `/ideate` phase, in workflow state)
- Implementation plan path (from `/plan` phase, in workflow state)
- Workflow state (`exarchos_workflow get --featureId <id>`)
- Test results (`npm run test:run`, coverage report)

## Audit Process

### Step 0: Pre-Flight — Query Convergence View

Before running manual checks, query the convergence view for pre-populated gate results:

```typescript
exarchos_view({ action: "convergence", workflowId: "<featureId>" })
```

Use the response to:
1. **Skip redundant checks** — If a dimension has `converged: true` with recent gate results, focus on qualitative assessment rather than re-running deterministic checks.
2. **Prioritize gaps** — `uncheckedDimensions` identifies dimensions with no gate coverage. Focus manual effort there.
3. **Cross-reference** — Compare gate results with qualitative assessment. Divergence indicates gaps in gate coverage.

If the convergence view is unavailable or empty (cold pipeline), fall through to the full check suite.

### Step 1: Run Deterministic Checks

Execute the deterministic check suite. See `references/deterministic-checks.md` for the full command list and pass criteria.

Run via orchestrate actions where available:

```typescript
// D1: TDD + Tests + Types
exarchos_orchestrate({ action: "check_tdd_compliance", featureId, taskId, branch })
// npm run test:run
// npm run typecheck

// D2: Static analysis + Security
exarchos_orchestrate({ action: "check_static_analysis", featureId, repoRoot })
exarchos_orchestrate({ action: "check_security_scan", featureId, repoRoot, baseBranch: "main" })

// D3-D5: Extended quality gates
exarchos_orchestrate({ action: "check_context_economy", featureId, repoRoot, baseBranch: "main" })
exarchos_orchestrate({ action: "check_operational_resilience", featureId, repoRoot, baseBranch: "main" })
exarchos_orchestrate({ action: "check_workflow_determinism", featureId, repoRoot, baseBranch: "main" })
```

### Step 2: Qualitative Assessment per Dimension

Evaluate each dimension against its criteria. See `references/convergence-dimensions.md` for the full rubrics, invariants, and eval methods per dimension:

- **D1: Spec Fidelity & TDD** — Requirement traceability matrix, spec deviation, edge case coverage
- **D2: Pattern Compliance** — Event sourcing, CQRS, HSM, Saga, adversarial gate invariants, platform agnosticity (MCP self-containment)
- **D3: Context Economy** — Tool response sizes, event payloads, SKILL.md word counts, progressive disclosure. For skills created/modified by the feature, also evaluate against `references/skill-quality-standards.md` (Anthropic best practices)
- **D4: Operational Resilience** — I/O efficiency, cache bounds, concurrency, error messages
- **D5: Workflow Determinism** — Discriminative selection, structured outputs, validation scripts, gate coverage. For skills created/modified by the feature, also evaluate trigger quality and workflow patterns against `references/skill-quality-standards.md`

**Adversarial posture:** Do NOT trust passing tests as proof of completeness. Passing tests prove what they test — nothing about untested requirements. This posture generalizes: do NOT trust passing phase artifacts as proof of sufficiency.

### Step 3: Compute Verdict

Query convergence and determine verdict via orchestrate. See `references/scoring-model.md` for severity tiers, verdict classification, and quantitative summary computation.

```typescript
exarchos_orchestrate({
  action: "check_convergence",
  featureId: "<id>"
})

exarchos_orchestrate({
  action: "check_review_verdict",
  featureId: "<id>",
  high: <N>,
  medium: <N>,
  low: <N>,
  dimensionResults: {
    "D1": { passed: true, findingCount: 0 },
    "D2": { passed: true, findingCount: 0 },
    "D3": { passed: true, findingCount: 0 },
    "D4": { passed: true, findingCount: 0 },
    "D5": { passed: true, findingCount: 0 }
  }
})
```

### Step 4: Generate Report

Use the template from `references/report-template.md` to structure the audit output. Include:
- Per-dimension pass rates and finding density
- Traceability matrix (D1)
- All findings with dimension, criterion, severity, evidence, and required fix

## Required Output Format

The subagent MUST return results as structured JSON:

```json
{
  "verdict": "APPROVED | NEEDS_FIXES | BLOCKED",
  "summary": "1-2 sentence summary",
  "dimensions": {
    "D1": { "passed": true, "checks": 5, "passed_count": 5, "findings": [] },
    "D2": { "passed": true, "checks": 7, "passed_count": 7, "findings": [] },
    "D3": { "passed": true, "checks": 5, "passed_count": 5, "findings": [] },
    "D4": { "passed": true, "checks": 7, "passed_count": 7, "findings": [] },
    "D5": { "passed": true, "checks": 5, "passed_count": 5, "findings": [] }
  },
  "findings": [
    {
      "dimension": "D1",
      "severity": "HIGH | MEDIUM | LOW",
      "criterion": "Specific invariant or eval",
      "evidence": "file:line, command output, or observation",
      "required_fix": "What must change"
    }
  ],
  "quantitative": {
    "pass_rate": 0.95,
    "finding_density": 0.3,
    "severity_distribution": { "HIGH": 0, "MEDIUM": 2, "LOW": 1 }
  }
}
```

## Auto-Transition

- **APPROVED** -> set phase `synthesize`, invoke `/exarchos:synthesize`
- **NEEDS_FIXES** -> invoke `/exarchos:delegate --fixes`
- **BLOCKED** -> set phase `blocked`, invoke `/exarchos:ideate --redesign`

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Trust passing tests as proof of completeness | Check test *meaning*, not test *count* |
| Let a high D1 score compensate for D2 failure | Each dimension must independently converge |
| Skip qualitative assessment when gates pass | Cross-reference gate results with manual review |
| Run full deterministic suite when convergence view shows recent passes | Focus on gaps and unchecked dimensions |
| Embed audit criteria inline | Reference `references/convergence-dimensions.md` |

## Sources

This audit synthesizes:
1. **Exarchos Optimization Principles** — `docs/prompts/optimize.md`
2. **Anthropic Skill-Building Best Practices** — `docs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf`
3. **Microsoft Learn Event Sourcing & CQRS** — canonical pattern definitions
4. **Agentic Workflow Theory ADR** — `docs/adrs/agentic-workflow-theory.md`
5. **Adversarial Convergence Theory ADR** — `docs/adrs/adversarial-convergence-theory.md`

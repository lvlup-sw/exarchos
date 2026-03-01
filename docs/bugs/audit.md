```bash
  2. Implementation status across the pipeline

  Here's the honest assessment. The theory is well-formalized but implementation is partial and inconsistent across phases:

  ┌─────────────────────┬──────────────────────────────┬───────────────────────────────────────────┬─────────────────────┬─────────────────────────────────┐
  │     Phase Gate      │       $C_{adv}$ Check        │              Event Emission               │   Readiness View    │           Provenance            │
  ├─────────────────────┼──────────────────────────────┼───────────────────────────────────────────┼─────────────────────┼─────────────────────────────────┤
  │ ideate → plan       │ Script exists (just added)   │ Prose instructions only                   │ None needed         │ DR-N extraction only            │
  ├─────────────────────┼──────────────────────────────┼───────────────────────────────────────────┼─────────────────────┼─────────────────────────────────┤
  │ plan → plan-review  │ verify-plan-coverage.sh +    │ gate.executed via check_plan_coverage +   │ None                │ Implements: DR-N via provenance  │
  │                     │ check-task-decomposition.sh  │ check_task_decomposition (D5)             │                     │ chain verification               │
  ├─────────────────────┼──────────────────────────────┼───────────────────────────────────────────┼─────────────────────┼─────────────────────────────────┤
  │ per-task completion │ handleTaskComplete gate guard│ gate.executed via check_tdd_compliance +  │ None                │ task.completed carries provenance│
  │                     │ (D1 + D2 enforcement)       │ check_static_analysis (D2)               │                     │                                 │
  ├─────────────────────┼──────────────────────────────┼───────────────────────────────────────────┼─────────────────────┼─────────────────────────────────┤
  │ review → synthesize │ Feature audit (prompt)       │ gate.executed via quality-review          │ None                │ No provenance view query        │
  ├─────────────────────┼──────────────────────────────┼───────────────────────────────────────────┼─────────────────────┼─────────────────────────────────┤
  │ synthesize → merge  │ prepare_synthesis action     │ gate.executed for tests/typecheck         │ synthesis-readiness │ None                            │
  ├─────────────────────┼──────────────────────────────┼───────────────────────────────────────────┼─────────────────────┼─────────────────────────────────┤
  │ PR shepherding      │ assess_stack action          │ gate.executed + ci.status + remediation.* │ shepherd-status     │ None                            │
  ├─────────────────────┼──────────────────────────────┼───────────────────────────────────────────┼─────────────────────┼─────────────────────────────────┤
  │ post-merge          │ Nothing                      │ Nothing                                   │ None                │ None                            │
  └─────────────────────┴──────────────────────────────┴───────────────────────────────────────────┴─────────────────────┴─────────────────────────────────┘

  Three integration tiers exist in the codebase right now:

  1. Mature (full flywheel): per-task completion, plan→plan-review, synthesize, shepherd — orchestrate actions emit gate.executed events, CQRS projections materialize readiness, skills query views. Per-task gate enforcement is automated middleware (handleTaskComplete verifies gate.executed event presence). Plan boundary now checks D1 (plan coverage) + D5 (task decomposition). Telemetry hints feed into quality pipeline via prepare-delegation.
  2. Partial (pre-930): review — scripts validate, findings presented, but manual interpretation by the skill. Quality hints available but review skill doesn't consume telemetry state directly.
  3. Nascent: ideate — script exists, skill has prose instructions to emit events, but no orchestrate action, no view, no actual event store integration.

  Critical gaps from the ADR — status after refactor/gate-telemetry-consolidation:

  - Provenance chain ($L'$) — RESOLVED. handleTaskComplete now forwards `implements`, `tests`, `files` from task results into `task.completed` events. ProvenanceView exists. Delegation skill wires provenance extraction from subagent reports to task_complete calls. Implementation-planning skill now blocks (not advisory) on provenance chain verification.
  - Per-task gate checks — RESOLVED. handleTaskComplete enforces D1 (tdd-compliance) and D2 (static-analysis) gate checks before task completion — queries event store for `gate.executed` events with matching `gateName`, `taskId`, and `passed: true` for both dimensions. No bypass path exists. Delegation skill invokes `check_tdd_compliance` and `check_static_analysis` orchestrate actions which auto-emit gate events; handleTaskComplete independently verifies event presence via `hasPassingGate` helper. All 7 orchestrate handlers use `execFileSync` (argument arrays) to prevent command injection.
  - Post-merge gate — RESOLVED. check-post-merge.sh exists with orchestrate action handler emitting gate.executed events.
  - Convergence framing — RESOLVED. All 15 gate handlers emit phase metadata in details. ConvergenceView stores phase on gate results. check_convergence supports phase filtering for graduated depth (ADR §3.3). Telemetry middleware emits D3 gate events on token threshold breach. context-economy queries runtime metrics via telemetry-queries abstraction (layer violation fixed). D5 dimension now covered at plan boundary via check_task_decomposition handler.
  - Telemetry hint activation — RESOLVED. Quality hints pipeline (`generateQualityHints`) accepts optional `telemetryState` parameter, converts telemetry `Hint[]` to `QualityHint[]` with category `'telemetry'`. prepare-delegation handler wires telemetry state into quality hint generation. Telemetry and quality systems now feed into each other.
  - Readiness deduplication — RESOLVED. prepare-delegation handler materializes DelegationReadinessView directly instead of inline `assessReadiness()` computation. Single source of truth for readiness checks.
  - Telemetry layer violation — RESOLVED. context-economy.ts no longer imports directly from telemetry projection. Uses `queryRuntimeMetrics()` from `telemetry/telemetry-queries.ts` abstraction layer.

  3. The pattern that should be codified

  The gap reveals that we need a canonical gate integration pattern. Right now each skill invents its own approach. The principle should be:

  Gate checks produce events, not console output. The bash script is the check logic. The orchestrate action is the integration layer that runs the script, parses results, emits gate.executed into the event store, and returns
   structured findings. Skills never parse stderr.

  This means the design doc's ideate gate implementation should be:

  Skill calls: exarchos_orchestrate({ action: "check_design_gate", featureId, designPath })
    ↓
  Orchestrate handler:
    1. Runs check-design-completeness.sh
    2. Parses exit code + stderr findings
    3. Emits gate.executed { gateName: "design-completeness", layer: "design", passed: bool, details: { findings, requirementCount } }
    4. Returns { passed: bool, findings: [...], advisory: true }
    ↓
  Skill receives structured response, presents findings, auto-chains to /plan
```


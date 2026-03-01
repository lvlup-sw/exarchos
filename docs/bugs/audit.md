```bash
  2. Implementation status across the pipeline

  Here's the honest assessment. The theory is well-formalized but implementation is partial and inconsistent across phases:

  ┌─────────────────────┬──────────────────────────────┬───────────────────────────────────────────┬─────────────────────┬─────────────────────────────────┐
  │     Phase Gate      │       $C_{adv}$ Check        │              Event Emission               │   Readiness View    │           Provenance            │
  ├─────────────────────┼──────────────────────────────┼───────────────────────────────────────────┼─────────────────────┼─────────────────────────────────┤
  │ ideate → plan       │ Script exists (just added)   │ Prose instructions only                   │ None needed         │ DR-N extraction only            │
  ├─────────────────────┼──────────────────────────────┼───────────────────────────────────────────┼─────────────────────┼─────────────────────────────────┤
  │ plan → plan-review  │ verify-plan-coverage.sh      │ None                                      │ None                │ No Implements: DR-N enforcement │
  ├─────────────────────┼──────────────────────────────┼───────────────────────────────────────────┼─────────────────────┼─────────────────────────────────┤
  │ per-task completion │ Scripts exist but not called │ None                                      │ None                │ No task.provenance events       │
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

  1. Mature (PR 930 pattern): synthesize + shepherd — orchestrate actions emit events, CQRS projections materialize readiness, skills query views. Full flywheel.
  2. Partial (pre-930): plan + review — scripts validate, findings presented, but no event emission or readiness projections. Manual interpretation by the skill.
  3. Nascent (what I just built): ideate — script exists, skill has prose instructions to emit events, but no orchestrate action, no view, no actual event store integration.

  Critical gaps from the ADR — status after refactor/provenance-convergence-wiring:

  - Provenance chain ($L'$) — RESOLVED. handleTaskComplete now forwards `implements`, `tests`, `files` from task results into `task.completed` events. ProvenanceView exists. Delegation skill wires provenance extraction from subagent reports to task_complete calls. Implementation-planning skill now blocks (not advisory) on provenance chain verification.
  - Per-task gate checks — PARTIALLY RESOLVED. Delegation skill documents MANDATORY TDD compliance gates before task completion. Per-task gate invocation is skill-level enforcement (prose), not automated middleware.
  - Post-merge gate — RESOLVED. check-post-merge.sh exists with orchestrate action handler emitting gate.executed events.
  - Convergence framing — RESOLVED. All 14 gate handlers emit phase metadata in details. ConvergenceView stores phase on gate results. check_convergence supports phase filtering for graduated depth (ADR §3.3). Telemetry middleware emits D3 gate events on token threshold breach. context-economy queries telemetry projection for runtime metrics.

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


# Auto-Transition & Integration

## Transition

All transitions happen **immediately** without user confirmation:

### If APPROVED:
1. Update state: `action: "set", featureId: "<id>", phase: "synthesize"`
2. Output: "Quality review passed. Auto-continuing to synthesis..."
3. Auto-invoke synthesize:
   ```typescript
   Skill({ skill: "exarchos:synthesize", args: "<feature-name>" })
   ```

### If NEEDS_FIXES:
1. Update state: `action: "set", featureId: "<id>", updates: { "reviews": { "quality": { "status": "fail", "issues": [...] } } }`
2. Output: "Quality review found [N] HIGH-priority issues. Auto-continuing to fixes..."
3. Auto-invoke delegate with fix tasks:
   ```typescript
   Skill({ skill: "exarchos:delegate", args: "--fixes <plan-path>" })
   ```

### If BLOCKED:
1. Update state: `action: "set", featureId: "<id>", phase: "blocked"`
2. Output: "Quality review blocked: [issue]. Returning to design..."
3. Auto-invoke ideate for redesign:
   ```typescript
   Skill({ skill: "exarchos:ideate", args: "--redesign <feature-name>" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.

## Exarchos Integration

Gate events are automatically emitted by the orchestrate handlers — do NOT manually emit `gate.executed` events via `exarchos_event`.

1. **Read CI status** via `gh pr checks <number>` (or GitHub MCP `pull_request_read` with method `get_status` if available)
2. **Gate events** — emitted automatically by `check_static_analysis`, `check_security_scan`, `check_context_economy`, `check_operational_resilience`, `check_workflow_determinism`, and `check_review_verdict` handlers
3. **Read unified status** via `exarchos_view` with `action: "tasks"`, `fields: ["taskId", "status", "title"]`, `limit: 20`
4. **Query convergence** via `exarchos_view` with `action: "convergence"`, `workflowId: "<featureId>"` for per-dimension gate results
5. **When all per-PR gates pass**, apply `stack-ready` label to the PR

## Performance Notes

- Complete each step fully before advancing — quality over speed
- Do not skip validation checks even when the change appears trivial
- Read each checklist file completely before scoring. Do not skip security or SOLID checks even for small changes.

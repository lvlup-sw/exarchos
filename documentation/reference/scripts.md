# Validation Scripts

Validation scripts are deterministic bash checks that replace prose checklists. Instead of asking "did you check for lint errors?", Exarchos runs a script that checks and returns a machine-readable result.

## Conventions

All scripts follow the same pattern:

```bash
#!/usr/bin/env bash
set -euo pipefail

# ... check logic ...

exit 0  # pass
exit 1  # fail
exit 2  # skip (precondition not met)
```

- Exit 0: Check passed
- Exit 1: Check failed
- Exit 2: Check skipped (missing prerequisites, not applicable)

## Co-located tests

Each script has a `.test.sh` file alongside it:

```text
scripts/
  check-tdd-compliance.sh
  check-tdd-compliance.test.sh
  check-context-economy.sh
  check-context-economy.test.sh
```

## Resolution order

Scripts resolve from two locations, checked in order:

1. `EXARCHOS_PLUGIN_ROOT/scripts/` -- plugin install (primary)
2. `~/.claude/scripts/` -- companion installer (fallback)

## Invocation

Skills invoke scripts through the MCP server, not via direct bash paths:

```typescript
exarchos_orchestrate({ action: "run_script", script: "check-tdd-compliance", args: ["--branch", "feature/my-task"] })
```

The `run_script` action resolves the script path, executes it, and returns structured output with the exit code and stdout/stderr.

## Script catalog

Key scripts used by convergence gates:

| Script | Gate | Purpose |
|--------|------|---------|
| `check-tdd-compliance.sh` | D1 | Verify test-before-code commit ordering |
| `verify-provenance-chain.sh` | D1 | Trace design requirements to implementation |
| `check-design-completeness.sh` | D1 | Verify design document sections |
| `verify-plan-coverage.sh` | D1 | Check plan tasks cover design sections |
| `static-analysis-gate.sh` | D2 | Lint and typecheck |
| `check-context-economy.sh` | D3 | Code complexity impact on context |
| `check-operational-resilience.sh` | D4 | Empty catches, swallowed errors |
| `check-post-merge.sh` | D4 | Post-merge regression check |
| `check-workflow-determinism.sh` | D5 | `.only`/`.skip`, non-deterministic code |
| `check-task-decomposition.sh` | D5 | Task decomposition quality |
| `security-scan.sh` | D1 | Security pattern scan on diff |

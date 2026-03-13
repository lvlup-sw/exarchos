# Deterministic Check Suite

Run these in sequence. Each produces exit code 0 (pass) or non-zero (fail).

## D1: Spec Fidelity

```bash
# TDD commit order
scripts/check-tdd-compliance.sh --repo-root . --base-branch main

# Test suite green
npm run test:run

# Type safety
npm run typecheck

# Static analysis
scripts/static-analysis-gate.sh

# Security scan
scripts/security-scan.sh
```

## D2: Pattern Compliance (grep-assisted)

```bash
# Append-only: no event mutation
grep -rn 'splice\|\.pop()\|\.shift()\|delete.*events\[' --include='*.ts' src/

# CQRS: no raw event scanning in read paths
grep -rn 'readEvents\|scanEvents\|events\.filter' --include='*.ts' src/handlers/

# Guard purity: no I/O in guard functions
grep -rn 'guard.*async\|guard.*await\|guard.*fs\.\|guard.*fetch' --include='*.ts' src/
```

## D2b: Platform Agnosticity

```bash
# Registration completeness: all composite handler cases have registry schemas
# Compare handler case labels vs registered action names
grep -oP "case ['\"](\w+)['\"]" servers/exarchos-mcp/src/*/composite.ts | \
  sed "s/.*case ['\"]//;s/['\"].*//" | sort > /tmp/handler-actions.txt
# Check each is in registry (manual cross-reference)

# Schema discoverability: describe(actions: ["set"]) returns stateSchema
# Run via test or manual MCP call

# Playbook self-sufficiency: compactGuidance mentions prerequisite gates
grep -c 'check_tdd_compliance\|check_static_analysis' \
  servers/exarchos-mcp/src/workflow/playbooks.ts
```

## D3: Token Economy

```bash
# Skill word counts (flag >1,600)
wc -w skills/*/SKILL.md | sort -n

# Large response builders
find src/ -name '*.ts' -exec grep -l 'ToolResult\|toolResponse' {} \; | \
  xargs -I{} wc -c {}
```

## D4: Operational

```bash
# Unbounded caches
grep -rn 'new Map()\|new Set()\|cache\s*=' --include='*.ts' src/ | \
  grep -v 'maxSize\|evict\|LRU\|bounded'
```

## D5: Verdict

```bash
# If available
scripts/review-verdict.sh
```

## Orchestrate Equivalents

Where orchestrate actions exist, prefer them over direct script invocation:

| Check | Orchestrate Action | Dimension |
|-------|--------------------|-----------|
| Static analysis | `check_static_analysis` | D2 |
| Security scan | `check_security_scan` | D1 |
| TDD compliance | `check_tdd_compliance` | D1 |
| Context economy | `check_context_economy` | D3 |
| Operational resilience | `check_operational_resilience` | D4 |
| Workflow determinism | `check_workflow_determinism` | D5 |
| Convergence status | `check_convergence` | All |
| Review verdict | `check_review_verdict` | All |

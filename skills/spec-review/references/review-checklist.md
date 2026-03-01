---
name: spec-review-checklist
description: "Validation script invocations and report template for spec compliance verification."
---

# Spec Review Checklist

## Adversarial Review Posture

You are an ADVERSARIAL reviewer. Your job is to find what's wrong, not confirm what's right.

- Do NOT trust the implementer's self-assessment of completeness
- Do NOT assume passing tests mean the spec is satisfied
- Do NOT accept "it works" as evidence of correctness
- Independently verify each spec requirement against the actual code
- Treat every claim as unverified until you see the evidence yourself

Consult `references/rationalization-refutation.md` when you feel tempted to accept a rationalization for skipping verification.

## Automated Verification

Run these scripts as the authoritative checks:

```bash
# TDD compliance (test-first ordering, naming conventions, coverage)
scripts/check-tdd-compliance.sh --repo-root <repo-root> --base-branch main

# Full test suite
npm run test:run

# Coverage thresholds (line >80%, branch >70%, function 100% for public APIs)
npm run test:coverage

# Type safety
npm run typecheck
```

## Manual Checks

After scripts pass, verify:
- All spec requirements implemented (compare to design/plan)
- No over-engineering beyond spec
- No missing edge cases

## Report Template

```markdown
## Spec Review Report

### Summary
- Status: [PASS | FAIL | NEEDS_FIXES]
- Tested: [timestamp]

### Compliance Matrix
| Requirement | Implemented | Test Exists | Notes |
|-------------|-------------|-------------|-------|

### Issues Found
1. [Issue] — File: `path` — Fix: [required change]

### Verdict
[PASS] Ready for quality review
[FAIL] Return to implementer with fix list
```

## Completion Criteria

- [ ] `check-tdd-compliance.sh` passes
- [ ] All tests pass
- [ ] Coverage meets thresholds
- [ ] All spec requirements verified
- [ ] State file updated with review results

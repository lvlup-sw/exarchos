---
description: Run two-stage review (spec compliance + code quality)
---

# Review

Review implementation for: "$ARGUMENTS"

## Skill References

- Spec review: `@skills/spec-review/SKILL.md`
- Quality review: `@skills/quality-review/SKILL.md`

## Two-Stage Process

### Stage 1: Spec Review

**Focus:** Functional completeness, TDD compliance, specification alignment

**Checklist:**
- [ ] All requirements implemented
- [ ] Tests exist for all features
- [ ] Tests written before implementation
- [ ] Coverage >80% for new code
- [ ] Matches design specification

**Verification:**
```bash
npm run test:run
npm run test:coverage
```

**Verdict:**
- PASS → Proceed to quality review
- FAIL → Return to implementer with fix list

### Stage 2: Quality Review

**Prerequisite:** Spec review must PASS

**Focus:** Code quality, SOLID principles, error handling, security

**Priority Levels:**
- HIGH: Must fix before merge
- MEDIUM: Should fix, may defer
- LOW: Nice to have

**Checklist:**
- [ ] Clear naming and structure
- [ ] SOLID principles applied
- [ ] Proper error handling
- [ ] No security issues
- [ ] Good test quality

**Verdict:**
- APPROVED → Ready for synthesis
- NEEDS_FIXES → Return for quality fixes
- BLOCKED → Requires design discussion

## Fix Loop

For failures, create specific fix task:
```typescript
Task({
  model: "opus",
  description: "Fix review issues",
  prompt: "[Specific issues and required fixes]"
})
```

Re-review after fixes.

## Output

When both stages pass:
> "Review complete. All tasks ready for `/synthesize`."

When issues found:
> "[Stage] found [N] issues. Returning for fixes."

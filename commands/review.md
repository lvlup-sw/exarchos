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

Track the feature name and plan path as `$FEATURE_NAME` and `$PLAN_PATH`.

## Auto-Chain

### On PASS (both spec and quality stages):

1. Summarize: "Spec review: PASS. Quality review: APPROVED."
2. Ask: "Continue to synthesis with `/synthesize`? (yes/no)"
3. On user confirmation (yes, y, continue, proceed):
   ```typescript
   Skill({ skill: "synthesize", args: "$FEATURE_NAME" })
   ```
4. On decline: "No problem. Run `/synthesize $FEATURE_NAME` when ready."

### On FAIL (spec or quality issues):

Do NOT offer synthesis. Instead:

1. Summarize: "[Stage] found [N] issues."
2. Auto-invoke delegate with fix context:
   ```typescript
   Skill({ skill: "delegate", args: "--fixes $PLAN_PATH" })
   ```

### On BLOCKED (critical design issues):

Do NOT offer synthesis. Instead:

1. Summarize: "Quality review BLOCKED: [critical issue]. Returning to design discussion."
2. Auto-invoke ideate for redesign:
   ```typescript
   Skill({ skill: "ideate", args: "--redesign $FEATURE_NAME" })
   ```

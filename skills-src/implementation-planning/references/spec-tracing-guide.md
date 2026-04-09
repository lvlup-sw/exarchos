# Spec Tracing Guide

## Traceability Matrix

Create a traceability table mapping design sections to planned tasks. This ensures complete coverage.

```markdown
## Spec Traceability

### Scope Declaration

**Target:** [Full design | Partial: <specific components>]
**Excluded:** [List any intentionally excluded sections with rationale]

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Technical Design > Component A | - Requirement 1<br>- Requirement 2 | 001, 002 | Covered |
| Technical Design > Component B | - Requirement 3 | 003 | Covered |
| Integration Points > X | - Connection to Y | 004 | Covered |
| Testing Strategy | - Unit tests<br>- Integration tests | 005, 006 | Covered |
| Open Questions > Q1 | Decision needed | — | Deferred: [reason] |
```

### Rules

- Every sub-section of Technical Design MUST map to at least one task
- Every file in "Files Changed" table MUST be touched by at least one task
- Open Questions MUST be resolved OR explicitly deferred with rationale
- For partial plans, declare scope upfront and only trace in-scope sections

## Plan Verification

Before saving, verify completeness against the design document.

### Coverage Checklist

- [ ] Every sub-section of "Technical Design" has at least one task
- [ ] All files in "Files Changed" table are touched by tasks
- [ ] Testing strategy items have corresponding test tasks
- [ ] Open questions are resolved OR explicitly deferred with rationale
- [ ] For partial plans: scope declaration is clear and justified

### Delta Analysis

Compare design sections against task list. For each gap:
1. Create a task to address it, OR
2. Add to "Deferred Items" with explicit rationale

If significant gaps remain that cannot be justified, **do not proceed** — return to design phase for clarification.

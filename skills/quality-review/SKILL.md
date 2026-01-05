# Quality Review Skill

## Overview

Stage 2 of two-stage review: Assess code quality, maintainability, and engineering best practices.

**Prerequisite:** Spec review must PASS before quality review.

## Triggers

Activate this skill when:
- Spec review has passed
- `/review` command (after spec review)
- Ready to assess code quality
- Before synthesis/merge

## Execution Context

This skill runs in a SUBAGENT spawned by the orchestrator, not inline.

The orchestrator provides:
- State file path (preferred) OR design/plan paths
- Diff output from `scripts/review-diff.sh` (context-efficient)
- Task ID being reviewed
- Spec review results (must be PASS)

The subagent:
- Reads state file to get artifact paths
- Uses diff output instead of reading full files
- Runs static analysis
- Performs code walkthrough
- Generates report
- Returns verdict to orchestrator

### Context-Efficient Input

Instead of full file contents, receive git diffs:

```bash
# Generate diff for review
scripts/review-diff.sh .worktrees/<task> main
```

This reduces context consumption by 80-90%.

## Review Scope

**Quality Review focuses on:**
- Code quality and readability
- SOLID principles
- Error handling
- Test quality
- Performance considerations
- Security basics

**Does NOT re-check:**
- Functional completeness (spec review)
- TDD compliance (spec review)

## Review Criteria

### 1. Code Quality

| Aspect | Check For |
|--------|-----------|
| Readability | Clear variable/function names |
| Complexity | Functions <30 lines, single responsibility |
| Duplication | DRY - no copy-paste code |
| Comments | Only where logic isn't self-evident |
| Formatting | Consistent with project style |

### 2. SOLID Principles

| Principle | Verify |
|-----------|--------|
| **S**ingle Responsibility | One reason to change per class/function |
| **O**pen/Closed | Extensible without modification |
| **L**iskov Substitution | Subtypes are substitutable |
| **I**nterface Segregation | No forced dependencies |
| **D**ependency Inversion | Depend on abstractions |

### 2.1 Control Flow Standards

| Standard | Check For |
|----------|-----------|
| Guard clauses | Validate at method entry, not nested |
| Early returns | Exit as soon as result is known |
| No arrow code | Deeply nested if/else is a smell |
| Conditional abstraction | Large switch/if-else extracted to helper |

#### Guard Clause Pattern

**Preferred:**
```
if (input == null) return;
// Main logic flat
```

**Avoid:**
```
if (input != null) {
  // Entire body nested
}
```

### 2.2 Structural Standards

| Standard | Check For |
|----------|-----------|
| One responsibility per file | Public types in dedicated files |
| Composition over inheritance | Inheritance depth > 2 is a smell |
| Sealed by default | Explicitly design for extension |

**Language-specific rules:** See `.claude/rules/coding-standards-{language}.md`

### 3. Error Handling

| Check | Verify |
|-------|--------|
| Errors caught | Try/catch where needed |
| Errors meaningful | Clear error messages |
| Errors propagated | Proper error bubbling |
| No silent failures | All errors handled or logged |
| Input validation | At system boundaries |

### 4. Test Quality

| Aspect | Verify |
|--------|--------|
| Arrange-Act-Assert | Clear test structure |
| Test isolation | No shared state issues |
| Meaningful assertions | Not just "expect(true)" |
| Edge cases | Boundary conditions tested |
| Error paths | Failure scenarios covered |

### 5. Performance

| Check | Verify |
|-------|--------|
| No N+1 queries | Batch operations used |
| Efficient algorithms | No obvious O(n²) when O(n) works |
| Memory management | No leaks, proper cleanup |
| Async patterns | Proper await usage |

### 6. Security Basics

| Check | Verify |
|-------|--------|
| Input sanitization | User input validated |
| No secrets in code | Use environment variables |
| SQL injection | Parameterized queries |
| XSS prevention | Output encoding |

## Priority Levels

| Priority | Action | Examples |
|----------|--------|----------|
| **HIGH** | Must fix before merge | Security issues, data loss risks |
| **MEDIUM** | Should fix, may defer | SOLID violations, complexity |
| **LOW** | Nice to have | Style preferences, minor refactors |

## Review Process

### Step 1: Static Analysis

```bash
# TypeScript
npm run lint
npm run typecheck

# If available
npm run quality-check
```

### Step 2: Code Walkthrough

Read each modified file and assess:
- Function/class structure
- Error handling patterns
- Test quality

### Step 3: Generate Report

```markdown
## Quality Review Report

### Summary
- Status: [APPROVED | NEEDS_FIXES | BLOCKED]
- Reviewed: [timestamp]
- Reviewer: Claude Code

### Findings

#### HIGH Priority
1. [Finding title]
   - File: `path/to/file.ts:42`
   - Issue: [Description]
   - Fix: [Required change]

#### MEDIUM Priority
1. [Finding title]
   - File: `path/to/file.ts:88`
   - Issue: [Description]
   - Suggestion: [Recommended change]

#### LOW Priority
1. [Finding title]
   - File: `path/to/file.ts:15`
   - Note: [Observation]

### Verdict
[APPROVED] Ready for synthesis
[NEEDS_FIXES] Fix HIGH priority items, then re-review
[BLOCKED] Critical issues require design discussion
```

## Fix Loop for HIGH Priority

If HIGH priority issues found:

1. Create fix task with specific issues
2. Dispatch to implementer
3. Re-review quality after fixes
4. Only mark APPROVED when HIGH items resolved

```typescript
// Return for quality fixes
Task({
  model: "opus",
  description: "Fix quality review issues",
  prompt: `
# Fix Required: Quality Review Issues

## HIGH Priority (Must Fix)
1. SQL Injection vulnerability
   - File: src/api/users.ts:42
   - Issue: Raw string interpolation in query
   - Fix: Use parameterized query

2. Unhandled promise rejection
   - File: src/services/email.ts:88
   - Issue: Missing await/catch
   - Fix: Add try/catch with error logging

## Success Criteria
- All HIGH priority items resolved
- Tests still pass
- No new issues introduced
`
})
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Block on LOW priority | Accept and track for later |
| Review before spec passes | Complete spec review first |
| Be overly pedantic | Focus on impactful issues |
| Skip security checks | Always verify basics |
| Accept poor test quality | Tests are code too |
| Apply generic standards to language issues | Reference language-specific rules |

## State Management

Update workflow state with review results.

### On Review Complete

```bash
# Update task review status
scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '(.tasks[] | select(.id == "<task-id>")).reviewStatus.qualityReview = "approved"'

# Or if needs fixes:
scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '(.tasks[] | select(.id == "<task-id>")).reviewStatus.qualityReview = "needs_fixes"'

# Add review details
scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.reviews["<task-id>"].qualityReview = {"status": "approved", "highPriority": [], "mediumPriority": []}'
```

### On All Reviews Pass

Update phase for synthesis:

```bash
scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json '.phase = "synthesize"'
```

## Completion Criteria

- [ ] Static analysis passes
- [ ] All HIGH priority issues fixed
- [ ] No security vulnerabilities
- [ ] Test quality acceptable
- [ ] Code is maintainable
- [ ] State file updated with review results

## Transition

All transitions happen **immediately** without user confirmation:

### If APPROVED:
1. Update state: `.phase = "synthesize"`
2. Output: "Quality review passed. Auto-continuing to synthesis..."
3. Auto-invoke synthesize:
   ```typescript
   Skill({ skill: "synthesize", args: "<feature-name>" })
   ```

### If NEEDS_FIXES:
1. Update state with failed issues
2. Output: "Quality review found [N] HIGH priority issues. Auto-continuing to fixes..."
3. Auto-invoke delegation with fix tasks:
   ```typescript
   Skill({ skill: "delegate", args: "--fixes <plan-path>" })
   ```

### If BLOCKED:
1. Update state: `.phase = "blocked"`
2. Output: "Quality review blocked: [issue]. Returning to design..."
3. Auto-invoke ideate for redesign:
   ```typescript
   Skill({ skill: "ideate", args: "--redesign <feature-name>" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.

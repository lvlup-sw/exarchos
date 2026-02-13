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
- Diff output from `~/.claude/scripts/review-diff.sh` (context-efficient)
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

Instead of reading full files, receive the stack diff:

```bash
# Generate diff for review (Graphite stack vs main)
gt diff main > /tmp/stack-diff.patch

# Alternative: use GitHub MCP to get PR diff
# mcp__plugin_github_github__pull_request_read({ owner, repo, pullNumber, method: "get_diff" })
```

This provides the complete picture of all changes across all tasks and reduces context consumption by 80-90%.

### Review Scope: Combined Changes

After delegation completes, quality review examines:
- The **complete stack diff** (all task branches vs main)
- All changes across all tasks in one view
- The full picture of combined code quality

This enables catching:
- Cross-task SOLID violations
- Duplicate code across task boundaries
- Inconsistent patterns between tasks

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

### 1.1 DRY Enforcement

| Pattern | Threshold | Priority |
|---------|-----------|----------|
| Identical code blocks | 3+ occurrences OR 5+ lines | HIGH (3+), MEDIUM (2) |
| Similar code (literals differ) | 3+ occurrences | MEDIUM |
| Repeated validation logic | 2+ locations | HIGH |
| Repeated business rules | 2+ locations | HIGH |
| Copy-pasted tests | 3+ similar tests | LOW |
| Magic literals | Same value 3+ times | MEDIUM |

**Detection approach (prefer MCP tools):**
- Use `mcp__plugin_serena_serena__search_for_pattern` to find duplicate code blocks
- Use `mcp__plugin_serena_serena__find_referencing_symbols` to trace dependency usage
- Use `mcp__plugin_serena_serena__get_symbols_overview` to understand module structure before deep-reading

**Detection checklist:**
- [ ] Search for identical multi-line blocks (5+ lines duplicated)
- [ ] Flag validation code outside designated validation layer
- [ ] Trace business rule conditionals - must have single source
- [ ] Check for repeated string/number literals without constants

### 2. SOLID Principles

| Principle | Verify | Specific Checks |
|-----------|--------|-----------------|
| **S**RP | One reason to change | Max 1 public type/file; class name matches responsibility |
| **O**CP | Extensible without modification | No switch/if-else on types; uses strategy/polymorphism |
| **L**SP | Subtypes substitutable | No `NotImplementedException`; no precondition strengthening |
| **I**SP | No forced dependencies | Interface <= 5 methods; no empty implementations |
| **D**IP | Depend on abstractions | No `new` for services; constructor injection only |

#### ISP Violation Patterns

| Pattern | Detection | Priority |
|---------|-----------|----------|
| Fat interface (> 5 methods) | Count methods on interface | MEDIUM |
| Mixed read/write interface | Check for getters + mutators together | MEDIUM |
| Empty/throw implementations | Scan for `NotImplementedException`, empty bodies | HIGH |
| Vague interface names | `IService`, `IManager`, `IHandler` without qualifier | LOW |
| Partial interface usage | Client uses < 50% of interface methods | MEDIUM |

**ISP Checklist:**
- [ ] No interface has more than 5 methods
- [ ] Interfaces are role-specific (IReadable, IWritable, not IDataAccess)
- [ ] No classes implement interfaces with NotImplementedException
- [ ] Interface names describe a single capability

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

| Standard | Check For | Priority |
|----------|-----------|----------|
| One responsibility per file | Public types in dedicated files | HIGH |
| Composition over inheritance | See checklist below | MEDIUM-HIGH |
| Sealed by default | `sealed` unless designed for extension | LOW |

#### Composition Over Inheritance Checklist

| Smell | Detection | Priority | Fix |
|-------|-----------|----------|-----|
| Inheritance depth > 2 | Count class hierarchy levels | MEDIUM | Refactor to delegation |
| Base class with multiple concerns | Base has unrelated methods | MEDIUM | Split into interfaces + composition |
| `protected` for code sharing | Many protected methods (> 2/class) | MEDIUM | Extract to utility or inject strategy |
| Override that only extends | `super.method()` + additions | MEDIUM | Use decorator pattern |
| Inherit for one method | Extends to reuse single method | HIGH | Compose with delegation |
| Missing `sealed` | Non-sealed without extension design | LOW | Add `sealed` (C#) |

**Composition Checklist:**
- [ ] Inheritance represents true "is-a" relationship, not code reuse
- [ ] Class hierarchy depth <= 2
- [ ] `protected` methods are rare (< 2 per class)
- [ ] No override methods that just call super + add logic
- [ ] C# classes are `sealed` unless explicitly designed for inheritance

**Language-specific rules:** See `~/.claude/rules/coding-standards-{language}.md`

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
| Efficient algorithms | No obvious O(n^2) when O(n) works |
| Memory management | No leaks, proper cleanup |
| Async patterns | Proper await usage |

### 6. Security Basics

| Check | Verify |
|-------|--------|
| Input sanitization | User input validated |
| No secrets in code | Use environment variables |
| SQL injection | Parameterized queries |
| XSS prevention | Output encoding |

### 7. Frontend Aesthetics (if applicable)

For frontend code (React, Vue, HTML/CSS, etc.), verify distinctive design:

| Check | Verify |
|-------|--------|
| Distinctive typography | Not using Inter, Roboto, Arial, or system defaults |
| Intentional color palette | CSS variables defined, not ad-hoc colors |
| Purposeful motion | Orchestrated animations, not scattered micro-interactions |
| Atmospheric backgrounds | Layered/textured, not flat solid colors |
| Overall distinctiveness | Doesn't exhibit "AI slop" patterns |

**Anti-patterns to flag:**
- Purple gradients on white backgrounds
- Perfectly centered symmetric layouts
- Generic font choices
- Flat #f5f5f5 or pure white/black backgrounds
- Animation without purpose

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

Update workflow state with review results using `mcp__exarchos__exarchos_workflow` with `action: "set"`.

### On Review Complete

```text
# Update task review status - for approved
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "tasks[id=<task-id>].reviewStatus.qualityReview": "approved" }

# Or if needs fixes:
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "tasks[id=<task-id>].reviewStatus.qualityReview": "needs_fixes" }

# Add review details
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: {
    "reviews.<task-id>.qualityReview": {"status": "approved", "highPriority": [], "mediumPriority": []}
  }
```

### On All Reviews Pass

Update phase for synthesis:

```text
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  phase: "synthesize"
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
3. Auto-invoke delegate with fix tasks:
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

## Exarchos Integration

When Exarchos MCP tools are available, emit gate events during review:

1. **Read CI status:** Use `mcp__plugin_github_github__pull_request_read` with `method: "get_status"` to get CI gate results
2. **For each CI check:** Call `mcp__exarchos__exarchos_event` with `action: "append"` with event type `gate.executed` including:
   - `gateName`: The CI check name
   - `layer`: "per-pr" or "per-stack"
   - `passed`: boolean
   - `duration`: milliseconds (if available)
3. **Read unified status:** Use `mcp__exarchos__exarchos_view` with `action: "tasks"` with `fields: ["taskId", "status", "title"]` and `limit: 20` for combined task + gate view with minimal token cost
4. **When all per-PR gates pass:** Apply `stack-ready` label to the PR

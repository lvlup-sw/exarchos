---
name: quality-review
description: |
  Two-stage code review: spec compliance then code quality analysis.
  Use when the user says "review code", "check quality", "code review",
  or runs /review. Stage 1 verifies design alignment. Stage 2 checks
  SOLID principles, DRY, security, and test quality.
  Do NOT use for plan-design delta analysis -- use spec-review instead.
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: review
---

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

The orchestrator provides the state file path, diff output from `~/.claude/scripts/review-diff.sh`, task ID, and spec review results (must be PASS).

The subagent reads the state file for artifact paths, uses the diff output instead of full files, runs static analysis, performs a code walkthrough, generates a report, and returns the verdict.

### Context-Efficient Input

Instead of reading full files, receive the integrated diff:

```bash
# Generate integrated diff for review (Graphite stack vs main)
gt diff main > /tmp/stack-diff.patch

# Alternative: git diff for integration branch
git diff main...integration-branch > /tmp/integration-diff.patch

# Alternative: use GitHub MCP to get PR diff
# mcp__plugin_github_github__pull_request_read({ owner, repo, pullNumber, method: "get_diff" })
```

This reduces context consumption by 80-90% while providing the complete picture.

### Review Scope: Combined Changes

After delegation completes, quality review examines:
- The **complete stack diff** (all task branches vs main), or the **feature/integration-branch** diff when using integration branches
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

Assess each modified file against the quality checklists:
- Consult `references/code-quality-checklist.md` for code quality, SOLID, DRY, and structural criteria
- Consult `references/security-checklist.md` for security review criteria

### Step 3: Generate Report

Use the template from `references/review-report-template.md` to structure the review output.

## Priority Levels

| Priority | Action | Examples |
|----------|--------|----------|
| **HIGH** | Must fix before merge | Security issues, data loss risks |
| **MEDIUM** | Should fix, may defer | SOLID violations, complexity |
| **LOW** | Nice to have | Style preferences, minor refactors |

## Fix Loop for HIGH-Priority

If HIGH-priority issues found:

1. Create fix task listing each HIGH finding with file, issue, and required fix
2. Dispatch to implementer subagent
3. Re-review quality after fixes
4. Only mark APPROVED when all HIGH items resolved and tests pass

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

Update workflow state with review results using `mcp__exarchos__exarchos_workflow` with `action: "set"`:

- **On review complete:** Set `tasks[id=<task-id>].reviewStatus.qualityReview` to `"approved"` or `"needs_fixes"`, and add review details to `reviews.<task-id>.qualityReview`
- **On all reviews pass:** Set `phase: "synthesize"` to advance the workflow

## Completion Criteria

- [ ] Static analysis passes
- [ ] All HIGH-priority issues fixed
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
2. Output: "Quality review found [N] HIGH-priority issues. Auto-continuing to fixes..."
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

1. **Read CI status** via `pull_request_read` with `method: "get_status"`
2. **Emit gate events** via `exarchos_event` with `action: "append"`, type `gate.executed` (include `gateName`, `layer`, `passed`, `duration`)
3. **Read unified status** via `exarchos_view` with `action: "tasks"`, `fields: ["taskId", "status", "title"]`, `limit: 20`
4. **When all per-PR gates pass**, apply `stack-ready` label to the PR

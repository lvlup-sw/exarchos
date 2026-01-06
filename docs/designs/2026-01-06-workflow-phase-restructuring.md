# Design: Workflow Phase Restructuring

## Problem Statement

The current orchestration workflow has three interconnected issues that degrade session longevity and prevent parallel execution:

1. **Testing burden on orchestrator** — After `/delegate` completes, the orchestrator runs integration tests directly in the main context, consuming valuable context window.

2. **Fix iteration on orchestrator** — When `/review` identifies issues, the orchestrator fixes them directly instead of delegating to subagents, further consuming context.

3. **Inconsistent worktree usage** — Subagents receive worktree paths inconsistently (often main project root), defeating parallelization and causing merge conflicts.

These issues compound: the orchestrator becomes an implementer rather than a coordinator, exhausting context and limiting session duration.

## Chosen Approach

**Explicit Phase Restructuring** — Add a formal `/integrate` phase and enforce strict delegation boundaries.

### New Workflow

```
/ideate → /plan → /delegate → /integrate → /review → /synthesize
                      ↑            │            │
                      │            │            │
                      └── ON FAIL ─┴────────────┘
```

### Design Principles

1. **Orchestrator as pure coordinator** — Never writes implementation code
2. **All code changes delegated** — Implementation, fixes, and testing via subagents
3. **Explicit phase boundaries** — Each phase has single responsibility
4. **Worktree enforcement** — Subagents MUST work in isolated worktrees
5. **Integration as gate** — Must pass before review proceeds

## Technical Design

### Phase Responsibilities

| Phase | Responsibility | Orchestrator Actions | Subagent Actions |
|-------|---------------|---------------------|------------------|
| `/ideate` | Design exploration | Facilitate discussion, save design | N/A |
| `/plan` | Implementation planning | Extract tasks, save plan | N/A |
| `/delegate` | Task implementation | Create worktrees, dispatch implementers | Write code (TDD) in worktrees |
| `/integrate` | Merge and test | Dispatch integrator | Merge branches, run tests |
| `/review` | Quality assessment | Dispatch reviewers | Assess integrated diff |
| `/synthesize` | PR creation | Create PR, handle feedback | N/A (or fix subagents for feedback) |

### New Integration Phase

#### Skill Definition: `skills/integration/SKILL.md`

**Trigger:** Auto-invoked when all `/delegate` tasks complete

**Integration Subagent Responsibilities:**
1. Create integration branch from main
2. Merge worktree branches in dependency order
3. Run full test suite
4. Run type checking and linting
5. Report pass/fail with details

**Input to Subagent:**
```markdown
# Integration Task

## Working Directory
[Main project root - NOT a worktree]

## Branches to Merge (in order)
1. feature/001-types (.worktrees/001-types)
2. feature/002-api (.worktrees/002-api)
3. feature/003-tests (.worktrees/003-tests)

## Integration Branch
feature/integration-<feature-name>

## Commands
1. git checkout main && git pull
2. git checkout -b feature/integration-<feature-name>
3. For each branch:
   - git merge --no-ff <branch> -m "Merge <branch>"
   - npm run test:run (stop if fails, report which merge broke)
4. npm run typecheck
5. npm run lint
6. npm run build

## Success Criteria
- All branches merged without conflict
- All tests pass
- Type check passes
- Lint passes
- Build succeeds

## On Failure
Report:
- Which merge caused failure (if merge conflict)
- Which tests failed (with error output)
- Which files are involved
```

**Output:**
```markdown
## Integration Report

### Status: [PASS | FAIL]

### Merged Branches
- [x] feature/001-types
- [x] feature/002-api
- [ ] feature/003-tests (FAILED)

### Failure Details
Merge of feature/003-tests caused test failures:
- `src/api/handler.test.ts`: TypeError at line 42
- Root cause: Incompatible interface change

### Suggested Fix
Task 003 needs to update handler to use new interface from Task 001.
```

### State Transitions

```
Phase: ideate
  ↓ (design saved)
Phase: plan
  ↓ (tasks extracted)
Phase: delegate
  ↓ (all tasks complete)
Phase: integrate
  ↓ PASS → Phase: review
  ↓ FAIL → Phase: delegate (with fix tasks)
Phase: review
  ↓ PASS → Phase: synthesize
  ↓ FAIL → Phase: delegate (with fix tasks), then back to integrate
Phase: synthesize
  ↓ (PR created)
Phase: awaiting-merge (human checkpoint)
  ↓ (merged)
Phase: completed
```

### Worktree Enforcement

#### Orchestrator Requirements

Before dispatching any implementer:

```bash
# 1. Ensure .worktrees is gitignored
git check-ignore -q .worktrees || echo ".worktrees/" >> .gitignore

# 2. Create worktree for task
git branch feature/<task-id>-<name> main
git worktree add .worktrees/<task-id>-<name> feature/<task-id>-<name>

# 3. Run setup in worktree
cd .worktrees/<task-id>-<name> && npm install
```

#### Implementer Prompt Requirements

The implementer prompt MUST include:

```markdown
## Working Directory
/absolute/path/to/.worktrees/<task-id>-<name>

## CRITICAL: Worktree Verification
Before making ANY changes, verify you are in the worktree:
1. Run: pwd
2. Confirm path contains ".worktrees/"
3. If NOT in worktree, STOP and report error

DO NOT proceed if working directory is the main project root.
```

#### State Tracking

```bash
# Track worktree in state
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.worktrees["<task-id>"] = {
    "path": ".worktrees/<task-id>-<name>",
    "branch": "feature/<task-id>-<name>",
    "status": "active"
  }'
```

### Orchestrator Constraints

Add new rule file: `rules/orchestrator-constraints.md`

```markdown
# Orchestrator Constraints

The orchestrator (main Claude Code session) MUST NOT:

1. **Write implementation code** — All code changes via subagents
2. **Fix review findings directly** — Dispatch fixer subagents
3. **Run integration tests inline** — Dispatch integration subagent
4. **Work in main project root** — All implementation in worktrees

The orchestrator SHOULD:

1. **Parse and extract** — Read plans, extract task details
2. **Dispatch and monitor** — Launch subagents, track progress
3. **Manage state** — Update workflow state file
4. **Chain phases** — Invoke next skill when phase completes
5. **Handle failures** — Route failures back to appropriate phase
```

### Review Phase Updates

#### Changes to Spec Review

- **Before:** Reviews individual task diffs (per worktree)
- **After:** Reviews integrated diff (integration branch vs main)

```bash
# Generate diff for review
git diff main...feature/integration-<feature> > /tmp/integrated-diff.patch
```

#### Changes to Quality Review

Same change — reviews the integrated code, not fragments.

**Benefits:**
- Reviewers see the complete picture
- Can catch integration issues (interface mismatches, etc.)
- Single diff to review instead of multiple

### Fix Delegation

When review fails, orchestrator MUST:

1. **Extract specific issues** from review report
2. **Create fix task** with:
   - Issue description
   - File path and line numbers
   - Expected behavior
   - Worktree path (existing or new)
3. **Dispatch fixer subagent** (same as implementer, different prompt)
4. **After fix completes** — Re-run `/integrate` (not just `/review`)

```typescript
// Orchestrator dispatches fixer
Task({
  subagent_type: "general-purpose",
  model: "opus",
  description: "Fix review issue: handler interface",
  prompt: `
# Fix Task

## Working Directory
/path/to/.worktrees/003-tests

## Issue to Fix
File: src/api/handler.ts:42
Problem: Using old interface signature
Expected: Update to use UserContext from types.ts

## Verification
1. Fix the interface usage
2. Run: npm run test:run
3. Ensure all tests pass

## TDD (if adding test)
[Standard TDD requirements]
`
})
```

### Simplified Synthesis

With integration phase handling merge+test:

**Before `/synthesize`:**
- Merge branches in order
- Run tests after each merge
- Create PR

**After `/synthesize`:**
- Integration branch already exists and passes tests
- Just create PR from integration branch
- Handle PR feedback (dispatch fixers if needed)

## Integration Points

### Skill File Changes

| File | Change |
|------|--------|
| `skills/integration/SKILL.md` | **NEW** — Integration phase skill |
| `skills/delegation/SKILL.md` | Add worktree enforcement, update transition |
| `skills/spec-review/SKILL.md` | Review integrated diff, update input |
| `skills/quality-review/SKILL.md` | Review integrated diff, update input |
| `skills/synthesis/SKILL.md` | Simplify (no merge/test), just PR |
| `skills/git-worktrees/SKILL.md` | Add validation helpers |
| `rules/orchestrator-constraints.md` | **NEW** — Orchestrator rules |

### State Schema Updates

Add to `docs/schemas/workflow-state.schema.json`:

```json
{
  "integration": {
    "type": "object",
    "properties": {
      "branch": { "type": "string" },
      "status": { "enum": ["pending", "in_progress", "passed", "failed"] },
      "mergedBranches": { "type": "array", "items": { "type": "string" } },
      "failureDetails": { "type": "string" },
      "testResults": {
        "type": "object",
        "properties": {
          "tests": { "enum": ["pass", "fail"] },
          "typecheck": { "enum": ["pass", "fail"] },
          "lint": { "enum": ["pass", "fail"] },
          "build": { "enum": ["pass", "fail"] }
        }
      }
    }
  }
}
```

### Prompt Template Updates

Update `skills/delegation/references/implementer-prompt.md`:

```markdown
## CRITICAL: Worktree Verification (MANDATORY)

Before making ANY changes:

1. Verify working directory:
   ```bash
   pwd | grep -q ".worktrees" || echo "ERROR: Not in worktree!"
   ```

2. If NOT in a worktree directory, STOP immediately and report:
   "ERROR: Working directory is not a worktree. Aborting task."

3. DO NOT proceed with any file modifications outside a worktree.
```

## Testing Strategy

### Unit Testing

1. **Workflow state transitions** — Test state machine logic
2. **Worktree validation** — Test enforcement scripts
3. **Integration subagent prompt** — Verify merge order logic

### Integration Testing

1. **End-to-end workflow** — Run full `/ideate` → `/synthesize` flow
2. **Failure recovery** — Test integration failure → fix → re-integrate
3. **Parallel execution** — Verify multiple worktrees work correctly

### Manual Verification

1. **Context consumption** — Measure orchestrator context usage before/after
2. **Session longevity** — Track how many tasks complete per session
3. **Worktree isolation** — Verify no cross-contamination between tasks

## Open Questions

1. **Worktree cleanup timing** — Clean up after integration passes, or after PR merges?
   - Recommendation: After integration passes (branches preserved in git)

2. **Partial integration** — If 2/3 branches merge but 3rd fails, keep partial?
   - Recommendation: Yes, report which succeeded and which failed

3. **Review granularity** — One review for entire integration, or per-task?
   - Recommendation: One review for integration (see full picture)

4. **Fixer worktree** — Use existing task worktree or create new one?
   - Recommendation: Use existing if task-specific fix, new if cross-cutting

## Implementation Order

1. **Phase 1: Orchestrator constraints** — Add rules, update delegation prompt
2. **Phase 2: Worktree enforcement** — Validation in state script, prompt updates
3. **Phase 3: Integration skill** — New skill file, state schema updates
4. **Phase 4: Review updates** — Change to integrated diff review
5. **Phase 5: Synthesis simplification** — Remove merge/test logic
6. **Phase 6: Fix delegation** — Ensure all fixes go through subagents

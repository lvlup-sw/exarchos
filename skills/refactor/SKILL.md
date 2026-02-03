# Refactor Workflow Skill

## Overview

Two-track workflow for improving existing code. Polish track for small, contained refactors; overhaul track for architectural changes and migrations. Both tracks emphasize exploration before commitment and mandatory documentation updates.

## Triggers

Activate this skill when:
- User runs `/refactor` command
- User wants to improve existing code structure
- User mentions "refactor", "restructure", "clean up", "migrate"
- User asks to "move", "extract", "rename", or "reorganize" code

## Workflow Overview

```
                              /refactor
                                  |
                            +-----+-----+
                            |  Explore  |
                            +-----+-----+
                                  |
                   +--------------+--------------+
                   |                             |
              --polish                       (default)
                   |                             |
                   v                             v
          +--------------+              +--------------+
          |    Polish    |              |   Overhaul   |
          |    Track     |              |    Track     |
          +--------------+              +--------------+
```

## Command Interface

### Start Refactor Workflow

```bash
# Default: overhaul track
/refactor "Description of what needs refactoring"

# Fast path: polish track
/refactor --polish "Small contained refactor description"

# Explore first, then decide track
/refactor --explore "Unsure of scope, explore first"
```

### Mid-Workflow Commands

```bash
# Switch from polish to overhaul (during explore/brief)
/refactor --switch-overhaul

# Resume after context compaction
/resume
```

## Track Comparison

| Aspect | Polish | Overhaul |
|--------|--------|----------|
| Scope | <=5 files, single concern | No limit |
| Worktree | No (direct) | Yes (isolated) |
| Delegation | No | Yes (full workflow) |
| Documentation | Mandatory update phase | Mandatory update phase |
| Human Checkpoints | 1 (completion) | 1 (merge) |

## Polish Track

### Purpose

Fast path for small, contained refactors. Single session, minimal ceremony. Orchestrator may write implementation code directly (exception to orchestrator constraints).

### Phases

```
Explore -> Brief -> Implement -> Validate -> Update Docs -> Complete
   |         |          |           |             |
   |         |          |           |             +-- Update affected documentation
   |         |          |           +-- Run tests, verify goals met
   |         |          +-- Direct implementation (no worktree)
   |         +-- Capture goals and approach in state
   +-- Quick scope assessment, confirm polish-appropriate
```

### Phase Details

#### 1. Explore Phase

Use `@skills/refactor/references/explore-checklist.md` to assess:
- Current code structure
- Files/modules affected (must be <=5 for polish)
- Test coverage of affected areas
- Documentation that needs updates
- Confirm polish is appropriate

Update state:
```bash
~/.claude/scripts/workflow-state.sh init refactor-<slug> --refactor
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.track = "polish" | .phase = "explore" | .explore = {
    "startedAt": "<ISO8601>",
    "scopeAssessment": {
      "filesAffected": ["<file1>", "<file2>"],
      "modulesAffected": ["<module>"],
      "testCoverage": "good | gaps | none",
      "recommendedTrack": "polish"
    }
  }'
```

On completion:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.explore.completedAt = "<ISO8601>" | .phase = "brief"'
```

#### 2. Brief Phase

Capture refactor intent and approach in state (not separate document).

Use `@skills/refactor/references/brief-template.md` to structure:
- Problem statement (2-3 sentences)
- Specific goals (bulleted list)
- High-level approach
- Out of scope items
- Success criteria
- Docs to update

Update state:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.brief = {
    "problem": "<what is wrong with current code>",
    "goals": ["<goal 1>", "<goal 2>"],
    "approach": "<high-level approach>",
    "affectedAreas": ["<area 1>", "<area 2>"],
    "outOfScope": ["<exclusion 1>"],
    "successCriteria": ["<criterion 1>", "<criterion 2>"],
    "docsToUpdate": ["<doc path 1>"]
  } | .phase = "implement"'
```

#### 3. Implement Phase

**Orchestrator may write code directly** (polish track exception).

Constraints:
- Follow TDD (write/update test first if behavior changes)
- Commit after each logical change
- Stop if scope expands beyond brief

Update state on completion:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.phase = "validate"'
```

#### 4. Validate Phase

Verify refactor goals are met:
- [ ] All existing tests pass
- [ ] Each goal in brief is addressed
- [ ] No new lint/type errors introduced
- [ ] Code quality improved per brief

Run validation:
```bash
npm run test:run
npm run lint  # or equivalent
npm run typecheck  # if TypeScript
```

Update state:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.validation = {
    "testsPass": true,
    "goalsVerified": ["<goal 1>", "<goal 2>"],
    "docsUpdated": false
  } | .phase = "update-docs"'
```

#### 5. Update Docs Phase

**Mandatory** - documentation must reflect new architecture.

Use `@skills/refactor/references/doc-update-checklist.md` to update:
- Architecture docs if structure changed
- API docs if interfaces changed
- README if setup/usage changed
- Inline comments if complex logic moved

If `docsToUpdate` is empty, verify no docs need updating.

Update state:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.validation.docsUpdated = true | .artifacts.updatedDocs = ["<doc1>", "<doc2>"] | .phase = "completed"'
```

**Human checkpoint:** Confirm refactor complete.

## Overhaul Track

### Purpose

Rigorous path for architectural changes, migrations, and multi-file restructuring. Uses full delegation model with worktree isolation.

### Phases

```
Explore -> Brief -> Plan -> Delegate -> Integrate -> Review -> Update Docs -> Synthesize
   |         |        |         |           |           |            |             |
   |         |        |         |           |           |            |             +-- PR creation
   |         |        |         |           |           |            +-- Update architecture docs
   |         |        |         |           |           +-- Quality review (emphasized)
   |         |        |         |           +-- Merge worktrees, run tests
   |         |        |         +-- TDD implementation in worktrees
   |         |        +-- Extract tasks from brief
   |         +-- Detailed goals, approach, affected areas
   +-- Thorough scope assessment, identify affected systems
```

### Phase Details

#### 1. Explore Phase

Thorough scope assessment using `@skills/refactor/references/explore-checklist.md`:
- Read affected code to understand current structure
- Identify ALL files/modules that will change
- Assess test coverage of affected areas
- Identify documentation that will need updates
- Map dependencies and impact

Update state:
```bash
~/.claude/scripts/workflow-state.sh init refactor-<slug> --refactor
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.track = "overhaul" | .phase = "explore" | .explore = {
    "startedAt": "<ISO8601>",
    "scopeAssessment": {
      "filesAffected": ["<file1>", "<file2>", ...],
      "modulesAffected": ["<module1>", "<module2>"],
      "testCoverage": "good | gaps | none",
      "recommendedTrack": "overhaul"
    }
  }'
```

On completion:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.explore.completedAt = "<ISO8601>" | .phase = "brief"'
```

#### 2. Brief Phase

Detailed capture of refactor intent (more thorough than polish).

Update state:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.brief = {
    "problem": "<detailed problem statement>",
    "goals": ["<specific goal 1>", "<specific goal 2>", "<specific goal 3>"],
    "approach": "<detailed approach with phases/steps>",
    "affectedAreas": ["<area 1>", "<area 2>", "<area 3>"],
    "outOfScope": ["<exclusion 1>", "<exclusion 2>"],
    "successCriteria": ["<criterion 1>", "<criterion 2>", "<criterion 3>"],
    "docsToUpdate": ["<doc 1>", "<doc 2>"]
  } | .phase = "plan"'
```

#### 3. Plan Phase

Invoke `/plan` skill with refactor-specific context:

```bash
# The plan skill extracts tasks from the brief
# Focus on incremental, testable changes
# Each task should leave code in working state
# Dependency order matters more for refactors
```

Update state:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.artifacts.plan = "docs/plans/<plan-file>.md" | .phase = "delegate"'
```

#### 4. Delegate Phase

Invoke `/delegate` skill for TDD implementation in worktrees:

```bash
# Create worktrees for each task
# Full TDD: write failing test, implement, verify
# Parallel execution where dependencies allow
```

Update state on completion:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.phase = "integrate"'
```

#### 5. Integrate Phase

Invoke `/integrate` skill to merge worktrees and run tests:

```bash
# Merge all task branches
# Run full test suite
# Verify no regressions
```

Update state on completion:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.phase = "review"'
```

#### 6. Review Phase

Invoke `/review` skill with emphasis on quality:

```bash
# Quality review is emphasized for refactors
# Refactors are high regression risk
# Verify structure matches brief goals
```

Update state on completion:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.phase = "update-docs"'
```

#### 7. Update Docs Phase

**Mandatory** - documentation must reflect new architecture.

For overhaul, typically includes:
- Architecture documentation updates
- API documentation changes
- Migration guides if public interfaces changed
- Updated diagrams

Update state:
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.validation.docsUpdated = true | .artifacts.updatedDocs = ["<doc1>", "<doc2>"] | .phase = "synthesize"'
```

#### 8. Synthesize Phase

Invoke `/synthesize` skill to create PR:

```bash
gh pr create --title "refactor: <summary>" --body "$(cat <<'EOF'
## Summary

[Brief description of the refactor and why it was needed]

## Changes

- [Key structural change 1]
- [Key structural change 2]

## Documentation Updated

- [doc1.md] - Updated for X
- [doc2.md] - Updated for Y

## Test Plan

- All existing tests pass
- [Any new tests added]
EOF
)"
```

**Human checkpoint:** Confirm merge.

## State Management

Initialize refactor workflow:
```bash
~/.claude/scripts/workflow-state.sh init refactor-<slug> --refactor
```

Full state schema:
```json
{
  "version": "1.0",
  "featureId": "refactor-<slug>",
  "workflowType": "refactor",
  "track": "polish | overhaul",
  "phase": "explore | brief | plan | delegate | integrate | review | update-docs | synthesize | completed",
  "explore": {
    "startedAt": "ISO8601",
    "completedAt": "ISO8601 | null",
    "scopeAssessment": {
      "filesAffected": ["string"],
      "modulesAffected": ["string"],
      "testCoverage": "good | gaps | none",
      "recommendedTrack": "polish | overhaul"
    }
  },
  "brief": {
    "problem": "string",
    "goals": ["string"],
    "approach": "string",
    "affectedAreas": ["string"],
    "outOfScope": ["string"],
    "successCriteria": ["string"],
    "docsToUpdate": ["string"]
  },
  "artifacts": {
    "plan": "string | null",
    "pr": "string | null",
    "updatedDocs": ["string"]
  },
  "validation": {
    "testsPass": "boolean",
    "goalsVerified": ["string"],
    "docsUpdated": "boolean"
  }
}
```

## Auto-Chain Behavior

Both tracks have ONE human checkpoint: completion/merge confirmation.

### Polish Auto-Chain

```
explore -> brief -> implement -> validate -> update-docs -> [HUMAN: complete]
           (auto)   (auto)       (auto)      (auto)
```

**Next actions:**
- `AUTO:refactor-brief` after explore
- `AUTO:refactor-implement` after brief
- `AUTO:refactor-validate` after implement
- `AUTO:refactor-update-docs` after validate
- `WAIT:human-checkpoint:polish-complete` after update-docs

### Overhaul Auto-Chain

```
explore -> brief -> plan -> delegate -> integrate -> review -> update-docs -> synthesize -> [HUMAN: merge]
           (auto)   (auto)   (auto)      (auto)       (auto)    (auto)         (auto)
```

**Next actions:**
- `AUTO:refactor-brief` after explore
- `AUTO:plan:<brief>` after brief
- `AUTO:delegate:<plan>` after plan
- `AUTO:integrate:<state>` after delegate
- `AUTO:review:<path>` after integrate
- `AUTO:refactor-update-docs` after review
- `AUTO:synthesize:<feature>` after update-docs
- `WAIT:human-checkpoint:overhaul-merge` after synthesize

## Track Switching

### Polish -> Overhaul

If scope expands beyond polish limits during explore or brief phase:

```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.track = "overhaul" | .explore.scopeAssessment.recommendedTrack = "overhaul"'
```

**Indicators to switch:**
- More than 5 files affected
- Multiple concerns identified
- Cross-module changes needed
- Test coverage gaps require new tests
- Architectural documentation needed

Output to user:
> Scope has expanded beyond polish limits. Switching to overhaul track.
> This will use worktree isolation and full delegation.
>
> Continue? (Y/n)

## Integration Points

### With Existing Skills

| Skill | Usage |
|-------|-------|
| `/plan` | Overhaul track task extraction |
| `/delegate` | Overhaul track implementation |
| `/integrate` | Overhaul track merge and test |
| `/review` | Overhaul track quality review |
| `/synthesize` | Overhaul track PR creation |

### With workflow-state.sh

Extended to support:
- `workflowType: "refactor"` field
- Refactor-specific phases in `next-action` command
- Refactor context in `summary` output

### With workflow-auto-resume.md

Refactor phases map to auto-resume actions:

| Phase | Next Action |
|-------|-------------|
| `explore` (completed) | `AUTO:refactor-brief` |
| `brief` (completed, polish) | `AUTO:refactor-implement` |
| `brief` (completed, overhaul) | `AUTO:plan:<brief>` |
| `implement` (completed) | `AUTO:refactor-validate` |
| `validate` (completed) | `AUTO:refactor-update-docs` |
| `update-docs` (completed, polish) | `WAIT:human-checkpoint:polish-complete` |
| `update-docs` (completed, overhaul) | `AUTO:synthesize:<feature>` |

## Completion Criteria

### Polish Complete

- [ ] Scope assessment completed (<=5 files)
- [ ] Brief goals captured
- [ ] Implementation complete
- [ ] All tests pass
- [ ] Each goal verified
- [ ] Documentation updated
- [ ] User confirmed completion

### Overhaul Complete

- [ ] Full exploration done
- [ ] Detailed brief captured
- [ ] Plan created
- [ ] All tasks delegated and complete
- [ ] Integration passed
- [ ] Quality review passed
- [ ] Documentation updated
- [ ] PR merged

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Skip exploration | Always assess scope first |
| Use polish for large changes | Switch to overhaul when scope expands |
| Skip doc updates | Documentation is mandatory |
| Add features during refactor | Scope creep - stick to brief goals |
| Skip tests because "just moving code" | Refactors need test verification |
| Create design document for polish | Use brief in state file instead |
| Work in main for overhaul | Use worktree isolation |

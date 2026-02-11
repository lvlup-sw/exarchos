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

Update state using MCP tools:
1. Use `mcp__exarchos__exarchos_workflow_init` with featureId `refactor-<slug>` and workflowType `refactor`
2. Use `mcp__exarchos__exarchos_workflow_set` to set track, phase, and explore scope assessment

On completion, use `mcp__exarchos__exarchos_workflow_set` to set `explore.completedAt` and `phase` to "brief".

#### 2. Brief Phase

Capture refactor intent and approach in state (not separate document).

Use `@skills/refactor/references/brief-template.md` to structure:
- Problem statement (2-3 sentences)
- Specific goals (bulleted list)
- High-level approach
- Out of scope items
- Success criteria
- Docs to update

Update state using `mcp__exarchos__exarchos_workflow_set` to set the `brief` object and `phase` to "polish-implement".

#### 3. Implement Phase

**Orchestrator may write code directly** (polish track exception).

Constraints:
- Follow TDD (write/update test first if behavior changes)
- Commit after each logical change
- Stop if scope expands beyond brief

When done, commit via Graphite:
```typescript
mcp__graphite__run_gt_cmd({ args: ["create", "-m", "refactor: <description>"], cwd: "<repo-root>" })
```

Update state on completion using `mcp__exarchos__exarchos_workflow_set` to set `phase` to "polish-validate".

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

Update state using `mcp__exarchos__exarchos_workflow_set` to set `validation` object and `phase` to "polish-update-docs".

#### 5. Update Docs Phase

**Mandatory** - documentation must reflect new architecture.

Use `@skills/refactor/references/doc-update-checklist.md` to update:
- Architecture docs if structure changed
- API docs if interfaces changed
- README if setup/usage changed
- Inline comments if complex logic moved

If `docsToUpdate` is empty, verify no docs need updating.

Update state using `mcp__exarchos__exarchos_workflow_set` to set `validation.docsUpdated` to true, `artifacts.updatedDocs` array, and `phase` to "completed".

> **Note:** The HSM transitions directly from `polish-update-docs` to `completed`. There is no `synthesize` phase for polish track.

**Human checkpoint:** Confirm refactor complete.

## Overhaul Track

### Purpose

Rigorous path for architectural changes, migrations, and multi-file restructuring. Uses full delegation model with worktree isolation.

### Phases

```
Explore -> Brief -> Plan -> Delegate -> Review -> Update Docs -> Synthesize
   |         |        |         |          |            |             |
   |         |        |         |          |            |             +-- PR creation
   |         |        |         |          |            +-- Update architecture docs
   |         |        |         |          +-- Quality review (emphasized)
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

Update state using MCP tools:
1. Use `mcp__exarchos__exarchos_workflow_init` with featureId `refactor-<slug>` and workflowType `refactor`
2. Use `mcp__exarchos__exarchos_workflow_set` to set track to "overhaul", phase, and explore scope assessment

On completion, use `mcp__exarchos__exarchos_workflow_set` to set `explore.completedAt` and `phase` to "brief".

#### 2. Brief Phase

Detailed capture of refactor intent (more thorough than polish).

Update state using `mcp__exarchos__exarchos_workflow_set` to set the `brief` object and `phase` to "overhaul-plan".

Then auto-invoke plan:
```typescript
Skill({ skill: "plan", args: "--refactor docs/workflow-state/<feature>.state.json" })
```

#### 3. Plan Phase

Invoke `/plan` skill with explicit Skill tool call:

```typescript
Skill({ skill: "plan", args: "--refactor docs/workflow-state/<feature>.state.json" })
```

The `/plan` skill:
- Extracts tasks from the brief
- Focuses on incremental, testable changes
- Each task leaves code in working state
- Dependency order matters more for refactors

Update state on completion using `mcp__exarchos__exarchos_workflow_set` to set `artifacts.plan` and `phase` to "overhaul-delegate".

> **Note:** There is no `plan-review` phase in the refactor HSM. Overhaul goes directly `overhaul-plan` → `overhaul-delegate`.

Then auto-invoke delegate:
```typescript
Skill({ skill: "delegate", args: "docs/workflow-state/<feature>.state.json" })
```

#### 4. Delegate Phase

Invoke `/delegate` skill for TDD implementation in worktrees:

```typescript
Skill({ skill: "delegate", args: "docs/workflow-state/<feature>.state.json" })
```

The `/delegate` skill:
- Creates worktrees for each task
- Dispatches subagents via Task tool with `model: "opus"`
- Uses implementer prompt template for full context
- Parallel execution where dependencies allow
- Tracks progress in state file

Update state on completion using `mcp__exarchos__exarchos_workflow_set` to set `phase` to "overhaul-review".

Then auto-invoke review:
```typescript
Skill({ skill: "review", args: "docs/workflow-state/<feature>.state.json" })
```

#### 5. Review Phase

Invoke `/review` skill with emphasis on quality:

```typescript
Skill({ skill: "review", args: "docs/workflow-state/<feature>.state.json" })
```

The `/review` skill:
- Quality review is emphasized for refactors
- Refactors are high regression risk
- Verifies structure matches brief goals

Update state on completion using `mcp__exarchos__exarchos_workflow_set` to set `phase` to "overhaul-update-docs".

#### 6. Update Docs Phase

**Mandatory** - documentation must reflect new architecture.

For overhaul, typically includes:
- Architecture documentation updates
- API documentation changes
- Migration guides if public interfaces changed
- Updated diagrams

Update state using `mcp__exarchos__exarchos_workflow_set` to set `validation.docsUpdated` to true, `artifacts.updatedDocs` array, and `phase` to "synthesize".

Then auto-invoke synthesize:
```typescript
Skill({ skill: "synthesize", args: "<feature-name>" })
```

#### 7. Synthesize Phase

Invoke `/synthesize` skill with explicit Skill tool call:

```typescript
Skill({ skill: "synthesize", args: "<feature-name>" })
```

The `/synthesize` skill creates the PR via Graphite MCP:

```typescript
// Submit the stack to create PRs
mcp__graphite__run_gt_cmd({ args: ["submit", "--no-interactive"], cwd: "<repo-root>" })
```

Then update the PR description using GitHub MCP:
```typescript
mcp__plugin_github_github__update_pull_request({
  owner, repo, pullNumber,
  body: "## Summary\n[Brief description of the refactor]\n\n## Changes\n- [Key structural change 1]\n\n## Documentation Updated\n- [doc1.md] - Updated for X\n\n## Test Plan\n- All existing tests pass"
})
```

**Human checkpoint:** Confirm merge.

## State Management

Initialize refactor workflow using `mcp__exarchos__exarchos_workflow_init` with featureId `refactor-<slug>` and workflowType `refactor`.

Full state schema:
```json
{
  "version": "1.0",
  "featureId": "refactor-<slug>",
  "workflowType": "refactor",
  "track": "polish | overhaul",
  "phase": "explore | brief | polish-implement | polish-validate | polish-update-docs | overhaul-plan | overhaul-delegate | overhaul-review | overhaul-update-docs | synthesize | completed | cancelled | blocked",
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
explore -> brief -> polish-implement -> polish-validate -> polish-update-docs -> completed
           (auto)   (auto)              (auto)             (auto)                [HUMAN]
```

**Next actions:**
- `AUTO:refactor-brief` after explore
- `AUTO:refactor-implement` after brief
- `AUTO:refactor-validate` after polish-implement
- `AUTO:refactor-update-docs` after polish-validate
- `WAIT:human-checkpoint:polish-complete` after polish-update-docs

### Overhaul Auto-Chain

```
explore -> brief -> overhaul-plan -> overhaul-delegate -> overhaul-review -> overhaul-update-docs -> synthesize -> completed
           (auto)   (auto)          (auto)               (auto)             (auto)                  (auto)        [HUMAN]
```

**Next actions:**
- `AUTO:refactor-brief` after explore
- `AUTO:plan:<brief>` after brief
- `AUTO:delegate:<plan>` after overhaul-plan
- `AUTO:review:<path>` after overhaul-delegate
- `AUTO:refactor-update-docs` after overhaul-review
- `AUTO:synthesize:<feature>` after overhaul-update-docs
- `WAIT:human-checkpoint:overhaul-merge` after synthesize

## Track Switching

### Polish -> Overhaul

If scope expands beyond polish limits during explore or brief phase, use `mcp__exarchos__exarchos_workflow_set` to set `track` to "overhaul" and update `explore.scopeAssessment.recommendedTrack`.

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

**CRITICAL:** All skill invocations MUST use explicit `Skill()` tool calls to ensure they actually execute:

| Skill | Invocation | Usage |
|-------|------------|-------|
| `/plan` | `Skill({ skill: "plan", args: "--refactor <state-file>" })` | Task extraction from brief |
| `/delegate` | `Skill({ skill: "delegate", args: "<state-file>" })` | Subagent dispatch for TDD |
| `/review` | `Skill({ skill: "review", args: "<state-file>" })` | Quality review |
| `/synthesize` | `Skill({ skill: "synthesize", args: "<feature>" })` | PR creation |

The `/delegate` skill dispatches subagents using:
```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",  // REQUIRED for coding tasks
  description: "Implement task N",
  prompt: "[Full implementer prompt with TDD requirements]"
})
```

### With Workflow State MCP

The workflow-state MCP server supports:
- `workflowType: "refactor"` field
- Refactor-specific phases in `mcp__exarchos__exarchos_workflow_next_action` output
- Refactor context in `mcp__exarchos__exarchos_workflow_summary` output

### With workflow-auto-resume.md

Refactor phases map to auto-resume actions:

| HSM Phase | Next Action |
|-----------|-------------|
| `explore` (completed) | `AUTO:refactor-brief` |
| `brief` (completed, polish) | `AUTO:refactor-implement` |
| `brief` (completed, overhaul) | `AUTO:plan:<brief>` |
| `polish-implement` (completed) | `AUTO:refactor-validate` |
| `polish-validate` (completed) | `AUTO:refactor-update-docs` |
| `polish-update-docs` (completed) | `WAIT:human-checkpoint:polish-complete` |
| `overhaul-plan` (completed) | `AUTO:delegate:<plan>` |
| `overhaul-delegate` (completed) | `AUTO:review:<path>` |
| `overhaul-review` (completed) | `AUTO:refactor-update-docs` |
| `overhaul-update-docs` (completed) | `AUTO:synthesize:<feature>` |
| `synthesize` (completed) | `WAIT:human-checkpoint:overhaul-merge` |

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

## Exarchos Integration

When Exarchos MCP tools are available, emit events throughout the refactor workflow:

1. **At workflow start (explore):** `exarchos_event_append` → `workflow.started` with workflowType "refactor"
2. **On track selection:** `exarchos_event_append` → `phase.transitioned` with selected track (polish/overhaul)
3. **On each phase transition:** `exarchos_event_append` → `phase.transitioned` from→to
4. **Overhaul track stacking:** Handled by `/delegate` (subagents use `gt create` per implementer prompt)
5. **Polish track commit:** Single `gt create -m "refactor: <description>"` — no multi-branch stacking needed
6. **On complete:** `exarchos_event_append` → `phase.transitioned` to "completed"

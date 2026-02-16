---
name: refactor
description: "Code improvement workflow with two tracks: polish (small, direct changes) and overhaul (large, delegated restructuring). Use when the user says \"refactor\", \"clean up\", \"restructure\", \"reorganize\", \"refactor this code\", or runs /refactor. Handles explore, brief, implement, validate, and documentation phases. Do NOT use for bug fixes (use debug) or new features (use ideate)."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity:
    - explore
    - brief
    - implement
    - validate
    - update-docs
    - synthesize
---

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
| Human Checkpoints | 0 | 1 (merge) |

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

Use `@skills/refactor/references/explore-checklist.md` to assess current code structure, then run the scope assessment script to determine the recommended track:

```bash
# Assess scope from a comma-separated file list
scripts/assess-refactor-scope.sh --files "src/foo.ts,src/bar.ts,src/baz.ts"

# Or read files from workflow state (requires jq)
scripts/assess-refactor-scope.sh --state-file ~/.claude/workflow-state/<feature>.state.json
```

> **Dependency:** The `--state-file` option requires `jq` to parse the workflow state JSON. The script will exit with an error if `jq` is not installed.

**What it validates:**
- File count (<=5 for polish)
- Cross-module span (files in different top-level directories)
- Test coverage assessment (test counterparts for source files)

**Exit code routing:**
- Exit 0 = polish recommended (proceed with polish track)
- Exit 1 = overhaul recommended (switch to overhaul track)
- Exit 2 = usage error

Update state using MCP tools:
1. Use `mcp__exarchos__exarchos_workflow` with `action: "init"` with featureId `refactor-<slug>` and workflowType `refactor`
2. Use `mcp__exarchos__exarchos_workflow` with `action: "set"` to set track (based on script recommendation), phase, and explore scope assessment

On completion, use `mcp__exarchos__exarchos_workflow` with `action: "set"` to set `explore.completedAt` and `phase` to "brief".

#### 2. Brief Phase

Capture refactor intent and approach in state (not separate document).

Use `@skills/refactor/references/brief-template.md` to structure:
- Problem statement (2-3 sentences)
- Specific goals (bulleted list)
- High-level approach
- Out of scope items
- Success criteria
- Docs to update

Update state using `mcp__exarchos__exarchos_workflow` with `action: "set"` to set the `brief` object and `phase` to "polish-implement".

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

Update state on completion using `mcp__exarchos__exarchos_workflow` with `action: "set"` to set `phase` to "polish-validate".

#### 4. Validate Phase

Run the validation script to verify refactor goals are met:

```bash
# Run all checks (tests, lint, typecheck)
scripts/validate-refactor.sh --repo-root <path>

# Skip optional checks
scripts/validate-refactor.sh --repo-root <path> --skip-lint --skip-typecheck
```

**What it validates:**
- `npm run test:run` passes (required)
- `npm run lint` passes (skipped if missing or `--skip-lint`)
- `npm run typecheck` passes (skipped if missing or `--skip-typecheck`)

**Exit code routing:**
- Exit 0 = all checks pass (proceed to update-docs)
- Exit 1 = one or more checks failed (fix before proceeding)
- Exit 2 = usage error

Additionally verify each goal in brief is addressed and code quality improved per brief (manual review).

Update state using `mcp__exarchos__exarchos_workflow` with `action: "set"` to set `validation` object and `phase` to "polish-update-docs".

#### 5. Update Docs Phase

**Mandatory** - documentation must reflect new architecture.

Use `@skills/refactor/references/doc-update-checklist.md` to update:
- Architecture docs if structure changed
- API docs if interfaces changed
- README if setup/usage changed
- Inline comments if complex logic moved

If `docsToUpdate` is empty, verify no docs need updating.

After updating documentation, verify all internal links resolve:

```bash
# Check a single doc file
scripts/verify-doc-links.sh --doc-file docs/designs/my-design.md

# Check all docs recursively
scripts/verify-doc-links.sh --docs-dir docs/
```

**What it validates:**
- All `[text](path)` markdown links resolve to existing files
- External URLs (http/https) are skipped
- Anchor-only links (#section) are skipped

**Exit code routing:**
- Exit 0 = all internal links valid (proceed)
- Exit 1 = broken links found (fix before proceeding)
- Exit 2 = usage error

Update state using `mcp__exarchos__exarchos_workflow` with `action: "set"` to set `validation.docsUpdated` to true, `artifacts.updatedDocs` array, and `phase` to "completed".

> **Note:** The HSM transitions directly from `polish-update-docs` to `completed`. There is no `synthesize` phase for polish track.

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
1. Use `mcp__exarchos__exarchos_workflow` with `action: "init"` with featureId `refactor-<slug>` and workflowType `refactor`
2. Use `mcp__exarchos__exarchos_workflow` with `action: "set"` to set track to "overhaul", phase, and explore scope assessment

On completion, use `mcp__exarchos__exarchos_workflow` with `action: "set"` to set `explore.completedAt` and `phase` to "brief".

#### 2. Brief Phase

Detailed capture of refactor intent (more thorough than polish).

Update state using `mcp__exarchos__exarchos_workflow` with `action: "set"` to set the `brief` object and `phase` to "overhaul-plan".

Then auto-invoke plan:
```typescript
Skill({ skill: "plan", args: "--refactor ~/.claude/workflow-state/<feature>.state.json" })
```

#### 3. Plan Phase

Invoke `/plan` skill with explicit Skill tool call:

```typescript
Skill({ skill: "plan", args: "--refactor ~/.claude/workflow-state/<feature>.state.json" })
```

The `/plan` skill:
- Extracts tasks from the brief
- Focuses on incremental, testable changes
- Each task leaves code in working state
- Dependency order matters more for refactors

Update state on completion using `mcp__exarchos__exarchos_workflow` with `action: "set"` to set `artifacts.plan` and `phase` to "overhaul-delegate".

> **Note:** There is no `plan-review` phase in the refactor HSM. Overhaul goes directly `overhaul-plan` → `overhaul-delegate`.

Then auto-invoke delegate:
```typescript
Skill({ skill: "delegate", args: "~/.claude/workflow-state/<feature>.state.json" })
```

#### 4. Delegate Phase

Invoke `/delegate` skill for TDD implementation in worktrees:

```typescript
Skill({ skill: "delegate", args: "~/.claude/workflow-state/<feature>.state.json" })
```

The `/delegate` skill:
- Creates worktrees for each task
- Dispatches subagents via Task tool with `model: "opus"`
- Uses implementer prompt template for full context
- Parallel execution where dependencies allow
- Tracks progress in state file

Update state on completion using `mcp__exarchos__exarchos_workflow` with `action: "set"` to set `phase` to "overhaul-review".

Then auto-invoke review:
```typescript
Skill({ skill: "review", args: "~/.claude/workflow-state/<feature>.state.json" })
```

#### 5. Review Phase

Invoke `/review` skill with emphasis on quality:

```typescript
Skill({ skill: "review", args: "~/.claude/workflow-state/<feature>.state.json" })
```

The `/review` skill:
- Quality review is emphasized for refactors
- Refactors are high regression risk
- Verifies structure matches brief goals

Update state on completion using `mcp__exarchos__exarchos_workflow` with `action: "set"` to set `phase` to "overhaul-update-docs".

#### 6. Update Docs Phase

**Mandatory** - documentation must reflect new architecture.

For overhaul, typically includes:
- Architecture documentation updates
- API documentation changes
- Migration guides if public interfaces changed
- Updated diagrams

Update state using `mcp__exarchos__exarchos_workflow` with `action: "set"` to set `validation.docsUpdated` to true, `artifacts.updatedDocs` array, and `phase` to "synthesize".

Then auto-invoke synthesize:
```typescript
Skill({ skill: "synthesize", args: "<feature-name>" })
```

#### 7. Synthesize Phase

Invoke `/synthesize` skill:

```typescript
Skill({ skill: "synthesize", args: "<feature-name>" })
```

Creates PR via Graphite, updates description via GitHub MCP. **Human checkpoint:** Confirm merge.

## State Management

Initialize refactor workflow using `mcp__exarchos__exarchos_workflow` with `action: "init"` with featureId `refactor-<slug>` and workflowType `refactor`.

Full state schema:
```json
{
  "version": "1.1",
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
           (auto)   (auto)              (auto)             (auto)                (auto)
```

**Next actions:**
- `AUTO:refactor-brief` after explore
- `AUTO:polish-implement` after brief
- `AUTO:refactor-validate` after polish-implement
- `AUTO:refactor-update-docs` after polish-validate
- `AUTO:completed` after polish-update-docs

### Overhaul Auto-Chain

```
explore -> brief -> overhaul-plan -> overhaul-delegate -> overhaul-review -> overhaul-update-docs -> synthesize -> completed
           (auto)   (auto)          (auto)               (auto)             (auto)                  (auto)        [HUMAN]
```

**Next actions:**
- `AUTO:refactor-brief` after explore
- `AUTO:overhaul-plan` after brief
- `AUTO:refactor-delegate` after overhaul-plan
- `AUTO:refactor-review` after overhaul-delegate
- `AUTO:refactor-update-docs` after overhaul-review
- `AUTO:refactor-synthesize` after overhaul-update-docs
- `WAIT:human-checkpoint:synthesize` after synthesize

## Track Switching

### Polish -> Overhaul

During the implement phase, run the scope check script to detect expansion triggers:

```bash
scripts/check-polish-scope.sh --repo-root <path> --base-branch main
```

**What it validates (expansion triggers):**
- File count > 5 (modified files via git diff)
- Module boundaries crossed (>2 top-level dirs modified)
- New test files needed (impl files without test counterparts)
- Architectural docs needed (structural files across modules)

**Exit code routing:**
- Exit 0 = scope OK (stay on polish track)
- Exit 1 = scope expanded (switch to overhaul track)
- Exit 2 = usage error

If exit 1, use `mcp__exarchos__exarchos_workflow` with `action: "set"` to set `track` to "overhaul" and update `explore.scopeAssessment.recommendedTrack`.

Output: "Scope expanded beyond polish limits. Switching to overhaul track."

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
- Refactor-specific phases handled by the SessionStart hook (which determines next action on resume)
- Refactor context provided by the SessionStart hook on session start

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

1. **At workflow start (explore):** `mcp__exarchos__exarchos_event` with `action: "append"` → `workflow.started` with workflowType "refactor"
2. **On track selection:** `mcp__exarchos__exarchos_event` with `action: "append"` → `phase.transitioned` with selected track (polish/overhaul)
3. **On each phase transition:** `mcp__exarchos__exarchos_event` with `action: "append"` → `phase.transitioned` from→to
4. **Overhaul track stacking:** Handled by `/delegate` (subagents use `gt create` per implementer prompt)
5. **Polish track commit:** Single `gt create -m "refactor: <description>"` — no multi-branch stacking needed
6. **On complete:** `mcp__exarchos__exarchos_event` with `action: "append"` → `phase.transitioned` to "completed"

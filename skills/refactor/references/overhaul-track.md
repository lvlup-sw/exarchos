# Overhaul Track — Detailed Phase Guide

## Purpose

Rigorous path for architectural changes, migrations, and multi-file restructuring. Uses full delegation model with worktree isolation.

## Phases

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

### 1. Explore Phase

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

### 2. Brief Phase

Detailed capture of refactor intent (more thorough than polish).

Update state using `mcp__exarchos__exarchos_workflow` with `action: "set"` to set the `brief` object and `phase` to "overhaul-plan".

Then auto-invoke plan:
```typescript
Skill({ skill: "plan", args: "--refactor ~/.claude/workflow-state/<feature>.state.json" })
```

### 3. Plan Phase

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

> **Note:** There is no `plan-review` phase in the refactor HSM. Overhaul goes directly `overhaul-plan` -> `overhaul-delegate`.

Then auto-invoke delegate:
```typescript
Skill({ skill: "delegate", args: "~/.claude/workflow-state/<feature>.state.json" })
```

### 4. Delegate Phase

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

### 5. Review Phase

Invoke `/review` skill with emphasis on quality:

```typescript
Skill({ skill: "review", args: "~/.claude/workflow-state/<feature>.state.json" })
```

The `/review` skill:
- Quality review is emphasized for refactors
- Refactors are high regression risk
- Verifies structure matches brief goals

Update state on completion using `mcp__exarchos__exarchos_workflow` with `action: "set"` to set `phase` to "overhaul-update-docs".

### 6. Update Docs Phase

**Mandatory** - documentation must reflect new architecture.

Verify all documentation links are valid:

```bash
bash scripts/verify-doc-links.sh --docs-dir docs/
```

**On Exit 0:** All links valid.
**On Exit 1:** Broken links found — fix before proceeding.

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

### 7. Synthesize Phase

Invoke `/synthesize` skill:

```typescript
Skill({ skill: "synthesize", args: "<feature-name>" })
```

Creates PR via Graphite, updates description via `gh pr edit`. **Human checkpoint:** Confirm merge.

> Or use GitHub MCP `update_pull_request` if available.

## Auto-Chain

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

## Completion Criteria

- [ ] Full exploration done
- [ ] Detailed brief captured
- [ ] Plan created
- [ ] All tasks delegated and complete
- [ ] Quality review passed
- [ ] Documentation updated
- [ ] PR merged

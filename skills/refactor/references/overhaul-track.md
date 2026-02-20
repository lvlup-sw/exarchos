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

**Initialize workflow:**
```
action: "init", featureId: "refactor-<slug>", workflowType: "refactor"
```

**Set track and scope assessment:**
```
action: "set", featureId: "refactor-<slug>", updates: {
  "track": "overhaul",
  "explore": {
    "startedAt": "<ISO8601>",
    "scopeAssessment": {
      "filesAffected": ["<paths>"],
      "modulesAffected": ["<modules>"],
      "testCoverage": "good | gaps | none",
      "recommendedTrack": "overhaul"
    }
  }
}, phase: "brief"
```

### 2. Brief Phase

Detailed capture of refactor intent (more thorough than polish).

**Save brief and advance:**
```
action: "set", featureId: "refactor-<slug>", updates: {
  "brief": {
    "problem": "<problem statement>",
    "goals": ["<goal1>", "<goal2>"],
    "approach": "<approach>",
    "affectedAreas": ["<areas>"],
    "outOfScope": ["<items>"],
    "successCriteria": ["<criteria>"],
    "docsToUpdate": ["<doc paths>"]
  }
}, phase: "overhaul-plan"
```

Then auto-invoke plan:
```typescript
Skill({ skill: "exarchos:plan", args: "--refactor ~/.claude/workflow-state/<feature>.state.json" })
```

### 3. Plan Phase

Invoke `/exarchos:plan` skill with explicit Skill tool call:

```typescript
Skill({ skill: "exarchos:plan", args: "--refactor ~/.claude/workflow-state/<feature>.state.json" })
```

The `/exarchos:plan` skill:
- Extracts tasks from the brief
- Focuses on incremental, testable changes
- Each task leaves code in working state
- Dependency order matters more for refactors

**Save plan and advance:**
```
action: "set", featureId: "refactor-<slug>", updates: {
  "artifacts": { "plan": "<plan-file-path>" },
  "tasks": [{ "id": "001", "title": "...", "status": "pending", "branch": "...", "blockedBy": [] }, ...]
}, phase: "overhaul-delegate"
```

> **Note:** There is no `plan-review` phase in the refactor HSM. Overhaul goes directly `overhaul-plan` -> `overhaul-delegate`.

Then auto-invoke delegate:
```typescript
Skill({ skill: "exarchos:delegate", args: "~/.claude/workflow-state/<feature>.state.json" })
```

### 4. Delegate Phase

Invoke `/exarchos:delegate` skill for TDD implementation in worktrees:

```typescript
Skill({ skill: "exarchos:delegate", args: "~/.claude/workflow-state/<feature>.state.json" })
```

The `/exarchos:delegate` skill:
- Creates worktrees for each task
- Dispatches subagents via Task tool with `model: "opus"`
- Uses implementer prompt template for full context
- Parallel execution where dependencies allow
- Tracks progress in state file

**Advance to review:**
```
action: "set", featureId: "refactor-<slug>", phase: "overhaul-review"
```

Then auto-invoke review:
```typescript
Skill({ skill: "exarchos:review", args: "~/.claude/workflow-state/<feature>.state.json" })
```

### 5. Review Phase

Invoke `/exarchos:review` skill with emphasis on quality:

```typescript
Skill({ skill: "exarchos:review", args: "~/.claude/workflow-state/<feature>.state.json" })
```

The `/exarchos:review` skill:
- Quality review is emphasized for refactors
- Refactors are high regression risk
- Verifies structure matches brief goals

**Advance to doc updates:**
```
action: "set", featureId: "refactor-<slug>", phase: "overhaul-update-docs"
```

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

**Mark docs updated and advance:**
```
action: "set", featureId: "refactor-<slug>", updates: {
  "validation": { "docsUpdated": true },
  "artifacts": { "updatedDocs": ["<doc paths>"] }
}, phase: "synthesize"
```

Then auto-invoke synthesize:
```typescript
Skill({ skill: "exarchos:synthesize", args: "<feature-name>" })
```

### 7. Synthesize Phase

Invoke `/exarchos:synthesize` skill:

```typescript
Skill({ skill: "exarchos:synthesize", args: "<feature-name>" })
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

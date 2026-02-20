---
name: polish-track
---

# Polish Track — Detailed Phase Guide

## Purpose

Fast path for small, contained refactors. Single session, minimal ceremony. Orchestrator may write implementation code directly (exception to orchestrator constraints).

## Phases

```
Explore -> Brief -> Implement -> Validate -> Update Docs -> Complete
   |         |          |           |             |
   |         |          |           |             +-- Update affected documentation
   |         |          |           +-- Run tests, verify goals met
   |         |          +-- Direct implementation (no worktree)
   |         +-- Capture goals and approach in state
   +-- Quick scope assessment, confirm polish-appropriate
```

### 1. Explore Phase

Use `@skills/refactor/references/explore-checklist.md` to assess:
- Current code structure
- Files/modules affected (must be <=5 for polish)
- Test coverage of affected areas
- Documentation that needs updates
- Confirm polish is appropriate

**Initialize workflow:**
```
action: "init", featureId: "refactor-<slug>", workflowType: "refactor"
```

**Set track and scope assessment:**
```
action: "set", featureId: "refactor-<slug>", updates: {
  "track": "polish",
  "explore": {
    "startedAt": "<ISO8601>",
    "scopeAssessment": {
      "filesAffected": ["<paths>"],
      "modulesAffected": ["<modules>"],
      "testCoverage": "good | gaps | none",
      "recommendedTrack": "polish"
    }
  }
}, phase: "brief"
```

### 2. Brief Phase

Capture refactor intent and approach in state (not separate document).

Use `@skills/refactor/references/brief-template.md` to structure:
- Problem statement (2-3 sentences)
- Specific goals (bulleted list)
- High-level approach
- Out of scope items
- Success criteria
- Docs to update

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
}, phase: "polish-implement"
```

### 3. Implement Phase

**Orchestrator may write code directly** (polish track exception).

Constraints:
- Follow TDD (write/update test first if behavior changes)
- Commit after each logical change
- Stop if scope expands beyond brief

When done, commit via Graphite:
```typescript
mcp__graphite__run_gt_cmd({ args: ["create", "-m", "refactor: <description>"], cwd: "<repo-root>" })
```

**Advance to validation:**
```
action: "set", featureId: "refactor-<slug>", phase: "polish-validate"
```

### 4. Validate Phase

Verify scope hasn't expanded beyond polish limits:

```bash
bash scripts/check-polish-scope.sh --repo-root <path>
```

**On Exit 0:** Scope OK — stay on polish track.
**On Exit 1:** Scope expanded — switch to overhaul track.

Then run the refactor validation:

```bash
bash scripts/validate-refactor.sh --repo-root <path>
```

**On Exit 0:** All checks pass (tests, lint, typecheck).
**On Exit 1:** One or more checks failed — fix before proceeding.

**Save validation results and advance:**
```
action: "set", featureId: "refactor-<slug>", updates: {
  "validation": { "testsPass": true, "goalsVerified": ["<verified goals>"] }
}, phase: "polish-update-docs"
```

### 5. Update Docs Phase

**Mandatory** - documentation must reflect new architecture.

Use `@skills/refactor/references/doc-update-checklist.md` to update:
- Architecture docs if structure changed
- API docs if interfaces changed
- README if setup/usage changed
- Inline comments if complex logic moved

If `docsToUpdate` is empty, verify no docs need updating.

**Mark docs updated and complete:**
```
action: "set", featureId: "refactor-<slug>", updates: {
  "validation": { "docsUpdated": true },
  "artifacts": { "updatedDocs": ["<doc paths>"] }
}, phase: "completed"
```

> **Note:** The HSM transitions directly from `polish-update-docs` to `completed`. There is no `synthesize` phase for polish track.

## Auto-Chain

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

## Completion Criteria

- [ ] Scope assessment completed (<=5 files)
- [ ] Brief goals captured
- [ ] Implementation complete
- [ ] All tests pass
- [ ] Each goal verified
- [ ] Documentation updated
- [ ] User confirmed completion

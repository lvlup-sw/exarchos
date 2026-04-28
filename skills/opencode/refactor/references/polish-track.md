# Polish Track — Detailed Phase Guide

## Purpose

Fast path for small, contained refactors. Single session, minimal ceremony. Orchestrator may write implementation code directly (exception to orchestrator constraints).

## Phases

```
explore -> brief -> polish-implement -> polish-validate -> polish-update-docs -> completed
   |         |          |                    |                    |
   |         |          |                    |                    +-- Update affected documentation
   |         |          |                    +-- Run tests, verify goals met
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

**Set track and scope assessment, then transition to brief:**

Before calling `set`, query the required guard shape:
```
exarchos_workflow({ action: "describe", playbook: "refactor" })
```
Use the returned guard requirements for the `explore → brief` transition to construct your `set` call with the correct fields.

### 2. Brief Phase

Capture refactor intent and approach in state (not separate document).

Use `@skills/refactor/references/brief-template.md` to structure:
- Problem statement (2-3 sentences)
- Specific goals (bulleted list)
- High-level approach
- Out of scope items
- Success criteria
- Docs to update

**Save brief and advance to polish-implement:**

Call `exarchos_workflow({ action: "describe", playbook: "refactor" })` for the `brief → polish-implement` guard requirements, then `set` the required fields (brief) and phase.

### 3. Implement Phase

**Orchestrator may write code directly** (polish track exception).

Constraints:
- Follow TDD (write/update test first if behavior changes)
- Commit after each logical change
- Stop if scope expands beyond brief

When done, commit and push:
```bash
git add <files>
git commit -m "refactor: <description>"
git push -u origin refactor/<brief-name>
```

**Advance to validation:**

Call `exarchos_workflow({ action: "describe", playbook: "refactor" })` for the `polish-implement → polish-validate` guard requirements, then `set` the phase.

### 4. Validate Phase

Verify scope hasn't expanded beyond polish limits:

```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "check_polish_scope",
  repoRoot: "<path>"
})
```

**On `passed: true`:** Scope OK — stay on polish track.
**On `passed: false`:** Scope expanded — switch to overhaul track.

Then run the refactor validation via the static analysis gate:

```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "check_static_analysis",
  featureId: "refactor-<slug>",
  repoRoot: "<path>"
})
```

**On `passed: true`:** All static analysis checks pass (lint, typecheck).
**On `passed: false`:** One or more static analysis checks failed — fix before proceeding.

**Save validation results and advance to polish-update-docs:**

Call `exarchos_workflow({ action: "describe", playbook: "refactor" })` for the `polish-validate → polish-update-docs` guard requirements, then `set` the required fields (validation) and phase.

### 5. Update Docs Phase

**Mandatory** - documentation must reflect new architecture.

Use `@skills/refactor/references/doc-update-checklist.md` to update:
- Architecture docs if structure changed
- API docs if interfaces changed
- README if setup/usage changed
- Inline comments if complex logic moved

If `docsToUpdate` is empty, verify no docs need updating.

**Mark docs updated and complete:**

Call `exarchos_workflow({ action: "describe", playbook: "refactor" })` for the `polish-update-docs → completed` guard requirements, then `set` the required fields (validation, artifacts) and phase.

> **Note:** The HSM transitions directly from `polish-update-docs` to `completed`. There is no `synthesize` phase for polish track.

## Auto-Chain

```
explore -> brief -> polish-implement -> polish-validate -> polish-update-docs -> completed
           (auto)   (auto)              (auto)             (auto)                (auto)
```

**Next actions:**
- `AUTO:brief` after explore
- `AUTO:polish-implement` after brief
- `AUTO:polish-validate` after polish-implement
- `AUTO:polish-update-docs` after polish-validate
- `AUTO:completed` after polish-update-docs

## Completion Criteria

- [ ] Scope assessment completed (<=5 files)
- [ ] Brief goals captured
- [ ] Implementation complete
- [ ] All tests pass
- [ ] Each goal verified
- [ ] Documentation updated
- [ ] User confirmed completion

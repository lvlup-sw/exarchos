---
description: Start refactor workflow for code improvement
---

# Refactor

Start refactor workflow for: "$ARGUMENTS"

## Workflow Overview

Refactor workflows are **exploration-first**: understand scope before committing to a track.

```
/refactor → Explore → Brief → [Implement|Plan] → Validate → Update Docs → [CONFIRM]
                                    │
                   ┌────────────────┼────────────────┐
                   │                                 │
              --polish                          (default)
           (direct, ≤5 files)               (full delegation)
```

**Single human checkpoint:** Completion confirmation (polish) or merge confirmation (overhaul).

## Skill Reference

Follow the refactor skill: `@skills/refactor/SKILL.md`

## Command Variants

### Default: Overhaul Track

```bash
/refactor "Restructure the authentication module into separate concerns"
```

Full delegation workflow with worktree isolation.

### Fast Path: Polish Track

```bash
/refactor --polish "Extract validation logic into utility functions"
```

Direct implementation, <=5 files, single concern.

### Explore First

```bash
/refactor --explore "Not sure of scope, assess first"
```

Explore to assess scope, then decide track.

### Mid-Workflow: Switch to Overhaul

```bash
/refactor --switch-overhaul
```

Switch from polish to overhaul if scope expands.

## Process

### Step 1: Initialize State

Initialize workflow state using `mcp__exarchos__exarchos_workflow` with `action: "init"`, featureId `refactor-<slug>`, and workflowType `refactor`.

### Step 2: Explore

Assess scope using `@skills/refactor/references/explore-checklist.md`:

1. **What code is affected?**
2. **How many files/modules?**
3. **What is the test coverage?**
4. **What documentation needs updating?**

Select track based on scope assessment.

### Step 3: Execute Track

**Polish Track:**
- Brief (capture goals in state)
- Implement directly (orchestrator may write code)
- Validate (tests pass, goals met)
- Update docs
- Completion checkpoint

**Overhaul Track:**
- Brief (detailed goals and approach)
- Plan (extract tasks via `/plan`)
- Delegate (TDD in worktrees via `/delegate`)
- Review (quality review via `/review`)
- Update docs
- Synthesize (PR via `/synthesize`)
- Merge checkpoint

## Arguments

| Argument | Effect |
|----------|--------|
| `<description>` | Refactor description for scope context |
| `--polish` | Select polish track (<=5 files, single concern) |
| `--explore` | Explore scope before selecting track |
| `--switch-overhaul` | Switch from polish to overhaul mid-workflow |

## State Management

Refactor workflows use extended state schema. See `@skills/refactor/SKILL.md` for full schema.

Key fields:
- `workflowType: "refactor"`
- `track: "polish" | "overhaul"`
- `explore: { scopeAssessment }`
- `brief: { problem, goals, approach, successCriteria }`
- `validation: { testsPass, goalsVerified, docsUpdated }`

## Auto-Chain Behavior

Both tracks auto-chain through phases with ONE human checkpoint.

**Polish:**
```
explore → brief → implement → validate → update-docs → [HUMAN: complete]
          (auto)   (auto)      (auto)     (auto)
```

**Overhaul:**
```
explore → brief → plan → delegate → review → update-docs → synthesize → [HUMAN: merge]
          (auto)  (auto)  (auto)    (auto)   (auto)        (auto)
```

## Resume Support

Refactor workflows resume like other workflows:

```bash
/resume docs/workflow-state/refactor-<slug>.state.json
```

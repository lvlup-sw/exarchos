---
description: Start debug workflow for bugs and regressions
---

# Debug

Start debug workflow for: "$ARGUMENTS"

## Workflow Overview

Debug workflows are **investigation-first**: understand the problem before fixing it.

```
/exarchos:debug → Triage → Investigate → [Fix] → Validate → [CONFIRM] → merge
                              │
                ┌─────────────┼─────────────┐
                │             │             │
           --hotfix      (default)     --escalate
                │             │             │
           Fast path    Thorough path   → /exarchos:ideate
    (15 min)     (full RCA)
```

**Single human checkpoint:** Merge confirmation (after fix is validated).

## Skill Reference

Follow the debug skill: `@skills/debug/SKILL.md`

## Command Variants

### Default: Thorough Track

```bash
/exarchos:debug "Users report cart total is wrong after removing items"
```

Full investigation with RCA documentation.

### Fast Path: Hotfix Track

```bash
/exarchos:debug --hotfix "Production login is returning 500 errors"
```

Time-boxed investigation (15 min), minimal ceremony.

### Escalate: Feature Workflow Handoff

```bash
/exarchos:debug --escalate "This requires redesigning the auth system"
```

Hands off to `/exarchos:ideate` with preserved context.

### Mid-Workflow: Switch to Thorough

```bash
/exarchos:debug --switch-thorough
```

Switch from hotfix to thorough track during investigation.

## Process

### Step 1: Initialize State

Initialize workflow state using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "init"`:
- Set `featureId` to `debug-<issue-slug>`
- Set `workflowType` to "debug"

Then update the track using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "set"`:
- Set `track` to "hotfix" or "thorough" based on triage

### Step 2: Triage

Gather context using `@skills/debug/references/triage-questions.md`:

1. **What is the symptom?**
2. **Can it be reproduced?**
3. **What is the impact/urgency?**
4. **What area of code is likely affected?**

Select track based on urgency and complexity.

### Step 3: Execute Track

**Hotfix Track:**
- Investigate (15 min max)
- Implement minimal fix
- Smoke test
- Merge checkpoint

**Thorough Track:**
- Investigate (no time limit)
- Document RCA
- Design fix approach
- Implement with TDD
- Spec review
- Create PR
- Merge checkpoint

## Arguments

| Argument | Effect |
|----------|--------|
| `<description>` | Bug description for triage context |
| `--hotfix` | Select hotfix track (P0 urgency) |
| `--escalate` | Hand off to /exarchos:ideate workflow |
| `--switch-thorough` | Switch from hotfix to thorough mid-workflow |

## State Management

Debug workflows use extended state schema. See `@skills/debug/references/state-schema.md`.

Key fields:
- `workflowType: "debug"`
- `track: "hotfix" | "thorough"`
- `urgency: { level, justification }`
- `triage: { symptom, reproduction, affectedArea, impact }`
- `investigation: { rootCause, findings }`

## Auto-Chain Behavior

Debug workflows auto-chain through phases with ONE human checkpoint.

**Both tracks:**
```
[all phases auto-chain] → merge confirmation (HUMAN)
```

## Resume Support

Debug workflows resume via MCP auto-discovery:

```bash
/exarchos:rehydrate
```

## When to Use /exarchos:debug vs /exarchos:refactor

| Signal | Use /exarchos:debug | Use /exarchos:refactor |
|--------|-----------|---------------|
| Something is broken or wrong | Yes | No |
| Code works but is messy/complex | No | Yes |
| Users report a bug or regression | Yes | No |
| Performance degradation | Start with /exarchos:debug (investigate) | Escalate to /exarchos:refactor if structural |
| "This should be reorganized" | No | Yes |
| Error in production logs | Yes | No |

**Rule of thumb:** If there is a _symptom_ (something that should work but doesn't), use `/exarchos:debug`. If there is _dissatisfaction_ with working code (hard to read, violates SOLID, duplicated logic), use `/exarchos:refactor`.

## Related

- RCA template: `@skills/debug/references/rca-template.md`
- Triage questions: `@skills/debug/references/triage-questions.md`
- Investigation checklist: `@skills/debug/references/investigation-checklist.md`
- State schema: `@skills/debug/references/state-schema.md`

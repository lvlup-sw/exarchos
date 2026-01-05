---
description: Start collaborative design exploration for a feature or problem
---

# Ideate

Begin brainstorming session for: "$ARGUMENTS"

## Workflow Overview

This command is the **entry point** of the development workflow:

```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge
            ↑           (auto)    ▲ (auto)  (auto)     (auto)          │
            │                     │                                    │
            │   ON FAIL ──────────┤                                    │
            │   --pr-fixes ───────┴────────────────────────────────────┘
            └──────────── ON BLOCKED ──────────────────────────────────┘
```

**Confirmation points:**
- After `/ideate`: User confirms before implementation planning begins
- After `/synthesize`: User confirms before PR is merged (or requests feedback fixes)

## Skill Reference

Follow the brainstorming skill: `@skills/brainstorming/SKILL.md`

## Process

### Phase 1: Understanding
Ask clarifying questions (one at a time):
1. What problem are we solving?
2. What constraints exist?
3. What patterns already exist in the codebase?
4. Who/what will consume this?
5. What does success look like?

### Phase 2: Exploration
Present 2-3 distinct approaches with:
- Approach description
- Pros and cons
- Best use case
- Recommendation with rationale

### Phase 3: Design Presentation
After user selects approach:
- Write detailed design (200-300 word sections)
- Include diagrams if helpful
- Save to `docs/designs/YYYY-MM-DD-<feature>.md`

## State Management

Initialize workflow state at the start:

```bash
~/.claude/scripts/workflow-state.sh init <feature-id>
```

After saving design, update state:

```bash
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.artifacts.design = "<design-path>" | .phase = "plan"'
```

## Output

Save design to `docs/designs/YYYY-MM-DD-<feature>.md` and capture the path as `$DESIGN_PATH`.

## Human Checkpoint

After saving the design document, this is a **human checkpoint** - user confirmation required.

This is one of only TWO human checkpoints in the workflow:
1. Here (design confirmation)
2. After `/synthesize` (merge confirmation)

## Auto-Chain

After saving the design document:

1. Update state with design path
2. Output: "Design saved to `$DESIGN_PATH`."
3. **PAUSE for user input**: "Continue to implementation planning? (yes/no)"

4. **On 'yes'** (yes, y, continue, proceed):
   ```typescript
   Skill({ skill: "plan", args: "$DESIGN_PATH" })
   ```
   From here, workflow runs autonomously until PR merge confirmation.

5. **On 'no'**: "Workflow paused. Run `/plan $DESIGN_PATH` or `/resume` to continue later."

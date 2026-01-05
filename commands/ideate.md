---
description: Start collaborative design exploration for a feature or problem
---

# Ideate

Begin brainstorming session for: "$ARGUMENTS"

## Workflow Overview

This command is the **entry point** of the development workflow:

```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge
            ↑           (auto)   (auto)    (auto)     (auto)           ↓
            └──────────── ON BLOCKED ────────────────────────────────────┘
                          ON FAIL → /delegate --fixes (auto)
```

**Confirmation points:**
- After `/ideate`: User confirms before implementation planning begins
- After `/synthesize`: User confirms before PR is merged

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

## Output

Save design to `docs/designs/YYYY-MM-DD-<feature>.md` and capture the path as `$DESIGN_PATH`.

## Auto-Chain

After saving the design document:

1. Summarize: "Design saved to `$DESIGN_PATH`."
2. Ask: "Continue to implementation planning with `/plan`? (yes/no)"
3. On user confirmation (yes, y, continue, proceed):
   ```typescript
   Skill({ skill: "plan", args: "$DESIGN_PATH" })
   ```
4. On decline: "No problem. Run `/plan $DESIGN_PATH` when ready."

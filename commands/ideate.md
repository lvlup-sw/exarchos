---
description: Start collaborative design exploration for a feature or problem
---

# Ideate

Begin brainstorming session for: "$ARGUMENTS"

## Workflow Overview

This command is the **entry point** of the development workflow:

```
/exarchos:ideate → /exarchos:plan → [CONFIRM] → /exarchos:delegate → /exarchos:review → /exarchos:synthesize → [CONFIRM] → merge
  ▲▲▲▲▲▲▲▲▲▲▲▲▲▲     (auto)            ↑             (auto)              (auto)             (auto)                     │
                        │                     ▲                         │
                        │   ON FAIL ──────────┤                         │
                        │   --pr-fixes ───────┴─────────────────────────┘
                        └──────────── ON BLOCKED ───────────────────────┘
```

**Confirmation points:**
- After `/exarchos:plan` (plan-review): User confirms implementation plan before delegation begins
- After `/exarchos:synthesize`: User confirms before PR is merged (or requests feedback fixes)

## Skill Reference

Follow the brainstorming skill: `@skills/brainstorming/SKILL.md`

## Process

### Phase 0: Constraints (first turn)

Before the clarifying questions, load the machine-readable invariants catalog at `docs/architecture/invariants.md` and surface a **Constraints** section naming the invariants and dimensions relevant to the proposal. For a CLI-shaped or agent-surface proposal, this typically includes `INV-5a` (input ergonomics), `INV-5b` (output contract), `INV-5c` (Aspire-style verbs), `INV-5d` (action discriminator), and `DIM-1` (topology). For an event-store or projection proposal, surface `INV-1` plus `DIM-1` / `DIM-3`. The brainstorming skill's "Constraint anchoring" subsection describes the selection rules.

Emit the Constraints section *before* Phase 1 so the clarifying questions can probe the proposal against the load-bearing invariants instead of re-discovering them mid-design.

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

Initialize workflow state at the start using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "init"`, `featureId`, and `workflowType: "feature"`.

After saving design, update state using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
- Set `artifacts.design` to the design path
- Set `phase` to "plan"

## Output

Save design to `docs/designs/YYYY-MM-DD-<feature>.md` and capture the path as `$DESIGN_PATH`.

## Auto-Chain

After saving the design document, **auto-continue to planning** (no user confirmation here):

1. Update state with design path and phase using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
   - Set `artifacts.design` to the design document path
   - Set `phase` to "plan"

2. Output: "Design saved. Auto-continuing to implementation planning..."

3. Invoke immediately:
   ```typescript
   Skill({ skill: "exarchos:plan", args: "$DESIGN_PATH" })
   ```

This is NOT a human checkpoint. The human checkpoint occurs after plan review (plan-design delta analysis), before delegation.

**Workflow continues:** `/exarchos:ideate` → `/exarchos:plan` → plan-review → [HUMAN CHECKPOINT] → `/exarchos:delegate`

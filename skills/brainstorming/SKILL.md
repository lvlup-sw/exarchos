# Brainstorming Skill

## Overview

Collaborative design exploration for new features, architecture decisions, and complex problem-solving.

## Triggers

Activate this skill when:
- User says "let's brainstorm", "let's ideate", or "let's explore"
- User runs `/ideate` command
- User wants to discuss design options before implementation
- A problem has multiple valid solutions needing evaluation

## Three-Phase Process

### Phase 1: Understanding

**Goal:** Deeply understand the problem before proposing solutions.

**Rules:**
- Ask ONE question at a time
- Wait for response before asking next question
- Focus on: goals, constraints, existing patterns, user preferences
- Maximum 5 questions before moving to exploration

**Question Types:**
1. "What problem are we solving?" (core need)
2. "What constraints exist?" (time, tech, compatibility)
3. "What patterns already exist in the codebase?" (consistency)
4. "Who/what will consume this?" (users, APIs, other systems)
5. "What does success look like?" (acceptance criteria)

### Phase 2: Exploration

**Goal:** Present 2-3 distinct approaches with trade-offs.

**Format for each approach:**
```markdown
### Option [N]: [Name]

**Approach:** [2-3 sentence description]

**Pros:**
- [Benefit 1]
- [Benefit 2]

**Cons:**
- [Drawback 1]
- [Drawback 2]

**Best when:** [Scenario where this option excels]
```

**Rules:**
- Present genuinely different approaches (not variations of same idea)
- Be honest about trade-offs
- Include at least one "simple but limited" option
- Include at least one "flexible but complex" option
- Recommend one option but explain why

### Phase 3: Design Presentation

**Goal:** Document the chosen approach in detail.

**Format:**
- Sections of 200-300 words maximum
- Use diagrams (ASCII or Mermaid) for complex flows
- Include concrete examples
- Reference existing codebase patterns

**Design Document Structure:**
```markdown
# Design: [Feature Name]

## Problem Statement
[What we're solving and why]

## Chosen Approach
[Selected option with rationale]

## Technical Design
[Implementation details, data structures, APIs]

## Integration Points
[How this connects to existing code]

## Testing Strategy
[How we'll verify it works]

## Open Questions
[Decisions deferred or needing input]
```

**Save Location:** `docs/designs/YYYY-MM-DD-<feature>.md`

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Jump to solution immediately | Ask clarifying questions first |
| Present only one option | Always show 2-3 alternatives |
| Hide drawbacks of preferred option | Be transparent about trade-offs |
| Write walls of text | Use 200-300 word sections max |
| Ignore existing patterns | Reference codebase conventions |
| Skip documentation | Save design to docs/designs/ |

## State Management

This skill manages workflow state for context persistence.

### On Start (before Phase 1)

Initialize workflow state using `mcp__workflow-state__workflow_init` with the featureId.

This creates a state file tracked by the MCP server.

### On Design Save (after Phase 3)

Update state with design artifact using `mcp__workflow-state__workflow_set`:
- Set `artifacts.design` to the design path
- Set `phase` to "plan"

## Completion Criteria

- [ ] Problem is clearly understood (Phase 1 complete)
- [ ] 2-3 distinct options presented with trade-offs
- [ ] User has selected an approach
- [ ] Design document saved to `docs/designs/`
- [ ] State file created and updated with design path
- [ ] Ready for implementation planning

## Transition

After brainstorming completes, **auto-continue to planning** (no user confirmation):

1. Update state with design path and phase using `mcp__workflow-state__workflow_set`:
   - Set `artifacts.design` to the design path
   - Set `phase` to "plan"

2. Output: "Design saved. Auto-continuing to implementation planning..."

3. Invoke immediately:
   ```typescript
   Skill({ skill: "plan", args: "<design-path>" })
   ```

This is NOT a human checkpoint. The human checkpoint occurs at plan-review (plan approval) and synthesize (merge confirmation).

**Workflow continues:** `/ideate` → `/plan` → plan-review → [HUMAN CHECKPOINT] → `/delegate` → `/integrate` → `/review` → `/synthesize` → [HUMAN CHECKPOINT]

---
name: brainstorming
description: "Collaborative design exploration for new features and architecture decisions. Use when the user says \"let's brainstorm\", \"let's ideate\", \"explore options\", or runs /ideate. Presents 2-3 distinct approaches with trade-offs, then documents the chosen approach as a design document. Do NOT use for implementation planning or code review. Use when no design document exists yet for the target feature. Do NOT use if a design document already exists — use /plan instead."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: ideate
---

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

### Exploration Quality Gate

Stop Phase 2 when ALL are true:
- [ ] 2-3 approaches documented
- [ ] Each answers design questions from Phase 1
- [ ] Approaches differ in at least 2 of: {data structure, API design, complexity}
- [ ] Trade-offs are honest and specific
- [ ] One approach recommended with rationale

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

Initialize workflow state using `mcp__exarchos__exarchos_workflow` with `action: "init"` and the featureId.

This creates a state file tracked by the MCP server.

### On Design Save (after Phase 3)

Update state with design artifact using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Set `artifacts.design` to the design path
- Set `phase` to "plan"

## Completion Verification

Run the ideation artifact verification:

```bash
scripts/verify-ideate-artifacts.sh --state-file <state-file> --docs-dir docs/designs
```

**On exit 0:** All completion criteria met — proceed to /plan.
**On exit 1:** Missing artifacts — review output and complete before continuing.

## Transition

After brainstorming completes, **auto-continue to planning** (no user confirmation):

### Pre-Chain Validation (MANDATORY)

Before invoking `/plan`:
1. Verify `artifacts.design` exists in workflow state
2. Verify the design file exists on disk: `test -f "$DESIGN_PATH"`
3. If either fails: "Design artifact not found, cannot auto-chain to /plan"

### Chain Steps

1. Update state with design path and phase using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
   - Set `artifacts.design` to the design path
   - Set `phase` to "plan"

2. Output: "Design saved. Auto-continuing to implementation planning..."

3. Invoke immediately:
   ```typescript
   Skill({ skill: "plan", args: "<design-path>" })
   ```

This is NOT a human checkpoint. The human checkpoint occurs at plan-review (plan approval) and synthesize (merge confirmation).

**Workflow continues:** `/ideate` -> `/plan` -> plan-review -> [HUMAN CHECKPOINT] -> `/delegate` -> `/review` -> `/synthesize` -> [HUMAN CHECKPOINT]

## Exarchos Integration

When Exarchos MCP tools are available:

1. **At workflow start:** Call `mcp__exarchos__exarchos_event` with `action: "append"` and event type `workflow.started` including featureId and workflowType

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

Use the approach format from `references/design-template.md`. Present genuinely different approaches with honest trade-offs. Recommend one option with rationale.

### Phase 3: Design Presentation

**Goal:** Document the chosen approach in detail.

Document the chosen approach using the structure in `references/design-template.md`. Sections of 200-300 words max. Use diagrams for complex flows.

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

Initialize workflow state using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "init"` and the featureId.

This creates a state file tracked by the MCP server.

### On Design Save (after Phase 3)

```
action: "set", featureId: "<id>", updates: { "artifacts": { "design": "<path>" } }, phase: "plan"
```

## Completion Verification

Run the ideation artifact verification:

```bash
scripts/verify-ideate-artifacts.sh --state-file <state-file> --docs-dir docs/designs
```

**On exit 0:** All completion criteria met — proceed to /exarchos:plan.
**On exit 1:** Missing artifacts — review output and complete before continuing.

## Transition

After brainstorming completes, **auto-continue to planning** (no user confirmation):

### Pre-Chain Validation (MANDATORY)

Before invoking `/exarchos:plan`:
1. Verify `artifacts.design` exists in workflow state
2. Verify the design file exists on disk: `test -f "$DESIGN_PATH"`
3. If either fails: "Design artifact not found, cannot auto-chain to /exarchos:plan"

### Chain Steps

1. Update state: `action: "set", featureId: "<id>", updates: { "artifacts": { "design": "<path>" } }, phase: "plan"`

2. Output: "Design saved. Auto-continuing to implementation planning..."

3. Invoke immediately:
   ```typescript
   Skill({ skill: "exarchos:plan", args: "<design-path>" })
   ```

This is NOT a human checkpoint. The human checkpoint occurs at plan-review (plan approval) and synthesize (merge confirmation).

**Workflow continues:** `/exarchos:ideate` -> `/exarchos:plan` -> plan-review -> [HUMAN CHECKPOINT] -> `/exarchos:delegate` -> `/exarchos:review` -> `/exarchos:synthesize` -> [HUMAN CHECKPOINT]

## Exarchos Integration

When Exarchos MCP tools are available:

1. **At workflow start:** Auto-emitted by `exarchos_workflow` `action: "init"` — do NOT manually append `workflow.started`

---
name: brainstorming
description: "Collaborative design exploration for new features and architecture decisions. Triggers: 'brainstorm', 'ideate', 'explore options', or /ideate. Presents 2-3 approaches with trade-offs, documents chosen approach. Do NOT use for implementation planning or code review. Requires no existing design document — use /plan if one exists."
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
- User runs `ideate` command
- User wants to discuss design options before implementation
- A problem has multiple valid solutions needing evaluation

For a complete worked example, see `references/worked-example.md`.

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

**Goal:** Document the chosen approach in detail with numbered requirements.

Document the chosen approach using the structure in `references/design-template.md`. Sections of 200-300 words max. Use diagrams for complex flows.

**Requirements format (MANDATORY):**
- Use numbered requirement identifiers: `DR-1`, `DR-2`, ..., `DR-N`
- Each requirement MUST have an `**Acceptance criteria:**` block with concrete, testable criteria
- At least one requirement MUST address error handling, failure modes, or edge cases
- These DR-N identifiers are provenance anchors — implementation plans trace tasks to them

**Save Location:** `docs/designs/YYYY-MM-DD-<feature>.md`

## Iteration Limits

**Design iterations: max 3.** If Phase 2 (Exploration) cycles through 3 rounds of presenting approaches without the user converging on a choice, pause and summarize the trade-offs for the user to make a final decision.

The user can override: `ideate --max-iterations 5`

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

Initialize workflow state using `mcp__exarchos__exarchos_workflow` with `action: "init"`, `workflowType: "feature"`, and the featureId.

This creates a state file tracked by the MCP server.

### On Design Save (after Phase 3)

```
action: "set", featureId: "<id>", updates: { "artifacts": { "design": "<path>" } }, phase: "plan"
```

### Phase Transitions and Guards

This skill is the entry point for the **feature workflow** (`workflowType: "feature"`). The full lifecycle is:

```
ideate → plan → plan-review → delegate ⇄ review → synthesize → completed
```

For the full transition table, consult `@skills/workflow-state/references/phase-transitions.md`.

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["set", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "feature" })`
for phase transitions, guards, and playbook guidance.

## Completion Verification

Run the ideation artifact verification:

```typescript
mcp__exarchos__exarchos_orchestrate({
  action: "check_design_completeness",
  featureId: "<featureId>",
  designPath: "docs/designs/YYYY-MM-DD-<feature>.md"
})
```

**On `passed: true`:** All completion criteria met — proceed to gate check.
**On `passed: false`:** Missing artifacts — review output and complete before continuing. If the check is advisory (`advisory: true`), emit a warning but do not block auto-chain.

## Adversarial Gate Check (ideate → plan)

After artifact verification passes, run the design completeness gate check. This is the D1 (spec fidelity) lightweight adversarial check at the ideate → plan boundary.

```typescript
mcp__exarchos__exarchos_orchestrate({
  action: "check_design_completeness",
  featureId: "<id>",
  designPath: "<path>"
})
```

The handler returns a structured result: `{ passed, advisory, findings[], checkCount, passCount, failCount }`.

- **`passed=true`:** Design complete — all requirements have acceptance criteria and error coverage.
- **`passed=false, advisory=true`:** Findings detected. These are advisory — they do NOT block the auto-chain to `plan`. Present `result.data.findings` to the user alongside the transition message.

Gate events (`gate.executed`) are emitted automatically by the handler — no manual event emission is needed.

## Transition

After brainstorming completes, **auto-continue to planning** (no user confirmation):

### Pre-Chain Validation (MANDATORY)

Before invoking `plan`:
1. Verify `artifacts.design` exists in workflow state
2. Verify the design file exists on disk: `test -f "$DESIGN_PATH"`
3. Run `mcp__exarchos__exarchos_orchestrate({ action: "check_design_completeness", featureId: "<id>", designPath: "<path>" })` (advisory — record findings but don't block)
4. If steps 1 or 2 fail: "Design artifact not found, cannot auto-chain to plan"

### Chain Steps

1. Update state: `action: "set", featureId: "<id>", updates: { "artifacts": { "design": "<path>" } }, phase: "plan"`

2. If `result.data.passed === false` and `result.data.advisory === true`: Output `result.data.findings` summary, then: "Advisory findings noted. Auto-continuing to implementation planning..."
   If `result.data.passed === true`: Output: "Design complete. Auto-continuing to implementation planning..."

3. Invoke immediately:
   ```typescript
   [Invoke the exarchos:plan skill with args: <design-path>]
   ```

This is NOT a human checkpoint. The human checkpoint occurs at plan-review (plan approval) and synthesize (merge confirmation).

**Workflow continues:** `ideate` -> `plan` -> plan-review -> [HUMAN CHECKPOINT] -> `delegate` -> `review` -> `synthesize` -> [HUMAN CHECKPOINT]

## Exarchos Integration

When Exarchos MCP tools are available:

1. **At workflow start:** Auto-emitted by `exarchos_workflow` `action: "init"` — do NOT manually append `workflow.started`

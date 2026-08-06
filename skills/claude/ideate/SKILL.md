---
name: ideate
description: "Collaborative design exploration that authors the Design & Rationale section of the one unified docs/specs/ spec. Triggers: 'brainstorm', 'ideate', 'explore options', or /ideate. Default is a one-pass design preamble; the deep rung gates the 2-3 approach divergent loop and the discover bridge. Do NOT use for task decomposition (that is /plan, which adds Decomposition to the same doc) or code review."
metadata:
  author: exarchos
  version: 2.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: plan
---

# Brainstorming Skill

## Overview

Collaborative design exploration for new features, architecture decisions, and complex problem-solving. In the collapsed flow, there is **no separate design phase** — `/exarchos:ideate` authors the `## Design & Rationale` section of **one unified `docs/specs/` artifact**, then auto-chains to `/exarchos:plan`, which adds the `## Decomposition` section to the **same** document. The single approval point is `plan-review` (a dispatched, fresh-context adversarial pass over the unified doc).

The artifact shape is owned by the unified spec template — author against it, do not restate it: see `@skills/plan/references/spec-template.md`.

## Triggers

Activate this skill when:
- User says "let's brainstorm", "let's ideate", or "let's explore"
- User runs `/exarchos:ideate` command
- User wants to discuss design rationale before decomposition
- A problem has multiple valid solutions needing evaluation (the `deep` rung)

For a complete worked example, see `references/worked-example.md`.

## Planning depth (one-pass by default; `deep` gates the divergent loop)

The design section is authored at one of three depths, resolved-then-frozen per feature as `designDepth` on PLAN entry (the per-feature analog of per-task `riskTier`). The resolver **proposes** a depth from brief signals (uncertainty, blast-radius, task count); the author confirms or overrides. A higher rung is a strict superset of the lower.

| `designDepth` | This skill's behavior | When |
|---|---|---|
| `thin` | One-pass: Problem Statement + the DR-N list. No alternatives, no exploration. | Trivial, low-blast features where the decomposition is the substance. |
| `standard` | One-pass: full rationale (Problem, Chosen Approach, DR-N with acceptance criteria, Technical Design, Alternatives). **(default)** | Most features. |
| `deep` | The divergent loop below: 2-3 genuinely distinct approaches with honest trade-offs and human back-and-forth, **plus** the opt-in discover bridge. | High-uncertainty / high-blast-radius features where the open-design path is warranted. |

**The 2-3 approach exploration is the `deep` rung — not a default ceremony.** At `thin`/`standard`, converge in one pass; do not manufacture alternatives the problem does not warrant.

## Process

### Phase 0: Constraint anchoring (first turn, before Phase 1)

**Goal:** Surface the architectural invariants relevant to the proposal *before* the clarifying questions, so the design is anchored to load-bearing constraints from the first turn.

Load the **core** invariants catalog at `.exarchos/invariants.md` (entries marked `cost-of-load: always-load`) and surface a **Constraints** section naming the relevant invariants — e.g. a CLI / agent-first surface proposal anchors on `INV-5a` (input ergonomics) and `INV-5c` (Aspire verbs). The full selection rules — `always-load` baseline vs `reference-only` on-demand vs `archivable` not-surfaced, the proposal-shape → anchor-invariant table, the emit format, and the catalog-registration gating (surfaced only when a catalog is registered under `invariants.catalogs`) — are the **single shared source of truth** for the design-time Constraints step used by `/ideate`, `/refactor`, and `/debug`. See `@skills/ideate/references/constraint-anchoring.md`.

Emit the **Constraints** section (per that reference) *before* Phase 1 so the clarifying questions can probe the proposal against the load-bearing invariants instead of re-discovering them mid-design.

### Phase 1: Understanding

**Goal:** Deeply understand the problem before proposing a design.

**Rules:**
- Ask ONE question at a time
- Wait for response before asking next question
- Focus on: goals, constraints, existing patterns, user preferences
- Maximum 5 questions before moving on

**Question Types:**
1. "What problem are we solving?" (core need)
2. "What constraints exist?" (time, tech, compatibility)
3. "What patterns already exist in the codebase?" (consistency)
4. "Who/what will consume this?" (users, APIs, other systems)
5. "What does success look like?" (acceptance criteria)

### Phase 2: Exploration — `deep` rung only

**Goal (when `designDepth: 'deep'`):** Present 2-3 distinct approaches with honest trade-offs, recommend one, and converge through human back-and-forth.

Use the approach format from `references/design-template.md`. Present genuinely different approaches; recommend one with rationale. **Opt-in discover bridge:** at the `deep` rung the runtime publishes a discover-bridge affordance via `next_actions` (DR-7) — an event-linked, `correlationId`-stitched escalation to the `/exarchos:discover` research workflow. It **never** auto-runs; surface it to the author and only escalate on confirmation. Cite the discover report by path and `correlationId` in the Exploration section so provenance spans both documents.

At `thin`/`standard`, skip this phase — converge directly in Phase 3.

### Phase 3: Author the Design & Rationale section

**Goal:** Write the `## Design & Rationale` section of the unified `docs/specs/` artifact, at the resolved depth, using the structure in `@skills/plan/references/spec-template.md`. Sections of 200-300 words max; diagrams for complex flows.

**Requirements format (MANDATORY):**
- Use numbered requirement identifiers: `DR-1`, `DR-2`, ..., `DR-N`, under the `### Requirements (DR-N)` heading
- Each requirement MUST have an `**Acceptance criteria:**` block with concrete, testable criteria (`thin` may use a single bullet)
- At least one requirement MUST address error handling, failure modes, or edge cases
- These DR-N identifiers are provenance anchors — the `## Decomposition` section traces tasks to them **within this same document** (no second file)

**Save location:** `docs/specs/YYYY-MM-DD-<feature>.md`. Capture the path as `$SPEC_PATH`.

## Iteration Limits

**Design iterations: max 3** (the `deep` divergent loop). If Phase 2 cycles through 3 rounds without the user converging, pause and summarize the trade-offs for a final decision.

The user can override: `/exarchos:ideate --max-iterations 5`

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Jump to a solution immediately | Ask clarifying questions first |
| Manufacture 2-3 options at thin/standard | Reserve the divergent loop for the `deep` rung |
| Hide drawbacks of the preferred option | Be transparent about trade-offs |
| Write walls of text | Use 200-300 word sections max |
| Ignore existing patterns | Reference codebase conventions |
| Write a separate `docs/designs/` doc | Author the Design & Rationale § of the one `docs/specs/` artifact |
| Auto-escalate to discover | Surface the bridge; escalate only on author confirmation |

## State Management

This skill manages workflow state for context persistence.

### On Start (before Phase 1)

Initialize workflow state using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "init"`, `workflowType: "feature"`, and the featureId. The feature workflow's **initial phase is `plan`** (the former ideate/GATHER phase was collapsed into PLAN) — there is no phase to transition into here.

### On Design-Section Save (after Phase 3)

Persist the unified-spec path as `artifacts.spec` (NOT `artifacts.design` — the new flow produces one `docs/specs/` artifact):

```text
action: "update", featureId: "<id>", updates: { "artifacts": { "spec": "<docs/specs/...>" } }
```

Do **not** transition the phase here — `/exarchos:plan` finalizes the unified doc with the `## Decomposition` section and transitions `plan → plan-review`.

### Phase Transitions and Guards

This skill is the entry point for the **feature workflow** (`workflowType: "feature"`). The collapsed lifecycle is:

```text
plan → plan-review → delegate ⇄ review → synthesize → completed
```

`/exarchos:ideate` and `/exarchos:plan` both author the one `docs/specs/` artifact **within** the initial `plan` phase. For the full transition table, consult `@skills/checkpoint/references/phase-transitions.md`.

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["update", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "feature" })`
for phase transitions, guards, and playbook guidance.

## Completion & Coverage

There is **no separate design-completeness gate** in the collapsed flow — `check_design_completeness` is a deprecated alias. The design section's acceptance-criteria coverage is validated as part of `check_plan_coverage` over the unified artifact, run by `/exarchos:plan` once the `## Decomposition` section exists. Before chaining, confirm each `DR-N` carries acceptance criteria and at least one DR-N covers error handling / edge cases.

## Transition

After the Design & Rationale section is authored, **auto-continue to decomposition** (no user confirmation):

### Pre-Chain Validation (MANDATORY)

Before invoking `/exarchos:plan`:
1. Verify `artifacts.spec` exists in workflow state
2. Verify the spec file exists on disk: `test -f "$SPEC_PATH"`
3. If steps 1 or 2 fail: "Spec artifact not found, cannot auto-chain to /exarchos:plan"

### Chain Steps

1. Update state: `action: "update", featureId: "<id>", updates: { "artifacts": { "spec": "<docs/specs/...>" } }`
2. Output: "Design & Rationale section saved to the unified spec. Auto-continuing to decomposition..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "exarchos:plan", args: "$SPEC_PATH" })
   ```

This is NOT a human checkpoint. The single human checkpoint occurs at plan-review (the dispatched adversarial pass over the unified artifact) and at synthesize (merge confirmation).

**Workflow continues:** `/exarchos:ideate` -> `/exarchos:plan` -> plan-review -> [HUMAN CHECKPOINT] -> `/exarchos:delegate` -> `/exarchos:review` -> `/exarchos:synthesize` -> [HUMAN CHECKPOINT]

## Exarchos Integration

When Exarchos MCP tools are available:

1. **At workflow start:** Auto-emitted by `exarchos_workflow` `action: "init"` — do NOT manually append `workflow.started`

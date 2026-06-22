---
description: Start collaborative design exploration for a feature or problem
---

# Ideate

Begin design exploration for: "$ARGUMENTS"

## Workflow Overview

This command is the **entry point** of the development workflow. In the collapsed flow (#1581) `/ideate` and `/plan` author **one unified `docs/specs/` artifact** within the single `plan` phase — there is no separate design phase or design approval:

```text
/exarchos:ideate → /exarchos:plan → [CONFIRM] → /exarchos:delegate → /exarchos:review → /exarchos:synthesize → [CONFIRM] → merge
  ▲ Design & Rationale §  ▲ Decomposition §       ↑                      (auto)             (auto)
        (one docs/specs/ artifact)          plan-review                  │
                                       (fresh-context adversarial)  ON FAIL --pr-fixes
```

**Confirmation points:**
- After `/exarchos:plan` (plan-review): a dispatched, fresh-context adversarial pass over the unified artifact, then the user confirms before delegation begins
- After `/exarchos:synthesize`: user confirms before the PR is merged (or requests feedback fixes)

## Skill Reference

Follow the brainstorming skill: `@skills/brainstorming/SKILL.md`. The unified artifact shape is owned by `@skills/implementation-planning/references/spec-template.md`.

## Process

### Phase 0: Constraints (first turn)

Before the clarifying questions, load the **core** invariants catalog at `.exarchos/invariants.md` (entries marked `cost-of-load: always-load`) and surface a **Constraints** section naming the invariants relevant to the proposal. The selection rules (`always-load` baseline vs `reference-only` on-demand vs `archivable` not-surfaced), the proposal-shape → anchor-invariant table, the emit format, and the devCatalog gating are the **single shared source of truth** for the design-time Constraints step — the same reference used by `/refactor` and `/debug`. See `@skills/brainstorming/references/constraint-anchoring.md`.

Emit the Constraints section *before* Phase 1 so the clarifying questions can probe the proposal against the load-bearing invariants instead of re-discovering them mid-design.

**Dev-only gating (v2):** Per the shared reference, the catalog at `.exarchos/invariants.md` is **dev-invariants only** and is surfaced only when `.exarchos.yml: invariants.devCatalog: enabled` (default disabled). When this flag is unset or `disabled`, Phase 0 surfaces no Constraints section from the dev catalog — invoke Phase 1 directly.

### Phase 1: Understanding
Ask clarifying questions (one at a time):
1. What problem are we solving?
2. What constraints exist?
3. What patterns already exist in the codebase?
4. Who/what will consume this?
5. What does success look like?

### Phase 2: Exploration — `deep` rung only
The 2-3 approach divergent loop is the **`deep`** planning rung, not a default. When `designDepth` is `deep` (resolver-proposed, author-confirmed), present 2-3 distinct approaches with pros/cons and a recommendation, and surface the opt-in **discover bridge** (`next_actions`, never auto-run) to escalate to `/exarchos:discover`. At `thin`/`standard`, converge in one pass — skip this phase.

### Phase 3: Design & Rationale section
Author the `## Design & Rationale` section of the unified `docs/specs/` artifact at the resolved depth (per the spec template): Problem Statement + `### Requirements (DR-N)` with acceptance criteria (at least one DR-N covering error handling), and — at `standard`/`deep` — Chosen Approach, Technical Design, Alternatives. Save to `docs/specs/YYYY-MM-DD-<feature>.md`.

## State Management

Initialize workflow state at the start using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "init"`, `featureId`, and `workflowType: "feature"`. The feature workflow's **initial phase is `plan`** (#1581 collapsed the former `ideate`/GATHER phase) — do not transition here.

After authoring the Design & Rationale section, persist the unified-spec path as `artifacts.spec` (the new flow produces ONE artifact — not `artifacts.design`):

1. Update artifacts using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
   - Set `updates.artifacts.spec` to the `docs/specs/...` path

Do **not** transition the phase — `/exarchos:plan` adds the `## Decomposition` section to the same doc and transitions `plan → plan-review`.

## Output

Save the unified spec to `docs/specs/YYYY-MM-DD-<feature>.md` and capture the path as `$SPEC_PATH`.

## Auto-Chain

After saving the Design & Rationale section, **auto-continue to decomposition** (no user confirmation here):

1. Update artifacts via `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
   - Set `updates.artifacts.spec` to the unified spec path

2. Output: "Design & Rationale saved to the unified spec. Auto-continuing to decomposition..."

3. Invoke immediately:
   ```typescript
   Skill({ skill: "exarchos:plan", args: "$SPEC_PATH" })
   ```

This is NOT a human checkpoint. The human checkpoint occurs at plan-review (the dispatched adversarial pass over the unified artifact), before delegation.

**Workflow continues:** `/exarchos:ideate` → `/exarchos:plan` → plan-review → [HUMAN CHECKPOINT] → `/exarchos:delegate`

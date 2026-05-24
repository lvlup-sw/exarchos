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

Before the clarifying questions, load the **core** invariants catalog at `docs/architecture/invariants.md` (entries marked `cost-of-load: always-load`) and surface a **Constraints** section naming the invariants and dimensions relevant to the proposal. The always-load set is the Phase 0 working baseline; load `reference-only` entries on-demand by re-reading the same file with a topic-filtered scan if the proposal's domain warrants them (e.g., capability-resolution or remote-MCP topics pull in `INV-3`; CLI-verb design pulls in `INV-5c`; composite-tool changes pull in `INV-5d`; axiom-dimension overlap pulls in the relevant `DIM-*`). Entries marked `archivable` (e.g., axiom-owned prose checks) are not loaded at Phase 0 — they exist for vocabulary-lint cross-reference only. The brainstorming skill's "Constraint anchoring" subsection describes the selection rules.

Emit the Constraints section *before* Phase 1 so the clarifying questions can probe the proposal against the load-bearing invariants instead of re-discovering them mid-design.

**Dev-only gating (v2):** The catalog at `docs/architecture/invariants.md` is **dev-invariants only** — invariants for Exarchos's own designers, not for consumers using Exarchos as a plugin. The loader surfaces entries only when `.exarchos.yml: invariants.devCatalog: enabled` (default disabled). When this flag is unset or `disabled`, Phase 0 surfaces no Constraints section from the dev catalog — invoke Phase 1 directly. Consumer-facing SDLC invariants live in a separate (future) catalog; see `docs/proposals/2026-05-20-invariants-catalog-v2-spec.md` §1.1 and §10 for the audience-scope rationale.

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

After saving design, persist the artifact and transition the phase via two separate calls — the runtime rejects `updates.phase` (`update` is non-phase mutation only; phase changes go through the HSM-guarded `transition` action):

1. Update artifacts using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
   - Set `updates.artifacts.design` to the design path
2. Transition phase using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "transition"`:
   - Set `target: "plan"`

## Output

Save design to `docs/designs/YYYY-MM-DD-<feature>.md` and capture the path as `$DESIGN_PATH`.

## Auto-Chain

After saving the design document, **auto-continue to planning** (no user confirmation here):

1. Update artifacts via `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
   - Set `updates.artifacts.design` to the design document path

2. Transition phase via `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "transition"`:
   - Set `target: "plan"`

3. Output: "Design saved. Auto-continuing to implementation planning..."

4. Invoke immediately:
   ```typescript
   Skill({ skill: "exarchos:plan", args: "$DESIGN_PATH" })
   ```

This is NOT a human checkpoint. The human checkpoint occurs after plan review (plan-design delta analysis), before delegation.

**Workflow continues:** `/exarchos:ideate` → `/exarchos:plan` → plan-review → [HUMAN CHECKPOINT] → `/exarchos:delegate`

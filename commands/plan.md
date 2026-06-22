---
description: Decompose the unified docs/specs/ artifact into verification-laddered tasks
---

# Plan

Author the Decomposition section for: "$ARGUMENTS"

## Workflow Position

```text
/exarchos:ideate → /exarchos:plan → [CONFIRM] → /exarchos:delegate → /exarchos:review → /exarchos:synthesize → [CONFIRM] → merge
  Design & Rationale §  Decomposition §   ↑
       (one docs/specs/ artifact)    plan-review
```

`/ideate` and `/plan` author **one unified `docs/specs/` artifact** within the single `plan` phase. After the Decomposition section is saved, plan-review runs as a **dispatched, fresh-context adversarial** pass over that artifact (DR-10). User confirms at the plan-review checkpoint before delegation.

## Skill Reference

Follow the implementation-planning skill: `@skills/implementation-planning/SKILL.md`. The unified artifact shape is owned by `@skills/implementation-planning/references/spec-template.md`.

## Verification Ladder

Verification depth scales with each task's **blast radius** — it is not a blanket failing-test-first rule (#1587). Stamp every task with a `riskTier`; the depth follows:

- **low** — static analysis (typecheck + lint); no tests required.
- **medium** — scoped tests + the `check_test_adequacy` kill-probe, judged test-after.
- **high** — the medium set + the integration suite across the seam.

See `@skills/_shared/references/verification.md` and the reframed `@skills/implementation-planning/SKILL.md`.

## Process

### Step 1: Analyze the Design & Rationale section
Read the unified spec's `## Design & Rationale` section (already written if `/ideate` ran; otherwise author it now at thin/standard depth). Identify:
- The `DR-N` requirements every task must trace to
- Core behaviors to implement
- Data structures / interfaces needed
- Integration points
- Edge cases

### Step 2: Decompose into Tasks
Create tasks (in the `## Decomposition` section of the same doc) with:
- 2-5 minute granularity
- A `riskTier` stamp (low | medium | high) + optional `boundaryTouching`
- An `**Implements:** DR-N` trace to the Design & Rationale section above
- Test file paths for the tier's verification (medium/high)
- Expected test names (Method_Scenario_Outcome)
- Dependencies

### Step 3: Identify Parallelization
Group tasks into:
- Sequential chains (dependencies)
- Parallel-safe groups (can run in worktrees)

### Step 4: Save the unified spec
Write the Decomposition section into `docs/specs/YYYY-MM-DD-<feature>.md` (the same file as the Design & Rationale section).

## Task Format

```markdown
### Task [N]: [Description]
**Risk Tier:** low | medium | high   ← drives verification depth
**Boundary Touching:** true | false (optional)
**Implements:** DR-N                  ← traces to the Design & Rationale section

**Verification (scales with Risk Tier):**
- low → static analysis only (typecheck + lint)
- medium → scoped tests + `check_test_adequacy` kill-probe (test-after)
- high → the medium set + the integration suite across the seam

**Files:** `path/to/impl.ts`, `path/to/test.ts` (medium/high)
**Dependencies:** [Task IDs or None]
**Parallelizable:** [Yes/No]
```

## State Management

After saving the spec, persist the artifact + tasks with a single `update` call — the runtime rejects `updates.phase` (`update` is non-phase mutation only; the phase transition to plan-review is owned by **Auto-Chain** below, through the HSM-guarded `transition` action):

- Update artifacts + tasks using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
  - Set `updates.artifacts.plan` to the unified `docs/specs/...` path (the key the `planArtifactExists` guard reads — same file `/ideate` recorded as `artifacts.spec`)
  - Set `updates.tasks` to an array of task objects (id, title, status, branch)

## Output

Save the unified spec to `docs/specs/YYYY-MM-DD-<feature>.md` and capture the path as `$SPEC_PATH`.

## Idempotency

Before planning, check if the spec already carries a Decomposition:
1. Read state file for `.artifacts.plan`
2. If the unified spec exists and already has a `## Decomposition` section, skip planning
3. Auto-chain directly to plan-review

## Auto-Chain

After saving the Decomposition section, **auto-continue to plan-review**:

1. Transition phase via `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "transition"`, `target: "plan-review"`
2. Output: "Unified spec saved to `$SPEC_PATH` with [N] tasks. Dispatching the fresh-context plan-review..."
3. Run plan-review as a **dispatched, fresh-context adversarial** pass (DR-10) — NOT an inline re-read of your own plan:
   - Provision it: `exarchos_orchestrate({ action: "prepare_review", scope: "plan", artifact: "$SPEC_PATH", designDepth: "<frozen>" })`
   - The dispatched reviewer receives only {artifact + spec} (never this authoring transcript), is prompted to **refute** the plan, and scales its adversarial depth by the frozen `designDepth`
   - It returns an evidence-emitting verdict (concrete gaps), not a rubric pass

## Plan Review: Auto-Loop on Gaps

Plan-review refutes the plan and **auto-loops** back to `/exarchos:plan` if it finds gaps (similar to `/exarchos:review` → `/exarchos:delegate --fixes`):

```text
/exarchos:plan → plan-review (dispatched, adversarial) → [refuted?] → /exarchos:plan --revise (auto-loop)
                      ↓
                 [survives]
                      ↓
            [HUMAN: approve?] ← checkpoint
                      ↓
                 /exarchos:delegate
```

### On Gaps Found (Auto-Loop)

If plan-review refutes the plan:

1. Update state with gaps using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
   - Set `planReview.gapsFound` to true
   - Set `planReview.gaps` to the reviewer's concrete gap list

2. Auto-invoke:
   ```typescript
   Skill({ skill: "exarchos:plan", args: "--revise $SPEC_PATH" })
   ```

The `--revise` flag provides gap context for targeted spec updates.

### On No Gaps (Human Checkpoint)

If plan-review's verdict survives:

1. Display the verdict showing:
   - Every DR-N requirement covered by tasks
   - Confirmation that the plan survived refutation

2. **PAUSE for user input**: "Plan survives review and covers all requirements. Approve and continue to delegation? (yes/no)"

3. **On approval**, persist the approval flag and transition phase via two separate calls (the runtime rejects `updates.phase`):
   - First, `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
     - Set `updates.planReview.approved` to true
   - Then, `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "transition"`:
     - Set `target: "delegate"`

   Then invoke:
   ```typescript
   Skill({ skill: "exarchos:delegate", args: "$SPEC_PATH" })
   ```

From here, workflow runs autonomously until PR merge confirmation.

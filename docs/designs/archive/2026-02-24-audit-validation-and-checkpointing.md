# Design: Validation Script Audit + Checkpointing Hardening

**Feature ID:** `audit-validation-and-checkpointing`
**Workflow Type:** refactor
**Date:** 2026-02-24

---

## Summary

Three-workstream audit addressing validation script drift, post-compaction agent behavioral degradation, and missing eval coverage. Introduces phase playbooks as a single source of truth for post-compaction behavioral guidance, a `/rehydrate` command for mid-session recovery, remediation of all stale validation scripts, and a compaction behavioral eval suite.

---

## Problem Statement

### 1. Post-Compaction Agent Behavioral Drift

After context compaction, the agent loses skill instructions and reverts to generic behavior: stops emitting events via `exarchos_event`, stops proactively using MCP tools, has to be reminded of phase-specific workflows.

**Root cause:** `assemble-context.ts` generates state-only context (phase, tasks, artifacts, next-action hint) with zero behavioral guidance. The `context.md` tells the agent WHERE it is but not HOW to behave:

```markdown
## Workflow Context: my-feature
**Phase:** delegate | **Type:** feature
### Next Action
AUTO:review
```

Missing: what tools to call, what events to emit, what skill governs the phase, what guard prerequisites to set before transitioning.

### 2. Validation Script Drift

Five scripts and two eval datasets have fallen out of sync with the HSM definitions:

| Artifact | Drift |
|----------|-------|
| `reconcile-state.sh` (L153-169) | Refactor: `explore brief implement validate` — missing all `polish-*`, `overhaul-*`, `synthesize`. Debug: `triage investigate fix validate` — missing `rca`, `design`, `debug-implement`, `debug-validate`, `debug-review`, `hotfix-implement`, `hotfix-validate`, `synthesize` |
| `pre-synthesis-check.sh` (L183-213) | Refactor: only handles `overhaul-delegate/review/update-docs`. Missing `overhaul-plan`, all `polish-*` states. Debug: uses bare `validate` instead of `debug-validate`/`hotfix-validate` |
| `evals/refactor/datasets/regression.jsonl` | Both cases use `brief → implement → validate` — not valid HSM states |
| `evals/refactor/datasets/golden.jsonl` | All 3 cases use `brief → implement → validate` — same issue |

Four implemented-and-tested scripts are not wired into any skill:

| Script | Intended Use |
|--------|-------------|
| `check-benchmark-regression.sh` | Gate at synthesis: compare benchmark results against baselines |
| `coderabbit-review-gate.sh` | Sophisticated CodeRabbit review cycle (rounds, severity, auto-resolve) for shepherd |
| `verify-review-triage.sh` | Verify review triage routing was applied correctly during review phase |
| `check-pr-comments.sh` | Verify all inline PR comments have replies before merge |

### 3. Missing Compaction Behavioral Eval

The existing `evals/reliability/` suite has 3 compaction cases (`rel-compact-001/002/003`) but they only test event sequence patterns (does `workflow.resume` appear after `context.compaction`?). They do NOT test:
- Whether the agent continues emitting events post-compaction
- Whether the agent calls MCP tools proactively post-compaction
- Whether the agent follows phase-specific behavioral instructions post-compaction

---

## Design

### Workstream A: Phase Playbooks

#### A.1 Playbook Data Structure

New module: `servers/exarchos-mcp/src/workflow/playbooks.ts`

```typescript
interface PhasePlaybook {
  readonly phase: string;
  readonly workflowType: string;
  readonly skill: string;                       // e.g., "delegation" (skill folder name)
  readonly skillRef: string;                     // e.g., "@skills/delegation/SKILL.md"
  readonly tools: readonly ToolInstruction[];     // MCP tools to use
  readonly events: readonly EventInstruction[];   // Events to emit
  readonly transitionCriteria: string;           // Human-readable: what must be true to advance
  readonly guardPrerequisites: string;           // What state fields to set
  readonly validationScripts: readonly string[]; // Scripts to run as gates
  readonly humanCheckpoint: boolean;             // Whether this phase pauses for user input
  readonly compactGuidance: string;              // ~200 char behavioral instruction for post-compaction
}

interface ToolInstruction {
  readonly tool: string;        // e.g., "exarchos_workflow"
  readonly action: string;      // e.g., "set"
  readonly purpose: string;     // e.g., "Update task statuses after dispatch"
}

interface EventInstruction {
  readonly type: string;        // e.g., "task.assigned"
  readonly when: string;        // e.g., "On dispatch of each task to subagent"
}
```

#### A.2 Playbook Registry

A `Map<string, PhasePlaybook>` keyed by `${workflowType}:${phase}`. Covers all 36 non-final, non-compound phases across the three workflow types:

**Feature (9 phases):** `ideate`, `plan`, `plan-review`, `delegate`, `review`, `synthesize`, `completed`, `cancelled`, `blocked`

**Debug (13 phases):** `triage`, `investigate`, `rca`, `design`, `debug-implement`, `debug-validate`, `debug-review`, `hotfix-implement`, `hotfix-validate`, `synthesize`, `completed`, `cancelled`, `blocked`

**Refactor (14 phases):** `explore`, `brief`, `polish-implement`, `polish-validate`, `polish-update-docs`, `overhaul-plan`, `overhaul-delegate`, `overhaul-review`, `overhaul-update-docs`, `synthesize`, `completed`, `cancelled`, `blocked`

Terminal (`completed`, `cancelled`) and `blocked` get minimal playbooks (no tools/events, just "workflow is done" or "waiting for human unblock").

#### A.3 Playbook Examples

**Feature `delegate` phase:**
```typescript
{
  phase: "delegate",
  workflowType: "feature",
  skill: "delegation",
  skillRef: "@skills/delegation/SKILL.md",
  tools: [
    { tool: "exarchos_workflow", action: "get", purpose: "Read task list and worktree assignments" },
    { tool: "exarchos_workflow", action: "set", purpose: "Update task statuses, transition to review when all complete" },
    { tool: "exarchos_event", action: "append", purpose: "Emit task.assigned on dispatch, gate.executed on post-delegation check" },
    { tool: "exarchos_event", action: "batch_append", purpose: "Batch emit team.task.planned events (agent-team mode)" },
    { tool: "exarchos_orchestrate", action: "task_complete", purpose: "Mark individual task complete (subagent mode)" },
  ],
  events: [
    { type: "task.assigned", when: "On dispatch of each task" },
    { type: "team.spawned", when: "After team creation (agent-team mode)" },
    { type: "team.teammate.dispatched", when: "After each agent spawn (agent-team mode)" },
    { type: "team.disbanded", when: "After all tasks collected (agent-team mode)" },
    { type: "gate.executed", when: "After post-delegation-check.sh runs" },
  ],
  transitionCriteria: "All tasks have status 'complete' AND team disbanded (if agent-team mode)",
  guardPrerequisites: "tasks[].status = 'complete' for every task in state",
  validationScripts: [
    "scripts/setup-worktree.sh",
    "scripts/verify-worktree.sh",
    "scripts/post-delegation-check.sh",
  ],
  humanCheckpoint: false,
  compactGuidance: "You are dispatching implementation tasks. Use exarchos_event to emit task.assigned for each dispatch. Use exarchos_workflow set to mark tasks complete. Run post-delegation-check.sh when all tasks finish. Transition to review phase when all tasks complete.",
}
```

**Debug `investigate` phase:**
```typescript
{
  phase: "investigate",
  workflowType: "debug",
  skill: "debug",
  skillRef: "@skills/debug/SKILL.md",
  tools: [
    { tool: "exarchos_workflow", action: "set", purpose: "Record investigation findings, set track selection" },
  ],
  events: [
    { type: "investigation.timeout", when: "At 15-min mark during hotfix investigation" },
  ],
  transitionCriteria: "Set track='thorough' (→ rca) or track='hotfix' (→ hotfix-implement)",
  guardPrerequisites: "state.track = 'thorough' | 'hotfix'",
  validationScripts: [
    "scripts/select-debug-track.sh",
    "scripts/investigation-timer.sh",
  ],
  humanCheckpoint: false,
  compactGuidance: "You are investigating a bug. Run select-debug-track.sh to determine hotfix vs thorough track. If hotfix, run investigation-timer.sh to enforce 15-min timebox. Set track in state via exarchos_workflow set to advance.",
}
```

#### A.4 Context Assembly Integration

Update `assemble-context.ts` to include a `### Behavioral Guidance` section from the current phase's playbook. This section is part of the core budget (always included, never truncated):

```typescript
// In ContextSections, add:
interface ContextSections {
  header: string;
  behavioral: string;    // NEW: always included
  taskTable: string;
  events: string;
  gitState: string;
  artifacts: string;
  nextAction: string;
}
```

The `behavioral` section renders:

```markdown
### Behavioral Guidance
**Skill:** @skills/delegation/SKILL.md
**Tools:** exarchos_workflow (get, set), exarchos_event (append, batch_append), exarchos_orchestrate (task_complete)
**Events to emit:** task.assigned (on dispatch), team.spawned, team.disbanded, gate.executed (post-check)
**Transition:** All tasks complete → review | Guard: tasks[].status = 'complete'
**Scripts:** post-delegation-check.sh
You are dispatching implementation tasks. Use exarchos_event to emit task.assigned for each dispatch. Use exarchos_workflow set to mark tasks complete. Run post-delegation-check.sh when all tasks finish. Transition to review phase when all tasks complete.
```

Target: ~400-600 chars per playbook rendering, fitting within the 8KB budget alongside existing sections.

#### A.5 Playbook Access via MCP

Expose playbooks through `exarchos_workflow get` with a new field projection:

```
exarchos_workflow get featureId="my-feature" fields=["playbook"]
```

Returns the `PhasePlaybook` for the current `(workflowType, phase)`. This enables `/rehydrate` and any tool to query behavioral guidance on demand.

#### A.6 Validation Script Cross-Reference

Each playbook's `validationScripts` array creates the canonical mapping from phase to scripts. A new meta-validation script `scripts/validate-phase-coverage.sh` (see Workstream B.5) checks that:
1. Every playbook's referenced scripts exist on disk
2. Every non-terminal phase has a playbook
3. Every implemented validation script is referenced by at least one playbook (detects unwired scripts)

---

### Workstream B: Validation Script Remediation

#### B.1 Fix `reconcile-state.sh` Valid Phases

Update the `case` block (L153-169) to match authoritative HSM phase enums from `servers/exarchos-mcp/src/workflow/schemas.ts`:

```bash
case "$workflow_type" in
    feature)
        valid_phases=(ideate plan plan-review delegate review synthesize completed cancelled blocked)
        ;;
    debug)
        valid_phases=(triage investigate rca design debug-implement debug-validate debug-review hotfix-implement hotfix-validate synthesize completed cancelled blocked)
        ;;
    refactor)
        valid_phases=(explore brief polish-implement polish-validate polish-update-docs overhaul-plan overhaul-delegate overhaul-review overhaul-update-docs synthesize completed cancelled blocked)
        ;;
```

Update co-located test `reconcile-state.test.sh` to cover the new phases.

#### B.2 Fix `pre-synthesis-check.sh` Phase Handling

Replace the refactor case block (L183-213) to handle both tracks:

```bash
refactor)
    case "$phase" in
        # Polish track — no synthesize step, goes directly to completed
        polish-implement|polish-validate|polish-update-docs)
            check_fail "Phase is synthesize" \
              "Current phase '$phase' — polish track completes directly (no synthesize). Use exarchos_workflow cleanup."
            return 1
            ;;
        # Overhaul track — has synthesize step
        overhaul-plan)
            missing+=("Transition: overhaul-plan → overhaul-delegate (guard: planArtifactExists)")
            missing+=("Transition: overhaul-delegate → overhaul-review (guard: allTasksComplete)")
            missing+=("Transition: overhaul-review → overhaul-update-docs (guard: allReviewsPassed)")
            missing+=("Transition: overhaul-update-docs → synthesize (guard: docsUpdated)")
            ;;
        overhaul-delegate)
            missing+=("Transition: overhaul-delegate → overhaul-review (guard: allTasksComplete)")
            missing+=("Transition: overhaul-review → overhaul-update-docs (guard: allReviewsPassed)")
            missing+=("Transition: overhaul-update-docs → synthesize (guard: docsUpdated)")
            ;;
        overhaul-review)
            missing+=("Transition: overhaul-review → overhaul-update-docs (guard: allReviewsPassed)")
            missing+=("Transition: overhaul-update-docs → synthesize (guard: docsUpdated)")
            ;;
        overhaul-update-docs)
            missing+=("Transition: overhaul-update-docs → synthesize (guard: docsUpdated)")
            ;;
        *)
            check_fail "Phase is synthesize" \
              "Current phase '$phase' — not on a synthesis-eligible path for $workflow_type workflow"
            return 1
            ;;
    esac
    ;;
```

Similarly fix the debug case block to use `debug-validate`/`hotfix-validate`/`debug-review` instead of bare `validate`.

Update co-located test.

#### B.3 Wire Unwired Scripts into Skills

| Script | Wire Into | How |
|--------|-----------|-----|
| `check-benchmark-regression.sh` | `skills/synthesis/SKILL.md` | Add as optional gate in pre-synthesis checks: run when `state.verification.hasBenchmarks` is true |
| `coderabbit-review-gate.sh` | `skills/shepherd/SKILL.md` | Replace/augment `check-coderabbit.sh` reference with the more sophisticated gate that handles rounds, severity, and auto-resolution |
| `verify-review-triage.sh` | `skills/quality-review/SKILL.md` | Add as pre-check before quality review: verify triage routing was applied correctly |
| `check-pr-comments.sh` | `skills/shepherd/SKILL.md` | Add as gate before requesting approval: verify all inline PR comments have replies |

Update playbook `validationScripts` arrays to include these.

#### B.4 Fix Stale Eval Datasets

Update `evals/refactor/datasets/regression.jsonl` and `golden.jsonl` to use correct HSM phases:

**Before:** `explore → brief → implement → validate`
**After (polish track):** `explore → brief → polish-implement → polish-validate → polish-update-docs → completed`
**After (overhaul track):** `explore → brief → overhaul-plan → overhaul-delegate → overhaul-review → overhaul-update-docs → synthesize → completed`

Ensure regression cases cover both tracks. Update expected patterns accordingly.

#### B.5 Meta-Validation Script

New script: `scripts/validate-phase-coverage.sh`

Purpose: Ensure no future drift by validating playbook registry against HSM definitions and disk.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Inputs: --playbook-json <path> --scripts-dir <path>
# Checks:
# 1. Every non-final phase in each workflow type has a playbook entry
# 2. Every validationScript in every playbook exists on disk
# 3. Every *.sh file in scripts/ (excluding utilities) is referenced by at least one playbook
# Exit: 0 = all covered, 1 = gaps found, 2 = usage error
```

Add co-located `validate-phase-coverage.test.sh`.

Include in the CI gate (the benchmark infrastructure branch already adds a `scripts:test` CI step).

---

### Workstream C: `/rehydrate` Command + Streamlined Flow

#### C.1 Command Definition

New file: `commands/rehydrate.md`

```markdown
---
name: rehydrate
description: Re-inject workflow state and behavioral guidance into current context. Use after compaction, when the agent seems to have forgotten workflow patterns, or to resume a prior session.
---

# Rehydrate

Restore full workflow awareness without starting a new session.

## When to Use
- After context compaction when the agent stops emitting events or using tools proactively
- Mid-session when you notice behavioral drift (forgetting to use exarchos_event, skipping validation scripts)
- Returning to a workflow after a break (replaces /resume)

## Process
1. Discover active workflow(s) via `exarchos_workflow get`
2. If multiple active workflows, ask user which to rehydrate
3. Fetch full state + phase playbook
4. Render compact behavioral context (same format as post-compaction context.md)
5. Output the rehydration context to refresh agent awareness

## Output Format
The rehydration output includes:
- Current phase and workflow type
- Task progress summary
- **Behavioral guidance** (tools, events, transition criteria, scripts)
- Next action
- Active artifacts (design doc, plan, PR URLs)
```

#### C.2 Legacy Command Deprecation

Update `commands/resume.md` to add a deprecation notice pointing to `/rehydrate`. Keep functional for backward compatibility but recommend `/rehydrate` in the output.

`/checkpoint` remains as-is — it's the explicit "save progress" command. `/rehydrate` is the "restore awareness" command. They're complementary, not overlapping.

#### C.3 SessionStart Hook Enhancement

Update `session-start.ts` to include behavioral guidance in the `SessionStartResult`:

```typescript
interface SessionStartResult extends CommandResult {
  readonly workflows?: ReadonlyArray<WorkflowInfo>;
  readonly contextDocument?: string;
  readonly behavioralGuidance?: string;  // NEW: rendered playbook for active phase
  // ... existing fields
}
```

When a checkpoint is found, also look up the phase playbook and render it into `behavioralGuidance`. This way the agent gets behavioral instructions automatically on session start, without needing to run `/rehydrate`.

---

### Workstream D: Compaction Behavioral Eval Suite

#### D.1 New Dataset

New file: `evals/reliability/datasets/compaction-behavioral.jsonl`

6 new eval cases testing post-compaction behavioral fidelity:

**Case rel-compact-beh-001: "Agent emits events after compaction"**
```jsonl
{
  "id": "rel-compact-beh-001",
  "type": "trace",
  "description": "Agent continues emitting events via exarchos_event after compaction mid-delegation",
  "tags": ["compaction", "behavioral", "events"],
  "layer": "reliability",
  "input": {
    "trace_events": [
      {"type": "workflow.transition", "from": "plan-review", "to": "delegate"},
      {"type": "task.assigned", "taskId": "T1"},
      {"type": "context.compaction", "tokensBefore": 180000, "tokensAfter": 40000},
      {"type": "workflow.resume", "phase": "delegate", "source": "compaction"},
      {"type": "task.assigned", "taskId": "T2"},
      {"type": "task.completed", "taskId": "T2"},
      {"type": "gate.executed", "gateName": "post-delegation-check"}
    ]
  },
  "expected": {
    "patterns": [
      {"type": "context.compaction"},
      {"type": "workflow.resume"},
      {"type": "task.assigned"},
      {"type": "task.completed"},
      {"type": "gate.executed"}
    ]
  }
}
```

Asserts: After compaction, the agent still emits `task.assigned`, `task.completed`, AND `gate.executed` events — not just state transitions.

**Case rel-compact-beh-002: "Agent uses MCP tools proactively after compaction"**
```jsonl
{
  "id": "rel-compact-beh-002",
  "type": "trace",
  "description": "Agent proactively calls exarchos_workflow and exarchos_event after compaction in review phase",
  "tags": ["compaction", "behavioral", "tools"],
  "layer": "reliability",
  "input": {
    "trace_events": [
      {"type": "workflow.transition", "from": "delegate", "to": "review"},
      {"type": "context.compaction", "tokensBefore": 160000, "tokensAfter": 38000},
      {"type": "workflow.resume", "phase": "review", "source": "compaction"},
      {"type": "tool.call", "tool": "exarchos_workflow", "action": "get"},
      {"type": "gate.executed", "gateName": "static-analysis-gate"},
      {"type": "gate.executed", "gateName": "security-scan"},
      {"type": "tool.call", "tool": "exarchos_workflow", "action": "set", "args": {"phase": "synthesize"}}
    ]
  },
  "expected": {
    "patterns": [
      {"type": "context.compaction"},
      {"type": "workflow.resume"},
      {"type": "tool.call", "min": 2},
      {"type": "gate.executed", "min": 2}
    ]
  }
}
```

Asserts: Agent makes at least 2 `tool.call` events and 2 `gate.executed` events post-compaction.

**Case rel-compact-beh-003: "Agent follows phase-specific validation scripts after compaction"**
```jsonl
{
  "id": "rel-compact-beh-003",
  "type": "trace",
  "description": "Agent runs pre-synthesis-check.sh and reconstruct-stack.sh after compaction in synthesize phase",
  "tags": ["compaction", "behavioral", "scripts"],
  "layer": "reliability",
  "input": {
    "trace_events": [
      {"type": "workflow.transition", "from": "review", "to": "synthesize"},
      {"type": "context.compaction", "tokensBefore": 175000, "tokensAfter": 42000},
      {"type": "workflow.resume", "phase": "synthesize", "source": "compaction"},
      {"type": "tool.call", "tool": "exarchos_workflow", "action": "get"},
      {"type": "gate.executed", "gateName": "pre-synthesis-check"},
      {"type": "gate.executed", "gateName": "reconstruct-stack"},
      {"type": "tool.call", "tool": "graphite", "action": "submit"}
    ]
  },
  "expected": {
    "patterns": [
      {"type": "context.compaction"},
      {"type": "workflow.resume"},
      {"type": "gate.executed", "min": 2},
      {"type": "tool.call", "min": 2}
    ]
  }
}
```

**Case rel-compact-beh-004: "Agent handles mid-debug compaction with track awareness"**
```jsonl
{
  "id": "rel-compact-beh-004",
  "type": "trace",
  "description": "Agent resumes debug thorough track after compaction, continues with correct phase sequence",
  "tags": ["compaction", "behavioral", "debug"],
  "layer": "reliability",
  "input": {
    "trace_events": [
      {"type": "workflow.transition", "from": "investigate", "to": "rca"},
      {"type": "context.compaction", "tokensBefore": 140000, "tokensAfter": 35000},
      {"type": "workflow.resume", "phase": "rca", "source": "compaction"},
      {"type": "tool.call", "tool": "exarchos_workflow", "action": "get"},
      {"type": "tool.call", "tool": "exarchos_workflow", "action": "set", "args": {"artifacts.rca": "docs/rca/bug.md"}},
      {"type": "workflow.transition", "from": "rca", "to": "design"}
    ]
  },
  "expected": {
    "patterns": [
      {"type": "context.compaction"},
      {"type": "workflow.resume"},
      {"type": "tool.call", "min": 2},
      {"type": "workflow.transition"}
    ]
  }
}
```

**Case rel-compact-beh-005: "Agent handles refactor polish-track compaction"**
```jsonl
{
  "id": "rel-compact-beh-005",
  "type": "trace",
  "description": "Agent resumes polish-validate after compaction and transitions correctly to polish-update-docs",
  "tags": ["compaction", "behavioral", "refactor"],
  "layer": "reliability",
  "input": {
    "trace_events": [
      {"type": "workflow.transition", "from": "polish-implement", "to": "polish-validate"},
      {"type": "context.compaction", "tokensBefore": 155000, "tokensAfter": 37000},
      {"type": "workflow.resume", "phase": "polish-validate", "source": "compaction"},
      {"type": "tool.call", "tool": "exarchos_workflow", "action": "get"},
      {"type": "gate.executed", "gateName": "validate-refactor"},
      {"type": "tool.call", "tool": "exarchos_workflow", "action": "set", "args": {"validation.testsPass": true, "phase": "polish-update-docs"}},
      {"type": "workflow.transition", "from": "polish-validate", "to": "polish-update-docs"}
    ]
  },
  "expected": {
    "patterns": [
      {"type": "context.compaction"},
      {"type": "workflow.resume"},
      {"type": "tool.call", "min": 2},
      {"type": "gate.executed"},
      {"type": "workflow.transition"}
    ]
  }
}
```

**Case rel-compact-beh-006: "Agent uses /rehydrate mid-session to recover behavioral drift"**
```jsonl
{
  "id": "rel-compact-beh-006",
  "type": "trace",
  "description": "After behavioral drift (3 tool calls with no events), /rehydrate restores event emission",
  "tags": ["compaction", "behavioral", "rehydrate"],
  "layer": "reliability",
  "input": {
    "trace_events": [
      {"type": "workflow.transition", "from": "plan-review", "to": "delegate"},
      {"type": "tool.call", "tool": "Read", "action": "file"},
      {"type": "tool.call", "tool": "Read", "action": "file"},
      {"type": "tool.call", "tool": "Read", "action": "file"},
      {"type": "command.invoked", "command": "rehydrate"},
      {"type": "tool.call", "tool": "exarchos_workflow", "action": "get"},
      {"type": "task.assigned", "taskId": "T1"},
      {"type": "task.completed", "taskId": "T1"},
      {"type": "gate.executed", "gateName": "post-delegation-check"}
    ]
  },
  "expected": {
    "patterns": [
      {"type": "command.invoked"},
      {"type": "tool.call"},
      {"type": "task.assigned"},
      {"type": "gate.executed"}
    ]
  }
}
```

Asserts: After `/rehydrate`, agent resumes event emission (task.assigned, gate.executed).

#### D.2 Suite Configuration Update

Update `evals/reliability/suite.json` to include the new dataset:

```json
{
  "description": "Agent reliability evaluation — stall, loop, budget, phase, recovery, compaction, compaction-behavioral",
  "assertions": [
    {
      "type": "trace-pattern",
      "name": "reliability-trace-pattern",
      "threshold": 0.8,
      "config": { "ordered": false }
    }
  ],
  "datasets": {
    "regression": "./datasets/regression.jsonl",
    "compaction-behavioral": "./datasets/compaction-behavioral.jsonl"
  }
}
```

#### D.3 Integration Test

New test: `servers/exarchos-mcp/src/cli-commands/assemble-context.integration.test.ts`

Tests the full pre-compact → session-start round-trip:

1. Create a workflow in delegate phase with tasks
2. Call `handlePreCompact` — verify checkpoint.json and context.md written
3. Verify context.md contains `### Behavioral Guidance` section
4. Verify behavioral section includes tool instructions, event instructions, transition criteria
5. Call `handleSessionStart` — verify checkpoint consumed, context document returned
6. Verify `behavioralGuidance` field is populated
7. Repeat for each workflow type and representative phases

Property-based test: for any valid `(workflowType, phase)` pair, `getPlaybook()` returns a non-empty playbook with at least one tool instruction and a non-empty `compactGuidance`.

---

## Implementation Plan Overview

### Task Group 1: Phase Playbooks (Core)
1. Create `playbooks.ts` with `PhasePlaybook` type and `getPlaybook()` function
2. Populate playbook registry for all 36 phases (feature: 9, debug: 13, refactor: 14)
3. Unit tests for `getPlaybook()` — every phase returns valid playbook, unknown phases return null
4. Property test: all HSM state IDs have corresponding playbook entries

### Task Group 2: Context Assembly Enhancement
5. Add `behavioral` section to `ContextSections` in `assemble-context.ts`
6. Render playbook into behavioral guidance markdown
7. Update `truncateToCharBudget` to always include behavioral section (core, not optional)
8. Update existing `assemble-context` tests
9. Integration test for context.md with behavioral section

### Task Group 3: `/rehydrate` Command
10. Create `commands/rehydrate.md` slash command
11. Add `playbook` field projection to `exarchos_workflow get` handler
12. Update `commands/resume.md` with deprecation notice

### Task Group 4: SessionStart Enhancement
13. Add `behavioralGuidance` to `SessionStartResult`
14. Look up playbook in `handleSessionStart` when checkpoint found
15. Update session-start tests

### Task Group 5: Validation Script Remediation
16. Fix `reconcile-state.sh` valid phases + update test
17. Fix `pre-synthesis-check.sh` polish/debug handling + update test
18. Wire `check-benchmark-regression.sh` into synthesis skill
19. Wire `coderabbit-review-gate.sh` into shepherd skill
20. Wire `verify-review-triage.sh` into quality-review skill
21. Wire `check-pr-comments.sh` into shepherd skill
22. Create `validate-phase-coverage.sh` + test

### Task Group 6: Eval Remediation
23. Fix `evals/refactor/datasets/regression.jsonl` phase names
24. Fix `evals/refactor/datasets/golden.jsonl` phase names
25. Create `evals/reliability/datasets/compaction-behavioral.jsonl` (6 cases)
26. Update `evals/reliability/suite.json` to include new dataset
27. Integration test for pre-compact → session-start round-trip

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Playbooks drift from skills | Behavioral guidance doesn't match skill instructions | `validate-phase-coverage.sh` in CI catches missing/stale playbooks |
| 8KB budget pressure from behavioral section | Other context sections get truncated more aggressively | Behavioral section is compact (~400-600 chars); if still tight, increase budget to 10KB |
| `/rehydrate` becomes a crutch | Users rely on manual recovery instead of fixing root cause | Track `/rehydrate` usage via telemetry; high usage indicates context.md needs improvement |
| Playbook maintenance burden | New phases require playbook updates | Property test fails if HSM has a state without a playbook entry |

---

## Success Criteria

1. After compaction, context.md includes behavioral guidance section with tools, events, and transition criteria
2. `reconcile-state.sh` and `pre-synthesis-check.sh` accept all valid HSM phases without false positives
3. All 4 unwired scripts are referenced by at least one skill
4. Refactor eval datasets use correct HSM phase names
5. All 6 compaction-behavioral eval cases pass at >=0.8 threshold
6. `validate-phase-coverage.sh` exits 0 (all phases covered, all scripts wired)
7. `/rehydrate` command renders behavioral context for any active workflow

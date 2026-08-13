# Worked Example: Implementation Planning — Event Stream Compaction

## Context

Feature: event stream compaction for the Exarchos MCP server. The `## Design & Rationale` section of the unified `docs/specs/2026-02-20-stream-compaction.md` artifact already exists (authored by `/exarchos:ideate`). The user runs `/exarchos:plan` (or auto-chained from `/exarchos:ideate`) to add the `## Decomposition` section to the **same** document.

## Step 1: Analyze the Design & Rationale Section

Agent reads the `## Design & Rationale` section of the unified artifact and extracts:

- **Problem Statement:** Event streams grow unbounded; view queries slow down after 1000+ events.
- **Chosen Approach:** Snapshot-based compaction. Periodically write a snapshot event summarizing state, then readers start from latest snapshot.
- **Technical Design:** `SnapshotWriter` class, `StreamReader` with snapshot-aware cursor, snapshot trigger threshold.
- **Integration Points:** `exarchos_view` tool, `exarchos_event` append tool.
- **Testing Strategy:** Unit tests for writer/reader, integration test for round-trip.

## Step 1.5: Spec Tracing

Agent runs `exarchos_orchestrate({ action: "generate_traceability" })` to pre-populate the traceability matrix, then fills in key requirements per section.

## Step 2: Decompose into Tasks

Each task carries a **Risk Tier** that sets its verification depth (the ladder in `@skills/_shared/references/verification.md`). The plan mixes tiers — medium kill-probe tasks and a high-tier integration task — rather than imposing red-green-refactor uniformly. Tests are judged test-after by adequacy, not by commit order.

| Task | Risk Tier | Test Name / Verification | Dependencies | Parallel |
|------|-----------|--------------------------|-------------|----------|
| 1 | medium | `SnapshotEvent_Serialize_RoundTrips` + `check_test_adequacy` kill-probe | None | Yes |
| 2 | medium | `SnapshotWriter_ThresholdReached_WritesSnapshot` | Task 1 | Yes |
| 3 | medium | `SnapshotWriter_BelowThreshold_NoSnapshot` | Task 1 | Yes |
| 4 | medium | `StreamReader_SnapshotExists_StartsFromSnapshot` | Task 1 | No (after 1) |
| 5 | medium | `StreamReader_NoSnapshot_ReadsFullStream` | Task 4 | No (after 4) |
| 6 | high | `ViewTool_WithCompaction_ReturnsCorrectState` (boundaryTouching — adds the integration suite across the seam) | Tasks 2, 4 | No |

**Parallel groups:** Tasks 1-3 run simultaneously. Task 4 waits for 1, then 5 waits for 4. The high-tier integration task, Task 6, runs last.

## Step 3: Plan Verification

Agent runs `exarchos_orchestrate({ action: "check_plan_coverage" })`:

```
exarchos_orchestrate({
  action: "check_plan_coverage",
  featureId: "<id>",
  // one unified artifact — the design region and the decomposition region live in the same file
  designPath: "docs/specs/2026-02-20-stream-compaction.md",
  planPath: "docs/specs/2026-02-20-stream-compaction.md"
})
→ passed: false — Uncovered section: "Snapshot trigger threshold configuration"
```

## Gap Detected: Re-Planning

The design specifies a configurable threshold (default 500 events). The default is a single constant read from the resolved config plus a doc note — no parsing logic — so it is a **low-tier, static-only** task: typecheck + lint suffice, no test ceremony.

**Agent adds Task 7 (low tier):**

| Task | Risk Tier | Test Name / Verification | Dependencies | Parallel |
|------|-----------|--------------------------|-------------|----------|
| 7 | low | — (static only: add the `compactionThreshold` default constant + document it) | None | Yes |

Agent re-runs verification:

```
exarchos_orchestrate({ action: "check_plan_coverage", ... })
→ passed: true — All design sections covered
```

Agent runs `exarchos_orchestrate({ action: "spec_coverage_check", planFile: "docs/specs/2026-02-20-stream-compaction.md", repoRoot: ".", coveragePhase: "plan" })` -- passed: true (no pre-existing tests expected at planning time; `coveragePhase: "plan"` is what makes a declared-but-uncreated path a forward declaration rather than a failure).

## Output

Decomposition section added to the unified `docs/specs/2026-02-20-stream-compaction.md`. State updated: `artifacts.plan` set (the `docs/specs/` path), `tasks` array populated with 7 tasks, phase transitions to `plan-review`.

**Agent:** "Plan complete. Auto-continuing to plan-review for gap analysis..."

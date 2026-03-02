---
name: implementation-planning-worked-example
description: "Complete trace of the implementation planning skill in action, showing happy path and re-planning after gap detection."
---

# Worked Example: Implementation Planning — Event Stream Compaction

## Context

Feature: event stream compaction for the Exarchos MCP server. Design document exists at `docs/designs/2026-02-20-stream-compaction.md`. The user runs `/plan` (or auto-chained from `/ideate`).

## Step 1: Analyze Design Document

Agent reads design and extracts key sections:

- **Problem Statement:** Event streams grow unbounded; view queries slow down after 1000+ events.
- **Chosen Approach:** Snapshot-based compaction. Periodically write a snapshot event summarizing state, then readers start from latest snapshot.
- **Technical Design:** `SnapshotWriter` class, `StreamReader` with snapshot-aware cursor, snapshot trigger threshold.
- **Integration Points:** `exarchos_view` tool, `exarchos_event` append tool.
- **Testing Strategy:** Unit tests for writer/reader, integration test for round-trip.

## Step 1.5: Spec Tracing

Agent runs `exarchos_orchestrate({ action: "run_script", script: "generate-traceability.sh" })` to pre-populate the traceability matrix, then fills in key requirements per section.

## Step 2: Decompose into Tasks

| Task | Test Name | Dependencies | Parallel |
|------|-----------|-------------|----------|
| 1 | `SnapshotEvent_Serialize_RoundTrips` | None | Yes |
| 2 | `SnapshotWriter_ThresholdReached_WritesSnapshot` | Task 1 | Yes |
| 3 | `SnapshotWriter_BelowThreshold_NoSnapshot` | Task 1 | Yes |
| 4 | `StreamReader_SnapshotExists_StartsFromSnapshot` | Task 1 | No (after 1) |
| 5 | `StreamReader_NoSnapshot_ReadsFullStream` | Task 4 | No (after 4) |
| 6 | `ViewTool_WithCompaction_ReturnsCorrectState` | Tasks 2, 4 | No |

**Parallel groups:** Tasks 1-3 run simultaneously. Task 4 waits for 1. Task 5 waits for 4. Task 6 is the integration task, last.

## Step 3: Plan Verification

Agent runs `exarchos_orchestrate({ action: "check_plan_coverage" })`:

```
exarchos_orchestrate({
  action: "check_plan_coverage",
  featureId: "<id>",
  designPath: "docs/designs/2026-02-20-stream-compaction.md",
  planPath: "docs/plans/2026-02-20-stream-compaction.md"
})
→ passed: false — Uncovered section: "Snapshot trigger threshold configuration"
```

## Gap Detected: Re-Planning

The design specifies a configurable threshold (default 500 events). No task covers configuration parsing.

**Agent adds Task 7:**

| Task | Test Name | Dependencies | Parallel |
|------|-----------|-------------|----------|
| 7 | `CompactionConfig_CustomThreshold_OverridesDefault` | None | Yes |

Agent re-runs verification:

```
exarchos_orchestrate({ action: "check_plan_coverage", ... })
→ passed: true — All design sections covered
```

Agent runs `exarchos_orchestrate({ action: "run_script", script: "spec-coverage-check.sh" })` -- passed: true (no pre-existing tests expected at planning time).

## Output

Plan saved to `docs/plans/2026-02-20-stream-compaction.md`. State updated: `artifacts.plan` set, `tasks` array populated with 7 tasks, phase transitions to `plan-review`.

**Agent:** "Plan complete. Auto-continuing to plan-review for gap analysis..."

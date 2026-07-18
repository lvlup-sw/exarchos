# agency-csl-auto-pr — fixture plan (representative subset)

This fixture is a minimal subset of the real `docs/plans/2026-04-29-agency-csl-auto-pr.md`
plan (33 tasks total) captured to reproduce the three parser false-positive failure
modes documented in
[`exarchos-issue-check_task_decomposition-parser-false-positives.md`](../../../../../../exarchos-issue-check_task_decomposition-parser-false-positives.md).

The plan structure is the standard `@skills/plan` shape: each
task has a `**Goal:**` paragraph (not `**Description:**`), TDD step lists with
`[RED]`/`[GREEN]`/`[REFACTOR]` markers, an `**Acceptance criteria:**` section,
and explicit `**Dependencies:**` / `**Parallelizable:**` lines.

Three tasks are sufficient to reproduce all three bugs:

- **Task 003** and **Task 004** both reference the dotted record fields
  `imageProvenance.isFirstParty` and `mutatingTool.detected` in narrative prose
  (Bug 3 — file-conflict on dotted identifiers).
- **Task 033**'s `**Dependencies:**` line references `T002` and includes the
  Kusto function name `GetCslSloRollup24h` in narrative parens (Bug 2 — greedy
  digit fallback extracts `24`).
- All three tasks use `**Goal:**` instead of `**Description:**` so the parser
  reports `descriptionWordCount === 0` despite hundreds of words of substantive
  prose (Bug 1).

## Tasks

### Task 002: Author the Kusto schema for CSL telemetry rollups

**Goal:** Define the Kusto query module that exposes per-SLO sample-size rollups
over a rolling 24-hour window. The schema must declare both the input event
shape (drawn from the `agencyEvents` Kusto table) and the projected rollup row
shape consumed by downstream alerting and dashboards. Validate against a frozen
sample of last week's `agencyEvents` rows so future schema drift is caught at
build time rather than at runtime when the dashboard renders empty.

**Files:**
- `kusto/queries/csl-slo-rollup-24h.kql`
- `kusto/queries/csl-slo-rollup-24h.test.ts`
- `kusto/schemas/agency-events.ts`

**Tests:**
- [RED] `GetCslSloRollup24h_FrozenSample_ProducesExpectedRollupRows` — assert
  the query against the frozen `agencyEvents` sample produces the expected
  per-SLO sample-size counts.
- [RED] `GetCslSloRollup24h_EmptyWindow_ReturnsZeroRowsNotError` — assert
  empty-window behavior is graceful (zero rows, not a Kusto error).

**Dependencies:** None
**Parallelizable:** Yes

### Task 003: First-party image provenance check

**Goal:** Implement the provenance check that flags any image whose
`imageProvenance.isFirstParty` field is `false` for downstream review. The check
runs as part of the agency-csl pipeline's pre-commit gate and must record the
review verdict back onto the record. When `imageProvenance.isFirstParty` is
absent (legacy records), the check defaults to `false` and the record is
flagged. Edge case: a record may carry both a first-party flag and a
`mutatingTool.detected` signal — when both are set, the mutating-tool signal
wins (more conservative).

**Files:**
- `src/checks/image-provenance.ts`
- `src/checks/image-provenance.test.ts`

**Tests:**
- [RED] `ImageProvenanceCheck_FirstPartyTrue_DoesNotFlag` — verify a record
  with `imageProvenance.isFirstParty = true` and no mutating-tool signal is
  not flagged.
- [RED] `ImageProvenanceCheck_FirstPartyFalse_FlagsForReview` — verify the
  flag fires when `imageProvenance.isFirstParty` is `false`.
- [RED] `ImageProvenanceCheck_LegacyRecordMissingField_DefaultsToFlagged` —
  verify legacy records without the field default to flagged.

**Dependencies:** None
**Parallelizable:** Yes

### Task 004: Mutating-tool detection check

**Goal:** Implement the detection check that flags any image whose
`mutatingTool.detected` field is `true` for downstream review. This check is
adjacent to the first-party provenance check (T003) but operates on a separate
field of the same record. Where the two checks overlap is in the narrative
discussion of which signal wins when both fire — `mutatingTool.detected` is
more conservative and takes precedence over `imageProvenance.isFirstParty` in
the pipeline's combined verdict logic (which lives in a separate file owned by
T005, not T003 or T004).

**Files:**
- `src/checks/mutating-tool.ts`
- `src/checks/mutating-tool.test.ts`

**Tests:**
- [RED] `MutatingToolCheck_DetectedTrue_FlagsForReview` — verify the flag
  fires when `mutatingTool.detected` is `true`.
- [RED] `MutatingToolCheck_DetectedFalse_DoesNotFlag` — verify no flag when
  `mutatingTool.detected` is `false`.
- [RED] `MutatingToolCheck_FieldAbsent_DefaultsToNotDetected` — verify
  records without the field default to "not detected" (the field's absence
  is informational, not a flag).

**Dependencies:** None
**Parallelizable:** Yes

### Task 033: SLO sample-size dashboard panel

**Goal:** Render the per-SLO sample-size panel in the agency-csl Grafana
dashboard, sourced from the rollup query authored in T002. The panel shows
24-hour rolling sample sizes per SLO bucket, with a threshold line at the
minimum-sample-size policy boundary. Supports drill-down into the underlying
event stream when the on-call engineer clicks a panel cell. The dashboard
provisioning JSON declares the panel's query reference, axes, and the
threshold annotation.

**Files:**
- `dashboards/agency-csl/slo-sample-size-panel.json`
- `dashboards/agency-csl/slo-sample-size-panel.test.ts`

**Tests:**
- [RED] `SloSampleSizePanel_QueryReference_ResolvesToRollupQuery` — assert
  the panel JSON's query reference resolves to the T002 rollup query module.
- [RED] `SloSampleSizePanel_ThresholdAnnotation_MatchesPolicyBoundary` —
  assert the threshold annotation value equals the documented
  minimum-sample-size policy.

**Dependencies:** T002 (`GetCslSloRollup24h` exposes sample size per SLO)
**Parallelizable:** Yes

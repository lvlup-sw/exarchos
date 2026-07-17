# Implementation Plan: Authoring-Gate / Template Parity + YAML-Sidecar Abandonment

## Source Design

`docs/designs/2026-05-30-design-gate-parity.md` (tracker #1486; sub-issues #1493, #1494)

## Overview

Three dependency-ordered waves. Wave 1 fixes the two confirmed parser drifts in
parallel (file-disjoint). Wave 2 adds the template→gate round-trip contract
shield over the now-fixed parsers. Wave 3 removes the abandoned YAML-sidecar
layer as a refactor under that shield. DR-6 (docs + #1407 reconciliation) is
handled in the `overhaul-update-docs` phase by the orchestrator, not delegated.

Both drifts are empirically reproduced (baselines recorded in workflow state):
- #1493 — `check_design_completeness` emits a false-positive missing-acceptance
  advisory on a doc authored verbatim from `design-template.md`.
- task-decomposition — `check_task_decomposition` hard-FAILs a task authored
  verbatim from `task-template.md` (`Description: 0 words`).

| Wave | Task | Implements | Files (owner) | Parallel with |
|---|---|---|---|---|
| 1 | T-01 | DR-1, DR-2 | `pure/design-completeness.ts` (+test) | T-02 |
| 1 | T-02 | DR-3 | `task-decomposition.ts` (+test) | T-01 |
| 2 | T-03 | DR-4, DR-7 | new `template-roundtrip.test.ts` | — |
| 3 | T-04 | DR-5 | 4 gate handlers + 8 deletions | — |

Wave N+1 branches off the **integrated** result of Wave N. T-04's behavior is
guarded by T-03's shield + the existing gate suites.

## Task Breakdown

### Task 1: design-completeness recognizes template acceptance-criteria + flexible GWT

**Goal:** Broaden the pure design-completeness parser so a requirement is
credited with acceptance criteria when written in any shape the brainstorming
`design-template.md` mandates or the shell checker `check-design-completeness.sh`
already accepts. Eliminates the #1493 false-positive advisory.

**Phase:** RED
**Test Layer:** unit
**Implements:** DR-1, DR-2

**TDD Steps:**
1. [RED] Write characterization tests in
   `servers/exarchos-mcp/src/orchestrate/pure/design-completeness.test.ts`:
   - `CheckAcceptanceCriteria_BoldHeader_Recognized` — a DR with a standalone
     `**Acceptance criteria:**` header + bullets is NOT reported missing.
   - `CheckAcceptanceCriteria_HeadingForm_Recognized` — `#### Acceptance criteria` is recognized.
   - `CheckAcceptanceCriteria_SingleLineGWT_Recognized` — `- Given X, when Y, then Z` is recognized.
   - `CheckAcceptanceCriteria_ContinuationGWT_Recognized` — `- Given …` / `  When …` / `  Then …` is recognized.
   - `CheckAcceptanceCriteria_BulletHeader_StillRecognized` — existing `- Acceptance criteria:` still passes (no regression).
   - `CheckAcceptanceCriteria_NoCriteria_StillFlagged` — a DR with no criteria block still produces the advisory (no new false negative).
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL on the first four.
2. [GREEN] In `pure/design-completeness.ts`, broaden `ACCEPTANCE_CRITERIA_HEADER_PATTERN`
   to the union of the shell checker's shapes (`^\*\*\s*[Aa]cceptance`,
   `^#{1,}\s*[Aa]cceptance`, `^-\s*\*\*\s*[Aa]cceptance`, plus the existing
   bullet form), and relax `hasAcceptanceCriteria` GWT detection to also accept
   a single line containing given+when+then and continuation-line (non-bulleted)
   when/then. Keep the existing three-separate-bullets path.
   - File: `servers/exarchos-mcp/src/orchestrate/pure/design-completeness.ts`
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS.
3. [REFACTOR] Extract the accepted shapes into named, commented constants;
   reference `scripts/check-design-completeness.sh` as the parity source.

**Verification:**
- [ ] Witnessed the four new tests fail for the right reason (shape not matched)
- [ ] All design-completeness tests pass after the change
- [ ] No-criteria DR still flagged (false-negative guard holds)

**Dependencies:** None
**Parallelizable:** Yes

### Task 2: task-decomposition accepts a template-shaped task description

**Goal:** Make the task-decomposition parser credit a task authored verbatim
from `task-template.md` with a description, instead of hard-failing it with
`Description: 0 words`. Fix the false-negative without reopening the F20/#1213
regression where an inline `**Files:**` list was miscounted as prose.

**Phase:** RED
**Test Layer:** unit
**Implements:** DR-3

**TDD Steps:**
1. [RED] Write characterization tests in
   `servers/exarchos-mcp/src/orchestrate/task-decomposition.test.ts`:
   - `ValidateTaskStructure_TemplateShapedTask_HasDescription` — a task built
     verbatim from `task-template.md` (brief description in the `### Task N:`
     heading, body of TDD Steps) is credited with a description and is
     well-decomposed.
   - `ValidateTaskStructure_FilesListOnly_NotCountedAsDescription` — the #1213
     guard: a task whose only "prose" is an inline `**Files:** \`a.ts\`, \`b.ts\``
     list is STILL flagged missing-description.
   - Run: `cd servers/exarchos-mcp && npm run test:run` — first MUST FAIL, second MUST PASS.
2. [GREEN] In `task-decomposition.ts`, adjust description detection so the
   `### Task N: <brief description>` heading text and/or the TDD-step prose
   count toward the description signal (preferred: count the heading's
   description tail; do NOT count backtick-quoted file lists). Keep the
   `**Goal:**`/`**Description:**` introducer path intact.
   - File: `servers/exarchos-mcp/src/orchestrate/task-decomposition.ts`
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS.
3. [REFACTOR] Document the description-span rule in a comment referencing
   `task-template.md` and the F20/#1213 history.

**Verification:**
- [ ] Witnessed the template-shaped-task test fail for the right reason (0 words)
- [ ] Template-shaped task now passes; files-list-only task still flagged
- [ ] Existing task-decomposition suite stays green

**Dependencies:** None
**Parallelizable:** Yes

### Task 3: template→gate round-trip contract shield

**Goal:** Add a CI test that loads the SHIPPED authoring templates and runs every
authoring gate against them, asserting blocking checks pass and advisory checks
are advisory-clean. This is the durable recurrence shield for #1299 — it fails
when a parser tightens beyond a template or a template drifts from a parser.

**Phase:** RED
**Test Layer:** acceptance
**Implements:** DR-4, DR-7

**TDD Steps:**
1. [RED] Create `servers/exarchos-mcp/src/orchestrate/template-roundtrip.test.ts`:
   - Resolve the three shipped templates via an ESM-safe `import.meta.url` →
     repo-root path (mirror `sidecar-backfill.test.ts`'s pattern):
     `skills-src/brainstorming/references/design-template.md`,
     `skills-src/implementation-planning/references/plan-document-template.md`,
     `skills-src/implementation-planning/references/task-template.md`.
   - Derive a minimal VALID design/plan rendering from each template's fenced
     example (substitute placeholders into concrete values).
   - Run each gate's pure/handler entrypoint against the rendered fixtures:
     design-completeness, plan-coverage, provenance-chain, task-decomposition.
   - Assert each blocking check `passed: true` and acceptance-criteria /
     description advisories are clean. Failure message names the gate + template.
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS on the
     Wave-1-integrated base (it would have failed pre-fix; that is the point).
2. [GREEN] No production change expected; if the test surfaces a NEW drift
   beyond DR-1..DR-3, capture it and stop for re-planning (do not silently
   widen scope).
3. [REFACTOR] Factor the render-from-template helper so adding a 5th gate or
   template is a one-line addition.

**Verification:**
- [ ] Test loads the real `skills-src/**` template files (not inline copies)
- [ ] All four gates pass against all rendered templates
- [ ] Failure message identifies gate + template on a forced mismatch (spot-check)

**Dependencies:** T-01, T-02
**Parallelizable:** No (branches off Wave-1 integration)

### Task 4: remove the abandoned YAML gate-sidecar layer

**Goal:** Make markdown parsing the explicit, sole authoring-gate path. Remove
the consume-only YAML-sidecar subsystem and its phantom `npm run sidecar:emit`
deprecation messaging, under the protection of the T-03 shield.

**Phase:** REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** Task 3
**Implements:** DR-5

**TDD Steps:**
1. [RED] Add `servers/exarchos-mcp/src/orchestrate/design-completeness.test.ts`
   (or a co-located test) assertion `NoSidecarEmitReference_InOrchestrateSource`
   — greps orchestrate source for `sidecar:emit` and expects zero matches.
   Run — MUST FAIL.
2. [GREEN] Delete the sidecar layer and strip the branches:
   - Delete: `sidecar-lookup.ts`, `sidecar-schemas.ts`, `sidecar-lookup.test.ts`,
     `sidecar-consumption.test.ts`, `sidecar-backfill.test.ts`,
     `sidecar-schemas.test.ts`.
   - Delete fixtures: `docs/designs/2026-05-15-v2-10-0-preview-4-feature-freeze.sidecar.yml`,
     `docs/plans/2026-05-15-v2-10-0-preview-4-feature-freeze.sidecar.yml`.
   - Strip the `loadDesignSidecar`/`loadPlanSidecar` import + `if (sidecar) …`
     branch and `evaluate*Sidecar` helpers from all four gate handlers:
     `design-completeness.ts`, `plan-coverage.ts`, `provenance-chain.ts`,
     `task-decomposition.ts`. Each gate now evaluates the markdown path directly.
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS.
3. [REFACTOR] Remove now-dead imports/types; ensure `npm run typecheck` is clean.

**Verification:**
- [ ] `grep -rn "sidecar:emit" servers/exarchos-mcp/src` returns nothing
- [ ] No `loadDesignSidecar`/`loadPlanSidecar`/`DesignSidecarV1` references remain
- [ ] T-03 round-trip shield still green (behavior preserved)
- [ ] Full MCP suite + typecheck green

**Dependencies:** T-01, T-02, T-03
**Parallelizable:** No (branches off Wave-2 integration)

## Documentation (overhaul-update-docs phase — orchestrator, not delegated)

Implements DR-6:
- Reframe/close #1407 with rationale referencing the sidecar abandonment.
- Correct `CLAUDE.md` architecture section: markdown+SQLite is the canonical
  authoring contract; drop the live YAML-sidecar co-existence claim.
- Sweep comments that frame markdown parsing as a "deprecated fallback."

## Risk & Rollback

- **Sidecar removal blast radius (T-04):** mitigated by the importer map (7 source
  + test consumers enumerated) and the T-03 shield. If removal breaks an
  unrelated suite, revert T-04 alone — Waves 1–2 stand independently.
- **Template edits:** if T-02's remedy is a template change rather than a parser
  change, run `npm run build:skills` + `npm run skills:guard` and commit the
  regenerated `skills/` tree.
- **Scope guard:** if T-03 surfaces drift beyond DR-1..DR-3, stop and re-plan
  rather than widening silently.

## Verification (integration)

- Root `npm run test:run` green; `cd servers/exarchos-mcp && npm run test:run` green.
- `npm run typecheck` clean; `npm run skills:guard` clean if templates changed.
- Re-run `check_design_completeness` on `docs/designs/2026-05-30-design-gate-parity.md`
  → zero acceptance-criteria advisory.

// ─── The DR-30 register: ratchets, floors, and accepted gaps ────────────────
//
// This module is DELIBERATELY IMPORT-FREE apart from the generated debt list.
// It reads no filesystem and derives nothing. That is what makes it a genuine
// SECOND AUTHORITY against the corpus scan in `corpus.ts`: one side is what
// the repository actually contains right now, the other is what a human
// committed as the accepted state. If either were computed from the other,
// `suite-invariants.test.ts` would be the very Class B defect DR-30 exists to
// forbid — and its own `@oracle-sources` declaration would be rejected by its
// own derived-authority check.

import { LEGACY_SHAPE_DEBT } from './legacy-shape-debt.js';

export { LEGACY_SHAPE_DEBT };

// ─── Shape ratchet ──────────────────────────────────────────────────────────

/**
 * DR-30: "the list of covered shapes is itself ratcheted so it cannot quietly
 * shrink."
 *
 * Two separate teeth per entry:
 *   1. `id` must still exist in `COVERED_SHAPES`. Delete a shape to make the
 *      suite green and this goes RED instead.
 *   2. `corpusFloor` is the minimum number of REAL corpus files the shape must
 *      still match. This is the anti-vacuity tooth: a matcher edited into
 *      matching nothing (the classic silently-vacuous scanner) reports zero
 *      violations *and* zero matches, and the floor catches it.
 *
 * `observed` records the count measured when the floor was set (2026-08-05,
 * 920-file corpus). Floors are ~80% of observed so ordinary churn does not
 * flake, and are stated next to the observation so the gap is visible rather
 * than tuned.
 */
export interface ShapeRatchetEntry {
  readonly id: string;
  readonly observed: number;
  readonly corpusFloor: number;
}

export const SHAPE_RATCHET: readonly ShapeRatchetEntry[] = Object.freeze([
  { id: 'empty-census-diff', observed: 59, corpusFloor: 47 },
  { id: 'set-equality', observed: 22, corpusFloor: 17 },
  { id: 'sorted-parity', observed: 64, corpusFloor: 51 },
  { id: 'snapshot-drift', observed: 2, corpusFloor: 1 },
  { id: 'every-quantified', observed: 47, corpusFloor: 37 },
  { id: 'pinned-cardinality', observed: 34, corpusFloor: 27 },
  { id: 'fs-corpus-sweep', observed: 69, corpusFloor: 55 },
  { id: 'golden-artifact-compare', observed: 14, corpusFloor: 11 },
  { id: 'derived-pair-parity', observed: 153, corpusFloor: 122 },
]);

// ─── Denominator ratchet ────────────────────────────────────────────────────

/**
 * DR-30: "The denominator is reported and ratcheted." Floors stop the scan
 * root from being quietly emptied — deleting or relocating a root would
 * otherwise turn the whole meta-test vacuous while keeping it green.
 * Observed 2026-08-05: repo/src 60, mcp/src 849, mcp/test 9, mcp/tests 2.
 *
 * Re-stated after task 019 folded the two source trees into one. The `src`
 * floor is the SUM of the two it replaces (48 + 680), so the merge relaxes
 * nothing — the same number of files must still be there. The `test` and
 * `tests` roots follow the dissolved package's suites to their new addresses
 * under `core`, so their floors are unchanged: same files, same obligation.
 * `tools/evals` is the eval suite the same move routed out of the product
 * tree, tracked here so relocation cannot discharge its annotation debt.
 *
 * Observed 2026-08-13: src 899, test 13, tests 2, tools/evals 9.
 */
export const CORPUS_FLOORS: readonly { readonly root: string; readonly floor: number }[] =
  Object.freeze([
    { root: 'src', floor: 728 },
    { root: 'test', floor: 7 },
    { root: 'tests', floor: 2 },
    { root: 'tools/evals', floor: 7 },
  ]);

/** Observed 2026-08-05: 327 of 920 files match ≥1 covered shape. */
export const IN_SCOPE_FLOOR = 260;

/**
 * Observed 2026-08-05: 14 `it(...)` blocks raise a BLOCKING claim (all in
 * `test/integration/governance/**` and `test/integration/public-root/**`).
 * The kill-fixture rule (R5) is only meaningful if it has subjects; this floor
 * is its anti-vacuity tooth.
 */
export const BLOCKING_CLAIM_CENSUS_FLOOR = 11;

// ─── Known derivations between opaque (non-path) authorities ────────────────

/**
 * The static import-graph walk in `corpus.ts` decides derivation for
 * authorities that name a module path. Authorities that name something else
 * (a running process, a compiled artifact, a wire capture) cannot be walked.
 * For those, derivation is DECLARED here rather than inferred — an honest
 * limitation, stated in `LIMITATIONS.md`, not a pretence of analysis.
 */
export interface DerivationPair {
  readonly a: string;
  readonly b: string;
  readonly note: string;
}

export const KNOWN_DERIVATIONS: readonly DerivationPair[] = Object.freeze([
  {
    a: 'TOOL_REGISTRY',
    b: 'contract-drift-baseline',
    note: 'the drift baseline is generated from TOOL_REGISTRY; comparing them is the Class B defect DR-11 exists to remove',
  },
  {
    a: 'admission-projection',
    b: 'next-actions',
    note: 'DR-9: `next_actions` is computed FROM the admission projection, so comparing the two is admission against admission',
  },
]);

// ─── Accepted gaps ──────────────────────────────────────────────────────────

/**
 * DR-30: "Accepted coverage gaps carry an owner and expiry" and "The known
 * Class B instances … are either fixed … or carry a registered, expiring
 * exception — they are not silently exempt."
 *
 * `suppresses` lists the detector rules this entry excuses for `files`. An
 * empty `suppresses` means the entry excuses nothing mechanical — it is a
 * KNOWN DEFECT recorded so that it is visible and expires, which is the only
 * honest place for the findings T-37 handed to T-40.
 */
export type GapKind = 'shape-annotation-debt' | 'detector-exception' | 'known-defect';

export interface AcceptedGap {
  readonly id: string;
  readonly kind: GapKind;
  /** Repo-relative, forward-slashed. May be empty for a narrative gap. */
  readonly files: readonly string[];
  readonly suppresses: readonly string[];
  readonly owner: string;
  /** ISO `YYYY-MM-DD`. Past this date the suite goes RED. */
  readonly expires: string;
  readonly why: string;
  /** The requirement/task that is expected to close it. */
  readonly closedBy: string;
}

/** No gap may be parked further out than this. Stops `expires: '2099-01-01'`. */
export const MAX_GAP_HORIZON_DAYS = 400;

/**
 * The date this register was authored. The horizon above is measured from
 * HERE, not from "now" — otherwise the ceiling would slide forward with the
 * calendar and a gap could be re-parked indefinitely by nudging its date.
 */
export const REGISTER_ANCHOR = '2026-08-05';

export const ACCEPTED_GAPS: readonly AcceptedGap[] = Object.freeze([
  // ── The three Class B instances DR-30 names by name ────────────────────
  {
    id: 'class-b/projection-containment',
    kind: 'shape-annotation-debt',
    files: ['src/install/projection-containment.test.ts', 'src/install/projection-containment.packaging.test.ts'],
    suppresses: ['oracle-sources-missing'],
    owner: 'workflow-platform',
    expires: '2026-11-30',
    why: 'Builds the required inventory AND the "packaged layer" from the same `contents` map, so the comparison cannot disagree with itself. Registered individually — NOT folded into the bulk legacy debt — because DR-30 forbids these three being silently exempt.',
    closedBy: 'DR-21 (projection containment proven against packaged bytes)',
  },
  {
    id: 'class-b/contract-drift-guard',
    kind: 'shape-annotation-debt',
    files: [
      'src/verbs/gates/contract-drift.test.ts',
      'src/verbs/gates/contract-drift.parity.test.ts',
      'src/verbs/gates/contract-drift.integration.test.ts',
    ],
    suppresses: ['oracle-sources-missing'],
    owner: 'workflow-platform',
    expires: '2026-11-30',
    why: "Baseline and checker are both pure functions of the same registry. The plan's own taxonomy note (line 143) records that Class B governs here, so the fix must introduce an authority independent of TOOL_REGISTRY rather than collapse onto it.",
    closedBy: 'DR-11 (the contract compiler is the authority, not a description of the registry)',
  },
  {
    id: 'class-b/oracle-fixtures',
    kind: 'shape-annotation-debt',
    files: [
      'src/contract/oracle/oracle-seam.test.ts',
      'tools/evals/evals/benchmarks/seeded-defects/corpus.test.ts',
    ],
    suppresses: ['oracle-sources-missing'],
    owner: 'evals',
    expires: '2026-11-30',
    why: "The seeded breaks have declaration, handler and detector co-authored in one file, so the detector is measured against its own author's intent.",
    closedBy: 'DR-24 (the oracle observes real handler behavior)',
  },

  // ── The new tiers, which are NOT exemplary yet ──────────────────────────
  {
    id: 'new-tier/public-root-actions-unannotated',
    kind: 'shape-annotation-debt',
    files: ['test/core/integration/public-root/actions.test.ts'],
    suppresses: ['oracle-sources-missing'],
    owner: 'T-36 owner',
    expires: '2026-10-31',
    why: 'T-36 landed (a3a20a9c) before this convention existed; it matches four covered shapes and declares no authorities. T-40 may not edit another task\'s files, so the obligation is registered rather than silently skipped. Its real authorities are the live TOOL_REGISTRY and `parity/__tests__/packaged-proof.ts::derivePackagedDenominators` — which the file already keeps distinct, so this is a MISSING DECLARATION, not a suspected single-source comparison.',
    closedBy: 'T-36 follow-up: add `@oracle-sources` to the T1 tier',
  },
  {
    id: 'new-tier/process-tier-unannotated',
    kind: 'shape-annotation-debt',
    files: [
      'test/core/process/packaged-proof.test.ts',
      'test/core/process/multi-process-append.test.ts',
    ],
    suppresses: ['oracle-sources-missing'],
    owner: 'T-38/T-39 owner',
    expires: '2026-10-31',
    why: 'The T3 process tier predates the convention. Registered separately from the bulk legacy debt because the process tier is in active development under DR-29 and should be annotated as part of that work, not amortised into a 317-file backlog.',
    closedBy: 'DR-29 / T-38, T-39',
  },
  {
    id: 'dr27/merge-idempotency-synthesizes-dispatch-context',
    kind: 'detector-exception',
    files: ['test/core/integration/governance/merge-idempotency.test.ts'],
    suppresses: ['synthesized-dispatch-context'],
    owner: 'T-37 owner',
    expires: '2026-10-31',
    why: 'T-36 predicted this exactly: "a future file could import `dispatch` directly and hand it an object literal, and nothing would fail." `makeHarness()` (line ~178) builds `{ stateDir, eventStore, enableTelemetry, projectConfig } as unknown as DispatchContext` instead of going through `createPublicRootHarness()`, so this T2 file does NOT drive the production composition root. This detector found it on its first corpus run; the exception exists only because T-40 is forbidden from editing T-37\'s files.',
    closedBy: 'DR-27/DR-28 follow-up: route `merge-idempotency.test.ts` through `_harness.ts`',
  },
  {
    id: 'dr29/process-helpers-fs-sweep',
    kind: 'detector-exception',
    files: ['test/core/process/_helpers.test.ts'],
    suppresses: ['oracle-sources-missing'],
    owner: 'T-38 owner (process tier / DR-29)',
    expires: '2026-11-30',
    why: "In scope through `fs-corpus-sweep` alone, and only because of ONE `readdirSync`: a listing of a temp directory the test itself created moments earlier, asserting no `.build-tmp-` scratch dir leaked. That is a leak check on the test's own scratch space, not a coverage claim over a corpus, so the file has no second authority to declare — the listing's only reference is the `.build-tmp-` prefix literal copied by hand out of `_helpers.ts`, i.e. one source wearing two names. Annotating it would be exactly the FALSE declaration this rule exists to prevent, which is worse than a registered gap. The shape is deliberately NOT narrowed to exclude it: `readdirSync` in a test is a legitimate silhouette, and trimming a matcher to fit newly-written code is how a guard erodes.",
    closedBy:
      "DR-29 follow-up: assert the leak check against a scratch-prefix constant exported from `_helpers.ts` (making it a real two-source claim), or move the leak check out of this file",
  },

  // ── Known defects handed over by T-37, recorded so they expire ─────────
  {
    id: 'dr4-c2/projection-degraded-honoured-by-one-reader',
    kind: 'known-defect',
    files: [],
    suppresses: [],
    owner: 'workflow-platform',
    expires: '2026-11-30',
    why: 'T-37 pinned that DR-4 criterion 2 is NOT met in shipped code: `projection.degraded` is honoured by `wf get` alone, while `exarchos_view.workflow_status` and `exarchos_orchestrate.prepare_delegation` both return `success: true` with a payload on the SAME degraded streamId. Recorded here rather than left in a commit message so it carries an owner and an expiry instead of evaporating.',
    closedBy: 'DR-4 (a degraded projection is never served as success)',
  },
  {
    id: 'dr7-c1/cancel-is-an-untrailed-phase-mutation',
    kind: 'known-defect',
    files: ['test/core/integration/governance/denied-transition.test.ts'],
    suppresses: [],
    owner: 'workflow-platform',
    expires: '2026-11-30',
    why: 'T-37 labelled the `cancel` half of DR-7 criterion 1 a CHARACTERIZATION OF A KNOWN GAP: cancel is a second phase-mutation path and double-emits `workflow.cancel`. That is a CORRECT and DELIBERATE pattern — a future fix must redden it — so no detector flags it. It is registered here so the category is DECLARED with an owner rather than living only as a `// KNOWN GAP` comment.',
    closedBy: 'DR-7 (exactly one action mutates a phase)',
  },
  {
    id: 'dr27/envelope-conformance-degrades-to-well-formedness',
    kind: 'known-defect',
    files: [],
    suppresses: [],
    owner: 'contract',
    expires: '2026-11-30',
    why: 'T-36 measured that 107 of 121 registered `outputSchema`s are `EnvelopeSchema(z.unknown())`, so "envelope-conformant" degrades to "well-formed" for 88% of the surface. The invariant it recommended — an action whose `outputSchema` has an unconstrained `data` cannot be COUNTED as envelope-conformant — needs the schema registry, not the test corpus, so it is out of this meta-test\'s scan surface. Recorded, owned and expiring rather than dropped.',
    closedBy: 'DR-11 / contract-compiler work',
  },
  {
    id: 'dr24/axis-census-line-is-tautological',
    kind: 'known-defect',
    files: ['src/contract/oracle/fixtures.test.ts'],
    suppresses: [],
    owner: 'evals',
    expires: '2026-11-30',
    why: "Found while annotating that file for DR-30, and recorded rather than annotated around. `AxisCoverageSeparatesNotObservedFromPassAcrossTheSuite` asserts `[...byAxis.keys()].sort()` equals `[...ORACLE_AXES].sort()`, but `axisCoverage()` builds its rows with `ORACLE_AXES.map(...)` — so that single line is a census compared against its own generator and cannot fail. It suppresses nothing: the file IS annotated and its declared authorities are real; this entry exists so the one vacuous line inside it carries an owner and an expiry instead of reading as evidence. The pass/observed/notObserved counts asserted beside it are measured from real reports and are unaffected.",
    closedBy:
      'DR-24 follow-up: derive the left side from the axes that actually produced verdicts across `suite.reports`, so an axis that stopped emitting reddens the case',
  },

  // ── The bulk pre-existing debt ──────────────────────────────────────────
  {
    id: 'legacy/shape-annotation-debt',
    kind: 'shape-annotation-debt',
    files: LEGACY_SHAPE_DEBT,
    suppresses: ['oracle-sources-missing'],
    owner: 'repo-maintainers',
    expires: '2027-02-28',
    why: 'The 317 test files that matched a covered assertion shape before `@oracle-sources` existed. Enumerated exhaustively rather than counted, so NEW debt cannot hide inside a threshold; the list may only shrink (stale entries fail).',
    closedBy: 'incremental annotation; the ratchet forces the list down, never up',
  },
]);

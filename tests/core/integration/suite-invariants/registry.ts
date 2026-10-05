// The register of the suite invariants: ratchets, floors and accepted gaps.
//
// This module imports only the generated debt list. It reads no file and
// derives no value. That makes it a second authority against the corpus scan
// in `corpus.ts`. One side is the current content of the repository, and the
// other side is the state that a person committed.
//
// Neither side comes from the other. Otherwise, `suite-invariants.test.ts`
// compares one source with itself, and its derived-authority check rejects its
// own oracle-sources declaration.

import { LEGACY_SHAPE_DEBT } from './legacy-shape-debt.js';

export { LEGACY_SHAPE_DEBT };

/**
 * One ratchet entry for a covered shape. The entries stop a silent shrink of
 * the shape list:
 * - `id` must exist in `COVERED_SHAPES`, so a deleted shape fails.
 * - `corpusFloor` is the minimum number of corpus files that the shape must
 *   match. A matcher that matches nothing reports zero violations and zero
 *   matches, and the floor catches it.
 *
 * `observed` is the match count on the date that set the floor (2026-08-05,
 * a corpus of 920 files). A floor is about 80% of `observed`, so ordinary
 * churn does not fail it.
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

/**
 * Floors for the file count of a scan root. An empty root makes the meta-test
 * vacuous and green, and a floor stops that. The `src` and `tools/conformance`
 * roots have no floor here.
 *
 * A floor goes with its files. The floors of `tests/unit` and
 * `tests/integration` sum to 728, the floor of the `src` root that held their
 * files. The split has the ratio of the file counts.
 *
 * Observed 2026-08-13: `tests/unit` 885, `tests/integration` 14, `tools/evals`
 * 30, and 13 + 2 in the two trees that are now the `tests` root.
 */
export const CORPUS_FLOORS: readonly { readonly root: string; readonly floor: number }[] =
  Object.freeze([
    { root: 'tests/unit', floor: 717 },
    { root: 'tests/integration', floor: 11 },
    /**
     * The floor is the sum of the floors of the two trees that are now this
     * root (7 + 2). Thus the union does not relax the ratchet.
     */
    { root: 'tests', floor: 9 },
    { root: 'tools/evals', floor: 7 },
  ]);

/** Observed 2026-08-05: 327 of 920 files match ≥1 covered shape. */
export const IN_SCOPE_FLOOR = 260;

/**
 * The minimum number of test blocks with a blocking claim in the corpus. The
 * kill-fixture rule (R5) has meaning only when it has subjects. Observed
 * 2026-08-05: 14 blocks.
 */
export const BLOCKING_CLAIM_CENSUS_FLOOR = 11;

/**
 * A declared derivation between two authorities that name no module path, such
 * as a process, a compiled artifact or a wire capture. The import-graph walk in
 * `corpus.ts` cannot reach those, so the pair is declared here and not
 * inferred (see `LIMITATIONS.md`).
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

export type GapKind = 'shape-annotation-debt' | 'detector-exception' | 'known-defect';

/** An accepted coverage gap. Each gap carries an owner and an expiry date. */
export interface AcceptedGap {
  readonly id: string;
  readonly kind: GapKind;
  /** Repo-relative paths with forward slashes. The list can be empty for a gap that names no file. */
  readonly files: readonly string[];
  /**
   * The detector rules that this entry excuses for `files`. An empty list
   * excuses no rule: the entry records a known defect with an owner and an
   * expiry date.
   */
  readonly suppresses: readonly string[];
  readonly owner: string;
  /** ISO `YYYY-MM-DD`. The suite fails from 00:00 UTC on this date. */
  readonly expires: string;
  readonly why: string;
  /** The requirement or the work that closes the gap. */
  readonly closedBy: string;
}

/**
 * The maximum number of days between `REGISTER_ANCHOR` and the expiry date of
 * a gap. It stops an expiry date such as `'2099-01-01'`.
 */
export const MAX_GAP_HORIZON_DAYS = 400;

/**
 * The date of this register. The horizon counts from this date, not from the
 * current date. Otherwise the limit moves with the calendar, and a new expiry
 * date can extend a gap without end.
 */
export const REGISTER_ANCHOR = '2026-08-05';

/**
 * The accepted gaps. The three `class-b/` entries are registered one by one.
 * They stay out of the bulk `legacy/shape-annotation-debt` entry, so each one
 * has its own owner and expiry date.
 */
export const ACCEPTED_GAPS: readonly AcceptedGap[] = Object.freeze([
  {
    id: 'class-b/projection-containment',
    kind: 'shape-annotation-debt',
    files: ['tests/unit/install/projection-containment.test.ts', 'tests/unit/install/projection-containment.packaging.test.ts'],
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
      'tests/unit/verbs/gates/contract-drift.test.ts',
      'tests/unit/verbs/gates/contract-drift.parity.test.ts',
      'tests/unit/verbs/gates/contract-drift.integration.test.ts',
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
      'tests/unit/contract/oracle/oracle-seam.test.ts',
      'tools/evals/evals/benchmarks/seeded-defects/corpus.test.ts',
    ],
    suppresses: ['oracle-sources-missing'],
    owner: 'evals',
    expires: '2026-11-30',
    why: "The seeded breaks have declaration, handler and detector co-authored in one file, so the detector is measured against its own author's intent.",
    closedBy: 'DR-24 (the oracle observes real handler behavior)',
  },

  {
    id: 'new-tier/public-root-actions-unannotated',
    kind: 'shape-annotation-debt',
    files: ['tests/core/integration/public-root/actions.test.ts'],
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
      'tests/core/process/packaged-proof.test.ts',
      'tests/core/process/multi-process-append.test.ts',
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
    files: ['tests/core/integration/governance/merge-idempotency.test.ts'],
    suppresses: ['synthesized-dispatch-context'],
    owner: 'T-37 owner',
    expires: '2026-10-31',
    why: 'T-36 predicted this exactly: "a future file could import `dispatch` directly and hand it an object literal, and nothing would fail." `makeHarness()` (line ~178) builds `{ stateDir, eventStore, enableTelemetry, projectConfig } as unknown as DispatchContext` instead of going through `createPublicRootHarness()`, so this T2 file does NOT drive the production composition root. This detector found it on its first corpus run; the exception exists only because T-40 is forbidden from editing T-37\'s files.',
    closedBy: 'DR-27/DR-28 follow-up: route `merge-idempotency.test.ts` through `_harness.ts`',
  },
  {
    id: 'dr29/process-helpers-fs-sweep',
    kind: 'detector-exception',
    files: ['tests/core/process/_helpers.test.ts'],
    suppresses: ['oracle-sources-missing'],
    owner: 'T-38 owner (process tier / DR-29)',
    expires: '2026-11-30',
    why: "In scope through `fs-corpus-sweep` alone, and only because of ONE `readdirSync`: a listing of a temp directory the test itself created moments earlier, asserting no `.build-tmp-` scratch dir leaked. That is a leak check on the test's own scratch space, not a coverage claim over a corpus, so the file has no second authority to declare — the listing's only reference is the `.build-tmp-` prefix literal copied by hand out of `_helpers.ts`, i.e. one source wearing two names. Annotating it would be exactly the FALSE declaration this rule exists to prevent, which is worse than a registered gap. The shape is deliberately NOT narrowed to exclude it: `readdirSync` in a test is a legitimate silhouette, and trimming a matcher to fit newly-written code is how a guard erodes.",
    closedBy:
      "DR-29 follow-up: assert the leak check against a scratch-prefix constant exported from `_helpers.ts` (making it a real two-source claim), or move the leak check out of this file",
  },

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
    files: ['tests/core/integration/governance/denied-transition.test.ts'],
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
    files: ['tests/unit/contract/oracle/fixtures.test.ts'],
    suppresses: [],
    owner: 'evals',
    expires: '2026-11-30',
    why: "Found while annotating that file for DR-30, and recorded rather than annotated around. `AxisCoverageSeparatesNotObservedFromPassAcrossTheSuite` asserts `[...byAxis.keys()].sort()` equals `[...ORACLE_AXES].sort()`, but `axisCoverage()` builds its rows with `ORACLE_AXES.map(...)` — so that single line is a census compared against its own generator and cannot fail. It suppresses nothing: the file IS annotated and its declared authorities are real; this entry exists so the one vacuous line inside it carries an owner and an expiry instead of reading as evidence. The pass/observed/notObserved counts asserted beside it are measured from real reports and are unaffected.",
    closedBy:
      'DR-24 follow-up: derive the left side from the axes that actually produced verdicts across `suite.reports`, so an axis that stopped emitting reddens the case',
  },

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

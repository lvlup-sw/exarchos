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
    expires: '2027-02-28',
    why: 'The packaging file builds the required inventory and the "packaged layer" from the same `contents` map, so that comparison cannot disagree with itself (its header says an unchanged copy always passes). The unit file compares synthetic in-memory layers. Containment against packaged bytes now holds in `tests/core/packaged/containment.test.ts`, which reads a real `npm pack` and is annotated. Registered individually, not folded into the bulk legacy debt, because DR-30 forbids these three being silently exempt.',
    closedBy: 'DR-21 holds in tests/core/packaged. Re-scope the unit files: remove the self-comparisons, keep the seeded-mutation kills and the `files[]` check, and declare `package.json` `files[]` and the committed tree as the two sources.',
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
    expires: '2027-02-28',
    why: 'The three files test the `check_contract_drift` gate, which runs an external codegen and schema-diff tool. They no longer compare a registry baseline. The unit file drives `runContractDrift` with stub git and command runners. The parity file compares the CLI and MCP facades over a mocked drift core. The integration file runs the gate through `handleOrchestrate` against a temp git repo with an OpenAPI artifact and shell stubs for codegen and diff. None declares its two sources yet.',
    closedBy: 'DR-11: declare the two sources of each file (the stubbed tool results and the gate verdict; the temp git repo and the OpenAPI artifact for the integration file), and show that the two facades of the parity file are not one module chain',
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
    expires: '2027-02-28',
    why: "In `oracle-seam.test.ts` the seeded breaks have declaration, handler and detector co-authored in one file, so the detector is measured against its own author's intent. It needs a second observation route. `corpus.test.ts` reads real manifests and the production tier classifier, but declares neither. The oracle already observes the shipped handlers in `fixtures.test.ts`, which is annotated.",
    closedBy: 'DR-24 (the oracle observes real handler behavior): declare the manifests and the tier classifier in `corpus.test.ts`, and give `oracle-seam.test.ts` an observation route that its seeded breaks do not author',
  },

  {
    id: 'dr7-c1/cancel-is-an-untrailed-phase-mutation',
    kind: 'known-defect',
    files: ['tests/core/integration/governance/denied-transition.test.ts'],
    suppresses: [],
    owner: 'workflow-platform',
    expires: '2027-02-28',
    why: 'T-37 labelled the `cancel` half of DR-7 criterion 1 a CHARACTERIZATION OF A KNOWN GAP: cancel is a second phase-mutation path, appends `workflow.cancel` twice (the HSM event and the completion event) and appends no phase-boundary event. `Governance_Dr7_PhaseMutation_OnlyThroughGuardedTransition` pins that behavior on purpose, so a fix must redden it, and no detector flags it. It is registered here so the category is DECLARED with an owner rather than living only in the KNOWN GAP note of that test.',
    closedBy: 'DR-7 (exactly one action mutates a phase): cancel moves the phase through the guarded transition path with one `workflow.cancel` and a phase-boundary event, and the pinned assertions flip',
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

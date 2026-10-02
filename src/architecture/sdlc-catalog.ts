/**
 * The SDLC-* invariants catalog that Exarchos ships to consumers. It is on by default.
 * It is separate from the dev catalog (`INV-*`) and from a consumer `user` catalog.
 *
 * The catalog is a typed constant in the binary, not a Markdown file, because the
 * package does not ship `docs/`. Thus it is present wherever the server runs, with no
 * file I/O at resolve time. The entries use the frontmatter shape of the dev catalog
 * and go through the same `parseInvariantEntries` path.
 *
 * Every entry is `mode: audit`, because SDLC conduct is a judgment about the workflow,
 * not a property of a diff. The `integrity-class: sdlc` floor lets a consumer lower an
 * entry to advisory with `invariants.overrides`, but not disable it.
 */
import { parseInvariantEntries, type InvariantEntry } from './invariants-loader.js';

/** The code-bearing workflow types that the SDLC baseline governs. It leaves out `discovery`. */
const CODE_BEARING_WORKFLOWS = ['feature', 'debug', 'refactor', 'oneshot'] as const;

/**
 * The reference of every shipped entry. It is a command, not a path into this
 * repository, because a consumer project does not have the files of this repository.
 */
const GUIDE = 'run `exarchos invariants add` to author an entry interactively';

/**
 * The shipped baseline in catalog-frontmatter shape. It reads like the Markdown
 * catalog, and the shared parser validates it.
 */
const RAW_SDLC_ENTRIES: ReadonlyArray<Record<string, unknown>> = [
  {
    id: 'SDLC-1',
    dimension: 'phase-observability',
    axis: 'substrate',
    'cost-of-load': 'always-load',
    'integrity-class': 'sdlc',
    'applies-to': ['workflow-lifecycle', 'long-running-operations'],
    summary:
      'Every long-running workflow operation is queryable and workflow state ' +
      'is reconstructible — nobody on the team has to ask "what step are we on?".',
    references: [GUIDE],
    'phase-affinity': ['review'],
    'workflow-affinity': [...CODE_BEARING_WORKFLOWS],
    severity: { default: 'advisory' },
    enforcement: {
      mode: 'audit',
      'audit-prompt':
        'Does every long-running step in this workflow emit lifecycle events ' +
        'so its progress and outcome are queryable after the fact, and is the ' +
        "workflow's state reconstructible from on-disk artifacts rather than " +
        'from anyone’s memory?',
    },
  },
  {
    id: 'SDLC-2',
    dimension: 'tdd-discipline',
    axis: 'substrate',
    'cost-of-load': 'always-load',
    'integrity-class': 'sdlc',
    'applies-to': ['implementation-tasks', 'test-suites'],
    summary:
      'Outcome-based test adequacy for workflow types that declare it (feature, ' +
      'oneshot): new/changed behavior is covered by tests that can actually fail ' +
      '(the check_test_adequacy kill probe), judged test-AFTER — NOT commit-order ' +
      'test-first (#1587); discovery is exempt; debug and refactor have their own gates.',
    references: [GUIDE],
    'phase-affinity': ['review'],
    'workflow-affinity': ['feature', 'oneshot'],
    severity: { default: 'blocking', 'by-workflow': { oneshot: 'advisory' } },
    enforcement: {
      mode: 'audit',
      /**
       * Points at the `check_test_adequacy` gate, so test adequacy is not gated twice.
       * Test order is not a finding.
       */
      'audit-prompt':
        'For a workflow that declares verification (feature, oneshot), is each ' +
        'unit of new/changed production code covered by a test that can actually ' +
        'fail (not vacuous)? This mirrors the check_test_adequacy kill-probe gate; ' +
        'defer to that gate where it runs and flag only production code that landed ' +
        'with no adequacy-verified test. Test ORDERING (first vs after) is NOT a ' +
        'finding (#1587).',
    },
  },
  {
    id: 'SDLC-3',
    dimension: 'review-gate-honesty',
    axis: 'substrate',
    'cost-of-load': 'always-load',
    'integrity-class': 'sdlc',
    'applies-to': ['review-gates', 'verdicts'],
    summary:
      'A gate that fails surfaces its findings and the verdict reflects them. ' +
      'No advisory-laundering of a HIGH finding; a silent pass is worse than a ' +
      'loud fail.',
    references: [GUIDE],
    'phase-affinity': ['review'],
    'workflow-affinity': [...CODE_BEARING_WORKFLOWS],
    severity: { default: 'blocking' },
    enforcement: {
      mode: 'audit',
      'audit-prompt':
        'Does the review verdict faithfully reflect the findings — no HIGH ' +
        'finding quietly downgraded to advisory, no gate reported as passing ' +
        'while it had blocking findings? Flag any verdict that does not match ' +
        'its underlying findings.',
    },
  },
  {
    id: 'SDLC-4',
    dimension: 'branch-pr-discipline',
    axis: 'substrate',
    'cost-of-load': 'always-load',
    'integrity-class': 'sdlc',
    'applies-to': ['pull-requests', 'branch-topology', 'merge'],
    summary:
      'PR bodies carry the required sections (Summary / Changes / Test Plan); ' +
      'stacked PRs merge bottom-up; no admin-merge that bypasses review.',
    references: [GUIDE],
    'phase-affinity': ['review'],
    'workflow-affinity': [...CODE_BEARING_WORKFLOWS],
    severity: { default: 'blocking' },
    enforcement: {
      mode: 'audit',
      'audit-prompt':
        'Does the PR body carry the required sections (Summary, Changes, Test ' +
        'Plan), do stacked PRs merge bottom-up, and was review honoured rather ' +
        'than bypassed by an admin merge? Flag any PR that skipped these.',
    },
  },
  {
    id: 'SDLC-5',
    dimension: 'recovery-posture',
    axis: 'substrate',
    'cost-of-load': 'always-load',
    'integrity-class': 'sdlc',
    'applies-to': ['checkpoint', 'rehydrate', 'recovery-paths'],
    summary:
      'Any workflow can pause (checkpoint) and resume (rehydrate) from on-disk ' +
      'state without consulting human memory; recovery prefers native ' +
      'primitives and never destructively overwrites work.',
    references: [GUIDE],
    'phase-affinity': ['review'],
    'workflow-affinity': [...CODE_BEARING_WORKFLOWS],
    severity: { default: 'advisory' },
    enforcement: {
      mode: 'audit',
      'audit-prompt':
        'Can this workflow be paused and resumed purely from on-disk state, and ' +
        'does any reversal prefer a native recovery primitive over a ' +
        'destructive overwrite that could lose work? Flag recovery paths that ' +
        'depend on unsaved context or that discard work irrecoverably.',
    },
  },
];

/**
 * The validated SDLC-* baseline, parsed once at module load. A malformed entry
 * throws at server start, not during a resolve. `mergeCatalogs` also tags these
 * entries with `integrity-class: sdlc`.
 */
const SDLC_CATALOG: InvariantEntry[] = parseInvariantEntries(RAW_SDLC_ENTRIES);

/**
 * Returns the shipped SDLC-* catalog. It needs no registration. Each call returns
 * a new deep copy, so a consumer cannot change the shared module-level value.
 */
export function loadSdlcCatalog(): InvariantEntry[] {
  return structuredClone(SDLC_CATALOG);
}

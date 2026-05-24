/**
 * SDLC-* consumer-facing invariants catalog (issue #1467, design DR-1/DR-2).
 *
 * The default-on baseline Exarchos ships *to consumers* — engineers using
 * Exarchos as a plugin to govern their own SDLC. Distinct from the dev catalog
 * (`docs/architecture/invariants.md`, `INV-*`, devCatalog-gated, never surfaced
 * to consumers) and from a consumer's own `user`-layer catalog (`U-*`).
 *
 * ## Why inline (not a .md file)
 *
 * The MCP server ships as a single-file binary (`command: "exarchos"`); the npm
 * package `files` list bundles `dist/bin`, `commands`, `skills` — NOT `docs/`.
 * A catalog under `docs/` would be absent for plugin consumers, so a
 * *default-on* catalog cannot be a `docs/` file read at runtime. Authoring the
 * baseline as a typed constant compiled into the binary guarantees it is
 * present wherever the server runs, with zero file-IO at resolve time (INV-1)
 * and zero packaging/path-resolution risk. Consumers still author THEIR
 * catalogs as `.md`/`.yml` via `.exarchos.yml: invariants.catalogs`.
 *
 * ## Shape & validation
 *
 * Entries are authored in the same frontmatter shape as the dev catalog and
 * validated through the SAME `parseInvariantEntries` path (INV-2 spirit — one
 * parse, no drift), so the v3 `.strict()` enforcement DSL (INV-4) and every
 * typed-field projection apply identically. `loadSdlcCatalog()` fails fast at
 * module load if any entry is malformed.
 *
 * ## Audience-boundary contract (research §3)
 *
 * Every entry is workload-neutral consumer workflow-CONDUCT enforceable through
 * an affordance Exarchos already exposes (lifecycle events, review gates, the
 * PR template, checkpoint/rehydrate, posture). All are `mode: audit`: the
 * conformance gate evaluates a code diff, and SDLC conduct is a judgment about
 * the workflow, not a diff property. `axis: substrate` is the closest enum fit
 * for "runtime conduct" and yields the intended `discovery` exclusion (a
 * docs-only research workflow does not bear these). `integrity-class: sdlc`
 * gives the POLA override floor (INV-11): consumers tune entries down to
 * advisory via `.exarchos.yml: invariants.overrides`, never silently disable.
 */
import { parseInvariantEntries, type InvariantEntry } from './invariants-loader.js';

/** Workflow types the SDLC baseline governs — all code-bearing workflows; `discovery` (docs-only) excluded. */
const CODE_BEARING_WORKFLOWS = ['feature', 'debug', 'refactor', 'oneshot'] as const;

const GUIDE = 'docs/guides/authoring-invariants.md';

/**
 * The shipped baseline, authored in catalog-frontmatter shape. Kept as a plain
 * array so it reads like the `.md` catalog and is validated by the shared
 * parser rather than hand-built into the typed shape.
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
      'Test-before-implementation for workflow types that declare it (feature, ' +
      'oneshot); discovery is exempt; debug and refactor have their own gates.',
    references: [GUIDE],
    'phase-affinity': ['review'],
    'workflow-affinity': ['feature', 'oneshot'],
    severity: { default: 'blocking', 'by-workflow': { oneshot: 'advisory' } },
    enforcement: {
      mode: 'audit',
      // Points at the existing gate rather than re-expressing TDD as catalog
      // enforcement — avoids double-gating (research OQ#3 / design DR-1).
      'audit-prompt':
        'For a workflow that declares TDD (feature, oneshot), was each unit of ' +
        'production code preceded by a failing test? This mirrors the ' +
        'check_tdd_compliance gate; defer to that gate where it runs and flag ' +
        'only implementation that landed with no prior failing test.',
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
 * The validated SDLC-* baseline. Parsed once at module load via the shared
 * `parseInvariantEntries` (fail-fast: a malformed entry throws here, surfacing
 * at server start rather than mid-resolution). `mergeCatalogs` re-tags these
 * with `integrity-class: sdlc`; the inline class is the authoring intent.
 */
const SDLC_CATALOG: InvariantEntry[] = parseInvariantEntries(RAW_SDLC_ENTRIES);

/**
 * Return the shipped, default-on SDLC-* consumer catalog. No `devCatalog`-style
 * gate — sdlc ships enabled; the override mechanism is the consumer's escape
 * hatch, not a master switch.
 *
 * Returns a fresh deep copy per call (matching `loadInvariants`'s re-parse
 * semantics) so a downstream consumer cannot mutate the shared module-level
 * singleton — INV-1: the catalog is an immutable source, not a drifting store.
 */
export function loadSdlcCatalog(): InvariantEntry[] {
  return structuredClone(SDLC_CATALOG);
}

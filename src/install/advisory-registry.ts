/**
 * advisory-registry — governed inventory + ratchet for ADVISORY controls
 * (P07-07; WFQ-017, WFQ-018).
 *
 * An ADVISORY control is a check that WARNS rather than BLOCKS: it runs in CI,
 * surfaces findings, but its exit code is deliberately softened (`|| true`,
 * `continue-on-error: true`, or an `--observe` soak flag) so it cannot fail the
 * job. Advisories are a legitimate soak-window tool — but an unowned, un-expiring
 * advisory whose kill fixture can no longer fire is pure THEATRE: a gate that
 * exists only to look like coverage. This registry makes that impossible.
 *
 * ## The governance contract
 *
 * Every advisory control must carry, in {@link ADVISORY_REGISTRY}:
 *   - an OWNER (non-empty) — someone accountable for promoting or retiring it;
 *   - a PROMOTION THRESHOLD — the measured evidence that would justify making it
 *     blocking (non-empty);
 *   - a REMOVAL THRESHOLD — the measured evidence that would justify deleting it
 *     (non-empty);
 *   - an EXPIRY (`YYYY-MM-DD`) — a past expiry FAILS the ratchet, the same
 *     "deletion happens at expiry" philosophy as the shim ratchet and the
 *     `RESERVED(...)` module-intent gate;
 *   - a KILL FIXTURE (a probe id) — a seeded violation proving the advisory
 *     actually detects something. An advisory that cannot fire is theatre;
 *   - its SOFTENING SITES (`softening`) — every place the exit code is actually
 *     softened (`continue-on-error`, `--observe`, `|| true`), each keyed to the
 *     file it lives in and the target whose exit it swallows;
 *   - a CI PATH (`ciPath` + `ciStepMatch`) plus an explicit, MACHINE-VERIFIED
 *     claim about whether that path is filtered (`ciPathFiltered`);
 *   - an approval ISSUE (`#<number>`).
 *
 * ## Discovery is EXHAUSTIVE, not opt-in (DR-15)
 *
 * The original discovery scanned `scripts/**` for a hand-written
 * `ADVISORY(control: <id>)` marker comment. That mechanism can only see
 * advisories whose author volunteered to declare them — which is how the repo's
 * THIRD advisory (`tools/audit/gates/check-mutation-gate.mjs --observe`, softened inside
 * `.github/workflows/ci.yml`) and its FOURTH (the `continue-on-error: true`
 * capability-eval step in `.github/workflows/eval-gate.yml`) both sat outside
 * the registry: neither file carries a marker, and neither `.github/workflows`
 * nor `package.json` was even in the scan set. A detector that cannot see the
 * surface it claims to govern is the DR-12/13/14 failure class.
 *
 * {@link discoverSofteningSites} replaces that with EVIDENCE-BASED discovery
 * over the real tree. It walks `.github/workflows/**`, `package.json` scripts
 * and `scripts/**` and reports every occurrence of the three softening markers:
 *
 *   - `continue-on-error:` (any non-`false` value) on a workflow step;
 *   - `--observe` on an invocation of an enforcement primary;
 *   - `|| true` / `|| :` catching an invocation of an enforcement primary.
 *
 * "Enforcement primary" means a `scripts/(check|lint)-*.{mjs,sh}` file, directly
 * or through an `npm run <name>` chain. That narrowing is what keeps the scan
 * from drowning in the ~50 shell-idiom `|| true`s (`grep -c … || true`) that
 * soften nothing enforcement-bearing — see the module report for the shapes
 * deliberately NOT modelled.
 *
 * The `ADVISORY(...)` marker survives as a SUPPLEMENTARY, human-facing pointer:
 * a stray marker still fails the ratchet, but a registry entry is now backed by
 * a real softening site on disk, not by a comment.
 *
 * ## The ratchet
 *
 * {@link verifyAdvisoryRatchet} cross-checks the registry against the softening
 * sites discovered on disk, the markers discovered on disk, the parsed CI-path
 * analyses, AND the kill-fixture probe results:
 *   - a discovered SOFTENING SITE claimed by no registry entry FAILS (an
 *     advisory was added without complete governance — the count grew);
 *   - a discovered marker with no matching registry entry FAILS;
 *   - a registry entry with any missing/invalid governance field FAILS;
 *   - a registry entry whose `expires` is in the past FAILS (retire it);
 *   - a registry entry with a declared softening site that is NOT on disk FAILS
 *     (stale/dangling entry);
 *   - a registry entry whose `ciPathFiltered` claim disagrees with the PARSED
 *     workflow trigger / job / step `if:` gates FAILS, in BOTH directions — the
 *     "unfiltered CI path" claim used to be free text checked only for filename
 *     shape;
 *   - a registry entry whose kill fixture NO LONGER FIRES — the probe did not
 *     detect the seeded violation, or wrongly fired on the clean control — FAILS
 *     (the advisory has degraded into theatre).
 *
 * This module is PURE over its ratchet inputs — {@link verifyAdvisoryRatchet}
 * takes the registry, the discovered sets, the CI-path analyses, the probe
 * results, and `now` explicitly — so the ratchet rules are unit-testable without
 * a filesystem or a subprocess. {@link discoverAdvisories} and
 * {@link discoverSofteningSites} are the thin, injectable I/O adapters; the
 * CI-path analyses come from `tools/audit/gates/check-enforcer-wiring.mjs`
 * (`analyzeCiPathFilters`), which owns the workflow path-filter model.
 *
 * ## Marker grammar
 *
 * An advisory control file carries a single-line comment (any comment style):
 *
 *   `ADVISORY(control: <control-id>) — <free note>`
 *
 * Fields are `key: value` pairs separated by commas. The trailing ` — note`
 * after the close paren is not parsed.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The three ways this repo softens an exit code so a failure cannot block:
 *   - `continue-on-error` — a workflow step's `continue-on-error:` key;
 *   - `observe`           — an `--observe` soak-window flag on an enforcement
 *                           primary's invocation;
 *   - `or-true`           — a `|| true` / `|| :` catching an enforcement
 *                           primary's invocation.
 */
export type SofteningKind = 'continue-on-error' | 'observe' | 'or-true';

/** Every softening kind, for exhaustive validation. */
export const SOFTENING_KINDS: readonly SofteningKind[] = [
  'continue-on-error',
  'observe',
  'or-true',
];

/**
 * A registry entry's CLAIM on one softening site: "this advisory owns the
 * `<kind>` softening in `<file>` that swallows `<target>`". The ratchet matches
 * claims to discovered sites on the exact (file, kind, target) triple in BOTH
 * directions, so neither an unclaimed site nor a stale claim can survive.
 */
export interface AdvisorySofteningRef {
  /** POSIX repo-relative file carrying the softening marker. */
  readonly file: string;
  /** Which softening marker. */
  readonly kind: SofteningKind;
  /** Normalized principal artifact whose exit code the marker swallows. */
  readonly target: string;
}

/** A softening marker found on disk by {@link discoverSofteningSites}. */
export interface SofteningSite extends AdvisorySofteningRef {
  /** 1-based line of the softening marker in `file`. */
  readonly line: number;
  /** The raw (collapsed, truncated) text that produced the site. */
  readonly evidence: string;
}

/**
 * The structural result of `analyzeCiPathFilters` in
 * `tools/audit/gates/check-enforcer-wiring.mjs`. Kept as a structural type (not an import)
 * because `src/` is a separate `tsc` rootDir from `scripts/` — the CALLER
 * composes the two, exactly as it already composes the kill probes.
 */
export interface CiPathAnalysis {
  /** The event the analysis is about (`pull_request`). */
  readonly event: string;
  /** True ⇒ the claimed CI path really does fire on every PR. */
  readonly unfiltered: boolean;
  /** The narrowings found, empty iff `unfiltered`. */
  readonly filters: readonly { readonly kind: string; readonly detail: string }[];
}

/** One governed advisory control, keyed by (file, control). */
export interface AdvisoryEntry {
  /** Stable human id, e.g. `lint-inv6`. Unique across the registry. */
  readonly id: string;
  /** POSIX repo-relative path to the advisory control source file. */
  readonly file: string;
  /** The control id the advisory implements (matches the marker's `control`). */
  readonly control: string;
  /** Owning team / person — must be non-empty. */
  readonly owner: string;
  /** Measured evidence that would justify making the control BLOCKING. */
  readonly promotionThreshold: string;
  /** Measured evidence that would justify DELETING the control. */
  readonly removalThreshold: string;
  /** Approval issue ref: `#<number>`. */
  readonly issue: string;
  /** Expiry date `YYYY-MM-DD`; a past expiry FAILS the ratchet. */
  readonly expires: string;
  /** The kill-fixture probe id proving the advisory detects a seeded violation. */
  readonly killFixture: string;
  /** The `.github/workflows/*.yml` workflow hosting this advisory in CI. */
  readonly ciPath: string;
  /**
   * A plain SUBSTRING locating the hosting step inside `ciPath` (matched
   * against the step's `name` / `run` / `uses`). Required: without it the
   * "unfiltered CI path" claim cannot be verified past the workflow trigger.
   */
  readonly ciStepMatch: string;
  /**
   * The CLAIM: is the hosting CI lane path-filtered? Verified against the
   * PARSED trigger + job/step `if:` gates in BOTH directions — claiming
   * `false` when the lane is filtered, or `true` when it is not, both FAIL.
   */
  readonly ciPathFiltered: boolean;
  /**
   * Why the filtered lane is tolerated + what would move it to an unfiltered
   * host. Required (non-empty) iff `ciPathFiltered` is true; must be empty
   * when it is false, so the field cannot rot into decoration.
   */
  readonly ciFilterRationale: string;
  /** Every place this advisory's exit code is softened. Must be non-empty. */
  readonly softening: readonly AdvisorySofteningRef[];
}

/** An `ADVISORY(...)` marker parsed out of a source file. */
export interface DiscoveredAdvisory {
  /** POSIX repo-relative path to the file carrying the marker. */
  readonly file: string;
  /** The control id the marker declares. */
  readonly control: string;
  /** The raw field text inside the marker parens (for diagnostics). */
  readonly raw: string;
}

/**
 * The result of running an advisory's kill-fixture probe. A probe is HEALTHY
 * iff it FIRED on the seeded violation and stayed silent on the clean control —
 * i.e. it is discriminating. Anything else means the advisory can no longer be
 * trusted to detect its target.
 */
export interface KillProbeResult {
  /** The advisory id this probe attests. */
  readonly advisoryId: string;
  /** The kill-fixture id (matches the registry entry's `killFixture`). */
  readonly killFixture: string;
  /** True ⇒ the advisory FIRED on the seeded violation (detected it). */
  readonly firedOnViolation: boolean;
  /** True ⇒ the advisory (wrongly) fired on the seeded CLEAN control. */
  readonly firedOnClean: boolean;
  /** Optional free-text detail for diagnostics. */
  readonly detail?: string;
}

/** A single ratchet failure. */
export interface AdvisoryViolation {
  readonly kind:
    | 'unregistered'
    | 'expired'
    | 'malformed'
    | 'missing-on-disk'
    | 'control-mismatch'
    | 'duplicate-id'
    | 'ci-path-mismatch'
    | 'ci-path-unverified'
    | 'kill-fixture-missing'
    | 'kill-fixture-dead';
  readonly id?: string;
  readonly file?: string;
  readonly control?: string;
  readonly detail: string;
}

/** Result of a ratchet run — discriminated on `ok`. */
export interface AdvisoryRatchetResult {
  readonly ok: boolean;
  readonly violations: readonly AdvisoryViolation[];
}

// ─── The governed inventory ──────────────────────────────────────────────────

/**
 * The single authored list of governed advisory controls.
 *
 * Adding an `ADVISORY(...)` marker to the tree WITHOUT a complete matching entry
 * here fails {@link verifyAdvisoryRatchet}. Each entry pins an owner, a
 * promotion threshold (the measured evidence to make it blocking), a removal
 * threshold, an approval issue, an expiry, a kill-fixture probe, and the
 * unfiltered CI path where its findings reach CI.
 *
 * ### Inventory notes (P07-07, DR-15)
 *
 * The inventory is no longer taken from the enforcer-wiring manifest
 * (`tools/audit/gates/enforcer-wiring-manifest.json`, disposition `advisory`). That
 * manifest's domain is `scripts/check-*|lint-*` PRIMARIES, so it structurally
 * cannot name an advisory that is a built artifact — which is why it lists
 * THREE advisories while an exhaustive scan of the real tree finds FOUR. The
 * inventory below is reconciled against {@link discoverSofteningSites}, which
 * scans `.github/workflows/**`, `package.json` and `scripts/**` directly.
 *
 *   - `lint-inv6`             — grep lint for INV-6 workflow-agnosticism leaks.
 *     Softened by `(npm run lint:inv6 || true)` in the root `skills:guard`
 *     script. Its kill fixture spawns the REAL `tools/audit/gates/lint-inv6.mjs` against a
 *     seeded SKILL.md that leaks a workflow literal without a `workflow-type`
 *     declaration.
 *
 *   - `benchmark-regression`  — perf non-regression check, softened by
 *     `continue-on-error: true` in `benchmark-gate.yml`. Its kill fixture is a
 *     seeded (results, baselines) pair over the real script.
 *
 *   - `check-mutation-gate`   — diff-scoped mutation-adequacy gate, softened by
 *     `--observe` in `ci.yml`. NEWLY REGISTERED (DR-15). It escaped the previous
 *     registry because discovery required a hand-written `ADVISORY(...)` marker
 *     in a `scripts/**` file, and this advisory's softening lives in a WORKFLOW.
 *
 *   - `eval-capability-layer` — the promptfoo-backed capability eval suite,
 *     softened TWICE: `continue-on-error: true` on the `eval-gate.yml` step AND
 *     an in-code `layer === 'capability' ⇒ exit 0` rule in
 *     `tools/evals/evals/run-evals-cli.ts`. NEWLY DISCOVERED
 *     (DR-15) — no marker, not a `scripts/` primary, so neither the marker scan
 *     nor the enforcer-wiring manifest could see it.
 *
 * THREE of the four run on FILTERED CI lanes. That is recorded honestly in each
 * row's `ciPathFiltered` claim and machine-verified against the parsed
 * workflow, rather than asserted in prose.
 */
export const ADVISORY_REGISTRY: readonly AdvisoryEntry[] = [
  {
    id: 'lint-inv6',
    file: 'tools/audit/gates/lint-inv6.mjs',
    control: 'inv6-workflow-agnosticism',
    owner: 'exarchos',
    promotionThreshold:
      'Zero new INV-6 findings across two consecutive release trains AND a ' +
      'declared `workflow-type` escape hatch on every legitimate exception — ' +
      'then chain it into `skills:guard` with `&&` (drop the `|| true`).',
    removalThreshold:
      'The skills catalog no longer embeds workflow-typed literals at all (the ' +
      'INV-6 seam moves entirely into schema), making the grep lint redundant.',
    issue: '#1590',
    expires: '2027-06-30',
    killFixture: 'lint-inv6-flagged-skill',
    ciPath: '.github/workflows/ci.yml',
    ciStepMatch: 'npm run skills:guard',
    ciPathFiltered: true,
    ciFilterRationale:
      'Reaches CI only through `npm run skills:guard` in ci.yml\'s `test-root` job, ' +
      'which is gated by `needs.changes.outputs.root == \'true\'` — a dorny/paths-filter ' +
      'path filter. A PR touching only servers/** therefore never runs this lint at all. ' +
      'The pre-DR-15 registry claimed this ciPath was UNFILTERED; that claim was false and ' +
      'was only ever checked for filename shape. Moving it to the unfiltered grep-gates ' +
      'host is a prerequisite of its promotion threshold.',
    softening: [
      { file: 'package.json', kind: 'or-true', target: 'tools/audit/gates/lint-inv6.mjs' },
    ],
  },
  {
    id: 'benchmark-regression',
    file: 'tools/audit/gates/check-benchmark-regression.sh',
    control: 'benchmark-regression',
    owner: 'exarchos',
    promotionThreshold:
      'Benchmark variance is characterised (p95 spread over ≥3 green CI runs) ' +
      'and a threshold that clears the noise floor is set — then run it in ' +
      'benchmark-gate.yml WITHOUT `continue-on-error` so a real regression fails.',
    removalThreshold:
      'The tracked operations are retired or their perf budgets are enforced by ' +
      'a blocking latency gate elsewhere, making the advisory redundant.',
    issue: '#1590',
    expires: '2027-06-30',
    killFixture: 'benchmark-regression-over-threshold',
    ciPath: '.github/workflows/benchmark-gate.yml',
    ciStepMatch: 'tools/audit/gates/check-benchmark-regression.sh',
    ciPathFiltered: false,
    ciFilterRationale: '',
    softening: [
      {
        file: '.github/workflows/benchmark-gate.yml',
        kind: 'continue-on-error',
        target: 'tools/audit/gates/check-benchmark-regression.sh',
      },
    ],
  },
  {
    id: 'check-mutation-gate',
    file: 'tools/audit/gates/check-mutation-gate.mjs',
    control: 'mutation-adequacy',
    owner: 'exarchos',
    promotionThreshold:
      '#1720 resolves (StrykerJS dry-run stops degrading on the full server ' +
      'suite) AND the gate emits a real scored verdict — not a degrade/skip ' +
      'carrier — on ≥3 consecutive green CI runs; then drop `--observe` from the ' +
      'ci.yml invocation so a failing mutation verdict fails the job.',
    removalThreshold:
      'Diff-scoped mutation adequacy is subsumed by a blocking gate elsewhere ' +
      '(e.g. the coverage ratchet grows a mutation axis), making the standalone ' +
      'observe-mode gate redundant.',
    issue: '#1720',
    expires: '2027-06-30',
    killFixture: 'mutation-gate-failing-verdict',
    ciPath: '.github/workflows/ci.yml',
    ciStepMatch: 'tools/audit/gates/check-mutation-gate.mjs',
    ciPathFiltered: true,
    ciFilterRationale:
      'Hosted by ci.yml\'s `test-mcp` job, gated by `needs.changes.outputs.mcp == \'true\'` ' +
      '(a dorny/paths-filter path filter) AND by a step-level ' +
      '`if: github.event_name == \'pull_request\'`. A PR touching only root files never ' +
      'runs it. Compounding that, `--observe` collapses every failing verdict to exit 0 ' +
      '(the gate\'s own self-test, direction 9, `NoCoverageFailure_ObserveNeverBlocks`), so ' +
      'in its live configuration it cannot block on ANY lane. Both are exit conditions of ' +
      '#1720.',
    softening: [
      {
        file: '.github/workflows/ci.yml',
        kind: 'observe',
        target: 'tools/audit/gates/check-mutation-gate.mjs',
      },
    ],
  },
  {
    id: 'eval-capability-layer',
    file: 'tools/evals/evals/run-evals-cli.ts',
    control: 'eval-capability-layer',
    owner: 'exarchos',
    promotionThreshold:
      'The capability eval suite holds a stable pass rate across ≥3 consecutive ' +
      'green eval-gate runs with a pinned model + pinned graders (so a flake ' +
      'budget can be set) — then drop `continue-on-error` from the eval-gate.yml ' +
      'step AND the `layer === \'capability\' ⇒ exit 0` branch in run-evals-cli.ts, ' +
      'so a capability regression fails the job.',
    removalThreshold:
      'The capability layer is folded into the regression layer (one blocking ' +
      'suite) or the corpus is retired, making a separate advisory layer moot.',
    issue: '#1590',
    expires: '2027-06-30',
    killFixture: 'eval-capability-failing-summary',
    ciPath: '.github/workflows/eval-gate.yml',
    ciStepMatch: 'dist/evals/run-evals-cli.js',
    ciPathFiltered: true,
    ciFilterRationale:
      'eval-gate.yml is path-filtered at the trigger: `on.pull_request.paths` narrows to ' +
      'skills/**, commands/**, rules/**, tests/evals/**, a handful of src ' +
      'paths and the workflow file itself. A PR that regresses agent behaviour without ' +
      'touching one of those paths never runs the capability suite. Softened a SECOND time ' +
      'in code: run-evals-cli.ts returns 0 whenever `layer === \'capability\'`, regardless ' +
      'of `totalFailures` — the `continue-on-error` on the step is therefore redundant ' +
      'belt-and-braces, and removing only one of the two would not make the suite blocking.',
    softening: [
      {
        file: '.github/workflows/eval-gate.yml',
        kind: 'continue-on-error',
        target: 'dist/evals/run-evals-cli.js',
      },
    ],
  },
];

/**
 * Source roots scanned by {@link discoverAdvisories} in the real-repo ratchet
 * check. Advisory controls live with the repo automation, under `tools/` since
 * task 036; the scan is bounded so it stays fast and so "where advisories may
 * live" is an explicit list. An advisory marker smuggled outside these roots is
 * out of the ratchet's scope by design (add the root here to bring it in).
 */
export const ADVISORY_SCAN_ROOTS: readonly string[] = ['tools'];

/** File extensions scanned for advisory markers (advisories are scripts). */
export const ADVISORY_SCAN_EXTENSIONS: readonly string[] = ['.mjs', '.sh', '.js', '.cjs'];

/** This module's own repo-relative path — excluded from its own marker scan. */
const SELF_PATH = 'src/advisory-registry.ts';

// ─── Marker parsing ──────────────────────────────────────────────────────────

/**
 * Matches an `ADVISORY(<fields>)` marker. Built from a spliced string literal so
 * the regex source itself does NOT contain the literal marker token — that keeps
 * this module from matching itself if it is ever accidentally scanned.
 */
const ADVISORY_MARKER_RE = new RegExp('ADVISORY' + '\\(([^)]*)\\)', 'g');

/** Parse `key: value` field pairs from a marker's inner text. */
function parseFields(inner: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of inner.split(',')) {
    const kv = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(part);
    if (kv && kv[1] !== undefined && kv[2] !== undefined) {
      fields[kv[1].toLowerCase()] = kv[2];
    }
  }
  return fields;
}

/**
 * Extract every `ADVISORY(...)` marker from a file's source. Pure — no I/O.
 * `file` is echoed onto each result as the POSIX repo-relative path so callers
 * can key violations to a location.
 */
export function parseAdvisoryMarkers(source: string, file: string): DiscoveredAdvisory[] {
  const out: DiscoveredAdvisory[] = [];
  for (const m of source.matchAll(ADVISORY_MARKER_RE)) {
    const inner = m[1] ?? '';
    const fields = parseFields(inner);
    out.push({
      file,
      control: fields.control ?? '',
      raw: inner.trim(),
    });
  }
  return out;
}

// ─── Filesystem discovery (injectable I/O) ───────────────────────────────────

/** Narrow, injectable filesystem surface so discovery is testable. */
export interface AdvisoryDiscoveryFs {
  readFile(abs: string): string;
  listFiles(absRoot: string): string[];
}

/** Options for {@link discoverAdvisories}. */
export interface DiscoverAdvisoriesOptions {
  /** Absolute repo root. */
  readonly repoRoot: string;
  /** Repo-relative directories to scan. Defaults to {@link ADVISORY_SCAN_ROOTS}. */
  readonly roots?: readonly string[];
  /** File extensions to scan. Defaults to {@link ADVISORY_SCAN_EXTENSIONS}. */
  readonly extensions?: readonly string[];
  /** Override the filesystem surface (tests). */
  readonly fs?: AdvisoryDiscoveryFs;
}

/** True for paths/dirs that must never be scanned for advisory markers. */
function isExcludedSegment(segment: string): boolean {
  return segment === 'node_modules' || segment === 'dist' || segment === '__fixtures__';
}

/** True for a filename that is a test/self-test rather than a live advisory. */
function isExcludedFile(name: string): boolean {
  return /\.test\.[a-z]+$/.test(name) || name.endsWith('.d.ts');
}

/** Recursively collect files with a scanned extension under `absRoot`. */
function listFilesReal(absRoot: string, extensions: readonly string[]): string[] {
  const results: string[] = [];
  if (!existsSync(absRoot)) return results;
  const stack: string[] = [absRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break; // len>0 makes this unreachable; satisfies noUncheckedIndexedAccess without an assertion
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (isExcludedSegment(entry)) continue;
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (extensions.some((e) => entry.endsWith(e)) && !isExcludedFile(entry)) {
        results.push(full);
      }
    }
  }
  return results;
}

/** Normalize an OS path to POSIX separators. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Walk the configured roots and return every `ADVISORY(...)` marker found, as
 * POSIX-repo-relative {@link DiscoveredAdvisory}s. This module's own file is
 * excluded so its documentation/regex can never be mistaken for a live marker.
 */
export function discoverAdvisories(opts: DiscoverAdvisoriesOptions): DiscoveredAdvisory[] {
  const extensions = opts.extensions ?? ADVISORY_SCAN_EXTENSIONS;
  const fs: AdvisoryDiscoveryFs = opts.fs ?? {
    readFile: (abs) => readFileSync(abs, 'utf8'),
    listFiles: (absRoot) => listFilesReal(absRoot, extensions),
  };
  const roots = opts.roots ?? ADVISORY_SCAN_ROOTS;
  const found: DiscoveredAdvisory[] = [];
  for (const root of roots) {
    const absRoot = join(opts.repoRoot, root);
    for (const abs of fs.listFiles(absRoot)) {
      const rel = toPosix(relative(opts.repoRoot, abs));
      if (rel === SELF_PATH) continue;
      const source = fs.readFile(abs);
      if (!source.includes('ADVISORY' + '(')) continue;
      found.push(...parseAdvisoryMarkers(source, rel));
    }
  }
  return found;
}

// ─── Exhaustive softening discovery (DR-15) ──────────────────────────────────
//
// The mechanism that actually closes the registry gap. It does NOT look for a
// voluntary marker — it looks for the SOFTENING ITSELF, over the real tree.

/** Repo-relative roots scanned for `|| true` / `--observe` softening. */
export const SOFTENING_SCRIPT_ROOTS: readonly string[] = ['tools'];

/** Where workflow files live. */
export const SOFTENING_WORKFLOW_ROOT = '.github/workflows';

/** Extensions scanned under {@link SOFTENING_SCRIPT_ROOTS}. */
export const SOFTENING_SCRIPT_EXTENSIONS: readonly string[] = ['.mjs', '.sh', '.js', '.cjs'];

/**
 * Where enforcement primaries live — the single spelling this scan recognizes.
 *
 * Exported so a synthetic fixture can seed a path the scan will actually match
 * instead of restating the prefix. A fixture that hard-codes it keeps passing
 * against a vocabulary the scanner no longer speaks: after task 036 moved the
 * tree, half this module's fixtures still seeded `scripts/` and the scan
 * reported zero sites — an empty result that reads exactly like "clean".
 */
export const ENFORCEMENT_PRIMARY_DIR = 'tools/audit/gates';

/** An enforcement primary: the class of thing whose exit code MATTERS. */
const PRIMARY_PATH_RE = new RegExp(
  `${ENFORCEMENT_PRIMARY_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:check|lint)-[A-Za-z0-9._-]+?\\.(?:mjs|sh)`,
  'g',
);

/** `npm run <name>` reference. */
const NPM_RUN_RE = /\bnpm\s+run\s+([A-Za-z0-9:_.-]+)/g;

/** Collapse + truncate text for diagnostics. */
function evidenceOf(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Direct `scripts/(check|lint)-*.{mjs,sh}` references, self-tests excluded. */
function directPrimaryRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PRIMARY_PATH_RE)) {
    const rel = m[0];
    if (/\.test\.(mjs|sh)$/.test(rel)) continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/**
 * Every enforcement primary reachable from `text`, expanding `npm run <name>`
 * through the package.json script map (cycle-guarded). This is the narrowing
 * that separates a load-bearing `|| true` from the ~50 shell idioms
 * (`grep -c … || true`, `check_lint || true` on a shell FUNCTION) that soften
 * nothing enforcement-bearing.
 */
export function resolveEnforcementRefs(
  text: string,
  scripts: Readonly<Record<string, string>>,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  const out = directPrimaryRefs(text);
  for (const m of text.matchAll(NPM_RUN_RE)) {
    const name = m[1];
    if (name === undefined || seen.has(name)) continue;
    const body = scripts[name];
    if (typeof body !== 'string') continue;
    for (const ref of resolveEnforcementRefs(body, scripts, new Set([...seen, name]))) {
      if (!out.includes(ref)) out.push(ref);
    }
  }
  return out;
}

/** Normalize a path token found in a command into a stable target id. */
function normalizeTarget(token: string): string {
  return token
    .replace(/^["']|["']$/g, '')
    .replace(/^\$\{?GITHUB_WORKSPACE\}?\//, '')
    .replace(/^\$\{\{\s*github\.workspace\s*\}\}\//, '')
    .replace(/^\.\//, '');
}

/**
 * The principal artifact whose exit code a softened command carries. Resolution
 * order: an enforcement primary → an `npm run` name → the first script-ish path
 * token → the collapsed command text. Deterministic, so a registry claim can
 * pin it.
 */
export function principalTarget(
  command: string,
  scripts: Readonly<Record<string, string>>,
): string {
  const refs = resolveEnforcementRefs(command, scripts);
  if (refs[0] !== undefined) return refs[0];
  const npm = NPM_RUN_RE.exec(command);
  NPM_RUN_RE.lastIndex = 0;
  if (npm?.[1] !== undefined) return `npm:${npm[1]}`;
  const file = command.match(
    /(?:^|[\s"'=|])((?:[\w.@${}/-]+\/)*[\w.-]+\.(?:mjs|cjs|js|ts|sh|py))\b/,
  );
  if (file?.[1] !== undefined) return normalizeTarget(file[1]);
  return evidenceOf(command, 60);
}

/** Characters that end a shell "atom" for the purposes of softening analysis. */
function atomStart(text: string, before: number): number {
  for (let i = before - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '\n' || c === ';' || c === '(') return i + 1;
    if ((c === '&' || c === '|') && text[i - 1] === c) return i + 1;
  }
  return 0;
}

/** Characters that end an atom scanning forward. */
function atomEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '\n' || c === ';' || c === ')') return i;
    if ((c === '&' || c === '|') && text[i + 1] === c) return i;
  }
  return text.length;
}

/** 1-based line of `index` within `text`, offset by `baseLine`. */
function lineAt(text: string, index: number, baseLine: number): number {
  let n = baseLine;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/** `|| true` / `|| :` — a caught failure. */
const OR_TRUE_RE = /\|\|\s*(?:true\b|:(?=\s*(?:$|[;)\n&|])))/g;
const OBSERVE_RE = /--observe\b/g;

/**
 * Scan one command/source blob for `|| true` and `--observe` softening of an
 * enforcement primary. Pure — the caller supplies the file identity and the
 * line the blob starts on.
 */
export function scanCommandSoftening(
  text: string,
  file: string,
  baseLine: number,
  scripts: Readonly<Record<string, string>>,
): SofteningSite[] {
  const sites: SofteningSite[] = [];

  for (const m of text.matchAll(OR_TRUE_RE)) {
    const idx = m.index ?? 0;
    const caught = text.slice(atomStart(text, idx), idx);
    if (resolveEnforcementRefs(caught, scripts).length === 0) continue;
    sites.push({
      file,
      kind: 'or-true',
      target: principalTarget(caught, scripts),
      line: lineAt(text, idx, baseLine),
      evidence: evidenceOf(`${caught}${m[0]}`),
    });
  }

  for (const m of text.matchAll(OBSERVE_RE)) {
    const idx = m.index ?? 0;
    const atom = text.slice(atomStart(text, idx), atomEnd(text, idx));
    if (resolveEnforcementRefs(atom, scripts).length === 0) continue;
    sites.push({
      file,
      kind: 'observe',
      target: principalTarget(atom, scripts),
      line: lineAt(text, idx, baseLine),
      evidence: evidenceOf(atom),
    });
  }

  return sites;
}

/** A `- ` list item together with the absolute line index it starts on. */
interface ListItem {
  readonly lines: string[];
  readonly start: number;
}

/** Group workflow lines into `- ` list items (steps), keeping line offsets. */
function groupListItems(lines: readonly string[]): ListItem[] {
  const items: ListItem[] = [];
  let current: { lines: string[]; start: number } | null = null;
  let currentIndent = -1;
  const flush = (): void => {
    if (current) items.push({ lines: current.lines, start: current.start });
    current = null;
    currentIndent = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const marker = /^(\s*)-\s/.exec(line);
    if (marker) {
      const indent = (marker[1] ?? '').length;
      if (current && indent <= currentIndent) flush();
      if (!current) {
        current = { lines: [line], start: i };
        currentIndent = indent;
      } else {
        current.lines.push(line);
      }
      continue;
    }
    if (current) {
      const contentIndent = line.search(/\S/);
      if (contentIndent !== -1 && contentIndent <= currentIndent) {
        flush();
        continue;
      }
      current.lines.push(line);
    }
  }
  flush();
  return items;
}

/** The `run:` command of a step plus the line offset it starts on. */
function extractRun(stepLines: readonly string[]): { command: string; offset: number } | null {
  for (let i = 0; i < stepLines.length; i++) {
    const line = stepLines[i] ?? '';
    const m = line.match(/^(\s*)(?:-\s+)?run:\s?(.*)$/);
    if (!m) continue;
    const rest = m[2] ?? '';
    if (!/^[|>][+-]?\s*$/.test(rest.trim()) && rest.trim() !== '') {
      return { command: rest, offset: i };
    }
    const block: string[] = [];
    let contentIndent: number | null = null;
    for (let j = i + 1; j < stepLines.length; j++) {
      const bl = stepLines[j] ?? '';
      if (bl.trim() === '') {
        block.push('');
        continue;
      }
      const ind = bl.search(/\S/);
      if (contentIndent === null) contentIndent = ind;
      if (ind < contentIndent) break;
      block.push(bl.slice(contentIndent));
    }
    return { command: block.join('\n'), offset: i + 1 };
  }
  return null;
}

/**
 * Every softening site in one workflow file.
 *
 * `continue-on-error:` is enumerated from the LINES (every structural
 * occurrence), then attributed to the step block containing it. A
 * `continue-on-error:` that belongs to no step — a JOB-level softening — still
 * produces a site, with a coarse `job-level:<line>` target, so it cannot
 * escape. `--observe` / `|| true` are scanned inside `run:` bodies only, so a
 * YAML comment mentioning them is not mistaken for a live softening.
 */
export function discoverWorkflowSoftening(
  text: string,
  file: string,
  scripts: Readonly<Record<string, string>>,
): SofteningSite[] {
  const lines = text.split('\n');
  const items = groupListItems(lines);
  const sites: SofteningSite[] = [];

  // 1. `--observe` / `|| true` inside step `run:` bodies.
  for (const item of items) {
    const run = extractRun(item.lines);
    if (!run) continue;
    sites.push(
      ...scanCommandSoftening(run.command, file, item.start + run.offset + 1, scripts),
    );
  }

  // 2. Every structural `continue-on-error:` line, attributed to its step.
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(/^\s*(?:-\s+)?continue-on-error:\s*(.+?)\s*$/);
    if (!m) continue;
    const value = m[1] ?? '';
    if (/^false$/i.test(value)) continue; // explicitly NOT softened
    const owner = items.find((it) => i >= it.start && i < it.start + it.lines.length);
    const run = owner ? extractRun(owner.lines) : null;
    sites.push({
      file,
      kind: 'continue-on-error',
      target: run ? principalTarget(run.command, scripts) : `job-level:${i + 1}`,
      line: i + 1,
      evidence: evidenceOf(run ? run.command : (lines[i] ?? '')),
    });
  }

  return sites;
}

/** Narrow, injectable filesystem surface for {@link discoverSofteningSites}. */
export interface SofteningDiscoveryFs {
  readFile(abs: string): string;
  listFiles(absRoot: string, extensions: readonly string[]): string[];
  exists(abs: string): boolean;
}

/** Options for {@link discoverSofteningSites}. */
export interface DiscoverSofteningOptions {
  /** Absolute repo root. */
  readonly repoRoot: string;
  /** Repo-relative workflow directory. Defaults to `.github/workflows`. */
  readonly workflowRoot?: string;
  /** Repo-relative script roots. Defaults to {@link SOFTENING_SCRIPT_ROOTS}. */
  readonly scriptRoots?: readonly string[];
  /** Repo-relative package manifest. Defaults to `package.json`. */
  readonly packageJsonPath?: string;
  /** Override the filesystem surface (tests). */
  readonly fs?: SofteningDiscoveryFs;
}

function realSofteningFs(): SofteningDiscoveryFs {
  return {
    readFile: (abs) => readFileSync(abs, 'utf8'),
    listFiles: (absRoot, extensions) => listFilesReal(absRoot, extensions),
    exists: (abs) => existsSync(abs),
  };
}

/**
 * Walk the REAL tree and return every softening site. Exhaustive over the three
 * surfaces a softening can live on in this repo:
 *
 *   1. `.github/workflows/**` — `continue-on-error:`, plus `--observe` /
 *      `|| true` inside step `run:` bodies;
 *   2. `package.json` scripts — `--observe` / `|| true`;
 *   3. `scripts/**` (non-self-test) — `--observe` / `|| true`.
 *
 * Sites are sorted (file, line, kind) so the output is stable.
 */
export function discoverSofteningSites(opts: DiscoverSofteningOptions): SofteningSite[] {
  const fs = opts.fs ?? realSofteningFs();
  const workflowRoot = opts.workflowRoot ?? SOFTENING_WORKFLOW_ROOT;
  const scriptRoots = opts.scriptRoots ?? SOFTENING_SCRIPT_ROOTS;
  const pkgPath = opts.packageJsonPath ?? 'package.json';

  // npm script map — needed to resolve `npm run <name>` chains to primaries.
  let scripts: Record<string, string> = {};
  const absPkg = join(opts.repoRoot, pkgPath);
  let pkgRaw: string | null = null;
  if (fs.exists(absPkg)) {
    try {
      pkgRaw = fs.readFile(absPkg);
      const parsed: unknown = JSON.parse(pkgRaw);
      const maybe = (parsed as { scripts?: unknown } | null)?.scripts;
      if (maybe && typeof maybe === 'object') {
        for (const [k, v] of Object.entries(maybe as Record<string, unknown>)) {
          if (typeof v === 'string') scripts[k] = v;
        }
      }
    } catch {
      scripts = {};
    }
  }

  const sites: SofteningSite[] = [];

  // 1. Workflows.
  const absWorkflows = join(opts.repoRoot, workflowRoot);
  for (const abs of fs.listFiles(absWorkflows, ['.yml', '.yaml'])) {
    const rel = toPosix(relative(opts.repoRoot, abs));
    sites.push(...discoverWorkflowSoftening(fs.readFile(abs), rel, scripts));
  }

  // 2. package.json scripts. Line numbers are resolved against the raw file so
  //    a violation points at a real line.
  for (const [name, body] of Object.entries(scripts)) {
    const found = scanCommandSoftening(body, pkgPath, 1, scripts);
    if (found.length === 0) continue;
    let line = 1;
    if (pkgRaw !== null) {
      const idx = pkgRaw.indexOf(`"${name}":`);
      if (idx >= 0) line = lineAt(pkgRaw, idx, 1);
    }
    for (const site of found) sites.push({ ...site, line });
  }

  // 3. Script roots. Self-tests (`*.test.sh` / `*.test.mjs`) are excluded here,
  //    in DISCOVERY rather than only in the fs adapter: a harness that softens
  //    the subject it is probing is a test, not a live advisory, and that must
  //    hold for every filesystem the scan runs against.
  for (const root of scriptRoots) {
    const absRoot = join(opts.repoRoot, root);
    for (const abs of fs.listFiles(absRoot, SOFTENING_SCRIPT_EXTENSIONS)) {
      const rel = toPosix(relative(opts.repoRoot, abs));
      if (/\.test\.[A-Za-z0-9]+$/.test(rel)) continue;
      sites.push(...scanCommandSoftening(fs.readFile(abs), rel, 1, scripts));
    }
  }

  return sites.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind),
  );
}

// ─── Governance validation ───────────────────────────────────────────────────

/** UTC midnight of a date, for a whole-day expiry comparison. */
function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

interface GovernanceProblem {
  readonly kind: 'malformed' | 'expired';
  readonly detail: string;
}

const WORKFLOW_PATH_RE = /^\.github\/workflows\/[\w.-]+\.ya?ml$/;

/**
 * Validate a registry entry's governance fields against `now`. Returns the list
 * of problems (empty ⇒ valid): a non-empty owner, promotion threshold, removal
 * threshold, and kill fixture; a well-formed issue ref (`#<number>`); a CLEAN
 * `YYYY-MM-DD` expiry that is a real calendar date and not in the past; a
 * `ciPath` that names a `.github/workflows/*.yml` workflow; a non-empty
 * `ciStepMatch`; a `ciFilterRationale` present iff `ciPathFiltered`; and at
 * least one well-formed softening ref.
 *
 * This is the STRUCTURAL enforcement of "owner, threshold, expiry and kill
 * fixture" (DR-15) — the four mandated fields cannot be omitted (the type
 * forbids it) and cannot be blank (this pass forbids it).
 */
export function validateAdvisoryGovernance(
  entry: AdvisoryEntry,
  now: Date,
): GovernanceProblem[] {
  const problems: GovernanceProblem[] = [];

  const requireNonEmpty = (value: string, field: string): void => {
    if (!/\S/.test(value)) {
      problems.push({ kind: 'malformed', detail: `${field} is required and must be non-empty` });
    }
  };

  requireNonEmpty(entry.owner, 'owner');
  requireNonEmpty(entry.promotionThreshold, 'promotionThreshold');
  requireNonEmpty(entry.removalThreshold, 'removalThreshold');
  requireNonEmpty(entry.killFixture, 'killFixture');
  requireNonEmpty(entry.ciStepMatch, 'ciStepMatch');

  if (!/^#\d+$/.test(entry.issue)) {
    problems.push({
      kind: 'malformed',
      detail: `issue ref must be "#<number>" (got ${JSON.stringify(entry.issue)})`,
    });
  }

  if (!WORKFLOW_PATH_RE.test(entry.ciPath)) {
    problems.push({
      kind: 'malformed',
      detail:
        `ciPath must name a CI workflow (.github/workflows/*.yml) — ` +
        `got ${JSON.stringify(entry.ciPath)}`,
    });
  }

  // The filtered claim and its rationale move together, in BOTH directions —
  // a rationale on an unfiltered row is stale decoration.
  if (entry.ciPathFiltered && !/\S/.test(entry.ciFilterRationale)) {
    problems.push({
      kind: 'malformed',
      detail:
        'ciFilterRationale is required and must be non-empty when ciPathFiltered is true ' +
        '(record why the filtered lane is tolerated and what moves it off)',
    });
  }
  if (!entry.ciPathFiltered && /\S/.test(entry.ciFilterRationale)) {
    problems.push({
      kind: 'malformed',
      detail: 'ciFilterRationale must be empty when ciPathFiltered is false',
    });
  }

  if (entry.softening.length === 0) {
    problems.push({
      kind: 'malformed',
      detail:
        'softening must list at least one site — an advisory with no softening on disk is ' +
        'either blocking (promote it) or dead (remove it)',
    });
  }
  for (const [i, ref] of entry.softening.entries()) {
    if (!/\S/.test(ref.file)) {
      problems.push({ kind: 'malformed', detail: `softening[${i}].file is required` });
    }
    if (!/\S/.test(ref.target)) {
      problems.push({ kind: 'malformed', detail: `softening[${i}].target is required` });
    }
    if (!SOFTENING_KINDS.includes(ref.kind)) {
      problems.push({
        kind: 'malformed',
        detail:
          `softening[${i}].kind must be one of ${SOFTENING_KINDS.join('|')} — ` +
          `got ${JSON.stringify(ref.kind)}`,
      });
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
    problems.push({
      kind: 'malformed',
      detail: `expires must be a clean YYYY-MM-DD date (got ${JSON.stringify(entry.expires)})`,
    });
  } else {
    const parsed = new Date(`${entry.expires}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== entry.expires) {
      problems.push({
        kind: 'malformed',
        detail: `expires is not a real calendar date (got ${JSON.stringify(entry.expires)})`,
      });
    } else if (parsed.getTime() < startOfUtcDay(now)) {
      problems.push({
        kind: 'expired',
        detail:
          `advisory expired on ${entry.expires} — an expired advisory must be promoted, ` +
          `removed, or re-approved with a future expiry`,
      });
    }
  }

  return problems;
}

// ─── The ratchet ─────────────────────────────────────────────────────────────

const PAIR_SEP = '\u0000';
const pairKey = (file: string, control: string): string => `${file}${PAIR_SEP}${control}`;
const siteKey = (ref: AdvisorySofteningRef): string =>
  `${ref.file}${PAIR_SEP}${ref.kind}${PAIR_SEP}${ref.target}`;

/** Inputs to {@link verifyAdvisoryRatchet}. */
export interface AdvisoryRatchetInputs {
  readonly registry: readonly AdvisoryEntry[];
  readonly discovered: readonly DiscoveredAdvisory[];
  readonly probeResults: readonly KillProbeResult[];
  /**
   * Every softening marker found on disk (from {@link discoverSofteningSites}).
   * REQUIRED, not optional: a ratchet that can be run without its evidence is a
   * ratchet that WILL be run without its evidence.
   */
  readonly softeningSites: readonly SofteningSite[];
  /**
   * advisory id → the parsed CI-path analysis for that entry's `ciPath`, from
   * `analyzeCiPathFilters` in `tools/audit/gates/check-enforcer-wiring.mjs`. An entry with
   * no analysis FAILS (`ci-path-unverified`) — an unverifiable claim is not a
   * passing claim.
   */
  readonly ciPathAnalyses: ReadonlyMap<string, CiPathAnalysis>;
  readonly now: Date;
}

/**
 * The ratchet. Compares the governed registry against the softening sites and
 * advisory markers discovered on disk, validates each entry's governance,
 * verifies each entry's CI-path claim against the parsed workflow, and verifies
 * each entry's kill fixture still fires. Never short-circuits — a caller sees
 * every violation in one pass.
 *
 * Violation classes:
 *   - `duplicate-id`         — two registry entries share an id.
 *   - `malformed`/`expired`  — a registry entry's governance is invalid / past.
 *   - `unregistered`         — a discovered softening site or advisory marker
 *                              has no entry (the count grew without complete
 *                              governance).
 *   - `control-mismatch`     — the marker's control disagrees with the entry.
 *   - `missing-on-disk`      — a registry entry claims a softening site that is
 *                              not on disk (stale claim).
 *   - `ci-path-mismatch`     — the entry's `ciPathFiltered` claim disagrees with
 *                              the PARSED trigger / job / step `if:` gates.
 *   - `ci-path-unverified`   — no CI-path analysis was supplied for an entry.
 *   - `kill-fixture-missing` — a registry entry has no probe result at all.
 *   - `kill-fixture-dead`    — the probe did not fire on the seeded violation,
 *                              or wrongly fired on the clean control (the
 *                              advisory has decayed into theatre).
 */
export function verifyAdvisoryRatchet(inputs: AdvisoryRatchetInputs): AdvisoryRatchetResult {
  const { registry, discovered, probeResults, softeningSites, ciPathAnalyses, now } = inputs;
  const violations: AdvisoryViolation[] = [];

  // 0. Registry ids must be unique — a duplicate id makes remediation ambiguous.
  const seenIds = new Set<string>();
  for (const e of registry) {
    if (seenIds.has(e.id)) {
      violations.push({
        kind: 'duplicate-id',
        id: e.id,
        detail: `registry id '${e.id}' is declared more than once`,
      });
    }
    seenIds.add(e.id);
  }

  // 1. Governance: every entry must be well-formed and unexpired.
  for (const e of registry) {
    for (const p of validateAdvisoryGovernance(e, now)) {
      violations.push({
        kind: p.kind,
        id: e.id,
        file: e.file,
        control: e.control,
        detail: `registry entry '${e.id}': ${p.detail}`,
      });
    }
  }

  // 2. Every discovered SOFTENING SITE must be claimed by a registry entry.
  //    This is the exhaustive-discovery ratchet: a `continue-on-error` /
  //    `--observe` / `|| true` added anywhere on the scanned surfaces without a
  //    complete registry row fails here. It does NOT depend on anyone
  //    remembering to write an `ADVISORY(...)` marker.
  const claimed = new Map<string, AdvisoryEntry>();
  for (const e of registry) {
    for (const ref of e.softening) claimed.set(siteKey(ref), e);
  }
  const sitesOnDisk = new Set(softeningSites.map(siteKey));
  for (const site of softeningSites) {
    if (claimed.has(siteKey(site))) continue;
    violations.push({
      kind: 'unregistered',
      file: site.file,
      detail:
        `unregistered advisory softening: ${site.kind} at ${site.file}:${site.line} swallows ` +
        `'${site.target}' (${site.evidence}) — add an ADVISORY_REGISTRY entry with an owner, ` +
        `promotion + removal thresholds, an issue, a future expiry, a kill fixture, a verified ` +
        `CI-path claim, and this softening site; or remove the softening so the check blocks`,
    });
  }

  // 3. Every claimed softening site must still exist on disk (no stale claims).
  for (const e of registry) {
    for (const ref of e.softening) {
      if (sitesOnDisk.has(siteKey(ref))) continue;
      violations.push({
        kind: 'missing-on-disk',
        id: e.id,
        file: ref.file,
        control: e.control,
        detail:
          `registered advisory '${e.id}' claims a ${ref.kind} softening of '${ref.target}' in ` +
          `${ref.file}, but no such softening is on disk — remove the stale claim (the control ` +
          `may already be blocking) or restore it`,
      });
    }
  }

  const regByPair = new Map<string, AdvisoryEntry>();
  for (const e of registry) regByPair.set(pairKey(e.file, e.control), e);

  // 4. An `ADVISORY(...)` marker is now SUPPLEMENTARY (human-facing), but a
  //    stray one still fails: it would document an advisory nobody governs.
  for (const d of discovered) {
    const key = pairKey(d.file, d.control);
    const entry = regByPair.get(key);
    if (entry) continue;
    const sameFile = registry.find((r) => r.file === d.file);
    if (sameFile) {
      violations.push({
        kind: 'control-mismatch',
        id: sameFile.id,
        file: d.file,
        control: d.control,
        detail:
          `marker control '${d.control}' disagrees with registered control ` +
          `'${sameFile.control}' for '${sameFile.id}'`,
      });
    } else {
      violations.push({
        kind: 'unregistered',
        file: d.file,
        control: d.control,
        detail:
          `advisory marker ${d.file} (control ${d.control}) is not registered — add an ` +
          `ADVISORY_REGISTRY entry with an owner, promotion + removal thresholds, ` +
          `an issue, a future expiry, a kill fixture, and its softening sites, ` +
          `or remove the ADVISORY marker`,
      });
    }
  }

  // 5. The "unfiltered CI path" claim is VERIFIED against the parsed workflow,
  //    in BOTH directions. Before DR-15 this was free text checked only for
  //    filename shape, so `.github/workflows/anything.yml` satisfied it even
  //    when the lane was narrowed by `paths:` or gated by a job `if:`.
  for (const e of registry) {
    const analysis = ciPathAnalyses.get(e.id);
    if (!analysis) {
      violations.push({
        kind: 'ci-path-unverified',
        id: e.id,
        file: e.ciPath,
        control: e.control,
        detail:
          `no CI-path analysis supplied for '${e.id}' (${e.ciPath}) — the unfiltered-CI-path ` +
          `claim cannot be verified, and an unverifiable claim does not pass`,
      });
      continue;
    }
    const derivedFiltered = !analysis.unfiltered;
    if (derivedFiltered === e.ciPathFiltered) continue;
    violations.push({
      kind: 'ci-path-mismatch',
      id: e.id,
      file: e.ciPath,
      control: e.control,
      detail: e.ciPathFiltered
        ? `advisory '${e.id}' declares its ${e.ciPath} lane FILTERED, but the parsed ` +
          `${analysis.event} trigger + job/step gates show it is unfiltered — drop the ` +
          `ciPathFiltered claim and its rationale`
        : `advisory '${e.id}' claims an UNFILTERED CI path in ${e.ciPath}, but the parsed ` +
          `${analysis.event} lane is filtered: ` +
          analysis.filters.map((f) => `${f.kind} — ${f.detail}`).join('; '),
    });
  }

  // 6. Every registry entry's kill fixture must still fire (and be discriminating).
  const probeById = new Map<string, KillProbeResult>();
  for (const r of probeResults) probeById.set(r.advisoryId, r);
  for (const e of registry) {
    const probe = probeById.get(e.id);
    if (!probe) {
      violations.push({
        kind: 'kill-fixture-missing',
        id: e.id,
        file: e.file,
        control: e.control,
        detail:
          `advisory '${e.id}' declares kill fixture '${e.killFixture}' but no probe ` +
          `result was supplied — the kill fixture must be executed and shown to fire`,
      });
      continue;
    }
    if (!probe.firedOnViolation) {
      violations.push({
        kind: 'kill-fixture-dead',
        id: e.id,
        file: e.file,
        control: e.control,
        detail:
          `kill fixture '${e.killFixture}' did NOT fire on its seeded violation — the ` +
          `advisory can no longer detect its target (theatre)` +
          (probe.detail ? `: ${probe.detail}` : ''),
      });
    } else if (probe.firedOnClean) {
      violations.push({
        kind: 'kill-fixture-dead',
        id: e.id,
        file: e.file,
        control: e.control,
        detail:
          `kill fixture '${e.killFixture}' fired on the CLEAN control — it is not ` +
          `discriminating, so a "fire" proves nothing` +
          (probe.detail ? `: ${probe.detail}` : ''),
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Thrown by {@link assertAdvisoryRatchet} when the ratchet fails. */
export class AdvisoryRatchetError extends Error {
  override readonly name = 'AdvisoryRatchetError';
  readonly code = 'ADVISORY_RATCHET_VIOLATION';
  constructor(public readonly violations: readonly AdvisoryViolation[]) {
    super(
      `Advisory ratchet failed — ${violations.length} violation(s):\n` +
        violations
          .map((v) => `  • [${v.kind}] ${v.id ?? v.file ?? ''} — ${v.detail}`)
          .join('\n'),
    );
  }
}

/** Verify the ratchet and THROW {@link AdvisoryRatchetError} on any violation. */
export function assertAdvisoryRatchet(inputs: AdvisoryRatchetInputs): void {
  const result = verifyAdvisoryRatchet(inputs);
  if (!result.ok) throw new AdvisoryRatchetError(result.violations);
}

// ─── Kill fixtures for the DR-15 rows ────────────────────────────────────────
//
// DESIGN TENSION (reported, not absorbed): the executable kill fixtures belong
// in `advisory-kill-probes.ts` beside `probeLintInv6` /
// `probeBenchmarkRegression`. They live here because T-21's file scope is
// (advisory-registry.ts, check-enforcer-wiring.mjs, advisory-registry.test.ts)
// and a row without a firing kill fixture would fail the ratchet. Relocating
// them is a mechanical follow-up.
//
// Both probes follow the pattern `probeBenchmarkRegression` already established
// for a control that cannot be spawned portably: a FAITHFUL IN-PROCESS PORT of
// the control's decision rule, run against a seeded (violation, clean) pair,
// GUARDED by a structural assertion that the real control still contains the
// branch being ported. A gutted or deleted control therefore still fails.

/** Options accepted by the local kill probes. */
export interface LocalKillProbeOptions {
  /** Absolute repo root. */
  readonly repoRoot: string;
}

/** A kill-probe runner. */
export type AdvisoryProbeRunner = (
  advisory: AdvisoryEntry,
  opts: LocalKillProbeOptions,
) => KillProbeResult;

function missingControl(advisory: AdvisoryEntry, path: string): KillProbeResult {
  return {
    advisoryId: advisory.id,
    killFixture: advisory.killFixture,
    firedOnViolation: false,
    firedOnClean: false,
    detail: `advisory control not found on disk: ${path}`,
  };
}

/** The bridge-result carrier shape `check-mutation-gate.mjs` scores. */
interface MutationCarrier {
  readonly success: boolean;
  readonly data?: {
    readonly passed?: boolean;
    readonly mutationScore?: number;
    readonly threshold?: number;
    readonly noCoverage?: number;
    readonly maxNoCoverage?: number;
    readonly warning?: string;
    readonly skipped?: boolean;
    readonly degraded?: boolean;
  };
}

/**
 * A faithful port of `computeVerdict`'s FAILURE decision in
 * `tools/audit/gates/check-mutation-gate.mjs`: a carrier fails when the handler errored,
 * when it is a degrade/skip/warning carrier (no verifiable verdict), when its
 * scored axes are not finite, or when `passed !== true`.
 */
export function mutationVerdictFires(result: MutationCarrier): boolean {
  if (result.success !== true) return true;
  const data = result.data;
  if (!data || typeof data !== 'object') return true;
  if (data.warning !== undefined) return true;
  if (data.skipped === true) return true;
  if (data.degraded === true) return true;
  const hasVerdict =
    typeof data.passed === 'boolean' &&
    Number.isFinite(data.mutationScore) &&
    Number.isFinite(data.threshold) &&
    Number.isFinite(data.noCoverage) &&
    Number.isFinite(data.maxNoCoverage);
  if (!hasVerdict) return true;
  return data.passed !== true;
}

/**
 * Kill fixture `mutation-gate-failing-verdict`.
 *
 * Seeded pair over the real gate's verdict rule:
 *   - violation: a scored carrier with `passed:false` (mutationScore 41 under a
 *     threshold of 60, noCoverage 9 over a budget of 3)  → the gate FAILS;
 *   - clean:     a scored carrier with `passed:true`                → silent.
 *
 * The real gate cannot be spawned here: it shells `git` to resolve a PR diff and
 * drives the mutation-adequacy handler through a `bun` bridge. So the port
 * decides, bound to the real script by asserting its failing-verdict branch and
 * its `--observe` collapse are both still present.
 *
 * SCOPE, stated plainly: this attests that the gate's DETECTION logic still
 * discriminates. It does NOT attest that the gate can fire in the configuration
 * CI actually runs — `--observe` collapses exactly this verdict to exit 0. That
 * is the registered softening, and clearing it is the row's promotion threshold.
 */
export function probeMutationGateVerdict(
  advisory: AdvisoryEntry,
  opts: LocalKillProbeOptions,
): KillProbeResult {
  const script = join(opts.repoRoot, 'tools', 'audit', 'gates', 'check-mutation-gate.mjs');
  if (!existsSync(script)) return missingControl(advisory, script);
  const src = readFileSync(script, 'utf8');
  const structurallyIntact =
    src.includes('mutation-adequacy FAILED') &&
    src.includes('data.passed !== true') &&
    src.includes('OBSERVE — would FAIL blocking mode');

  const violation: MutationCarrier = {
    success: true,
    data: { passed: false, mutationScore: 41, threshold: 60, noCoverage: 9, maxNoCoverage: 3 },
  };
  const clean: MutationCarrier = {
    success: true,
    data: { passed: true, mutationScore: 82, threshold: 60, noCoverage: 0, maxNoCoverage: 3 },
  };

  return {
    advisoryId: advisory.id,
    killFixture: advisory.killFixture,
    firedOnViolation: structurallyIntact && mutationVerdictFires(violation),
    firedOnClean: mutationVerdictFires(clean),
    detail:
      `in-process port of computeVerdict; real gate's failing-verdict + observe-collapse ` +
      `branches ${structurallyIntact ? 'present' : 'MISSING'}`,
  };
}

/** The per-suite summary shape `run-evals-cli.ts` reduces over. */
interface EvalSummaryLite {
  readonly failed: number;
}

/**
 * A faithful port of `run-evals-cli.ts`'s exit rule:
 * `(layer === 'capability' || totalFailures === 0) ? 0 : 1`.
 */
export function evalRunnerExitCode(
  summaries: readonly EvalSummaryLite[],
  layer: string | undefined,
): number {
  const totalFailures = summaries.reduce((sum, s) => sum + s.failed, 0);
  return layer === 'capability' || totalFailures === 0 ? 0 : 1;
}

/**
 * Kill fixture `eval-capability-failing-summary`.
 *
 * Seeded pair over the real eval runner's failure accounting:
 *   - violation: a suite summary carrying `failed: 2` → the runner accounts a
 *     failure (and, on the BLOCKING `regression` layer, exits 1);
 *   - clean:     `failed: 0`                          → silent, exits 0.
 *
 * Also asserts the softening it is registered for: the SAME failing summary
 * exits 0 on the `capability` layer. If that in-code softening were removed the
 * advisory would be blocking and its registry row would fail as a stale claim —
 * which is the ratchet working.
 *
 * SCOPE: this attests the runner's failure accounting + exit rule. It does not
 * execute promptfoo or the graders (they need `bun`, the opt-in eval package and
 * an ANTHROPIC_API_KEY), so grader accuracy is out of the fixture's reach.
 */
export function probeEvalCapabilityLayer(
  advisory: AdvisoryEntry,
  opts: LocalKillProbeOptions,
): KillProbeResult {
  const cli = join(opts.repoRoot, 'tools', 'evals', 'evals', 'run-evals-cli.ts');
  if (!existsSync(cli)) return missingControl(advisory, cli);
  const src = readFileSync(cli, 'utf8');
  const structurallyIntact =
    src.includes('isAdvisoryLayer') &&
    src.includes("options.layer === 'capability'") &&
    src.includes('totalFailures');

  const violation: EvalSummaryLite[] = [{ failed: 2 }];
  const clean: EvalSummaryLite[] = [{ failed: 0 }];

  const detects = (s: readonly EvalSummaryLite[]): boolean =>
    s.reduce((sum, x) => sum + x.failed, 0) > 0;
  const softenedOnCapability =
    evalRunnerExitCode(violation, 'capability') === 0 &&
    evalRunnerExitCode(violation, 'regression') === 1;

  return {
    advisoryId: advisory.id,
    killFixture: advisory.killFixture,
    firedOnViolation: structurallyIntact && detects(violation) && softenedOnCapability,
    firedOnClean: detects(clean),
    detail:
      `in-process port of run-evals-cli's exit rule; real runner's capability-layer ` +
      `softening ${structurallyIntact ? 'present' : 'MISSING'}`,
  };
}

/**
 * Kill probes owned by this module (the DR-15 rows). Callers compose these with
 * `runKillProbe` from `advisory-kill-probes.ts`, which owns the two original
 * rows — see the DESIGN TENSION note above.
 */
export const REGISTRY_LOCAL_KILL_PROBES: Readonly<Record<string, AdvisoryProbeRunner>> = {
  'check-mutation-gate': probeMutationGateVerdict,
  'eval-capability-layer': probeEvalCapabilityLayer,
};

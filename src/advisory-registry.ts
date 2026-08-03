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
 *   - an UNFILTERED CI PATH (`ciPath`) — a `.github/workflows/*.yml` reference
 *     naming the workflow where its output reaches CI unfiltered (never a
 *     path-filtered / skipped-as-passed lane);
 *   - an approval ISSUE (`#<number>`).
 *
 * The advisory control declares only its EXISTENCE + COVERAGE in-source with an
 * `ADVISORY(control: <id>)` marker comment; all governance metadata lives ONLY
 * in the registry so the two cannot drift (the marker and the registry are
 * cross-checked by {@link verifyAdvisoryRatchet}).
 *
 * ## The ratchet
 *
 * {@link verifyAdvisoryRatchet} cross-checks the registry against the markers
 * discovered on disk AND the kill-fixture probe results:
 *   - a discovered marker with no matching registry entry FAILS (an advisory was
 *     added without complete governance — the count grew);
 *   - a registry entry with any missing/invalid governance field FAILS;
 *   - a registry entry whose `expires` is in the past FAILS (retire it);
 *   - a registry entry with no marker on disk FAILS (stale/dangling entry);
 *   - a registry entry whose kill fixture NO LONGER FIRES — the probe did not
 *     detect the seeded violation, or wrongly fired on the clean control — FAILS
 *     (the advisory has degraded into theatre).
 *
 * This module is PURE over its inputs — {@link verifyAdvisoryRatchet} takes the
 * registry, the discovered set, the probe results, and `now` explicitly — so the
 * ratchet rules are unit-testable without a filesystem or a subprocess.
 * {@link discoverAdvisories} is the thin, injectable I/O adapter, and the real
 * kill-fixture probes live in `advisory-kill-probes.ts`.
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
  /** Unfiltered CI path: a `.github/workflows/*.yml` reference. */
  readonly ciPath: string;
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
 * ### Inventory notes (P07-07)
 *
 * The repo's advisory controls are enumerated by the enforcer-wiring manifest
 * (`scripts/enforcer-wiring-manifest.json`, disposition `advisory`). Two of them
 * carry a genuine, firing kill fixture and are governed here:
 *
 *   - `lint-inv6`             — grep lint for INV-6 workflow-agnosticism leaks.
 *     Its kill fixture spawns the REAL `scripts/lint-inv6.mjs` against a seeded
 *     SKILL.md that leaks a workflow literal without a `workflow-type`
 *     declaration; the flagged skill produces ≥1 finding, the clean control
 *     produces none. Fully portable (Node only).
 *
 *   - `benchmark-regression`  — perf non-regression check. Its kill fixture is a
 *     seeded (results, baselines) pair where a metric exceeds baseline beyond
 *     the threshold, which the control reports as a FAIL; a within-threshold
 *     control does not fire.
 *
 * The THIRD advisory — `scripts/check-mutation-gate.mjs` — is deliberately NOT
 * registered here, and that omission is a REPORTED FINDING: in its live CI
 * configuration it runs with `--observe`, which collapses every failing verdict
 * (including a seeded NoCoverage failure) to exit 0 (see the gate's own
 * self-test, direction 9, `NoCoverageFailure_ObserveNeverBlocks`), and against
 * the real server suite the StrykerJS dry-run degrades (#1720). So although its
 * detection logic can score a failing verdict from a fixture in BLOCKING mode,
 * its kill fixture cannot fire in the configuration CI actually runs — it is,
 * today, advisory theatre. It stays governed for disposition/rationale by the
 * enforcer-wiring manifest, with #1720 as its exit condition; it is admitted
 * here only once its kill fixture fires in the live (observe) path.
 */
export const ADVISORY_REGISTRY: readonly AdvisoryEntry[] = [
  {
    id: 'lint-inv6',
    file: 'scripts/lint-inv6.mjs',
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
  },
  {
    id: 'benchmark-regression',
    file: 'scripts/check-benchmark-regression.sh',
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
  },
];

/**
 * Source roots scanned by {@link discoverAdvisories} in the real-repo ratchet
 * check. Advisory controls live in `scripts/` by convention; the scan is bounded
 * so it stays fast and so "where advisories may live" is an explicit list. An
 * advisory marker smuggled outside these roots is out of the ratchet's scope by
 * design (add the root here to bring it in).
 */
export const ADVISORY_SCAN_ROOTS: readonly string[] = ['scripts'];

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
    const current = stack.pop()!;
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
 * `YYYY-MM-DD` expiry that is a real calendar date and not in the past; and a
 * `ciPath` that names a `.github/workflows/*.yml` workflow (the unfiltered CI
 * path where the advisory's output must reach CI).
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
        `ciPath must name an unfiltered CI workflow (.github/workflows/*.yml) — ` +
        `got ${JSON.stringify(entry.ciPath)}`,
    });
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

/** Inputs to {@link verifyAdvisoryRatchet}. */
export interface AdvisoryRatchetInputs {
  readonly registry: readonly AdvisoryEntry[];
  readonly discovered: readonly DiscoveredAdvisory[];
  readonly probeResults: readonly KillProbeResult[];
  readonly now: Date;
}

/**
 * The ratchet. Compares the governed registry against the advisory markers
 * discovered on disk, validates each entry's governance, and verifies each
 * entry's kill fixture still fires. Never short-circuits — a caller sees every
 * violation in one pass.
 *
 * Violation classes:
 *   - `duplicate-id`         — two registry entries share an id.
 *   - `malformed`/`expired`  — a registry entry's governance is invalid / past.
 *   - `unregistered`         — a discovered advisory marker has no entry (the
 *                              count grew without complete governance).
 *   - `control-mismatch`     — the marker's control disagrees with the entry.
 *   - `missing-on-disk`      — a registry entry has no marker on disk (stale).
 *   - `kill-fixture-missing` — a registry entry has no probe result at all.
 *   - `kill-fixture-dead`    — the probe did not fire on the seeded violation,
 *                              or wrongly fired on the clean control (the
 *                              advisory has decayed into theatre).
 */
export function verifyAdvisoryRatchet(inputs: AdvisoryRatchetInputs): AdvisoryRatchetResult {
  const { registry, discovered, probeResults, now } = inputs;
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

  const regByPair = new Map<string, AdvisoryEntry>();
  for (const e of registry) regByPair.set(pairKey(e.file, e.control), e);

  // 2. Every discovered (file, control) marker must be registered, with a
  //    matching control. An unregistered marker is the "count grew" failure.
  const discoveredKeys = new Set<string>();
  for (const d of discovered) {
    const key = pairKey(d.file, d.control);
    discoveredKeys.add(key);
    const entry = regByPair.get(key);
    if (!entry) {
      // Is the FILE registered under a different control? Then it's a mismatch;
      // otherwise the whole advisory is unregistered.
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
            `advisory ${d.file} (control ${d.control}) is not registered — add an ` +
            `ADVISORY_REGISTRY entry with an owner, promotion + removal thresholds, ` +
            `an issue, a future expiry, a kill fixture, and an unfiltered CI path, ` +
            `or remove the ADVISORY marker`,
        });
      }
    }
  }

  // 3. Every registry entry must be backed by a marker on disk.
  for (const e of registry) {
    if (!discoveredKeys.has(pairKey(e.file, e.control))) {
      violations.push({
        kind: 'missing-on-disk',
        id: e.id,
        file: e.file,
        control: e.control,
        detail:
          `registered advisory '${e.id}' (${e.file}, control ${e.control}) has no ` +
          `ADVISORY marker on disk — remove the stale registry entry or restore the marker`,
      });
    }
  }

  // 4. Every registry entry's kill fixture must still fire (and be discriminating).
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

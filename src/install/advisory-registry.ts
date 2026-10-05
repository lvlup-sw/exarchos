/**
 * The governed inventory and ratchet for advisory controls. An advisory control warns and does not block:
 * CI runs it, but `|| true`, `continue-on-error: true`, or an `--observe` flag softens its exit code.
 * An advisory with no owner, no expiry, or a kill fixture that cannot fire is only theatre.
 *
 * Each entry of {@link ADVISORY_REGISTRY} carries an owner, promotion and removal thresholds, and an expiry.
 * It also carries a kill fixture, its softening sites, a verified CI-path claim, and an approval issue.
 * {@link discoverSofteningSites} finds each softening in the real tree, so an advisory does not need to
 * declare itself. {@link verifyAdvisoryRatchet} checks the registry against those sites, the advisory
 * markers, the CI-path analyses, and the kill-fixture results.
 *
 * The ratchet is pure over its inputs, so its tests need no filesystem or subprocess.
 * {@link discoverAdvisories} and {@link discoverSofteningSites} are the injectable I/O adapters.
 * `analyzeCiPathFilters` in `tools/audit/gates/check-enforcer-wiring.mjs` supplies the CI-path analyses.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The three ways this repo softens an exit code so a failure cannot block: `continue-on-error` (the key of
 * a workflow step), `observe` (an `--observe` flag on an enforcement primary), and `or-true` (a `|| true`
 * or `|| :` after an enforcement primary).
 */
export type SofteningKind = 'continue-on-error' | 'observe' | 'or-true';

/** Every softening kind, for exhaustive validation. */
export const SOFTENING_KINDS: readonly SofteningKind[] = [
  'continue-on-error',
  'observe',
  'or-true',
];

/**
 * The claim of a registry entry on one softening site: the `<kind>` softening in `<file>` that swallows
 * `<target>`. The ratchet matches claims and discovered sites on the exact (file, kind, target) triple in
 * both directions. Thus neither an unclaimed site nor a stale claim survives.
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
 * The structural result of `analyzeCiPathFilters` in `tools/audit/gates/check-enforcer-wiring.mjs`. It is
 * a structural type and not an import, because that script is outside the `tsc` rootDir of `src/`. The
 * caller composes the two, as it does with the kill probes.
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
  /** Stable human id, such as `lint-inv6`. Unique across the registry. */
  readonly id: string;
  /** POSIX repo-relative path to the advisory control source file. */
  readonly file: string;
  /** The control id the advisory implements (matches the marker's `control`). */
  readonly control: string;
  /** Owning team / person — must be non-empty. */
  readonly owner: string;
  /** The measured evidence that justifies making the control blocking. */
  readonly promotionThreshold: string;
  /** The measured evidence that justifies deleting the control. */
  readonly removalThreshold: string;
  /** Approval issue ref: `#<number>`. */
  readonly issue: string;
  /** Expiry date `YYYY-MM-DD`. A past expiry fails the ratchet. */
  readonly expires: string;
  /** The kill-fixture probe id proving the advisory detects a seeded violation. */
  readonly killFixture: string;
  /** The `.github/workflows/*.yml` workflow hosting this advisory in CI. */
  readonly ciPath: string;
  /**
   * A plain substring that finds the hosting step in `ciPath`, matched against its `name`, `run`, or
   * `uses`. Without it, the ratchet cannot check the CI-path claim past the workflow trigger.
   */
  readonly ciStepMatch: string;
  /**
   * The claim that the hosting CI lane is path-filtered. The ratchet checks it against the parsed trigger
   * and the job and step `if:` gates, and a wrong value fails in either direction.
   */
  readonly ciPathFiltered: boolean;
  /**
   * Why the filtered lane is acceptable, and what moves the advisory to an unfiltered host. It must be
   * non-empty when `ciPathFiltered` is true and empty when it is false.
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
 * The result of the kill-fixture probe of an advisory. A healthy probe fires on the seeded violation and
 * stays silent on the clean control. Any other result means that the advisory no longer detects its target.
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

/**
 * The one authored list of governed advisory controls. A softening site or an advisory marker with no
 * complete entry here fails {@link verifyAdvisoryRatchet}.
 *
 * The inventory matches the sites that {@link discoverSofteningSites} finds, not the enforcer-wiring
 * manifest. That manifest covers only `check-*` and `lint-*` primaries, so it cannot name
 * `eval-capability-layer`, whose control is `run-evals-cli.ts`. That entry is softened twice: by `continue-on-error: true` in
 * `eval-gate.yml`, and by an exit-0 rule for the `capability` layer in `run-evals-cli.ts`. Three of the
 * four entries run on filtered CI lanes, and each `ciPathFiltered` claim records that.
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
      'which is gated by lane `root` via ci-lanes (`fromJSON(needs.plan.outputs.lanes).root`) ' +
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
      'Hosted by ci.yml\'s `test-mcp` job, gated by lane `mcp` via ci-lanes ' +
      '(`fromJSON(needs.plan.outputs.lanes).mcp`) AND by a step-level ' +
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
    ciStepMatch: 'tools/evals/evals/run-evals-cli.ts',
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
        target: 'tools/evals/evals/run-evals-cli.ts',
      },
    ],
  },
];

/**
 * Source roots that {@link discoverAdvisories} scans in the real-repo ratchet check. Advisory controls live
 * under `tools/`. The list is short, so the scan stays fast and the allowed places are explicit. A marker
 * outside these roots is out of scope until its root joins the list.
 */
export const ADVISORY_SCAN_ROOTS: readonly string[] = ['tools'];

/** File extensions scanned for advisory markers (advisories are scripts). */
export const ADVISORY_SCAN_EXTENSIONS: readonly string[] = ['.mjs', '.sh', '.js', '.cjs'];

/**
 * The path that {@link discoverAdvisories} skips as this module. It does not match the real path of this
 * module, `src/install/advisory-registry.ts`. The default scan roots do not include `src/`, so the default
 * scan never reads this module.
 */
const SELF_PATH = 'src/advisory-registry.ts';

/**
 * Matches an advisory marker: the token `ADVISORY`, then `(<fields>)`, in a comment of any style. The
 * fields are `key: value` pairs separated by commas, and a note after the parenthesis is not parsed. A
 * spliced string builds the regex, so its source does not hold the literal marker token.
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

/**
 * Recursively collects files with a scanned extension under `absRoot`. The `undefined` check after `pop()`
 * cannot fire, but it satisfies `noUncheckedIndexedAccess` with no assertion.
 */
function listFilesReal(absRoot: string, extensions: readonly string[]): string[] {
  const results: string[] = [];
  if (!existsSync(absRoot)) return results;
  const stack: string[] = [absRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
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
 * Walks the configured roots and returns each advisory marker as a {@link DiscoveredAdvisory} with a POSIX
 * repo-relative path. It skips the file at {@link SELF_PATH}.
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

/** Repo-relative roots scanned for `|| true` / `--observe` softening. */
export const SOFTENING_SCRIPT_ROOTS: readonly string[] = ['tools'];

/** Where workflow files live. */
export const SOFTENING_WORKFLOW_ROOT = '.github/workflows';

/** Extensions scanned under {@link SOFTENING_SCRIPT_ROOTS}. */
export const SOFTENING_SCRIPT_EXTENSIONS: readonly string[] = ['.mjs', '.sh', '.js', '.cjs'];

/**
 * The directory of enforcement primaries, the one spelling that this scan recognizes. A synthetic fixture
 * imports it, so the fixture seeds a path that the scan matches. A fixture with a hard-coded prefix can
 * drift from this value. It then finds zero sites, and that empty result looks the same as a clean result.
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

/** Direct references to `tools/audit/gates/(check|lint)-*.{mjs,sh}`, with self-tests excluded. */
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
 * Each structural `continue-on-error:` line with a value other than `false` gives a site, attributed to
 * its step. A job-level one, outside any step, still gives a site with a coarse `job-level:<line>` target.
 * `--observe` and `|| true` count only inside `run:` bodies, so a YAML comment that names them is no site.
 */
export function discoverWorkflowSoftening(
  text: string,
  file: string,
  scripts: Readonly<Record<string, string>>,
): SofteningSite[] {
  const lines = text.split('\n');
  const items = groupListItems(lines);
  const sites: SofteningSite[] = [];

  for (const item of items) {
    const run = extractRun(item.lines);
    if (!run) continue;
    sites.push(
      ...scanCommandSoftening(run.command, file, item.start + run.offset + 1, scripts),
    );
  }

  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(/^\s*(?:-\s+)?continue-on-error:\s*(.+?)\s*$/);
    if (!m) continue;
    const value = m[1] ?? '';
    if (/^false$/i.test(value)) continue;
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
 * Walks the real tree and returns each softening site, sorted by file, line, and kind:
 *
 *   1. `.github/workflows/**`: `continue-on-error:`, and `--observe` or `|| true` in step `run:` bodies.
 *   2. `package.json` scripts: `--observe` or `|| true`. A site gets the line of its script in the raw file.
 *   3. The script roots, `tools/` by default: `--observe` or `|| true`.
 *
 * It reads the npm script map to follow `npm run <name>` chains to primaries. It skips `*.test.*` files in
 * discovery itself, not only in the fs adapter, because a harness that softens its subject is a test.
 */
export function discoverSofteningSites(opts: DiscoverSofteningOptions): SofteningSite[] {
  const fs = opts.fs ?? realSofteningFs();
  const workflowRoot = opts.workflowRoot ?? SOFTENING_WORKFLOW_ROOT;
  const scriptRoots = opts.scriptRoots ?? SOFTENING_SCRIPT_ROOTS;
  const pkgPath = opts.packageJsonPath ?? 'package.json';

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

  const absWorkflows = join(opts.repoRoot, workflowRoot);
  for (const abs of fs.listFiles(absWorkflows, ['.yml', '.yaml'])) {
    const rel = toPosix(relative(opts.repoRoot, abs));
    sites.push(...discoverWorkflowSoftening(fs.readFile(abs), rel, scripts));
  }

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
 * Returns the governance problems of a registry entry at `now`, or an empty list. It requires a non-empty
 * owner, thresholds, kill fixture, and `ciStepMatch`, an issue ref `#<number>`, and a real `YYYY-MM-DD`
 * expiry that is not past. It also requires a `.github/workflows/*.yml` `ciPath`, a `ciFilterRationale`
 * exactly when `ciPathFiltered` is true, and at least one well-formed softening ref. The type makes the
 * fields required, and this pass rejects blank values.
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
 * The ratchet. It never stops at the first problem, so a caller sees each violation in one pass:
 *
 *   - `duplicate-id`, `malformed`, `expired`: two entries share an id, or an entry has an invalid field or
 *     a past expiry.
 *   - `unregistered`: a softening site or a marker on disk has no entry.
 *   - `control-mismatch`: a marker names a control that differs from the entry for its file.
 *   - `missing-on-disk`: an entry claims a softening site that is not on disk.
 *   - `ci-path-mismatch`, `ci-path-unverified`: the `ciPathFiltered` claim disagrees with the parsed
 *     trigger and gates, or it has no analysis.
 *   - `kill-fixture-missing`, `kill-fixture-dead`: the probe result is absent, missed the violation, or
 *     fired on the clean control.
 */
export function verifyAdvisoryRatchet(inputs: AdvisoryRatchetInputs): AdvisoryRatchetResult {
  const { registry, discovered, probeResults, softeningSites, ciPathAnalyses, now } = inputs;
  const violations: AdvisoryViolation[] = [];

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
 * A port of the failure decision of `computeVerdict` in `tools/audit/gates/check-mutation-gate.mjs`. A
 * carrier fails when the handler errored, or when it is a degrade, skip, or warning carrier. It also fails
 * when a scored axis is not finite, or when `passed !== true`.
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
 * Kill fixture `mutation-gate-failing-verdict`. The violation is a scored carrier with `passed: false`, and
 * the clean control has `passed: true`.
 *
 * The real gate cannot run here, because it calls `git` for the PR diff and a `bun` bridge for the handler.
 * So the port decides, and the probe checks that the failing-verdict branch and the `--observe` collapse
 * are still in the real script. The probe proves that detection still discriminates. It does not prove
 * that the gate can fail in CI, where `--observe` turns this verdict into exit 0.
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
 * Kill fixture `eval-capability-failing-summary`. The violation is a suite summary with `failed: 2`, and
 * the clean control has `failed: 0`. The probe also checks the in-code softening: the failing summary exits
 * 0 on the `capability` layer and 1 on the `regression` layer. Without that softening, the probe does not
 * fire, and the ratchet reports `kill-fixture-dead`.
 *
 * It does not run promptfoo or the graders, which need `bun`, the eval package, and an `ANTHROPIC_API_KEY`.
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
 * The kill probes of this module, for `check-mutation-gate` and `eval-capability-layer`. Callers compose
 * them with `runKillProbe` from `advisory-kill-probes.ts`, which owns the other two probes. Each probe runs
 * an in-process port of the decision rule of its control on a seeded violation and clean pair. It also
 * checks that the real control still holds the ported branch, so a gutted control still fails.
 */
export const REGISTRY_LOCAL_KILL_PROBES: Readonly<Record<string, AdvisoryProbeRunner>> = {
  'check-mutation-gate': probeMutationGateVerdict,
  'eval-capability-layer': probeEvalCapabilityLayer,
};

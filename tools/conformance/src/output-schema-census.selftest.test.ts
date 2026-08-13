// DR-4 / G2 (task 018): the SELF-TEST proper — guard-execution failure must not
// pass as success.
//
// ── What is already proven, and is deliberately NOT re-proved here ──────────
// Task 018's original headline was "a new vacuous action fails CI". That is
// discharged, at a STRONGER rung than the one it asked for, and re-asserting it
// would be duplication:
//
//   • TASK 055 made vacuity UNCONSTRUCTIBLE. `BuiltinToolAction.outputSchema`
//     takes `DeclaredOutputSchema`, and the only escape, `vacuityWaiver(id)`,
//     types `id` as `VacuityWaiverId` — the literal union of the SEEDED ids. A
//     new action cannot acquire a waiver at all, so a new vacuous declaration is
//     a COMPILE ERROR, not a CI finding. Pinned by
//     `OutputSchema_NewActionDeclaringVacuous_FailsCompile` plus the
//     `_OutputSchema*` `Expect<>` aliases that `npm run typecheck` checks.
//   • TASK 060 closed the two residuals: the out-of-registry escape mints a
//     different brand (`OutputSchema_RegistryActionUsingExtensionEscape_
//     FailsCompile`), and an in-place allowlist swap fails the frozen seed
//     digest (`OutputSchema_AllowlistIdSwappedInPlace_FailsTheShrinkOnlyCheck`).
//   • TASK 017 made the expiry enforced rather than advisory and carried the
//     kill fixtures against the real data file, including the emptied allowlist
//     and the emptied census — all through `runGuard`'s injected seams.
//   • TASK 069 paid the first entry off the allowlist, proving the ratchet's
//     legal direction is reachable.
//   • TASKS 063/070 prove, from `scripts/guard-inventory.ts`, that the guard is
//     REACHABLE from an unfiltered CI job and that its exit is not swallowed.
//
// ── What none of that reaches — this file's whole subject ───────────────────
// Every assertion above calls `runGuard()` (or an `auditVacuity*` function)
// DIRECTLY and reads its RETURN VALUE. Nothing has ever executed DR-4's guard as
// a PROCESS. The two lines that turn a verdict into a merge block —
//
//     const isDirectRun = … ;
//     if (isDirectRun) process.exit(runGuard());
//
// — were, until this file, covered by nothing at all. That is not a theoretical
// gap. Measured on the landing branch, the predicate was
// `process.argv[1].endsWith('output-schema-ratchet-guard.ts')`, which couples
// self-execution to the FILE'S NAME: a byte-identical copy under any other name
// printed 0 bytes and exited 0. Rename the guard, update the `run:` step in
// ci.yml to match — the ordinary meaning of "rename a file" — and CI keeps a
// step that exists, runs, resolves and enforces NOTHING. `guard-inventory`
// cannot see it (the step is still there, still direct, still unfiltered); the
// 017 suite cannot see it (it never spawns anything). The fix and this file
// landed together; the legacy predicate is reproduced below as a mutation, so
// the probe is shown capable of reporting the failure it claims to detect.
//
// So the property under test is EXECUTION, not detection:
//   1. the shipped entrypoint really runs and really states its denominator;
//   2. it runs under any name — self-execution is not filename-coupled;
//   3. a finding really makes the PROCESS exit non-zero (`process.exit` is
//      wired to `runGuard`'s return value, not to a constant);
//   4. an emptied census reddens the PROCESS, not just the library;
//   5. importing the module does NOT run the guard — without which (1) and (2)
//      would be satisfied by an unconditional `process.exit(runGuard())` and
//      would prove nothing about the predicate.
//
// ── TWO AUTHORITIES ────────────────────────────────────────────────────────
// Authority A is the generated data file `../output-schema-vacuity-allowlist.ts`
// plus the census over the live registry, read IN THIS PROCESS. Authority B is
// the stdout/stderr/exit status of a SEPARATE OS PROCESS running the shipped
// guard. Neither can observe the other — the child has no channel back into the
// test — so their agreement on the denominator is evidence rather than a
// tautology.
//
// ── NO WALL-CLOCK VERDICT ──────────────────────────────────────────────────
// The live guard's exit status is a function of the date by design (DR-4's
// expiry is enforced), so this file never asserts that the live run is GREEN.
// It asserts that the run produced a VERDICT — a report on stdout with exit 0,
// or findings on stderr with exit 1 — which is true on both sides of
// VACUITY_EXPIRY_HORIZON. Pinning the green arm would turn "the debt came due"
// into "the self-test broke", which is the lesson 017 was careful not to teach.
// The mutation probes below are structural and therefore date-independent.
//
// @oracle-sources: ../../../src/output-schema-vacuity-allowlist.ts, the exit status and stdout/stderr of a separate OS process running the shipped guard entrypoint under tsx
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { censusLiveOutputSchemas } from './bindings/output-schema.js';
import { REPO_ROOT, SUBJECT_PACKAGE_ROOT } from './subject-root.js';
import { VACUITY_ALLOWLIST_IDS } from '../../../src/output-schema-vacuity-allowlist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `servers/exarchos-mcp` — the subject package, which is no longer this one. */
const MCP_ROOT = SUBJECT_PACKAGE_ROOT;
/** The artifact ci.yml invokes. Its reachability is guard-inventory's claim; its EXECUTION is this file's. */
// Task 019 moved the dissolved package's scripts under `scripts/core/`.
const GUARD_PATH = join(MCP_ROOT, 'scripts', 'core', 'output-schema-ratchet-guard.ts');

/**
 * The expression the shipped entrypoint uses to decide it is the process
 * entrypoint, and the legacy one it replaced.
 *
 * The legacy form is kept as DATA, not as prose: {@link MUTATIONS} substitutes
 * it back into a copy to produce the failure this file exists to detect. A guard
 * probe with no demonstrated failing subject has not been shown to work, and
 * "renaming used to break it" is a claim about git history, not a test.
 */
const SHIPPED_PREDICATE =
  'canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))';
const LEGACY_FILENAME_PREDICATE = "process.argv[1].endsWith('output-schema-ratchet-guard.ts')";

/** Relative module specifiers in the guard's source, e.g. `../src/output-schema-seed-pin.js`. */
const RELATIVE_SPECIFIER = /from '(\.\.\/[^']+\.js)'/g;

// ─── tsx, resolved rather than assumed ──────────────────────────────────────
//
// FAIL, never skip. A self-test that quietly skips because its runner could not
// be found reports "0 failures" for exactly the reason this file exists to
// reject. The MCP package is preferred so the Windows MCP lane (which installs
// both trees) uses its own copy; the root install is the fallback for the
// unfiltered grep-gates host.

function resolveTsxCli(): string {
  const candidates = [
    join(MCP_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(
    `tsx CLI not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
      'This self-test drives DR-4\'s guard as a real process; without a runner it ' +
      'must FAIL rather than skip, because a skipped guard self-test is the ' +
      'failure mode it exists to detect.',
  );
}

interface ProcessRun {
  /** `null` only when the child never started — asserted against, never ignored. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function textOf(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function runEntrypoint(entry: string): ProcessRun {
  const result = spawnSync(process.execPath, [resolveTsxCli(), entry], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  if (result.error !== undefined) {
    throw new Error(`spawning ${entry} failed: ${result.error.message}`);
  }
  return { code: result.status, stdout: textOf(result.stdout), stderr: textOf(result.stderr) };
}

/** Blank out ISO days so two runs straddling UTC midnight still compare equal. */
function withoutDays(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}/g, '<day>');
}

/**
 * The CODE lines of a source file — comment lines dropped.
 *
 * Required, not decorative. The guard's own header now DOCUMENTS the legacy
 * predicate (that is where the finding is recorded), so a raw
 * `not.toContain(LEGACY_FILENAME_PREDICATE)` over the whole text reports the
 * explanation as the defect. This assertion did exactly that on its first run —
 * the measure-a-text-proxy failure this wave keeps meeting, met again inside the
 * self-test written to police it. Same idiom the 017 suite already applies to
 * `output-schema-seed-pin.ts`.
 */
function codeOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

// ─── Copying the guard out of its own directory ─────────────────────────────
//
// Every probe below runs a COPY of the shipped source under a different name, in
// a per-run temp directory. The copy's relative imports are rewritten to
// absolute `file://` URLs pointing at the REAL modules, so what is exercised is
// the shipped guard against the shipped census, allowlist and pin — only the
// FILENAME changes. The specifier list is PARSED from the source rather than
// written down: if the guard's imports move, the parse changes with them, and
// {@link rewrittenGuardSource} fails loudly on an empty parse instead of
// silently producing a copy that cannot resolve.

interface SpecifierRewrite {
  /** The specifier as written in the guard, e.g. `../src/output-schema-seed-pin.js`. */
  readonly specifier: string;
  /** Absolute `file://` URL of the real `.ts` module it names. */
  readonly realUrl: string;
}

function guardSpecifiers(source: string): readonly SpecifierRewrite[] {
  const out: SpecifierRewrite[] = [];
  RELATIVE_SPECIFIER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RELATIVE_SPECIFIER.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    const real = resolve(dirname(GUARD_PATH), specifier.replace(/\.js$/, '.ts'));
    out.push({ specifier, realUrl: pathToFileURL(real).href });
  }
  return out;
}

/**
 * Rewrite the guard's relative imports to absolute URLs, applying `overrides`
 * (specifier → replacement URL) where given. Throws on a specifier set that
 * resolved to nothing — the non-empty-denominator tooth for the copy mechanism
 * itself.
 */
function rewrittenGuardSource(
  source: string,
  overrides: ReadonlyMap<string, string> = new Map(),
): string {
  const specifiers = guardSpecifiers(source);
  if (specifiers.length === 0) {
    throw new Error(
      `no relative import specifiers parsed out of ${GUARD_PATH}. The copy would not ` +
        'resolve, and a probe over an unresolvable copy proves nothing.',
    );
  }
  let out = source;
  for (const entry of specifiers) {
    const replacement = overrides.get(entry.specifier) ?? entry.realUrl;
    out = out.split(`'${entry.specifier}'`).join(`'${replacement}'`);
  }
  for (const entry of specifiers) {
    if (out.includes(`'${entry.specifier}'`)) {
      throw new Error(`specifier ${entry.specifier} survived the rewrite`);
    }
  }
  return out;
}

/** Locate exactly one parsed specifier whose path contains `moduleName`. */
function specifierFor(source: string, moduleName: string): string {
  const matches = guardSpecifiers(source).filter((s) => s.specifier.includes(moduleName));
  const only = matches[0];
  if (matches.length !== 1 || only === undefined) {
    throw new Error(
      `expected exactly one guard import naming '${moduleName}', found ${matches.length}. ` +
        'The guard\'s imports moved; this probe must be re-aimed rather than left ' +
        'silently pointing at nothing.',
    );
  }
  return only.specifier;
}

// ─── The mutation table (POLICY IS DATA) ────────────────────────────────────
//
// Each entry names a way DR-4's mechanism can be broken, the edit that breaks it
// — applied to a COPY, never to the shipped tree — and the verdict the shipped
// entrypoint must then produce. Two must be RED and one must be SILENTLY GREEN;
// that last one is the kill fixture for the probe itself.

type Verdict = 'red' | 'silent-green';

interface Mutation {
  readonly id: string;
  readonly why: string;
  readonly verdict: Verdict;
  /** Extra modules the copy needs, written beside it. Keyed by filename. */
  readonly sidecars: (source: string) => ReadonlyMap<string, string>;
  /** Specifier overrides applied to the copy. */
  readonly overrides: (source: string, dir: string) => ReadonlyMap<string, string>;
  /** Applied to the rewritten source, after the import overrides. */
  readonly rewriteBody: (rewritten: string) => string;
  /** A substring the child's stderr must contain, for a `red` verdict. */
  readonly expectFinding: string;
}

const MUTATIONS: readonly Mutation[] = Object.freeze([
  {
    id: 'seed-pin-drift',
    why:
      'the frozen key-set pin no longer matches the live allowlist — task 060\'s ' +
      'in-place-swap tooth. Isolated on purpose: the census and the deadlines are ' +
      'untouched, so the ONLY reason the process may be red is the pin.',
    verdict: 'red',
    sidecars: (source) => {
      const pinUrl = new Map(
        guardSpecifiers(source).map((s) => [s.specifier, s.realUrl]),
      ).get(specifierFor(source, 'output-schema-seed-pin'));
      if (pinUrl === undefined) throw new Error('seed-pin specifier did not resolve');
      return new Map([
        [
          'pin-with-a-drifted-digest.ts',
          [
            `export { VACUITY_EXPIRY_HORIZON, VACUITY_SEED_DIGEST_ALGORITHM } from '${pinUrl}';`,
            `export const VACUITY_SEED_KEY_SET_DIGEST = '${'0'.repeat(64)}';`,
            '',
          ].join('\n'),
        ],
      ]);
    },
    overrides: (source, dir) =>
      new Map([
        [
          specifierFor(source, 'output-schema-seed-pin'),
          pathToFileURL(join(dir, 'pin-with-a-drifted-digest.ts')).href,
        ],
      ]),
    rewriteBody: (rewritten) => rewritten,
    expectFinding: 'SEED_KEY_SET_DRIFT',
  },
  {
    id: 'empty-census',
    why:
      'the census enumerates ZERO declarations — a moved module, a broken import, ' +
      'an emptied registry. "No unwaived vacuity" becomes true for the worst ' +
      'possible reason, and the PROCESS must exit non-zero rather than report clean.',
    verdict: 'red',
    // The stub shadows the BINDING, not the census module. Task 018a inverted
    // the census's subjects into ports, so the guard no longer calls
    // `censusOutputSchemas` directly — it calls `censusLiveOutputSchemas`, which
    // supplies the live registry. A stub still aimed at the census module would
    // resolve, load, and shadow a function the guard never calls: the probe
    // would go VACUOUS rather than red, which is precisely the failure this
    // case exists to detect.
    sidecars: (source) => {
      const bindingUrl = new Map(
        guardSpecifiers(source).map((s) => [s.specifier, s.realUrl]),
      ).get(specifierFor(source, 'bindings/output-schema'));
      if (bindingUrl === undefined) throw new Error('binding specifier did not resolve');
      return new Map([
        [
          'census-over-an-empty-subject.ts',
          [
            `export * from '${bindingUrl}';`,
            'export function censusLiveOutputSchemas() {',
            "  return { ok: false, total: 0, vacuousCount: 0, substantiveCount: 0,",
            '    vacuous: [], substantive: [], records: [],',
            "    diagnostics: [{ code: 'EMPTY_CENSUS', message: 'seeded empty subject' }] };",
            '}',
            '',
          ].join('\n'),
        ],
      ]);
    },
    overrides: (source, dir) =>
      new Map([
        [
          specifierFor(source, 'bindings/output-schema'),
          pathToFileURL(join(dir, 'census-over-an-empty-subject.ts')).href,
        ],
      ]),
    rewriteBody: (rewritten) => rewritten,
    expectFinding: 'EMPTY_CENSUS',
  },
  {
    id: 'legacy-filename-coupled-predicate',
    why:
      'THE KILL FIXTURE for this file. Restore the entrypoint predicate the guard ' +
      'shipped with before task 018 — a match on the file\'s own NAME — and run the ' +
      'copy under a different name. The process prints nothing and exits 0: a CI ' +
      'step that still exists, still runs, and enforces nothing. If the probes ' +
      'below could not tell this apart from a real run, they would prove nothing.',
    verdict: 'silent-green',
    sidecars: () => new Map(),
    overrides: () => new Map(),
    rewriteBody: (rewritten) => {
      if (!rewritten.includes(SHIPPED_PREDICATE)) {
        throw new Error(
          `the shipped entrypoint predicate ${SHIPPED_PREDICATE} is not present in ` +
            `${GUARD_PATH}. This mutation cannot be applied, so it must FAIL rather ` +
            'than silently produce an unmutated copy that passes.',
        );
      }
      return rewritten.split(SHIPPED_PREDICATE).join(LEGACY_FILENAME_PREDICATE);
    },
    expectFinding: '',
  },
]);

// ─── Fixture wiring ─────────────────────────────────────────────────────────

let scratchDir = '';
let guardSource = '';
let liveRun: ProcessRun = { code: null, stdout: '', stderr: '' };

/** Write a copy of the guard under `name`, plus its sidecars, and run it. */
function runCopy(name: string, mutation: Mutation | undefined): ProcessRun {
  const dir = mkdtempSync(join(scratchDir, 'copy-'));
  const overrides =
    mutation === undefined ? new Map<string, string>() : mutation.overrides(guardSource, dir);
  const sidecars =
    mutation === undefined ? new Map<string, string>() : mutation.sidecars(guardSource);
  for (const [file, contents] of sidecars) writeFileSync(join(dir, file), contents, 'utf8');
  const rewritten = rewrittenGuardSource(guardSource, overrides);
  const body = mutation === undefined ? rewritten : mutation.rewriteBody(rewritten);
  const entry = join(dir, name);
  writeFileSync(entry, body, 'utf8');
  return runEntrypoint(entry);
}

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'imo-018-g2-selftest-'));
  guardSource = readFileSync(GUARD_PATH, 'utf8');
  liveRun = runEntrypoint(GUARD_PATH);
});

afterAll(() => {
  if (scratchDir.length > 0) rmSync(scratchDir, { recursive: true, force: true });
});

describe('DR-4 / G2 self-test: guard-execution failure cannot pass as success', () => {
  it('OutputSchemaRatchetGuard_ShippedEntrypoint_ProducesAVerdictOverANonEmptySubject', () => {
    // (1) THE SUBJECT EXISTS. A self-test whose artifact has moved must be red,
    // not absent — so the file, the runner and the populations it governs are
    // each asserted before anything is concluded from the run.
    expect(existsSync(GUARD_PATH), `${GUARD_PATH} is missing`).toBe(true);
    // `resolveTsxCli` THROWS rather than returning a sentinel, so binding it is
    // the assertion: there is no arm on which this file runs zero subprocesses
    // and still reports zero failures.
    expect(resolveTsxCli().endsWith('cli.mjs')).toBe(true);

    // NON-EMPTY DENOMINATOR, read in THIS process from the live artifacts —
    // derived on both sides, never written as a literal. Task 068 grew the
    // denominator and task 069 shrank the numerator during this very wave, each
    // reading as a guard failure where a count had been hard-coded.
    const liveTotal = censusLiveOutputSchemas().total;
    const liveWaived = VACUITY_ALLOWLIST_IDS.length;
    expect(liveWaived).toBeGreaterThan(0);
    expect(liveTotal).toBeGreaterThan(liveWaived);

    // (2) THE TAIL EXECUTED. Before task 018 nothing asserted this: every
    // existing assertion calls `runGuard()` in-process, so a guard whose
    // entrypoint never fires looked identical to one that passes.
    expect(liveRun.code).not.toBeNull();
    expect(liveRun.stdout.length + liveRun.stderr.length).toBeGreaterThan(0);

    // (3) THE VERDICT, without pinning the wall clock. DR-4's expiry is enforced,
    // so the live guard is designed to go red of its own accord after
    // VACUITY_EXPIRY_HORIZON. Asserting `code === 0` here would convert that
    // deadline into a broken test suite — the failure 017 explicitly designed
    // around. What must hold on BOTH sides of the horizon is that the process
    // stated a verdict and stated it in the right channel.
    const combined = `${liveRun.stdout}${liveRun.stderr}`;
    if (liveRun.code === 0) {
      expect(liveRun.stdout).toContain('outputSchema:ratchet — OK as of');
      expect(liveRun.stderr).toBe('');
    } else {
      expect(liveRun.code).toBe(1);
      expect(liveRun.stdout).toBe('');
      expect(liveRun.stderr).toContain('finding(s) as of');
    }

    // (4) THE TWO AUTHORITIES AGREE. The denominator the CHILD PROCESS printed
    // is the denominator this process measured. The child cannot see this
    // process's reads and vice versa, so this is a comparison and not a
    // restatement. Both report shapes state it — `N waived of T declaration(s)`
    // when green, `N waived, V vacuous of T declarations` when red — so the
    // assertion holds across the horizon too.
    expect(combined).toContain(`of ${liveTotal} declaration`);
    expect(combined).toContain(`${liveWaived} waived`);
  });

  it('OutputSchemaRatchetGuard_SameSourceUnderADifferentName_StillEnforces', () => {
    // THE RENAME TOOTH, and the reason this task was real.
    //
    // A rename is an ordinary, reviewable edit: move the file, update the `run:`
    // step in ci.yml. Under the legacy predicate that combination left a CI step
    // that existed, ran, resolved and enforced nothing — measured as 0 bytes of
    // output and exit 0. `guard-inventory` still saw a direct, unfiltered host;
    // the 017 suite still passed, because it never spawns anything. Nothing in
    // the repository could observe the difference.
    //
    // @kill-seam: the entrypoint predicate — the `legacy-filename-coupled-predicate`
    // mutation below restores the filename match and shows the same copy going
    // silently green, which is what makes this arm evidence rather than assertion.
    const renamed = runCopy('a-name-the-predicate-cannot-know.ts', undefined);

    expect(renamed.code).toBe(liveRun.code);
    expect(withoutDays(renamed.stdout)).toBe(withoutDays(liveRun.stdout));
    expect(withoutDays(renamed.stderr)).toBe(withoutDays(liveRun.stderr));
    expect(renamed.stdout.length + renamed.stderr.length).toBeGreaterThan(0);

    // …and the copy is the SHIPPED tail, not a rewritten one. Only import
    // specifiers were substituted; the lines that decide and act are verbatim.
    // Read from the CODE lines, so the header prose that RECORDS the legacy
    // predicate is not mistaken for a use of it.
    const rewritten = codeOf(rewrittenGuardSource(guardSource));
    expect(rewritten).toContain(SHIPPED_PREDICATE);
    expect(rewritten).toContain('process.exit(runGuard())');
    expect(rewritten).not.toContain(LEGACY_FILENAME_PREDICATE);
  });

  it('OutputSchemaRatchetGuard_BrokenMechanism_RedensTheProcessNotJustTheLibrary', () => {
    // `process.exit(runGuard())` is the plumbing that makes a finding block a
    // merge, and no test had ever run it. Replace it with `runGuard();`, or with
    // `process.exit(0)`, and every assertion task 017 shipped still passes while
    // CI goes permanently, silently green.
    //
    // The two red mutations below break DIFFERENT teeth — the frozen seed pin and
    // the census denominator — so what is shown is that the exit status TRACKS
    // THE VERDICT, not that this particular copy happens to be red.
    const red = MUTATIONS.filter((m) => m.verdict === 'red');
    expect(red.length).toBeGreaterThan(1);

    for (const mutation of red) {
      const run = runCopy(`${mutation.id}-guard.ts`, mutation);
      expect(run.code, `${mutation.id}: ${mutation.why}`).toBe(1);
      expect(run.stderr, mutation.id).toContain(mutation.expectFinding);
      // The report goes to stderr and stdout stays empty, so a CI log scraper
      // cannot read a failing run's output as the success line.
      expect(run.stdout, mutation.id).toBe('');
    }
  });

  it('OutputSchemaRatchetGuard_LegacyFilenamePredicate_GoesSilentlyGreen', () => {
    // THE KILL FIXTURE. Without it the two probes above would be satisfied by an
    // unconditional `process.exit(runGuard())` — a predicate that is always true
    // also runs under any name — and would prove nothing about the predicate.
    //
    // This arm restores the pre-018 predicate into a copy and runs it under a
    // different name. It must produce the exact silent-green signature: exit 0,
    // nothing on stdout, nothing on stderr. That is guard-execution failure
    // passing as success, reproduced on demand.
    const mutation = MUTATIONS.find((m) => m.id === 'legacy-filename-coupled-predicate');
    expect(mutation).toBeDefined();
    if (mutation === undefined) return;

    const silent = runCopy('a-name-the-legacy-predicate-cannot-match.ts', mutation);
    expect(silent.code).toBe(0);
    expect(silent.stdout).toBe('');
    expect(silent.stderr).toBe('');

    // …and the mutation is filename-coupled rather than simply broken: the SAME
    // mutated source under the ORIGINAL name still runs and still reports. Without
    // this control the fixture would be indistinguishable from "the edit broke the
    // module", and it would prove the wrong thing.
    const underOriginalName = runCopy('output-schema-ratchet-guard.ts', mutation);
    expect(underOriginalName.stdout.length + underOriginalName.stderr.length).toBeGreaterThan(0);
    expect(withoutDays(underOriginalName.stdout)).toBe(withoutDays(liveRun.stdout));
    expect(underOriginalName.code).toBe(liveRun.code);
  });

  it('OutputSchemaRatchetGuard_ImportedRatherThanInvoked_DoesNotSelfExecute', () => {
    // The other half of the predicate's contract, and the anti-vacuity tooth for
    // every arm above: a guard that ran on IMPORT would satisfy all of them and
    // would also `process.exit` inside its own test runner, inside the census, and
    // inside anything else that reads `runGuard`. So the negative case is pinned
    // explicitly — the module is imported, the export is real, and control
    // returns to the importer.
    const dir = mkdtempSync(join(scratchDir, 'import-'));
    const marker = 'IMPORTED-WITHOUT-RUNNING';
    const entry = join(dir, 'imports-the-guard-without-running-it.ts');
    writeFileSync(
      entry,
      [
        `import { runGuard, LIVE_SUBJECT } from '${pathToFileURL(GUARD_PATH).href}';`,
        'if (typeof runGuard !== \'function\') throw new Error(\'runGuard is not exported\');',
        'if (LIVE_SUBJECT.waived.length === 0) throw new Error(\'LIVE_SUBJECT is empty\');',
        `process.stdout.write('${marker}');`,
        '',
      ].join('\n'),
      'utf8',
    );

    const imported = runEntrypoint(entry);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toBe(marker);
    expect(imported.stderr).toBe('');
    // Specifically: no verdict of any kind leaked out of the import.
    expect(imported.stdout).not.toContain('outputSchema:ratchet');
  });
});

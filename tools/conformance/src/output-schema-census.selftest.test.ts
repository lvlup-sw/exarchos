// Self-test for the output-schema ratchet guard: a guard that fails to execute must not pass as
// success.
//
// Other suites call `runGuard()` in this process and read its return value. This file runs the
// shipped guard as a separate process. It proves five facts:
//   1. The shipped entrypoint runs and states its denominator.
//   2. The guard runs under any file name, so a rename does not make it a silent no-op.
//   3. A finding makes the process exit non-zero.
//   4. An empty census makes the process fail, not only the library.
//   5. An import of the module does not run the guard.
//
// Authority A is the allowlist data file and the live census, read in this process. Authority B
// is the output and exit status of the child process. The live exit status depends on the date,
// so the file asserts a verdict, not a green run.
//
// @oracle-sources: ../../../src/output-schema-vacuity-allowlist.ts, the exit status and stdout/stderr of a separate OS process running the shipped guard entrypoint under tsx
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { censusLiveOutputSchemas } from './bindings/output-schema.js';
import { REPO_ROOT, SUBJECT_PACKAGE_ROOT } from './subject-root.js';
import { VACUITY_ALLOWLIST_IDS } from '../../../src/output-schema-vacuity-allowlist.js';
import { spawnAsync } from '../../test-helpers/spawn.js';
import { rmrf } from '../../test-helpers/temp-dir.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The subject package root. */
const MCP_ROOT = SUBJECT_PACKAGE_ROOT;
/** The guard file that ci.yml runs. `guard-inventory` proves that CI reaches it, and this file proves that it executes. */
const GUARD_PATH = join(MCP_ROOT, 'tools', 'audit', 'core', 'output-schema-ratchet-guard.ts');

/**
 * The expression that the shipped entrypoint uses to decide that it is the process entrypoint,
 * and the legacy filename match.
 *
 * The legacy form is data, not prose: {@link MUTATIONS} puts it back into a copy to produce the
 * failure that this file detects. A probe with no failing subject does not prove that it works.
 */
const SHIPPED_PREDICATE =
  'canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))';
const LEGACY_FILENAME_PREDICATE = "process.argv[1].endsWith('output-schema-ratchet-guard.ts')";

/**
 * The exit plumbing that turns a finding into a failed lane. It is named once because more than one
 * assertion uses it. The guard sets `process.exitCode` and does not call `process.exit`, so its
 * output can drain before the process ends.
 */
const SHIPPED_EXIT = 'process.exitCode = runGuard()';
/** Relative module specifiers in the guard source, such as `../../conformance/src/output-schema-seed-pin.js`. */
const RELATIVE_SPECIFIER = /from '(\.\.\/[^']+\.js)'/g;

/**
 * Returns the tsx CLI path. It looks in the subject package first and then in the repo root. It
 * throws when tsx is absent, because a self-test that skips without a runner reports no failures
 * for the wrong reason.
 */
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

async function runEntrypoint(entry: string): Promise<ProcessRun> {
  const result = await spawnAsync(process.execPath, [resolveTsxCli(), entry], {
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
 * The code lines of a source file, with comment lines dropped. A comment that quotes the legacy
 * predicate must not count as a use of it.
 */
function codeOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

interface SpecifierRewrite {
  /** The specifier as written in the guard, such as `../../conformance/src/output-schema-seed-pin.js`. */
  readonly specifier: string;
  /** Absolute `file://` URL of the real `.ts` module it names. */
  readonly realUrl: string;
}

/**
 * Parses the relative import specifiers of the guard source, each with the `file://` URL of the
 * real module. Every probe runs a copy of the shipped guard under a new name in a temp directory.
 * The copy imports the real modules, so only the file name changes.
 */
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

/**
 * Ways to break the mechanism of the guard. Each entry gives the edit, applied to a copy and never
 * to the shipped tree, and the verdict that the copy must produce. Two entries must be red. One
 * must be silently green: it is the kill fixture for the probe itself.
 */
const MUTATIONS: readonly Mutation[] = Object.freeze([
  /**
   * The sidecar re-exports the real pin with `export *` and shadows only the digest. A named list
   * fails to link when the pin gains a constant.
   */
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
            `export * from '${pinUrl}';`,
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
    /**
     * The stub shadows the binding `censusLiveOutputSchemas`, not the census module, because the
     * guard calls the binding. A stub aimed at the census module shadows a function that the guard
     * does not call, and the probe goes vacuous instead of red.
     */
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

let scratchDir = '';
let guardSource = '';
let liveRun: ProcessRun = { code: null, stdout: '', stderr: '' };

/** Write a copy of the guard under `name`, plus its sidecars, and run it. */
async function runCopy(name: string, mutation: Mutation | undefined): Promise<ProcessRun> {
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

beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'imo-018-g2-selftest-'));
  guardSource = readFileSync(GUARD_PATH, 'utf8');
  liveRun = await runEntrypoint(GUARD_PATH);
});

afterAll(() => {
  if (scratchDir.length > 0) rmrf(scratchDir);
});

describe('DR-4 / G2 self-test: guard-execution failure cannot pass as success', () => {
  /**
   * The guard file, the runner and the governed populations must exist first, so a moved artifact
   * is red, not absent. The denominator comes from the live artifacts, never from a literal. The
   * test does not pin the wall clock: the expiry is enforced, so the live guard goes red after
   * `VACUITY_EXPIRY_HORIZON`. On both sides of the horizon, the process must state a verdict in the
   * correct channel. The child must also print the denominator that this process measured.
   */
  it('OutputSchemaRatchetGuard_ShippedEntrypoint_ProducesAVerdictOverANonEmptySubject', () => {
    expect(existsSync(GUARD_PATH), `${GUARD_PATH} is missing`).toBe(true);
    expect(resolveTsxCli().endsWith('cli.mjs')).toBe(true);

    const liveTotal = censusLiveOutputSchemas().total;
    const liveWaived = VACUITY_ALLOWLIST_IDS.length;
    expect(liveWaived).toBeGreaterThan(0);
    expect(liveTotal).toBeGreaterThan(liveWaived);

    expect(liveRun.code).not.toBeNull();
    expect(liveRun.stdout.length + liveRun.stderr.length).toBeGreaterThan(0);

    const combined = `${liveRun.stdout}${liveRun.stderr}`;
    if (liveRun.code === 0) {
      expect(liveRun.stdout).toContain('outputSchema:ratchet — OK as of');
      expect(liveRun.stderr).toBe('');
    } else {
      expect(liveRun.code).toBe(1);
      expect(liveRun.stdout).toBe('');
      expect(liveRun.stderr).toContain('finding(s) as of');
    }

    expect(combined).toContain(`of ${liveTotal} declaration`);
    expect(combined).toContain(`${liveWaived} waived`);
  });

  /**
   * The rename check. A rename moves the file and updates the `run:` step in ci.yml. A guard that
   * matches its own file name then runs, prints nothing and exits 0. The copy keeps the shipped
   * tail verbatim: only import specifiers change, and the check reads code lines only.
   *
   * @kill-seam: the entrypoint predicate. The `legacy-filename-coupled-predicate` mutation
   * restores the filename match, and the same copy goes silently green.
   */
  it('OutputSchemaRatchetGuard_SameSourceUnderADifferentName_StillEnforces', async () => {
    const renamed = await runCopy('a-name-the-predicate-cannot-know.ts', undefined);

    expect(renamed.code).toBe(liveRun.code);
    expect(withoutDays(renamed.stdout)).toBe(withoutDays(liveRun.stdout));
    expect(withoutDays(renamed.stderr)).toBe(withoutDays(liveRun.stderr));
    expect(renamed.stdout.length + renamed.stderr.length).toBeGreaterThan(0);

    const rewritten = codeOf(rewrittenGuardSource(guardSource));
    expect(rewritten).toContain(SHIPPED_PREDICATE);
    expect(rewritten).toContain(SHIPPED_EXIT);
    expect(rewritten).not.toContain(LEGACY_FILENAME_PREDICATE);
  });

  /**
   * `process.exitCode = runGuard()` makes a finding block a merge. If a bare `runGuard();` or a fixed
   * exit code takes its place, the in-process assertions still pass and CI stays green. The two red
   * mutations break different checks, the seed pin and the census denominator. Thus the exit status
   * tracks the verdict. The report goes to stderr with an empty stdout, so a CI log scraper cannot
   * read a failed run as the success line.
   */
  it('OutputSchemaRatchetGuard_BrokenMechanism_RedensTheProcessNotJustTheLibrary', async () => {
    const red = MUTATIONS.filter((m) => m.verdict === 'red');
    expect(red.length).toBeGreaterThan(1);

    for (const mutation of red) {
      const run = await runCopy(`${mutation.id}-guard.ts`, mutation);
      expect(run.code, `${mutation.id}: ${mutation.why}`).toBe(1);
      expect(run.stderr, mutation.id).toContain(mutation.expectFinding);
      expect(run.stdout, mutation.id).toBe('');
    }
  });

  /**
   * The kill fixture. Without it, an unconditional `process.exit(runGuard())` satisfies the two
   * probes above, because a predicate that is always true also runs under any name. The legacy
   * predicate under a new name must exit 0 with no output. The same source under the original name
   * must still report, so the fixture proves filename coupling and not a broken module.
   */
  it('OutputSchemaRatchetGuard_LegacyFilenamePredicate_GoesSilentlyGreen', async () => {
    const mutation = MUTATIONS.find((m) => m.id === 'legacy-filename-coupled-predicate');
    expect(mutation).toBeDefined();
    if (mutation === undefined) return;

    const silent = await runCopy('a-name-the-legacy-predicate-cannot-match.ts', mutation);
    expect(silent.code).toBe(0);
    expect(silent.stdout).toBe('');
    expect(silent.stderr).toBe('');

    const underOriginalName = await runCopy('output-schema-ratchet-guard.ts', mutation);
    expect(underOriginalName.stdout.length + underOriginalName.stderr.length).toBeGreaterThan(0);
    expect(withoutDays(underOriginalName.stdout)).toBe(withoutDays(liveRun.stdout));
    expect(underOriginalName.code).toBe(liveRun.code);
  });

  /**
   * A guard that runs on import satisfies every arm above. It also sets the exit code of every
   * process that imports it. The test imports the module, checks the exports, and asserts that
   * control comes back with no verdict in the output.
   */
  it('OutputSchemaRatchetGuard_ImportedRatherThanInvoked_DoesNotSelfExecute', async () => {
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

    const imported = await runEntrypoint(entry);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toBe(marker);
    expect(imported.stderr).toBe('');
    expect(imported.stdout).not.toContain('outputSchema:ratchet');
  });
});

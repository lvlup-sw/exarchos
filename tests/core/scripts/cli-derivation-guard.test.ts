// The source-level CLI derivation guard, and its self-tests.
//
// @oracle-sources: ../src/adapters/cli/cli.ts, the specification's hand-enumerated kill-fixture list of 11 literal command names
//
// The two authorities are independent. The first is the live composition root, which the guard
// parses. The second is a hand-written enumeration from the specification, copied into
// `EXPECTED_HAND_WRITTEN_LITERALS`. If the parser drifts, the two disagree and this suite fails.
// A guard that compares the parse with itself cannot disagree with itself.

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  GOVERNED_SOURCES,
  REPO_ROOT,
  ALLOWLIST_PATH,
  KILL_FIXTURE_COMMANDS,
  isKillFixture,
  scanGovernedSources,
  scanSourceForCommandSites,
  findDerivationViolations,
  readAllowlist,
  extractPolicyFileReferences,
  findPolicyReferenceProblems,
} from '../../../tools/audit/core/cli-derivation-guard.js';

/**
 * The module that the policy data names. It is a second authority, because the guard derives
 * nothing from this constant. If only one side follows a rename of the module, the suite fails.
 */
const GUARD_MODULE_PATH = 'tools/audit/core/cli-derivation-guard.ts';

/** An old path of the guard module. A policy `$comment` that names it points at no file. */
const RENAMED_AWAY_MODULE_PATH = 'tools/audit/core/cli-derivation-seam.ts';

/**
 * Writes a policy file into a temporary tree, with an empty stub of the guard module beside it.
 *
 * The default `$comment` names that stub, because the reader refuses a policy file that names a
 * missing file. Only the existence of the stub matters. Thus a fixture for the entry rules is
 * valid on the reference rules, and the two rejections stay independent.
 *
 * Callers pass only names. Each name gets the same placeholder `owner` and `expires`.
 */
function seedAllowlist(
  root: string,
  allowed: readonly string[],
  comment?: readonly string[],
): void {
  const abs = path.join(root, ALLOWLIST_PATH);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(path.join(root, GUARD_MODULE_PATH), '', 'utf8');
  const entries: Record<string, { owner: string; expires: string }> = {};
  for (const name of allowed) entries[name] = { owner: 'cli-surface', expires: '2027-02-28' };
  writeFileSync(
    abs,
    JSON.stringify({
      $comment: comment ?? [`policy data for ${GUARD_MODULE_PATH}`],
      allowed: entries,
      retired: {},
    }),
    'utf8',
  );
}

/** The message a throwing call produced, so two failure paths can be compared. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the call to throw, and it did not');
}

/**
 * The hand-written literals in the composition root, copied by hand from the specification and not
 * read from the parser. This list is the second authority.
 *
 * `merge-orchestrate` is absent, because the registry hint `cli.topLevel` promotes that verb and
 * the composition root holds no hand-written call for it. {@link KILL_FIXTURE_SOURCE} proves that
 * the guard still rejects such a call.
 */
const EXPECTED_HAND_WRITTEN_LITERALS: readonly string[] = [
  'doctor',
  'emissions',
  'feedback',
  'init',
  'install-skills',
  'mcp',
  'onboard',
  'schema',
  'topology',
  'version',
];

/**
 * The kill fixture: a hand-written `merge-orchestrate` definition, which the guard must reject.
 *
 * The live composition root holds no such definition, so a test appends this block to the real
 * source. Without the fixture, nothing stops an author who adds the hand-written promotion again.
 * The block is a chained `program.command(...)` with a `.description(...)`.
 */
const KILL_FIXTURE_SOURCE = [
  "const mergeOrchestrateCmd = program",
  "  .command('merge-orchestrate')",
  "  .description('Run the autonomous merge orchestrator.');",
  'mergeOrchestrateCmd.action(async () => {});',
].join('\n');

/**
 * The argument expressions of the three derived sites. Each site takes its name from a registry
 * declaration.
 */
const EXPECTED_DERIVED_EXPRESSIONS: readonly string[] = ['cliName', 'commandName', 'harness'];

function governedSourcePath(): string {
  const rel = GOVERNED_SOURCES[0];
  if (rel === undefined) throw new Error('GOVERNED_SOURCES is empty');
  return path.join(REPO_ROOT, rel);
}

describe('cli-derivation-guard (DR-5 / G1)', () => {
  /**
   * In the live composition root, each site is a derivation loop or a hand-written literal, and none
   * is indeterminate. The total is derived from the two populations, so a correct paydown does not
   * break it. The guard must not report the three derivation loops.
   *
   * The shipped allowlist must equal the expected literals minus the kill fixtures, and no kill
   * fixture can be in the live population. Thus the guard reports zero violations. That result has
   * meaning only because the seeded tests show a rejection.
   *
   * A text scan counts more `.command(` sites than the parser, because comments in `cli.ts` hold the
   * call form. The test finds those comment lines by shape. The site count must equal the text count
   * minus those lines, and no site can be on one.
   */
  it('CliDerivationGuard_CompositionRoot_ReportsOnlyAllowlistedHandWrittenLiterals', () => {
    const scan = scanGovernedSources();

    const names = scan.literals.map((s) => s.name).sort();
    expect(names).toEqual([...EXPECTED_HAND_WRITTEN_LITERALS].sort());
    expect(scan.literals).toHaveLength(EXPECTED_HAND_WRITTEN_LITERALS.length);

    expect(names).not.toContain('merge-orchestrate');

    expect(scan.derived.map((s) => s.expression).sort()).toEqual(
      [...EXPECTED_DERIVED_EXPRESSIONS].sort(),
    );

    expect(scan.indeterminate).toHaveLength(0);

    expect(scan.sites).toHaveLength(
      scan.literals.length + scan.derived.length + scan.indeterminate.length,
    );
    expect(scan.sites).toHaveLength(
      EXPECTED_HAND_WRITTEN_LITERALS.length + EXPECTED_DERIVED_EXPRESSIONS.length,
    );

    const allowlistable = EXPECTED_HAND_WRITTEN_LITERALS.filter((n) => !isKillFixture(n));
    expect([...readAllowlist()].sort()).toEqual([...allowlistable].sort());
    expect(readAllowlist().size).toBe(allowlistable.length);

    expect(EXPECTED_HAND_WRITTEN_LITERALS.filter(isKillFixture)).toEqual([]);

    const violations = findDerivationViolations(scan, readAllowlist());
    expect(violations).toEqual([]);

    const raw = readFileSync(governedSourcePath(), 'utf8');
    const lines = raw.split('\n');
    const naiveTextMatches = raw.match(/\.command\(/g) ?? [];

    const proseLines = lines
      .map((line, i) => ({ line, number: i + 1 }))
      .filter(({ line }) => /^\s*(\*|\/\/)/.test(line) && line.includes('.command('));

    expect(proseLines.length).toBeGreaterThan(0);
    expect(scan.sites.length).toBe(naiveTextMatches.length - proseLines.length);

    const siteLines = new Set(scan.sites.map((s) => s.line));
    for (const { number } of proseLines) {
      expect(siteLines.has(number)).toBe(false);
    }
  });

  /**
   * With no allowlist, each hand-written literal is a violation. One seeded literal must move the
   * literal count and the violation count by exactly one. Under the shipped allowlist the seeded
   * name must be the only violation, so a green run means "checked" and not "empty".
   */
  it('CliDerivationGuard_OneMoreLiteralSeeded_Fails', () => {
    const raw = readFileSync(governedSourcePath(), 'utf8');

    const before = scanSourceForCommandSites(raw, 'cli.ts');
    expect(findDerivationViolations(before)).toHaveLength(
      EXPECTED_HAND_WRITTEN_LITERALS.length,
    );

    const seeded = `${raw}\nconst __seededExtra = program.command('seeded-extra').description('x');\n`;
    const after = scanSourceForCommandSites(seeded, 'cli.ts');

    const violations = findDerivationViolations(after);
    expect(violations.map((v) => v.name)).toContain('seeded-extra');

    expect(after.literals.length).toBe(before.literals.length + 1);
    expect(violations.length).toBe(findDerivationViolations(before).length + 1);

    const underShippedPolicy = findDerivationViolations(after, readAllowlist());
    expect(underShippedPolicy.map((v) => v.name)).toEqual(['seeded-extra']);
  });

  /**
   * A governed source that parses but registers no command must throw. Without that check, a moved
   * or renamed composition root gives zero sites, zero violations and a green guard. A missing file,
   * an empty list of governed sources, and a source with a parse error must throw too.
   */
  it('CliDerivationGuard_ZeroCommandSitesParsed_FailsClosed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'imo-020-'));
    const rel = GOVERNED_SOURCES[0];
    if (rel === undefined) throw new Error('GOVERNED_SOURCES is empty');
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });

    writeFileSync(abs, 'export const nothing = 1;\n', 'utf8');
    expect(() => scanGovernedSources(root)).toThrow(/yielded 0 `\.command\(` sites/);

    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'imo-020-missing-'));
    expect(() => scanGovernedSources(emptyRoot)).toThrow(/does not exist/);

    expect(() => scanGovernedSources(REPO_ROOT, [])).toThrow(/no governed sources declared/);

    expect(() => scanSourceForCommandSites('const x = (;', 'broken.ts')).toThrow(
      /did not parse cleanly/,
    );
  });

  /**
   * `merge_orchestrate` is a registry action, so a hand-written `.command('merge-orchestrate')` is a
   * second declaration. The remedy is deletion, never an exemption.
   *
   * The first half reads the parse of the live root and not its text, so it is a claim about
   * registered commands only. The second half appends {@link KILL_FIXTURE_SOURCE} to the real source
   * and runs the same guard. With each other literal in the allowlist, the kill fixture must be the
   * only violation. An allowlist that names the kill fixture must not suppress it. The detail of the
   * violation must name deletion as the remedy.
   */
  it('CliDerivationGuard_MergeOrchestrateLiteral_IsRejected', () => {
    const live = scanGovernedSources();
    expect(live.literals.map((s) => s.name)).not.toContain('merge-orchestrate');

    const seededSource = `${readFileSync(governedSourcePath(), 'utf8')}\n${KILL_FIXTURE_SOURCE}\n`;
    const scan = scanSourceForCommandSites(
      seededSource,
      'src/adapters/cli/cli.ts',
    );

    const sites = scan.literals.filter((s) => s.name === 'merge-orchestrate');
    expect(sites).toHaveLength(1);
    const site = sites[0];
    if (site === undefined) throw new Error('unreachable: length asserted above');

    expect(site.kind).toBe('literal');
    expect(site.expression).toBe("'merge-orchestrate'");
    expect(site.file).toBe('src/adapters/cli/cli.ts');

    const reported = findDerivationViolations(scan, readAllowlist());
    expect(reported.map((v) => v.name)).toContain('merge-orchestrate');

    const everyOtherLiteral = new Set(EXPECTED_HAND_WRITTEN_LITERALS);
    expect(everyOtherLiteral.has('merge-orchestrate')).toBe(false);
    const survivors = findDerivationViolations(scan, everyOtherLiteral);
    expect(survivors.map((v) => v.name)).toEqual(['merge-orchestrate']);

    const withKillFixtureAllowed = new Set([
      ...everyOtherLiteral,
      'merge-orchestrate',
    ]);
    const stillRejected = findDerivationViolations(scan, withKillFixtureAllowed);
    expect(stillRejected.map((v) => v.name)).toEqual(['merge-orchestrate']);

    const detail = stillRejected[0]?.detail ?? '';
    expect(detail).toContain('not allowlistable');
    expect(detail).toMatch(/[Dd]elete the hand-written command/);
  });

  /**
   * The name must be absent from the `allowed` map, the `retired` map and the parsed view. The test
   * reads the two maps as raw JSON, because the parsed view refuses a file that holds the kill
   * fixture. The name must be present in {@link KILL_FIXTURE_COMMANDS}, so the exclusion is declared.
   *
   * Those absence checks cannot show that the reader rejects a new entry. Thus the test seeds an
   * allowlist that names the kill fixture, and `readAllowlist` must throw. The same file with no
   * kill fixture must load, so the rejection is specific to that name.
   */
  it('CliDerivationGuard_MergeOrchestrate_IsAbsentFromTheAllowlist', () => {
    const rawAllowlist: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, ALLOWLIST_PATH), 'utf8'),
    );
    const rawMapKeys = (field: string): string[] => {
      const raw: unknown =
        typeof rawAllowlist === 'object' && rawAllowlist !== null
          ? Reflect.get(rawAllowlist, field)
          : undefined;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`the shipped policy file has no "${field}" object`);
      }
      return Object.keys(raw);
    };
    expect(rawMapKeys('allowed').length).toBeGreaterThan(0);
    expect(rawMapKeys('allowed')).not.toContain('merge-orchestrate');
    expect(rawMapKeys('retired')).not.toContain('merge-orchestrate');

    expect([...readAllowlist()]).not.toContain('merge-orchestrate');

    expect(KILL_FIXTURE_COMMANDS).toContain('merge-orchestrate');

    const root = mkdtempSync(path.join(tmpdir(), 'imo-021-'));
    seedAllowlist(root, ['doctor', 'merge-orchestrate']);
    expect(() => readAllowlist(root)).toThrow(/allowlists the kill fixture/);

    seedAllowlist(root, ['doctor']);
    expect([...readAllowlist(root)]).toEqual(['doctor']);
  });

  /**
   * The zero-site check is in the pure scanner, so a gate that calls `scanSourceForCommandSites`
   * directly cannot bypass it. An empty string and a module with no command must throw, and the
   * message must name the file. A file that holds only `.commands` and `.commandName` has zero
   * sites, which excludes an implementation that matches text. One site is sufficient, which
   * excludes a `<= 1` check.
   *
   * `scanGovernedSources` holds no copy of the check. For the same input its message must equal the
   * message of the pure scanner.
   */
  it('CliDerivationGuard_PureScanner_ZeroCommandSites_Throws', () => {
    expect(() => scanSourceForCommandSites('', 'empty.ts')).toThrow(
      /yielded 0 `\.command\(` sites/,
    );

    expect(() => scanSourceForCommandSites('export const nothing = 1;\n', 'moved.ts')).toThrow(
      /yielded 0 `\.command\(` sites/,
    );

    expect(messageOf(() => scanSourceForCommandSites('', 'moved-root.ts'))).toContain(
      '"moved-root.ts"',
    );

    expect(() =>
      scanSourceForCommandSites('const n = program.commands.length + x.commandName;\n', 'near.ts'),
    ).toThrow(/yielded 0 `\.command\(` sites/);

    const single = scanSourceForCommandSites('program.command(cliName);\n', 'one.ts');
    expect(single.sites).toHaveLength(1);
    expect(single.derived).toHaveLength(1);

    const rel = GOVERNED_SOURCES[0];
    if (rel === undefined) throw new Error('GOVERNED_SOURCES is empty');
    const root = mkdtempSync(path.join(tmpdir(), 'imo-022-denominator-'));
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, 'export const nothing = 1;\n', 'utf8');

    const viaOuter = messageOf(() => scanGovernedSources(root));
    const viaPure = messageOf(() => scanSourceForCommandSites('export const nothing = 1;\n', rel));
    expect(viaOuter).toBe(viaPure);
    expect(viaOuter).toContain(rel);
  });

  /**
   * An author reads the policy `$comment` to decide whether an entry is legitimate. Thus each file
   * that the comment names must exist, or the reader refuses the policy.
   *
   * The shipped comment must give a non-empty reference list that holds the expected paths, because
   * the reader cannot check a path that the extractor misses. A comment that names the old module
   * path, a bare filename, or no file must fail. A policy with no `$comment` key must fail too. Its
   * body is valid, so only the reference rule can refuse it. The correct path must load, so the
   * rejection is specific to the bad reference.
   *
   * When a stale path and a kill fixture are in one file, the kill-fixture error must win.
   */
  it('CliDerivationGuard_PolicyCommentNamingAMissingModule_IsRejected', () => {
    const rawAllowlist: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, ALLOWLIST_PATH), 'utf8'),
    );
    const commentLines: unknown =
      typeof rawAllowlist === 'object' && rawAllowlist !== null
        ? Reflect.get(rawAllowlist, '$comment')
        : undefined;
    expect(Array.isArray(commentLines)).toBe(true);
    const commentText = Array.isArray(commentLines) ? commentLines.join('\n') : '';

    const references = extractPolicyFileReferences(commentText);
    expect(references.length).toBeGreaterThan(0);
    expect(references).toContain(GUARD_MODULE_PATH);
    expect(references).toContain('src/adapters/cli/cli.ts');
    expect(references).not.toContain(RENAMED_AWAY_MODULE_PATH);
    expect(findPolicyReferenceProblems(commentText)).toEqual([]);
    expect(() => readAllowlist()).not.toThrow();

    const root = mkdtempSync(path.join(tmpdir(), 'imo-022-reference-'));
    seedAllowlist(root, ['doctor'], [`DR-5 / G1 policy data for ${RENAMED_AWAY_MODULE_PATH}.`]);
    expect(() => readAllowlist(root)).toThrow(/cli-derivation-seam\.ts" does not exist/);

    seedAllowlist(root, ['doctor'], ['see KILL_FIXTURE_COMMANDS in cli-derivation-guard.ts.']);
    expect(() => readAllowlist(root)).toThrow(/is a bare filename/);

    seedAllowlist(root, ['doctor'], ['DR-5 policy data. Entries are tolerated literals.']);
    expect(() => readAllowlist(root)).toThrow(/names no file at all/);

    const abs = path.join(root, ALLOWLIST_PATH);
    writeFileSync(
      abs,
      JSON.stringify({
        allowed: { doctor: { owner: 'cli-surface', expires: '2027-02-28' } },
        retired: {},
      }),
      'utf8',
    );
    expect(() => readAllowlist(root)).toThrow(/names no file at all/);

    seedAllowlist(root, ['doctor'], [`DR-5 / G1 policy data for ${GUARD_MODULE_PATH}.`]);
    expect([...readAllowlist(root)]).toEqual(['doctor']);

    seedAllowlist(
      root,
      ['merge-orchestrate'],
      [`DR-5 / G1 policy data for ${RENAMED_AWAY_MODULE_PATH}.`],
    );
    expect(() => readAllowlist(root)).toThrow(/allowlists the kill fixture/);
  });
});

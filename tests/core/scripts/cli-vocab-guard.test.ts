import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  extractCliSurface,
  findVocabViolations,
  findLiveCliViolations,
  type CliSurface,
} from '../../../tools/audit/core/cli-vocab-guard.js';
import {
  GOVERNED_SOURCES,
  REPO_ROOT,
  scanSourceForCommandSites,
  findDerivationViolations,
  readAllowlist,
} from '../../../tools/audit/core/cli-derivation-guard.js';
import { getFullRegistry } from '../../../src/registry.js';

/**
 * Builds a `CliSurface` from planted verbs and flags. The detection logic is pure over a
 * `CliSurface`, so these tests reach the FAIL path with no change to the real registry.
 */
function surface(
  verbs: { path: string; token: string }[],
  flags: { path: string; token: string }[] = [],
): CliSurface {
  return { verbs, flags };
}

/** Each case passes an empty exception set, so nothing excuses the banned token. */
describe('cli-vocab-guard: findVocabViolations (FAIL path)', () => {
  it('flags a banned verb alias (`info`) with its canonical replacement', () => {
    const violations = findVocabViolations(
      surface([{ path: 'exarchos wf info', token: 'info' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: 'verb',
      token: 'info',
      path: 'exarchos wf info',
      canonical: 'get',
    });
  });

  it('flags a banned verb alias (`ls`) when not excepted', () => {
    const violations = findVocabViolations(
      surface([{ path: 'exarchos something ls', token: 'ls' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.token).toBe('ls');
    expect(violations[0]?.canonical).toBe('list');
  });

  it('flags a banned destructive verb alias (`rm`)', () => {
    const violations = findVocabViolations(
      surface([{ path: 'exarchos wf rm', token: 'rm' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('verb');
    expect(violations[0]?.token).toBe('rm');
  });

  it('flags a banned flag alias (`--format` as a JSON carrier) when not excepted', () => {
    const violations = findVocabViolations(
      surface([], [{ path: 'exarchos wf get --format', token: '--format' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: 'flag',
      token: '--format',
      canonical: '--json',
    });
  });

  it('flags a banned confirmation-bypass flag (`--skip-confirmations`)', () => {
    const violations = findVocabViolations(
      surface([], [{ path: 'exarchos wf cancel --skip-confirmations', token: '--skip-confirmations' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.canonical).toBe('--force');
  });

  it('reports every violation when several banned tokens are present', () => {
    const violations = findVocabViolations(
      surface(
        [
          { path: 'exarchos wf info', token: 'info' },
          { path: 'exarchos vw ls', token: 'ls' },
        ],
        [{ path: 'exarchos doctor --format', token: '--format' }],
      ),
      new Set(),
    );
    expect(violations).toHaveLength(3);
  });
});

describe('cli-vocab-guard: findVocabViolations (PASS path)', () => {
  /** `--skip-tests` skips a build step and is not a confirmation bypass, so it must not be a violation. */
  it('passes a surface using only canonical vocabulary', () => {
    const violations = findVocabViolations(
      surface(
        [
          { path: 'exarchos wf get', token: 'get' },
          { path: 'exarchos vw list', token: 'list' },
          { path: 'exarchos wf list_prs', token: 'list_prs' },
        ],
        [
          { path: 'exarchos wf get --json', token: '--json' },
          { path: 'exarchos wf cancel --force', token: '--force' },
          { path: 'exarchos orch create_pr --skip-tests', token: '--skip-tests' },
        ],
      ),
      new Set(),
    );
    expect(violations).toEqual([]);
  });

  it('honors KNOWN_EXCEPTIONS keyed by exact command path + token', () => {
    const exceptions = new Set(['exarchos vw ls::ls']);
    const violations = findVocabViolations(
      surface([{ path: 'exarchos vw ls', token: 'ls' }]),
      exceptions,
    );
    expect(violations).toEqual([]);
  });

  it('exception is surgical: same banned token on a DIFFERENT path still fails', () => {
    const exceptions = new Set(['exarchos vw ls::ls']);
    const violations = findVocabViolations(
      surface([{ path: 'exarchos wf ls', token: 'ls' }]),
      exceptions,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('exarchos wf ls');
  });
});

describe('cli-vocab-guard: extractCliSurface', () => {
  /**
   * A small hand-built Commander program has the shape of the tree that `buildCli` makes. The test
   * runs `extractCliSurface` on it. The program root is not a verb. Names and aliases are verbs. Each
   * flag has the path of the command that declares it.
   */
  it('walks command names, aliases, and long flags (skipping the program root)', () => {
    const program = new Command('exarchos');
    const wf = program.command('workflow').alias('wf');
    wf.command('get').option('--json', 'Output raw JSON').option('--feature-id <value>', 'id');
    const view = program.command('view').alias('vw');
    view.command('pipeline').alias('ls');

    const { verbs, flags } = extractCliSurface(program);
    const verbTokens = verbs.map((v) => v.token);

    expect(verbTokens).not.toContain('exarchos');
    expect(verbTokens).toEqual(expect.arrayContaining(['workflow', 'wf', 'get', 'view', 'vw', 'pipeline', 'ls']));
    expect(flags).toEqual(
      expect.arrayContaining([
        { path: 'exarchos workflow get', token: '--json' },
        { path: 'exarchos workflow get', token: '--feature-id' },
      ]),
    );
  });
});

describe('cli-vocab-guard: live CLI surface', () => {
  /**
   * The contract that the guard protects: the real rendered surface uses canonical vocabulary,
   * except for the tracked `KNOWN_EXCEPTIONS`. A new banned verb or flag fails this test. The
   * `cli:vocab-guard` gate catches the same regression in CI.
   */
  it('the current rendered CLI surface has no un-excepted vocabulary violations', () => {
    const violations = findLiveCliViolations();
    expect(violations).toEqual([]);
  });
});

/**
 * The name of the seeded command, written by hand as the second authority. The registry is the
 * first. The self-test asserts that the registry declares this name, so a rename on one side fails.
 */
const SELF_TEST_COMMAND_NAME = 'wait';

/** Top-level command names the registry DECLARES (`cli.topLevel` promotions). */
function registryDeclaredTopLevelNames(): readonly string[] {
  const names: string[] = [];
  for (const tool of getFullRegistry()) {
    for (const action of tool.actions) {
      const topLevel = action.cli?.topLevel;
      if (typeof topLevel === 'string') names.push(topLevel);
    }
  }
  return names;
}

/**
 * The canonical token `cli-vocab-guard` prescribes in place of `bannedToken`,
 * read from the guard's own verdict. Derived, not transcribed: if the policy
 * renames a canonical form, the fixture follows it instead of going stale.
 */
function canonicalReplacementFor(bannedToken: string): string {
  const [violation] = findVocabViolations(
    surface([], [{ path: 'exarchos probe', token: bannedToken }]),
    new Set(),
  );
  if (violation === undefined) {
    throw new Error(
      `\`${bannedToken}\` is no longer a banned flag, so no canonical replacement can be ` +
        'read from the policy. The vocabulary policy moved; update this fixture.',
    );
  }
  return violation.canonical;
}

function governedSourceRelPath(): string {
  const rel = GOVERNED_SOURCES[0];
  if (rel === undefined) throw new Error('GOVERNED_SOURCES is empty');
  return rel;
}

/**
 * `cli-vocab-guard` walks the rendered Commander tree and reads each token. That tree records no
 * provenance: `.command('wait')` and `.command(commandName)` give identical nodes. Thus the
 * vocabulary guard cannot find a command name that is hand-written in the composition root.
 *
 * The self-test builds a hand-written command with clean vocabulary. Its name is a `cli.topLevel`
 * declaration in the live registry, and its flags are the canonical tokens that the vocabulary
 * guard prescribes. `cli-vocab-guard` passes it with no exception, and `cli-derivation-guard`
 * rejects it.
 */
describe('G1 self-test: a clean-vocabulary hand-written command still fails (DR-5)', () => {
  /**
   * `cli.ts` registers the name through a derived site. A twin built from the registry name gives
   * the same surface, which is why the derivation guard reads source. The test seeds the command
   * into the live `cli.ts` source. It measures each count relative to the baseline scan, because a
   * correct paydown changes each absolute count. The seed must add exactly one literal and one
   * violation.
   *
   * The decisive step rewrites only the argument of the one seeded call, from a string literal to
   * an identifier. One site then moves from `literal` to `derived`, and the violation goes. A guard
   * keyed on the name, the token or the rendered node cannot give both answers. The vocabulary
   * guard reports nothing for the hand-written tree and for its twin.
   */
  it('CliDerivationGuard_CleanVocabularyHandWrittenCommand_IsStillRejected', () => {
    const declaredTopLevel = registryDeclaredTopLevelNames();
    expect(declaredTopLevel.length).toBeGreaterThan(0);
    expect(declaredTopLevel).toContain(SELF_TEST_COMMAND_NAME);

    const jsonFlag = canonicalReplacementFor('--format');
    const forceFlag = canonicalReplacementFor('--skip-confirmations');
    expect(jsonFlag).toBe('--json');
    expect(forceFlag).toBe('--force');

    const handWritten = new Command('exarchos');
    handWritten
      .command(SELF_TEST_COMMAND_NAME)
      .option(jsonFlag, 'Output raw JSON')
      .option(forceFlag, 'Bypass the confirmation guard');
    expect(findVocabViolations(extractCliSurface(handWritten), new Set())).toEqual([]);

    const nameFromRegistry = declaredTopLevel.find((n) => n === SELF_TEST_COMMAND_NAME);
    if (nameFromRegistry === undefined) throw new Error('unreachable: membership asserted above');
    const derivedTwin = new Command('exarchos');
    derivedTwin
      .command(nameFromRegistry)
      .option(jsonFlag, 'Output raw JSON')
      .option(forceFlag, 'Bypass the confirmation guard');
    expect(extractCliSurface(handWritten)).toEqual(extractCliSurface(derivedTwin));

    const rel = governedSourceRelPath();
    const cliSource = readFileSync(path.join(REPO_ROOT, rel), 'utf8');

    const baseline = scanSourceForCommandSites(cliSource, rel);
    expect(baseline.literals.length).toBeGreaterThan(0);
    expect(baseline.derived.length).toBeGreaterThan(0);
    expect(baseline.indeterminate).toHaveLength(0);

    const baselineViolations = findDerivationViolations(baseline, readAllowlist());
    expect(baselineViolations.map((v) => v.name)).not.toContain(SELF_TEST_COMMAND_NAME);

    const handWrittenCall = `.command('${SELF_TEST_COMMAND_NAME}')`;
    const seeded =
      `${cliSource}\n` +
      `const __g1CleanVocabularySelfTest = program\n` +
      `  ${handWrittenCall}\n` +
      `  .option('${jsonFlag}', 'Output raw JSON')\n` +
      `  .option('${forceFlag}', 'Bypass the confirmation guard');\n`;

    const seededScan = scanSourceForCommandSites(seeded, rel);
    expect(seededScan.literals).toHaveLength(baseline.literals.length + 1);
    expect(seededScan.derived).toHaveLength(baseline.derived.length);

    const seededViolations = findDerivationViolations(seededScan, readAllowlist());
    expect(seededViolations).toHaveLength(baselineViolations.length + 1);
    const reported = seededViolations.filter((v) => v.name === SELF_TEST_COMMAND_NAME);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.kind).toBe('literal');
    expect(reported[0]?.detail).toContain('bakes the command name into the composition');

    expect(seeded.split(handWrittenCall)).toHaveLength(2);
    const derivedVariant = seeded.replace(handWrittenCall, '.command(topLevelName)');
    expect(derivedVariant).not.toBe(seeded);

    const derivedScan = scanSourceForCommandSites(derivedVariant, rel);
    expect(derivedScan.sites).toHaveLength(seededScan.sites.length);
    expect(derivedScan.literals).toHaveLength(seededScan.literals.length - 1);
    expect(derivedScan.derived).toHaveLength(seededScan.derived.length + 1);
    const derivedViolations = findDerivationViolations(derivedScan, readAllowlist());
    expect(derivedViolations).toHaveLength(baselineViolations.length);
    expect(derivedViolations.map((v) => v.name)).not.toContain(SELF_TEST_COMMAND_NAME);

    expect(findVocabViolations(extractCliSurface(handWritten), new Set())).toEqual([]);
    expect(findVocabViolations(extractCliSurface(derivedTwin), new Set())).toEqual([]);
  });
});

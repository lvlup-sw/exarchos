/**
 * Each operator recovery that the release notes state reaches the operator on a surface that ships.
 * No package ships `CHANGELOG.md`, so a recovery that only the notes state reaches no installed user.
 * The subjects are the `Recovery:` bullets of the `[Unreleased]` section. A new marked bullet with no row fails.
 * A row names a shipped carrier and its phrases, or it is a register entry with an owner and a reason.
 *
 * @oracle-sources: ../../CHANGELOG.md, ../../package.json
 *
 * A produced carrier is a test case that asserts each phrase in a positive matcher on the text that the code produces.
 * A produced text is stronger proof than a phrase in source. A shipped-text carrier is a file that a package ships.
 * A change of the release notes alone runs no root test lane, so the `grep-gates` job also runs this file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The release notes, repo-relative. */
const NOTES_PATH = 'CHANGELOG.md';

/** The heading of the section that holds the notes of the next release. */
const UNRELEASED_HEADING = '## [Unreleased]';

/** A heading of a release section. The `[Unreleased]` section ends at the next one. */
const RELEASE_HEADING = /^## \[/;

/** A bullet that states an operator recovery. The marker is the first word of the bullet. */
const RECOVERY_BULLET = /^\s*- Recovery: /;

/** A surface that ships and carries a recovery to the operator. */
type Carrier =
  | {
      /** A test case that asserts each phrase in a positive matcher on the text that the code produces. */
      readonly kind: 'produced';
      /** The repo-relative path of the test file. */
      readonly test: string;
      /** The name of the case, as its `it` call names it. */
      readonly testCase: string;
      readonly phrases: readonly [string, ...string[]];
    }
  | {
      /** A file that a package ships, read as text, for example a skill reference under `rendered/`. */
      readonly kind: 'shipped-text';
      /** The repo-relative path of the file. */
      readonly path: string;
      readonly phrases: readonly [string, ...string[]];
    };

/** A recovery of the notes and the shipped surface that carries it. */
interface CarriedRecovery {
  readonly id: string;
  /** A phrase of the notes line that states the recovery. It selects that line. */
  readonly notes: string;
  readonly carrier: Carrier;
}

/** A recovery whose decided carrier is the release notes. */
interface RegisteredRecovery {
  readonly id: string;
  /** A phrase of the notes line that states the recovery. It selects that line. */
  readonly notes: string;
  /** Who owns the move of the recovery to a shipped surface, or the control that replaces it. */
  readonly owner: string;
  /** Why no shipped surface carries the recovery. */
  readonly reason: string;
}

/**
 * The recoveries that a shipped surface carries. Add a row with the notes line that states the recovery.
 * A row can also name a remedy line with no `Recovery:` marker, such as the rule for the `test:files` script.
 */
const CARRIED: readonly CarriedRecovery[] = [
  {
    id: 'completion-skipped-check',
    notes: 'Recovery: add the missing scripts to `package.json`',
    carrier: {
      kind: 'produced',
      test: 'tests/unit/tasks/tools.test.ts',
      testCase: 'HandleTaskComplete_LatestRunSkippedACheck_NamesTheCheckAndTheMissingScript',
      phrases: ['Add the missing scripts, or do not set the skip flags.'],
    },
  },
  {
    id: 'completion-rerun',
    notes: 'Recovery: run `exarchos_orchestrate check_static_analysis`',
    carrier: {
      kind: 'produced',
      test: 'tests/unit/tasks/tools.test.ts',
      testCase: 'HandleTaskComplete_NoRunnerVerdict_NamesTheRerunOfTheStep',
      phrases: ['then call task_complete again', 'settle the claim under a new batch id'],
    },
  },
  {
    id: 'probe-unread-exit-code',
    notes: 'Recovery: set a `test` command in `.exarchos.yml`',
    carrier: {
      kind: 'produced',
      test: 'tests/unit/verbs/gates/test-adequacy.integration.test.ts',
      testCase: 'ScopedTestRunner_WrapperRefusalThroughNpm_PassesExit2ThroughAsNoVerdict',
      phrases: ['the command exited 2', 'only exit 1 reads as a red run'],
    },
  },
  {
    id: 'probe-baseline-red',
    notes: 'Recovery: make the scoped tests pass on the task source',
    carrier: {
      kind: 'shipped-text',
      path: 'rendered/skills/claude/delegate/references/testing-patterns.md',
      phrases: ['make the scoped tests pass on the task source', 'then run `check_test_adequacy` again'],
    },
  },
  {
    id: 'boundary-local-depcruise',
    notes: 'Recovery: when the report says that no local `depcruise` exists',
    carrier: {
      kind: 'produced',
      test: 'tests/unit/verbs/gates/static-analysis.test.ts',
      testCase: 'BoundaryLint_NoLocalBin_MissingToolWithoutARun',
      phrases: ['npm install --save-dev dependency-cruiser', 'does not fetch it from the registry'],
    },
  },
  {
    id: 'boundary-no-source-root',
    notes: 'Recovery: when the report says that no `ownership.firstParty` source root exists',
    carrier: {
      kind: 'produced',
      test: 'tests/unit/verbs/gates/static-analysis.test.ts',
      testCase: 'BoundaryLint_NoFirstPartyRootExists_DegradedSkipWithoutARun',
      phrases: ['no ownership.firstParty source root exists'],
    },
  },
  {
    id: 'boundary-project-config',
    notes: 'Recovery: correct `.exarchos.yml` or the cause of the read error',
    carrier: {
      kind: 'produced',
      test: 'tests/unit/verbs/gates/static-analysis.test.ts',
      testCase: 'BoundaryLint_ProjectConfigThatCannotBeRead_FailsWithTheReadError',
      phrases: ['does not load or cannot be read', 'Correct the file or the cause of the read error'],
    },
  },
  {
    id: 'advisory-skip-cause',
    notes: 'Recovery: when the result line says `degraded`, read the cause of each advisory skip',
    carrier: {
      kind: 'produced',
      test: 'tests/unit/verbs/gates/static-analysis.test.ts',
      testCase: 'StaticAnalysis_TaintEngineDidNotStart_PassesWithAVisibleDegradedSkip',
      phrases: ['semgrep gave no verdict: the runner reported ENOENT', 'degraded: 1 advisory check gave no verdict'],
    },
  },
  {
    id: 'taint-fail-rerun',
    notes: 'Recovery: when the taint check fails, re-run the command that the report names without `--quiet`',
    carrier: {
      kind: 'produced',
      test: 'tests/unit/verbs/gates/static-analysis.test.ts',
      testCase: 'RawIoTaint_FatalExitWithNoText_FailsWithTheExitStatus',
      phrases: ['Re-run `semgrep --error --config', 'without --quiet to read its message'],
    },
  },
  {
    id: 'probe-scoped-test-script',
    notes: 'The script must run only the files that it gets.',
    carrier: {
      kind: 'shipped-text',
      path: 'rendered/skills/claude/delegate/references/testing-patterns.md',
      phrases: [
        'When `package.json` has a `test:files` script, the probe runs',
        'The script must run only the files that it gets.',
      ],
    },
  },
];

/**
 * The recoveries that only the release notes carry. This list is a deliberate subset of the recoveries,
 * because a row joins it only when no shipped surface can carry the recovery.
 */
const REGISTERED: readonly RegisteredRecovery[] = [
  {
    id: 'one-build-per-store',
    notes: 'Recovery: after you change the binary, restart every session',
    owner: 'Reed, as the operator of each store',
    reason:
      'a human control: no row names the build that wrote it, so no reader can refuse a row of an earlier build. ' +
      'A stamp with the build commit is a follow-up',
  },
  {
    id: 'probe-test-support-path',
    notes: 'Recovery: when the report says that the task changes no source file',
    owner: '#1540, which makes the test-support table of the probe configurable',
    reason:
      'no shipped text names the directory segments of the table. The report says only that the probe keeps ' +
      'test-support files, and it names no file that the probe did not revert',
  },
  {
    id: 'boundary-narrowed-scope',
    notes: 'Recovery: when first-party sources are outside the roots of the globs',
    owner: 'Reed, as the owner of the open question boundary-scope of the semantic-plane packet',
    reason:
      'the check scans only the roots of the globs, so no report can name a source directory outside them. ' +
      'Whether a PASS names the roots that it scanned is an open design question',
  },
];

/** The `[Unreleased]` section of the notes, or undefined when the notes have none. */
function unreleasedSection(notes: string): string | undefined {
  const lines = notes.split('\n');
  const start = lines.indexOf(UNRELEASED_HEADING);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && RELEASE_HEADING.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** The `Recovery:` bullets of a section. */
function recoveryBullets(section: string): readonly string[] {
  return section.split('\n').filter((line) => RECOVERY_BULLET.test(line));
}

/** The start of the next case or of its description. The text of one case ends there. */
const NEXT_CASE = /\n\s*(?:\/\*\*|it\(|test\()/;

/** The text of one test case, from its name to the next case of the file or its description. */
function caseText(testFile: string, testCase: string): string | undefined {
  const start = [`it('${testCase}'`, `it("${testCase}"`, `it(\`${testCase}\``]
    .map((opening) => testFile.indexOf(opening))
    .find((index) => index >= 0);
  if (start === undefined) return undefined;
  const next = testFile.slice(start + 1).search(NEXT_CASE);
  return next < 0 ? testFile.slice(start) : testFile.slice(start, start + 1 + next);
}

/** A matcher call of an assertion. The first group is `.not` when the assertion is negative. */
const MATCHER_CALL = /(\.not)?\.(?:toContain|toBe|toEqual|toStrictEqual|toMatch|toMatchObject)\(/g;

/**
 * The argument text of the call whose open parenthesis is at `open`, up to the parenthesis that closes it.
 * A parenthesis inside a string literal does not count.
 */
function callArgument(text: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

/** The arguments of the positive matcher calls of a case. A matcher after `.not` is a negative assertion and does not count. */
function positiveAssertionArguments(text: string): readonly string[] {
  return [...text.matchAll(MATCHER_CALL)]
    .filter((match) => match[1] === undefined)
    .map((match) => callArgument(text, match.index + match[0].length - 1));
}

/** The inputs that the judge reads, so the live tree and a seeded defect go through the same judge. */
interface CarrierWorld {
  readonly notes: string;
  /** The text of a repo-relative file, or undefined when the file does not exist. */
  readonly read: (path: string) => string | undefined;
  /** The `files` entries of `package.json`: the paths that the package ships. */
  readonly shipped: readonly string[];
}

/** How one carrier fails to carry its recovery. */
function carrierProblems(id: string, carrier: Carrier, world: CarrierWorld): readonly string[] {
  if (carrier.kind === 'produced') {
    const testFile = world.read(carrier.test);
    if (testFile === undefined) return [`${id}: the test file ${carrier.test} does not exist`];
    const text = caseText(testFile, carrier.testCase);
    if (text === undefined) return [`${id}: ${carrier.test} has no case ${carrier.testCase}`];
    const asserted = positiveAssertionArguments(text);
    return carrier.phrases
      .filter((phrase) => !asserted.some((argument) => argument.includes(phrase)))
      .map((phrase) => `${id}: the case ${carrier.testCase} does not assert "${phrase}"`);
  }
  if (!world.shipped.some((root) => carrier.path === root || carrier.path.startsWith(`${root}/`))) {
    return [`${id}: no package ships ${carrier.path}`];
  }
  const shippedText = world.read(carrier.path);
  if (shippedText === undefined) return [`${id}: the shipped file ${carrier.path} does not exist`];
  return carrier.phrases
    .filter((phrase) => !shippedText.includes(phrase))
    .map((phrase) => `${id}: ${carrier.path} does not hold "${phrase}"`);
}

/**
 * How the rows disagree with the notes and the carriers. Each `Recovery:` bullet of `[Unreleased]` has exactly one row.
 * Each row names a line of `[Unreleased]`, and each row id is unique.
 * A carried row reaches its phrases, and a registered row names an owner and a reason.
 */
function disagreements(
  world: CarrierWorld,
  carried: readonly CarriedRecovery[],
  registered: readonly RegisteredRecovery[],
): readonly string[] {
  const section = unreleasedSection(world.notes);
  if (section === undefined) return [`the notes have no ${UNRELEASED_HEADING} section`];
  const rows = [...carried, ...registered];
  const problems: string[] = [];
  for (const bullet of recoveryBullets(section)) {
    const owners = rows.filter((row) => bullet.includes(row.notes));
    if (owners.length !== 1) {
      problems.push(`${owners.length} rows name the recovery "${bullet.trim()}", and exactly one must`);
    }
  }
  for (const row of rows) {
    if (!section.includes(row.notes)) problems.push(`${row.id}: ${UNRELEASED_HEADING} does not state "${row.notes}"`);
  }
  const ids = rows.map((row) => row.id);
  problems.push(...ids.filter((id, index) => ids.indexOf(id) !== index).map((id) => `${id}: the id is not unique`));
  for (const row of carried) problems.push(...carrierProblems(row.id, row.carrier, world));
  for (const row of registered) {
    if (row.owner.trim().length === 0) problems.push(`${row.id}: the register entry names no owner`);
    if (row.reason.trim().length === 0) problems.push(`${row.id}: the register entry names no reason`);
  }
  return problems;
}

/** The text of a repo-relative file of the live tree, or undefined when it does not exist. */
function readLive(path: string): string | undefined {
  try {
    return readFileSync(join(REPO_ROOT, path), 'utf8');
  } catch {
    return undefined;
  }
}

/** The live notes and the live `files` list of `package.json`. */
function liveWorld(): CarrierWorld {
  const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const files =
    typeof manifest === 'object' && manifest !== null && 'files' in manifest && Array.isArray(manifest.files)
      ? manifest.files.filter((entry): entry is string => typeof entry === 'string')
      : [];
  return { notes: readFileSync(join(REPO_ROOT, NOTES_PATH), 'utf8'), read: readLive, shipped: files };
}

/** The live world with the notes replaced, for the seeded defects. */
function withNotes(world: CarrierWorld, notes: string): CarrierWorld {
  return { ...world, notes };
}

/** A recovery bullet that no row names, inserted at the top of the `[Unreleased]` section. */
function seedUnownedRecovery(notes: string): string {
  return notes.replace(
    `${UNRELEASED_HEADING}\n`,
    `${UNRELEASED_HEADING}\n\n- **Seeded.**\n  - Recovery: a seeded step that no row names.\n`,
  );
}

describe('OperatorRecoveryCarriers — each recovery of the notes reaches a shipped surface', () => {
  /** The table and the marked bullets are not empty, so a matcher that matches nothing cannot pass. */
  it('OperatorRecoveryCarriers_TableAndNotes_AreNotEmpty', () => {
    const world = liveWorld();
    expect(CARRIED.length + REGISTERED.length).toBeGreaterThan(0);
    const section = unreleasedSection(world.notes);
    expect(section, `${NOTES_PATH} has no ${UNRELEASED_HEADING} section`).toBeDefined();
    expect(recoveryBullets(section ?? '').length).toBeGreaterThan(0);
    expect(world.shipped.length, 'package.json lists no shipped files').toBeGreaterThan(0);
  });

  /** Each recovery bullet of the live notes has one row, and each row reaches its carrier or names its owner. */
  it('OperatorRecoveryCarriers_EveryRecoveryBullet_HasOneRowAndACarrier', () => {
    expect(disagreements(liveWorld(), CARRIED, REGISTERED)).toEqual([]);
  });

  /** An empty table names each recovery bullet of the live notes, so it cannot pass. */
  it('OperatorRecoveryCarriers_EmptyTable_NamesEveryRecoveryBullet', () => {
    const world = liveWorld();
    const bullets = recoveryBullets(unreleasedSection(world.notes) ?? '');
    expect(bullets.length).toBeGreaterThan(0);
    expect(disagreements(world, [], [])).toEqual(
      bullets.map((bullet) => `0 rows name the recovery "${bullet.trim()}", and exactly one must`),
    );
  });

  /**
   * The test seeds a recovery bullet that no row names, and a second one in a released section.
   * The first is named. The second is not a subject, because only the `[Unreleased]` notes are.
   */
  it('OperatorRecoveryCarriers_SeededBulletWithNoRow_IsNamed', () => {
    const world = liveWorld();
    const seeded = seedUnownedRecovery(world.notes);
    expect(seeded).not.toBe(world.notes);
    expect(disagreements(withNotes(world, seeded), CARRIED, REGISTERED)).toEqual([
      '0 rows name the recovery "- Recovery: a seeded step that no row names.", and exactly one must',
    ]);

    const released = `${world.notes}\n## [0.0.1]\n\n- **Old.**\n  - Recovery: an old step that no row names.\n`;
    expect(disagreements(withNotes(world, released), CARRIED, REGISTERED)).toEqual([]);

    const unheaded = withNotes(world, world.notes.replace(UNRELEASED_HEADING, '## Next'));
    expect(disagreements(unheaded, CARRIED, REGISTERED)).toEqual([`the notes have no ${UNRELEASED_HEADING} section`]);
  });

  /** A row whose notes line is gone, a duplicate id, and two rows that name one bullet are each named. */
  it('OperatorRecoveryCarriers_SeededRowDefects_AreNamed', () => {
    const world = liveWorld();
    const [first] = CARRIED;
    expect(first).toBeDefined();
    if (first === undefined) return;
    const stale: CarriedRecovery = { ...first, id: 'stale', notes: 'Recovery: a step that the notes do not state' };
    expect(disagreements(world, [...CARRIED, stale], REGISTERED)).toEqual([
      `stale: ${UNRELEASED_HEADING} does not state "Recovery: a step that the notes do not state"`,
    ]);

    const twin: CarriedRecovery = { ...first };
    const bullets = recoveryBullets(unreleasedSection(world.notes) ?? '');
    const bullet = bullets.find((line) => line.includes(first.notes)) ?? '';
    expect(disagreements(world, [...CARRIED, twin], REGISTERED)).toEqual([
      `2 rows name the recovery "${bullet.trim()}", and exactly one must`,
      `${first.id}: the id is not unique`,
    ]);
  });

  /**
   * Each carrier kind gets seeded defects. A produced carrier gets a case that does not assert the phrase and a case that
   * does not exist. A shipped-text carrier gets a file without the phrase and a file that no package ships.
   * The judge names each defect.
   */
  it('OperatorRecoveryCarriers_SeededCarrierDefects_AreNamed', () => {
    const world = liveWorld();
    const [first] = CARRIED;
    expect(first?.carrier.kind).toBe('produced');
    if (first === undefined || first.carrier.kind !== 'produced') return;
    const producedCarrier = first.carrier;
    const testFile = world.read(producedCarrier.test) ?? '';
    const [phrase] = producedCarrier.phrases;
    const unasserted = testFile.replaceAll(phrase, 'a phrase that the case does not assert');
    expect(unasserted).not.toBe(testFile);
    const unassertedWorld: CarrierWorld = {
      ...world,
      read: (path) => (path === producedCarrier.test ? unasserted : world.read(path)),
    };
    expect(disagreements(unassertedWorld, CARRIED, REGISTERED)).toEqual([
      `${first.id}: the case ${producedCarrier.testCase} does not assert "${phrase}"`,
    ]);

    const renamed: CarriedRecovery = { ...first, carrier: { ...producedCarrier, testCase: 'NoSuchCase' } };
    expect(carrierProblems(renamed.id, renamed.carrier, world)).toEqual([
      `${first.id}: ${producedCarrier.test} has no case NoSuchCase`,
    ]);

    const shipped: Carrier = {
      kind: 'shipped-text',
      path: 'rendered/skills/claude/delegate/SKILL.md',
      phrases: ['check_static_analysis'],
    };
    expect(carrierProblems('seeded', shipped, world)).toEqual([]);
    expect(carrierProblems('seeded', { ...shipped, phrases: ['a phrase that no skill holds'] }, world)).toEqual([
      'seeded: rendered/skills/claude/delegate/SKILL.md does not hold "a phrase that no skill holds"',
    ]);
    expect(carrierProblems('seeded', { ...shipped, path: 'content/delivery/skills/delegate/SKILL.md' }, world)).toEqual([
      'seeded: no package ships content/delivery/skills/delegate/SKILL.md',
    ]);
  });

  /** A register entry with no owner or no reason is named, because the entry replaces a carrier. */
  it('OperatorRecoveryCarriers_SeededRegisterEntryWithNoOwner_IsNamed', () => {
    const world = liveWorld();
    const [entry] = REGISTERED;
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(disagreements(world, CARRIED, [{ ...entry, owner: ' ', reason: '' }, ...REGISTERED.slice(1)])).toEqual([
      `${entry.id}: the register entry names no owner`,
      `${entry.id}: the register entry names no reason`,
    ]);
  });

  /**
   * A produced carrier counts a phrase only in a positive matcher of the named case.
   * The seeded twin asserts the phrase only in `.not.toContain`, so the text holds the phrase and the case does not assert it.
   * The judge names the twin. A phrase in a positive matcher with a parenthesis in a string literal still counts.
   */
  it('OperatorRecoveryCarriers_SeededNegativeAssertionTwin_IsNamed', () => {
    const world = liveWorld();
    const [first] = CARRIED;
    expect(first?.carrier.kind).toBe('produced');
    if (first === undefined || first.carrier.kind !== 'produced') return;
    const producedCarrier = first.carrier;
    const testFile = world.read(producedCarrier.test) ?? '';
    const [phrase] = producedCarrier.phrases;
    const positive = `.toContain('${phrase}')`;
    expect(caseText(testFile, producedCarrier.testCase) ?? '').toContain(positive);
    const negated = testFile.replace(positive, `.not.toContain('${phrase}')`);
    expect(negated).not.toBe(testFile);
    expect(caseText(negated, producedCarrier.testCase) ?? '').toContain(phrase);
    const negatedWorld: CarrierWorld = {
      ...world,
      read: (path) => (path === producedCarrier.test ? negated : world.read(path)),
    };
    expect(disagreements(negatedWorld, CARRIED, REGISTERED)).toEqual([
      `${first.id}: the case ${producedCarrier.testCase} does not assert "${phrase}"`,
    ]);

    expect(positiveAssertionArguments("expect(message).toContain('a (b) c');")).toEqual(["'a (b) c'"]);
    expect(positiveAssertionArguments("expect(message).not.toContain('a (b) c');")).toEqual([]);
  });
});

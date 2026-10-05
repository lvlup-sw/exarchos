/**
 * The authoring tree groups artifacts by capability domain. These tests hold
 * two properties of that grouping. The domain set is a closed, declared list.
 * The validators still read the skill fixtures, which live outside the
 * generated tree.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');
const CONTENT_ROOT = join(REPO_ROOT, 'content');

/**
 * The closed set of capability domains. A new domain widens where a reader
 * must look for an artifact, so it starts here.
 */
const DECLARED_DOMAINS = [
  '_shared',
  'continuity',
  'delivery',
  'design',
  'governance',
  'harness',
  'remediation',
  'review',
  'synthesis',
] as const;

function directoriesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => statSync(join(dir, entry)).isDirectory());
}

/** Every authored skill, as `{ domain, name }`. */
function authoredSkills(): Array<{ domain: string; name: string }> {
  return directoriesIn(CONTENT_ROOT).flatMap((domain) => {
    const skillsDir = join(CONTENT_ROOT, domain, 'skills');
    return directoriesIn(skillsDir)
      .filter((name) => existsSync(join(skillsDir, name, 'SKILL.md')))
      .map((name) => ({ domain, name }));
  });
}

describe('ContentDomains', () => {
  /**
   * Asserts the denominator first. A grouping assertion on an empty tree
   * passes, and a moved root then goes unnoticed.
   */
  it('EverySkill_LivesUnderADeclaredDomain', () => {
    const skills = authoredSkills();

    expect(skills.length).toBeGreaterThan(0);

    const offenders = skills
      .filter((s) => !(DECLARED_DOMAINS as readonly string[]).includes(s.domain))
      .map((s) => `content/${s.domain}/skills/${s.name}`);
    expect(offenders).toEqual([]);
  });

  it('EveryDirectoryUnderContent_IsADeclaredDomain', () => {
    const present = directoriesIn(CONTENT_ROOT);
    expect(present.length).toBeGreaterThan(0);

    const undeclared = present.filter(
      (d) => !(DECLARED_DOMAINS as readonly string[]).includes(d),
    );
    expect(undeclared).toEqual([]);
  });

  /** The renderer emits a flat name, so one name in two domains collides silently in the output tree. */
  it('NoSkillName_IsClaimedByTwoDomains', () => {
    const byName = new Map<string, string[]>();
    for (const { domain, name } of authoredSkills()) {
      byName.set(name, [...(byName.get(name) ?? []), domain]);
    }
    const collisions = [...byName.entries()]
      .filter(([, domains]) => domains.length > 1)
      .map(([name, domains]) => `${name} claimed by ${domains.join(', ')}`);
    expect(collisions).toEqual([]);
  });
});

/** `authoredOfKind` lists each authored artifact of one kind as `{ domain, file }`. */
describe('ContentDomains — commands and rules', () => {
  function authoredOfKind(kind: string): Array<{ domain: string; file: string }> {
    return directoriesIn(CONTENT_ROOT).flatMap((domain) => {
      const kindDir = join(CONTENT_ROOT, domain, kind);
      if (!existsSync(kindDir)) return [];
      return readdirSync(kindDir)
        .filter((f) => f.endsWith('.md'))
        .map((file) => ({ domain, file }));
    });
  }

  it('EveryCommandAndRule_LivesUnderADeclaredDomain', () => {
    const artifacts = [...authoredOfKind('commands'), ...authoredOfKind('rules')];
    expect(artifacts.length).toBeGreaterThan(0);

    const offenders = artifacts
      .filter((a) => !(DECLARED_DOMAINS as readonly string[]).includes(a.domain))
      .map((a) => `content/${a.domain}/…/${a.file}`);
    expect(offenders).toEqual([]);
  });

  /**
   * The emit is flat, so the last writer of a duplicate name wins. The
   * generator throws on a duplicate, and this test keeps the tree out of that
   * state.
   */
  it('NoCommandName_IsClaimedByTwoDomains', () => {
    for (const kind of ['commands', 'rules']) {
      const byName = new Map<string, string[]>();
      for (const { domain, file } of authoredOfKind(kind)) {
        byName.set(file, [...(byName.get(file) ?? []), domain]);
      }
      const collisions = [...byName.entries()]
        .filter(([, domains]) => domains.length > 1)
        .map(([file, domains]) => `${kind}/${file} claimed by ${domains.join(', ')}`);
      expect(collisions).toEqual([]);
    }
  });

  /**
   * `plugin.json` declares one flat directory for each kind. An authored
   * command that is absent from that directory never ships.
   */
  it('EveryAuthoredCommand_ReachesTheFlatShippedTree', () => {
    const authored = authoredOfKind('commands').map((a) => a.file).sort();
    const shipped = readdirSync(join(REPO_ROOT, 'rendered/commands'))
      .filter((f) => f.endsWith('.md'))
      .sort();
    expect(shipped).toEqual(authored);
  });
});

describe('CommandAliases', () => {
  /**
   * An alias copies the `description:` from the frontmatter of its command.
   * The test compares the two values, not only the existence of the files.
   */
  it('AfterMove_StillDeriveFromCommandFrontmatter', () => {
    const aliasRoot = join(REPO_ROOT, 'rendered/command-aliases');
    const runtimes = directoriesIn(aliasRoot);
    expect(runtimes.length).toBeGreaterThan(0);

    const descriptionOf = (body: string): string | undefined =>
      /^description:\s*(.+?)\s*$/m.exec(body)?.[1];

    let compared = 0;
    for (const runtime of runtimes) {
      for (const file of readdirSync(join(aliasRoot, runtime))) {
        if (!file.endsWith('.md')) continue;
        const sourcePath = join(CONTENT_ROOT_COMMANDS_BY_NAME.get(file) ?? '', '');
        if (sourcePath === '') continue;
        const alias = descriptionOf(readFileSync(join(aliasRoot, runtime, file), 'utf8'));
        const source = descriptionOf(readFileSync(sourcePath, 'utf8'));
        expect(alias, `alias ${runtime}/${file} lost its description`).toBeDefined();
        expect(alias).toBe(source);
        compared += 1;
      }
    }
    expect(compared, 'no alias was actually compared').toBeGreaterThan(0);
  });
});

/** Authored command sources keyed by their flat filename. */
const CONTENT_ROOT_COMMANDS_BY_NAME = new Map<string, string>(
  (existsSync(CONTENT_ROOT) ? readdirSync(CONTENT_ROOT) : []).flatMap((domain) => {
    const dir = join(CONTENT_ROOT, domain, 'commands');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => [f, join(dir, f)] as [string, string]);
  }),
);

describe('SkillFixtures', () => {
  const VALIDATOR_DIR = join(REPO_ROOT, 'tools/skill-validators');
  const FIXTURES_DIR = join(REPO_ROOT, 'tests/support/skill-fixtures');

  /**
   * Runs the fixture suite of the validator. A pass proves that the validator
   * resolves the fixtures, not only that they exist on disk.
   */
  it('AfterRelocation_AreStillReadByTheirValidators', async () => {
    expect(existsSync(FIXTURES_DIR)).toBe(true);
    expect(directoriesIn(FIXTURES_DIR).length).toBeGreaterThan(0);

    const script = join(VALIDATOR_DIR, 'validate-frontmatter.test.sh');
    expect(existsSync(script)).toBe(true);

    const output = await execFileAsync('bash', [script], {
      cwd: REPO_ROOT,
    });
    expect(output).toMatch(/Results: (\d+)\/\1 passed, 0 failed/);
  });

  /**
   * A `files` negation is necessary only while a shipped root holds what it
   * excludes. The check keys on shipped roots and not on repository presence,
   * because `tools/audit/test-fixtures/` exists on disk and does not ship.
   */
  it('AfterRelocation_AreNoLongerExcludedByPackaging', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    const files = pkg.files ?? [];
    expect(files).not.toContain('!**/trigger-tests');
    expect(files).not.toContain('tests');

    const shippedFixtureDirs = ['scripts/test-fixtures'].filter(
      (d) => files.some((f) => d.startsWith(`${f}/`) || f === d) && existsSync(join(REPO_ROOT, d)),
    );
    if (shippedFixtureDirs.length > 0) {
      expect(files, `still shipped: ${shippedFixtureDirs.join(', ')}`).toContain(
        '!**/test-fixtures',
      );
    } else {
      expect(files).not.toContain('!**/test-fixtures');
    }
  });
});

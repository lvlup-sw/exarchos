import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The authoring tree is grouped by capability. These tests hold two properties
 * the grouping depends on: that the domain set stays a closed, declared list,
 * and that the live files rescued out of the generated tree are still reachable
 * by the validators that read them.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');
const CONTENT_ROOT = join(REPO_ROOT, 'content');

/**
 * The closed set of capability domains. Adding a domain is a deliberate act:
 * it widens where a reader must look for an artifact, so it changes here first.
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
  it('EverySkill_LivesUnderADeclaredDomain', () => {
    const skills = authoredSkills();

    // Guard the denominator first. A grouping assertion over an empty tree
    // passes for the wrong reason, which is how a moved root goes unnoticed.
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

  it('NoSkillName_IsClaimedByTwoDomains', () => {
    // The renderer emits a flat name, so two domains claiming one name would
    // collide silently in the output tree.
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

describe('ContentDomains — commands and rules', () => {
  /** Every authored artifact of a kind, as `{ domain, file }`. */
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

  it('NoCommandName_IsClaimedByTwoDomains', () => {
    // The emit is flat, so a duplicated name is a last-writer-wins overwrite.
    // The generator throws on this; the assertion keeps the tree from
    // reaching that state in the first place.
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

  it('EveryAuthoredCommand_ReachesTheFlatShippedTree', () => {
    // `plugin.json` declares one flat directory per kind, so an authored
    // command that never lands there is authored into the void.
    const authored = authoredOfKind('commands').map((a) => a.file).sort();
    const shipped = readdirSync(join(REPO_ROOT, 'commands'))
      .filter((f) => f.endsWith('.md'))
      .sort();
    expect(shipped).toEqual(authored);
  });
});

describe('CommandAliases', () => {
  it('AfterMove_StillDeriveFromCommandFrontmatter', () => {
    // Aliases lift the `description:` out of a command's frontmatter. If the
    // move had broken the read path, the generator would have thrown; this
    // pins the actual content relationship rather than the file's existence.
    const aliasRoot = join(REPO_ROOT, 'command-aliases');
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

  it('AfterRelocation_AreStillReadByTheirValidators', () => {
    expect(existsSync(FIXTURES_DIR)).toBe(true);
    expect(directoriesIn(FIXTURES_DIR).length).toBeGreaterThan(0);

    // The fixture suite is the validator's own proof. Running it is what shows
    // the relocated fixtures are still resolved from the validator's new home,
    // rather than merely still existing somewhere on disk.
    const script = join(VALIDATOR_DIR, 'validate-frontmatter.test.sh');
    expect(existsSync(script)).toBe(true);

    const output = execFileSync('bash', [script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(output).toMatch(/Results: (\d+)\/\1 passed, 0 failed/);
  });

  it('AfterRelocation_AreNoLongerExcludedByPackaging', () => {
    // `!**/trigger-tests` guarded exactly one path, and that path left the
    // shipped tree with this move, so the rule now excludes nothing.
    //
    // `!**/test-fixtures` is NOT retired with it: `scripts/` is also published
    // and still carries a `test-fixtures/` of its own, so dropping the
    // negation ships those fixtures. The packing test is what caught that, and
    // this assertion keeps the distinction from being re-collapsed.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    const files = pkg.files ?? [];
    expect(files).not.toContain('!**/trigger-tests');
    expect(files).not.toContain('tests');

    const shippedFixtureDirs = ['scripts/test-fixtures'].filter((d) =>
      existsSync(join(REPO_ROOT, d)),
    );
    if (shippedFixtureDirs.length > 0) {
      expect(files, `still shipped: ${shippedFixtureDirs.join(', ')}`).toContain(
        '!**/test-fixtures',
      );
    }
  });
});

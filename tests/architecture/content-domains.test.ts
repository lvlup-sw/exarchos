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

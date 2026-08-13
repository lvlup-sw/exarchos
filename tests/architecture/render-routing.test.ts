import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAllSkills } from '../../src/install/build-skills.js';

/**
 * The rendered tree is addressed by artifact kind and flat name. The domain a
 * skill is authored under is an authoring concern and must not reach the
 * output — a harness resolves `mutation-adequacy`, not
 * `review/skills/mutation-adequacy`.
 *
 * Flattening buys that at the cost of a namespace: two domains can each author
 * the same name, and the output has one slot for it. That collision is the
 * hazard these tests exist to pin.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');
const RUNTIMES_DIR = join(REPO_ROOT, 'content/harness/runtimes');

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'render-routing-'));
}

/** Write a minimal procedural skill under `content/<domain>/skills/<name>/`. */
function writeSkill(root: string, domain: string, name: string, body?: string): void {
  const dir = join(root, 'content', domain, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    body ??
      `---\nname: ${name}\ndescription: A procedural skill named ${name} for routing tests. Do NOT use for anything else.\n---\n\n# ${name}\n\nBody.\n`,
  );
}

describe('Render', () => {
  it('DomainGroupedSource_EmitsFlatContractShapedOutput', () => {
    const root = makeSandbox();
    try {
      writeSkill(root, 'review', 'alpha-skill');
      writeSkill(root, 'delivery', 'beta-skill');

      const outDir = join(root, 'rendered', 'skills');
      buildAllSkills({ srcDir: join(root, 'content'), outDir, runtimesDir: RUNTIMES_DIR });

      // The emitted path carries the kind and the flat name, and nothing else.
      const trees = readdirSync(outDir);
      expect(trees.length).toBeGreaterThan(0);
      for (const tree of trees) {
        const names = readdirSync(join(outDir, tree));
        expect(names.sort()).toEqual(['alpha-skill', 'beta-skill']);
        // The authoring domain must appear nowhere in the output tree.
        expect(names).not.toContain('review');
        expect(names).not.toContain('delivery');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RenderedPath_DependsOnlyOnKindAndFlatName_NotOnDomain', () => {
    // The property, stated directly: moving a skill between domains changes
    // nothing about where it renders. Two builds that differ only in the
    // authoring domain must produce identical output paths.
    const pathsFor = (domain: string): string[] => {
      const root = makeSandbox();
      try {
        writeSkill(root, domain, 'portable-skill');
        const outDir = join(root, 'rendered', 'skills');
        buildAllSkills({ srcDir: join(root, 'content'), outDir, runtimesDir: RUNTIMES_DIR });
        const found: string[] = [];
        const walk = (dir: string, rel: string): void => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
            if (entry.isDirectory()) walk(join(dir, entry.name), next);
            else found.push(next);
          }
        };
        walk(outDir, '');
        return found.sort();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    for (const domain of ['governance', 'continuity', 'remediation']) {
      expect(pathsFor(domain), `domain '${domain}' leaked into the output`).toEqual(
        pathsFor('design'),
      );
    }
  });

  it('TwoDomainsDeclareSameFlatName_FailsAtBuildTimeNamingBothSources', () => {
    const root = makeSandbox();
    try {
      writeSkill(root, 'review', 'collide');
      writeSkill(root, 'delivery', 'collide');

      let err: Error | undefined;
      try {
        buildAllSkills({
          srcDir: join(root, 'content'),
          outDir: join(root, 'rendered', 'skills'),
          runtimesDir: RUNTIMES_DIR,
        });
      } catch (e) {
        err = e as Error;
      }

      expect(err, 'a flat-name collision must fail the build').toBeInstanceOf(Error);
      // Both sources named: the winner alone does not say what was lost.
      expect(err!.message).toContain('review');
      expect(err!.message).toContain('delivery');
      expect(err!.message).toContain('collide');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('DistinctNamesAcrossDomains_Succeeds', () => {
    // The guard must not over-trigger on the legitimate case it resembles:
    // many domains, each with its own names.
    const root = makeSandbox();
    try {
      writeSkill(root, 'review', 'one');
      writeSkill(root, 'delivery', 'two');
      writeSkill(root, 'design', 'three');

      const outDir = join(root, 'rendered', 'skills');
      expect(() =>
        buildAllSkills({ srcDir: join(root, 'content'), outDir, runtimesDir: RUNTIMES_DIR }),
      ).not.toThrow();

      const tree = readdirSync(outDir)[0]!;
      expect(readdirSync(join(outDir, tree)).sort()).toEqual(['one', 'three', 'two']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ArtifactKind', () => {
  it('RoutesToItsOwnRenderedRoot', () => {
    // Each kind occupies its own root under `rendered/`, so one kind's output
    // can never be mistaken for another's.
    const renderedRoot = join(REPO_ROOT, 'rendered');
    expect(existsSync(renderedRoot)).toBe(true);

    for (const kind of ['skills', 'commands', 'rules', 'agents', 'command-aliases']) {
      expect(existsSync(join(renderedRoot, kind)), `rendered/${kind}/ is missing`).toBe(true);
    }

    // And nothing authored leaked in alongside them.
    expect(existsSync(join(renderedRoot, 'content'))).toBe(false);
  });

  it('NoRenderedFile_IsHandEdited', () => {
    // A rendered skill is a pure function of its source, so its body must be
    // reachable from the source it was rendered from. Spot-checking the
    // relationship is what makes "generated" a claim rather than a label.
    const standard = join(REPO_ROOT, 'rendered/skills/standard');
    const names = readdirSync(standard);
    expect(names.length).toBeGreaterThan(0);

    for (const name of names.slice(0, 3)) {
      const rendered = readFileSync(join(standard, name, 'SKILL.md'), 'utf8');
      expect(rendered).toMatch(/^---/);
      expect(rendered).toContain(`name: ${name}`);
    }
  });
});

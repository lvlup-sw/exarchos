/**
 * Resolution of the artifact directories, and layout classification under them.
 *
 * The expectation table below is hand-written and reads nothing from the resolver. It pins
 * the verdicts for the default directories. A case must not change to match a new
 * implementation: a disagreement is a regression. The classifier in `workflow/rehydrate.ts`
 * is not a declared source, because it imports the resolver.
 *
 * @oracle-sources: ../../../src/config/artifacts.ts, characterization-corpus-captured-pre-dr6
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ARTIFACT_DIRS,
  DEFAULT_LEGACY_DESIGN_DIR,
  DEFAULT_SPEC_DIR,
  normalizeArtifactDir,
  resolveArtifactDirs,
} from '../../../src/config/artifacts.js';
import { classifyArtifactLayout } from '../../../src/workflow/rehydrate.js';
import { resolveConfig } from '../../../src/config/resolve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Artifact maps in the shapes that workflows record, with the expected layout of each. */
const CHARACTERIZATION_CORPUS: ReadonlyArray<{
  readonly name: string;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly expected: 'unified' | 'two-artifact';
}> = [
  { name: 'no artifacts at all (fresh init)', artifacts: {}, expected: 'unified' },
  {
    name: 'explicit spec key, collapsed flow',
    artifacts: { spec: 'docs/specs/2026-08-11-exarchos-repo-structure-cleanup.md' },
    expected: 'unified',
  },
  {
    name: 'plan under docs/specs, no spec key',
    artifacts: { plan: 'docs/specs/2026-07-18-test-mass-consolidation.md' },
    expected: 'unified',
  },
  {
    name: 'legacy design doc only',
    artifacts: { design: 'docs/designs/2026-04-01-old-feature.md' },
    expected: 'two-artifact',
  },
  {
    name: 'legacy design + legacy plan',
    artifacts: {
      design: 'docs/designs/2026-04-01-old-feature.md',
      plan: 'docs/plans/2026-04-01-old-feature.md',
    },
    expected: 'two-artifact',
  },
  {
    name: 'nested/archived legacy design still classifies (prefix, not exact dir)',
    artifacts: { design: 'docs/designs/archive/2025-12-01-ancient.md' },
    expected: 'two-artifact',
  },
  {
    name: 'migrated: legacy design present but a spec key wins',
    artifacts: {
      design: 'docs/designs/2026-04-01-old-feature.md',
      spec: 'docs/specs/2026-08-01-migrated.md',
    },
    expected: 'unified',
  },
  {
    name: 'design recorded under docs/specs (collapsed flow writes design there)',
    artifacts: { design: 'docs/specs/2026-08-01-collapsed.md' },
    expected: 'unified',
  },
  {
    name: 'unrecognised location falls forward to unified',
    artifacts: { plan: 'notes/scratch.md' },
    expected: 'unified',
  },
  {
    name: 'PR url alongside a spec does not disturb classification',
    artifacts: {
      spec: 'docs/specs/2026-08-01-x.md',
      pr: 'https://github.com/lvlup-sw/exarchos/pull/1',
    },
    expected: 'unified',
  },
];

describe('classifyArtifactLayout — characterization of the pre-DR-6 default', () => {
  it.each(CHARACTERIZATION_CORPUS)(
    'ArtifactDir_NoConfiguration_DefaultsToDocsSpecs: $name',
    ({ artifacts, expected }) => {
      expect(classifyArtifactLayout(artifacts)).toBe(expected);
    },
  );

  it('ArtifactDir_NoConfiguration_DefaultsToDocsSpecs: explicit defaults agree with omission', () => {
    for (const { artifacts } of CHARACTERIZATION_CORPUS) {
      expect(classifyArtifactLayout(artifacts, DEFAULT_ARTIFACT_DIRS)).toBe(
        classifyArtifactLayout(artifacts),
      );
    }
  });

  it('ArtifactDir_NoConfiguration_DefaultsToDocsSpecs: an empty `artifacts:` block resolves to the shipped literals', () => {
    expect(resolveArtifactDirs()).toEqual({
      specDir: 'docs/specs/',
      legacyDesignDir: 'docs/designs/',
    });
    expect(resolveArtifactDirs({})).toEqual(resolveArtifactDirs());
  });

  /** The count check prevents a vacuous pass when the spec directory holds few files. */
  it.skipIf(!fs.existsSync(path.join(REPO_ROOT, DEFAULT_SPEC_DIR)))('ArtifactDir_NoConfiguration_DefaultsToDocsSpecs: classifies this repository’s real spec corpus as unified', () => {
    const specsDir = path.join(REPO_ROOT, DEFAULT_SPEC_DIR);
    const specs = fs.readdirSync(specsDir).filter((f) => f.endsWith('.md'));
    expect(specs.length).toBeGreaterThan(10);
    for (const file of specs) {
      expect(classifyArtifactLayout({ plan: path.posix.join(DEFAULT_SPEC_DIR, file) })).toBe(
        'unified',
      );
    }
  });
});

describe('classifyArtifactLayout — configured prefixes', () => {
  it('ArtifactDir_ConfiguredPrefix_ClassifiesUnifiedSpecCorrectly', () => {
    const dirs = resolveArtifactDirs({ 'spec-dir': 'design-records' });
    expect(dirs.specDir).toBe('design-records/');
    expect(classifyArtifactLayout({ plan: 'design-records/2026-08-11-feature.md' }, dirs)).toBe(
      'unified',
    );
  });

  /**
   * With the spec directory moved, a path under the default spec directory is not a unified signal.
   * Thus the legacy design doc decides the layout.
   */
  it('ArtifactDir_ConfiguredPrefix_ClassifiesUnifiedSpecCorrectly: the OLD default no longer wins on its own', () => {
    const dirs = resolveArtifactDirs({ 'spec-dir': 'design-records' });
    expect(classifyArtifactLayout({ design: 'docs/designs/legacy.md', plan: 'docs/specs/x.md' }, dirs)).toBe(
      'two-artifact',
    );
  });

  it('ArtifactDir_LegacyDesignPrefix_StillClassifiesAsTwoArtifact', () => {
    const dirs = resolveArtifactDirs({ 'spec-dir': 'design-records' });
    expect(classifyArtifactLayout({ design: 'docs/designs/2026-04-01-old.md' }, dirs)).toBe(
      'two-artifact',
    );
    expect(dirs.legacyDesignDir).toBe(DEFAULT_LEGACY_DESIGN_DIR);
  });

  it('ArtifactDir_LegacyDesignPrefix_StillClassifiesAsTwoArtifact: a renamed legacy tree is honoured', () => {
    const dirs = resolveArtifactDirs({ 'legacy-design-dir': 'archive/designs' });
    expect(classifyArtifactLayout({ design: 'archive/designs/old.md' }, dirs)).toBe('two-artifact');
  });

  it('is stable under any configured prefix: the explicit `spec` key always wins', () => {
    const prefixes = ['docs/specs', 'specs', 'a/b/c/d', 'design-records', 'docs/specs/nested'];
    for (const prefix of prefixes) {
      const dirs = resolveArtifactDirs({ 'spec-dir': prefix });
      expect(classifyArtifactLayout({ spec: 'anywhere/at/all.md' }, dirs)).toBe('unified');
      expect(classifyArtifactLayout({}, dirs)).toBe('unified');
    }
  });

  it('is stable under any configured prefix: a path under the configured dir always classifies unified', () => {
    const prefixes = ['docs/specs', 'specs', 'a/b/c/d', 'design-records', 'Docs_Specs'];
    for (const prefix of prefixes) {
      const dirs = resolveArtifactDirs({ 'spec-dir': prefix });
      expect(classifyArtifactLayout({ plan: `${prefix}/2026-01-01-x.md` }, dirs)).toBe('unified');
    }
  });
});

describe('normalizeArtifactDir', () => {
  it('appends exactly one trailing slash', () => {
    expect(normalizeArtifactDir('docs/specs')).toBe('docs/specs/');
    expect(normalizeArtifactDir('docs/specs/')).toBe('docs/specs/');
    expect(normalizeArtifactDir('docs/specs///')).toBe('docs/specs/');
  });

  it('collapses duplicate separators and strips a leading ./', () => {
    expect(normalizeArtifactDir('docs//specs')).toBe('docs/specs/');
    expect(normalizeArtifactDir('./docs/specs')).toBe('docs/specs/');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeArtifactDir('  docs/specs  ')).toBe('docs/specs/');
  });

  it('returns empty for blank or separator-only input rather than a match-everything prefix', () => {
    for (const blank of ['', '   ', '/', '///', '.', './']) {
      expect(normalizeArtifactDir(blank)).toBe('');
    }
  });

  /**
   * The first `unified` is the default fallthrough, not a prefix match. The second case adds a
   * legacy design doc, which decides only when the prefix does not match.
   */
  it('the trailing slash prevents a sibling-directory false match', () => {
    const dirs = resolveArtifactDirs({ 'spec-dir': 'docs/spec' });
    expect(classifyArtifactLayout({ plan: 'docs/specifications/x.md' }, dirs)).toBe('unified');
    expect(
      classifyArtifactLayout(
        { design: 'docs/designs/old.md', plan: 'docs/specifications/x.md' },
        dirs,
      ),
    ).toBe('two-artifact');
  });
});

describe('resolveArtifactDirs — a blank prefix fails back, never open', () => {
  /**
   * An empty prefix matches every path, and then two-artifact work classifies as `unified`.
   * The fallback to the default prevents that.
   */
  it.each(['', '   ', '/', '.'])('rejects %o in favour of the default', (blank) => {
    const dirs = resolveArtifactDirs({ 'spec-dir': blank, 'legacy-design-dir': blank });
    expect(dirs.specDir).toBe(DEFAULT_SPEC_DIR);
    expect(dirs.legacyDesignDir).toBe(DEFAULT_LEGACY_DESIGN_DIR);
    expect(classifyArtifactLayout({ design: 'docs/designs/old.md' }, dirs)).toBe('two-artifact');
  });

  it('returns a frozen record', () => {
    const dirs = resolveArtifactDirs({ 'spec-dir': 'x' });
    expect(Object.isFrozen(dirs)).toBe(true);
  });
});

describe('resolveConfig — artifacts block', () => {
  it('defaults to the shipped literals when no `artifacts:` block is present', () => {
    expect(resolveConfig({}).artifacts).toEqual({
      specDir: DEFAULT_SPEC_DIR,
      legacyDesignDir: DEFAULT_LEGACY_DESIGN_DIR,
    });
  });

  it('normalizes a configured block through to the resolved config', () => {
    const resolved = resolveConfig({
      artifacts: { 'spec-dir': 'design-records', 'legacy-design-dir': 'archive\\designs' },
    });
    expect(resolved.artifacts).toEqual({
      specDir: 'design-records/',
      legacyDesignDir: 'archive/designs/',
    });
  });
});

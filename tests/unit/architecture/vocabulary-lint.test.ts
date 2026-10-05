import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanFile,
  scanPaths,
  scanRepoDefaults,
  scanText,
  scanRegistryActions,
  datedRecordTrees,
  type RegistryLoader,
  type RegistryToolLike,
} from '../../../src/architecture/vocabulary-lint.js';
import { ARTIFACT_DIRS } from '../../../tools/conformance/src/bindings/index.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, '.exarchos/invariants.md');

/** Registers the catalog as a dev source, so the tests do not depend on the `.exarchos.yml` of the repo. */
const ENABLED_CONFIG = {
  invariants: { catalogs: [{ path: INVARIANTS_DOC, tier: 'dev' as const }] },
};

describe('vocabulary-lint', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-lint-'));
  });

  afterAll(() => {
    rmrf(tmpDir);
  });

  it('VocabularyLint_UnknownInvariantReference_Fails', () => {
    const fixture = path.join(tmpDir, 'unknown-ref.md');
    fs.writeFileSync(
      fixture,
      'Some prose referencing INV-99 which does not exist.\n',
    );
    const findings = scanFile(fixture, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings.length).toBeGreaterThan(0);
    const inv99 = findings.find((f) => f.token === 'INV-99');
    expect(inv99).toBeDefined();
    expect(inv99!.kind).toBe('unknown-invariant');
  });

  it('VocabularyLint_KnownInvariantReference_Passes', () => {
    const fixture = path.join(tmpDir, 'known-ref.md');
    fs.writeFileSync(
      fixture,
      'Some prose referencing INV-1 which is documented.\n',
    );
    const findings = scanFile(fixture, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  /**
   * The catalog declares no `DIM-<n>` id, and the scanner still matches that shape.
   * As a result, a `DIM-<n>` reference is an unknown-invariant finding.
   */
  it('VocabularyLint_MultipleFileScan_AggregatesFindings', () => {
    const subDir = path.join(tmpDir, 'multi');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'a.md'), 'Prose with INV-1 and INV-77.\n');
    fs.writeFileSync(path.join(subDir, 'b.md'), 'Prose with INV-2 and DIM-42.\n');
    const findings = scanPaths([subDir], {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings.length).toBe(2);
    const tokens = findings.map((f) => f.token).sort();
    expect(tokens).toEqual(['DIM-42', 'INV-77']);
    for (const f of findings) {
      expect(typeof f.file).toBe('string');
      expect(typeof f.line).toBe('number');
      expect(f.line).toBeGreaterThan(0);
    }
  });
});

/**
 * `scanText` is the in-memory token scan that the file-path scanners delegate to.
 * These tests call it with a locator that is not a file path, so they show that it does no file I/O.
 * It gives one finding per distinct token per line, skips known ids and counts lines from 1.
 */
describe('scanText (DR-5 core)', () => {
  it('scanText_UnknownToken_IsFlaggedWithLocatorAndLine', () => {
    const findings = scanText(
      'first line is clean\nsecond line cites INV-99 which is unknown',
      'some-locator',
      new Set<string>(),
    );
    expect(findings).toEqual([
      { file: 'some-locator', line: 2, token: 'INV-99', kind: 'unknown-invariant' },
    ]);
  });

  it('scanText_KnownToken_IsNotFlagged', () => {
    const findings = scanText(
      'cites INV-1 which is known',
      'some-locator',
      new Set(['INV-1']),
    );
    expect(findings).toEqual([]);
  });

  it('scanText_RepeatedTokenOnSameLine_DedupsToOneFinding', () => {
    const findings = scanText(
      'INV-99 appears twice on one line: INV-99',
      'some-locator',
      new Set<string>(),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.token).toBe('INV-99');
  });

  /**
   * The test sorts the lines into a variable before the assertion.
   * The expected side is a literal and not a second read of the corpus, so no `@oracle-sources` declaration applies.
   */
  it('scanText_SameTokenDifferentLines_IsOneFindingPerLine', () => {
    const findings = scanText(
      'INV-99 on line one\nINV-99 on line two',
      'some-locator',
      new Set<string>(),
    );
    expect(findings.length).toBe(2);
    const lines = findings.map((f) => f.line).sort();
    expect(lines).toEqual([1, 2]);
  });
});

describe('scanRegistryActions (DR-4/DR-5)', () => {
  const fixtureLoader = (tools: readonly RegistryToolLike[]): RegistryLoader =>
    () => tools;

  /** The locator of a finding is stable: `registry.ts`, the tool and the action. */
  it('scanRegistryActions_BogusInvToken_IsFlagged', async () => {
    const loader = fixtureLoader([
      {
        name: 'exarchos_orchestrate',
        actions: [
          {
            name: 'do_thing',
            description: 'Does a thing per INV-99 which does not exist.',
          },
        ],
      },
    ]);
    const findings = await scanRegistryActions(loader, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.token).toBe('INV-99');
    expect(findings[0]!.kind).toBe('unknown-invariant');
    expect(findings[0]!.file).toBe('registry.ts#exarchos_orchestrate.do_thing');
  });

  it('scanRegistryActions_ValidInvToken_IsNotFlagged', async () => {
    const loader = fixtureLoader([
      {
        name: 'exarchos_workflow',
        actions: [
          {
            name: 'get',
            description: 'Reads workflow state per INV-1 (event-sourcing integrity).',
          },
        ],
      },
    ]);
    const findings = await scanRegistryActions(loader, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  /**
   * The scan covers the `name` field and the `description` field.
   * The fixture name sets the token between word boundaries so that `TOKEN_RE` matches.
   * A real snake_case action id does not hold a hyphenated token.
   */
  it('scanRegistryActions_ScansActionNameToo_NotJustDescription', async () => {
    const loader = fixtureLoader([
      {
        name: 'exarchos_view',
        actions: [
          { name: 'action-citing-INV-99-in-its-name', description: 'harmless prose' },
        ],
      },
    ]);
    const findings = await scanRegistryActions(loader, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    const tokens = findings.map((f) => f.token);
    expect(tokens).toContain('INV-99');
  });

  it('scanRegistryActions_MultipleCompositeTools_AreAllEnumerated', async () => {
    const loader = fixtureLoader([
      {
        name: 'exarchos_workflow',
        actions: [{ name: 'a', description: 'cites INV-101' }],
      },
      {
        name: 'exarchos_event',
        actions: [{ name: 'b', description: 'cites INV-102' }],
      },
      {
        name: 'exarchos_orchestrate',
        actions: [{ name: 'c', description: 'cites INV-103' }],
      },
      {
        name: 'exarchos_view',
        actions: [{ name: 'd', description: 'cites INV-104' }],
      },
    ]);
    const findings = await scanRegistryActions(loader, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    const tokens = findings.map((f) => f.token).sort();
    expect(tokens).toEqual(['INV-101', 'INV-102', 'INV-103', 'INV-104']);
  });

  it('scanRegistryActions_ThrowingLoader_FailsClosed', async () => {
    const throwingLoader: RegistryLoader = () => {
      throw new Error('registry import boom');
    };
    await expect(
      scanRegistryActions(throwingLoader, {
        invariantsDoc: INVARIANTS_DOC,
        config: ENABLED_CONFIG,
      }),
    ).rejects.toThrow('registry import boom');
  });

  it('scanRegistryActions_RejectingAsyncLoader_FailsClosed', async () => {
    const rejectingLoader: RegistryLoader = () =>
      Promise.reject(new Error('async registry load boom'));
    await expect(
      scanRegistryActions(rejectingLoader, {
        invariantsDoc: INVARIANTS_DOC,
        config: ENABLED_CONFIG,
      }),
    ).rejects.toThrow('async registry load boom');
  });

  it('scanRegistryActions_MalformedRegistryNotAnArray_FailsClosed', async () => {
    const malformedLoader = (() =>
      ({ notAnArray: true }) as unknown) as RegistryLoader;
    await expect(
      scanRegistryActions(malformedLoader, {
        invariantsDoc: INVARIANTS_DOC,
        config: ENABLED_CONFIG,
      }),
    ).rejects.toThrow();
  });

  it('scanRegistryActions_MalformedToolMissingActions_FailsClosed', async () => {
    const malformedLoader = (() =>
      [{ name: 'exarchos_workflow' }] as unknown) as RegistryLoader;
    await expect(
      scanRegistryActions(malformedLoader, {
        invariantsDoc: INVARIANTS_DOC,
        config: ENABLED_CONFIG,
      }),
    ).rejects.toThrow();
  });

  it('scanRegistryActions_MalformedActionMissingDescription_FailsClosed', async () => {
    const malformedLoader = (() =>
      [
        { name: 'exarchos_workflow', actions: [{ name: 'only_a_name' }] },
      ] as unknown) as RegistryLoader;
    await expect(
      scanRegistryActions(malformedLoader, {
        invariantsDoc: INVARIANTS_DOC,
        config: ENABLED_CONFIG,
      }),
    ).rejects.toThrow();
  });

  /**
   * Runs the default lazy loader against the live registry, with no injected fixture.
   * The action text of the live registry must cite no unknown token.
   */
  it('scanRegistryActions_DefaultLoader_ScansRealRegistryCleanly', async () => {
    const findings = await scanRegistryActions(undefined, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  /**
   * The loader must be a dynamic import inside a function body.
   * A static import of the registry loads that module when this module loads.
   * That breaks the lazy load and the fail-closed contract that the tests exercise.
   */
  it('scanRegistryActions_SourceHasNoStaticRegistryImportEdge', () => {
    const sourcePath = path.join(__dirname, '../../../src/architecture/vocabulary-lint.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/^\s*import\b[^;]*from\s+['"]\.\.\/registry\.js['"]/m);
    expect(source).toMatch(/import\(\s*['"]\.\.\/registry\.js['"]\s*\)/);
  });
});

/**
 * Pins the boundary between the scan roots and the dated-record trees. The tests scan the four roots in `SCAN_ROOTS`.
 * The two sets are disjoint, so an archive move of a dated record cannot change the scan.
 */
describe('scanRepoDefaults / DATED_RECORD_TREES archival-invariance (DR-18, task 030)', () => {
  const SCAN_ROOTS = [
    'docs/architecture',
    'docs/guides',
    'content',
    'commands',
  ] as const;

  /**
   * The controlled tree holds a stale token in each scan root and in each dated-record tree, archive included.
   * Each token is unique, so a leak names its tree. Only the four tokens of the scan roots can show.
   * The dated-record set holds `docs/designs/` and `docs/plans/` and none of the scan roots.
   * On the real repo, `scanRepoDefaults` gives no finding from those two trees.
   */
  it('VocabularyLint_ScanRoots_UnchangedByArchival', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-archival-'));
    const seed = (rel: string, token: string) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `Prose referencing ${token} which does not exist.\n`);
    };
    seed('docs/architecture/a.md', 'INV-9001');
    seed('docs/guides/g.md', 'INV-9002');
    seed('content/s/SKILL.md', 'INV-9003');
    seed('commands/c.md', 'INV-9004');
    seed('docs/designs/archive/2026-05-30-x.md', 'INV-9100');
    seed('docs/designs/2026-05-30-y.md', 'INV-9101');
    seed('docs/plans/archive/2026-05-30-x.md', 'INV-9102');
    seed('docs/plans/2026-05-30-y.md', 'INV-9103');

    try {
      const findings = scanPaths(
        SCAN_ROOTS.map((r) => path.join(root, r)),
        { invariantsDoc: INVARIANTS_DOC, config: ENABLED_CONFIG },
      );
      const tokens = findings.map((f) => f.token).sort();
      expect(tokens).toEqual(['INV-9001', 'INV-9002', 'INV-9003', 'INV-9004']);
    } finally {
      rmrf(root);
    }

    const dated = datedRecordTrees(ARTIFACT_DIRS);
    expect(dated).toContain('docs/designs/');
    expect(dated).toContain('docs/plans/');
    for (const scanRoot of SCAN_ROOTS) {
      const scanned = `${scanRoot}/`;
      expect(
        dated,
        `${scanned} must not be a dated-record tree — the scan allowlist and the dated-record set are disjoint`,
      ).not.toContain(scanned);
    }

    const repoFindings = scanRepoDefaults({
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    const fromDatedTrees = repoFindings.filter(
      (f) => f.file.includes('/docs/designs/') || f.file.includes('/docs/plans/'),
    );
    expect(fromDatedTrees).toEqual([]);
  });
});

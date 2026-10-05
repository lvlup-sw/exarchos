/**
 * Tests for the `invariants_add` handler. The handler validates one entry through
 * `InvariantEntryV3Schema`. A dry run, the default, returns the rendered YAML entry and a file diff,
 * and writes nothing. A ZodError maps to a carrier with `expectedShape` and `suggestedFix`.
 * With `dryRun: false`, the handler appends the entry to the catalog with the next free id.
 */
import { describe, it, expect } from 'vitest';

import * as os from 'node:os';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleAdd, appendEntryToCatalog } from '../../../../src/verbs/invariants/add.js';
import type { ScaffoldDeps } from '../../../../src/verbs/invariants/scaffold.js';
import { allocateNextId } from '../../../../src/verbs/invariants/add.js';
import { loadInvariants } from '../../../../src/architecture/invariants-loader.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

interface FakeFs {
  files: Map<string, string>;
  deps: ScaffoldDeps;
  writes: Array<{ path: string; contents: string }>;
}

function makeFakeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(seed));
  const writes: Array<{ path: string; contents: string }> = [];
  const deps: ScaffoldDeps = {
    exists: (p) => files.has(p),
    read: (p) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    },
    write: (p, contents) => {
      files.set(p, contents);
      writes.push({ path: p, contents });
    },
  };
  return { files, deps, writes };
}

/** A minimal DispatchContext stub. `eventStore.append` records each call, and `add` uses no other field. */
function makeCtx(): { ctx: DispatchContext; appended: Array<{ stream: string; event: unknown }> } {
  const appended: Array<{ stream: string; event: unknown }> = [];
  const ctx = {
    stateDir: '/tmp/state',
    enableTelemetry: false,
    eventStore: {
      append: async (stream: string, event: unknown) => {
        appended.push({ stream, event });
        return undefined as never;
      },
    },
  } as unknown as DispatchContext;
  return { ctx, appended };
}

/** A valid audit-mode entry without an id, so the handler assigns one. */
const VALID_AUDIT_ENTRY = {
  dimension: 'example-dimension',
  axis: 'authoring' as const,
  'cost-of-load': 'reference-only' as const,
  'applies-to': ['src/**/*.ts'],
  summary: 'Modules must not import across the boundary.',
  references: ['docs/architecture/some-design.md'],
  severity: { default: 'advisory' as const },
  'integrity-class': 'user' as const,
  enforcement: {
    mode: 'audit' as const,
    'audit-prompt': 'Does the diff cross the boundary? Cite the file + line.',
  },
};

describe('handleAdd — T8 validate + dry-run', () => {
  it('handleAdd_ValidEntry_DryRunReturnsRenderedDiff', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: true,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      committed: boolean;
      renderedEntry: string;
      diff: string;
      id: string;
      next_actions: string[];
    };
    expect(data.committed).toBe(false);
    expect(data.renderedEntry).toMatch(/id: U-1/);
    expect(data.renderedEntry).toMatch(/mode: audit/);
    expect(data.diff).toMatch(/U-1/);
    expect(data.next_actions).toContain('doctor');
    expect(data.next_actions).toContain('view invariants_effective');
    expect(fake.writes.length).toBe(0);
  });

  it('handleAdd_DryRunDefault_NoWrite', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { committed: boolean }).committed).toBe(false);
    expect(fake.writes.length).toBe(0);
  });

  /** The strict DSL rejects the embedded `exec` field, and the ZodError maps to the carrier shape. */
  it('handleAdd_CheckModeWithExecField_Rejected', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'user',
        entry: {
          dimension: 'd',
          axis: 'authoring',
          'cost-of-load': 'reference-only',
          'applies-to': ['src/**'],
          summary: 's',
          references: [],
          severity: { default: 'advisory' },
          enforcement: {
            mode: 'check',
            check: { kind: 'grep', pattern: 'foo', exec: 'rm -rf /' },
          },
        },
        dryRun: true,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.expectedShape).toBeDefined();
    expect(result.error!.suggestedFix).toBeDefined();
    expect(fake.writes.length).toBe(0);
  });

  /** `kind: 'shell'` is not a known leaf kind, so the schema throws `UnknownCheckKindError`. */
  it('handleAdd_UnknownLeafKind_Rejected', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'user',
        entry: {
          dimension: 'd',
          axis: 'authoring',
          'cost-of-load': 'reference-only',
          'applies-to': ['src/**'],
          summary: 's',
          references: [],
          severity: { default: 'advisory' },
          enforcement: {
            mode: 'check',
            check: { kind: 'shell', pattern: 'foo' },
          },
        },
        dryRun: true,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.message.toLowerCase()).toContain('kind');
    expect(fake.writes.length).toBe(0);
  });
});

describe('allocateNextId — T9 pure helper', () => {
  it('allocateNextId_EmptyNamespace_StartsAtOne', () => {
    expect(allocateNextId([], 'U')).toBe('U-1');
    expect(allocateNextId([], 'INV')).toBe('INV-1');
  });

  it('allocateNextId_NextFreeInNamespace', () => {
    expect(allocateNextId(['U-1', 'U-2'], 'U')).toBe('U-3');
    expect(allocateNextId(['INV-1', 'INV-2', 'INV-3'], 'INV')).toBe('INV-4');
  });

  it('allocateNextId_IgnoresOtherNamespaces', () => {
    expect(allocateNextId(['INV-5', 'U-1'], 'U')).toBe('U-2');
    expect(allocateNextId(['INV-5', 'U-1'], 'INV')).toBe('INV-6');
  });

  /** The next id is the maximum plus one, so a freed id is not used again. */
  it('allocateNextId_HandlesGaps_UsesMaxPlusOne', () => {
    expect(allocateNextId(['U-1', 'U-5'], 'U')).toBe('U-6');
  });
});

describe('handleAdd — T9 commit', () => {
  it('handleAdd_Commit_AppendsEntryToCatalog', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { committed: boolean }).committed).toBe(true);
    const written = fake.files.get('/repo/.exarchos/invariants.md')!;
    expect(written).toMatch(/id: U-1/);
    expect(written).toMatch(/mode: audit/);
  });

  it('handleAdd_AutoId_NextFreeInNamespace', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md':
        'invariants:\n  - id: U-1\n    dimension: d\n    axis: authoring\n    cost-of-load: reference-only\n    applies-to: ["src/**"]\n    summary: s\n    references: []\n  - id: U-2\n    dimension: d\n    axis: authoring\n    cost-of-load: reference-only\n    applies-to: ["src/**"]\n    summary: s\n    references: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('U-3');
    const written = fake.files.get('/repo/.exarchos/invariants.md')!;
    expect(written).toMatch(/id: U-3/);
  });

  /**
   * A commit emits `invariant.authored`. The `.exarchos.yml` fixture registers no catalog, so the commit
   * is the first registration and also emits `catalog.registered`.
   */
  it('handleAdd_Commit_EmitsInvariantAuthoredAndCatalogRegistered', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': 'invariants: []\n',
      '/repo/.exarchos.yml': 'test: npm test\n',
    });
    const { ctx, appended } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    const types = appended.map((a) => (a.event as { type: string }).type);
    expect(types).toContain('invariant.authored');
    expect(types).toContain('catalog.registered');
    expect((result.data as { events: string[] }).events).toEqual(
      expect.arrayContaining(['invariant.authored', 'catalog.registered']),
    );
  });

  it('handleAdd_Commit_AlreadyRegisteredCatalog_NoCatalogRegisteredEvent', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': 'invariants: []\n',
      '/repo/.exarchos.yml':
        'invariants:\n  catalogs:\n    - { path: .exarchos/invariants.md, tier: user }\n',
    });
    const { ctx, appended } = makeCtx();

    await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    const types = appended.map((a) => (a.event as { type: string }).type);
    expect(types).toContain('invariant.authored');
    expect(types).not.toContain('catalog.registered');
  });

  /**
   * A catalog whose `invariants:` node is not a sequence must give a structured `CATALOG_UNREADABLE`
   * refusal and stay as it was. A raw TypeError or an overwrite is wrong. After an overwrite, every id
   * looks free to the id-uniqueness check.
   */
  it('handleAdd_Commit_NonSequenceInvariantsNode_RefusesStructurally', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': 'invariants: not-a-list\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect((result as { error?: { code?: string } }).error?.code).toBe(
      'CATALOG_UNREADABLE',
    );
    expect(fake.writes).toHaveLength(0);
    expect(fake.files.get('/repo/.exarchos/invariants.md')).toBe(
      'invariants: not-a-list\n',
    );
  });

  /**
   * The `dev` tier with `INV` ids is the reserved namespace of exarchos. Only the exarchos repo, known by
   * its package.json name, can author into it, so the fixture seeds that name.
   */
  it('handleAdd_DevTier_UsesInvNamespace', async () => {
    const fake = makeFakeFs({
      '/repo/package.json': JSON.stringify({ name: '@lvlup-sw/exarchos' }),
      '/repo/.exarchos/invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'dev',
        entry: { ...VALID_AUDIT_ENTRY, 'integrity-class': 'substrate' as const },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('INV-1');
  });

  /**
   * A consumer repo that authors into the `dev` tier gets a reserved-tier refusal that points to the
   * `user` tier. The guard runs before any write.
   */
  it('handleAdd_DevTier_NonExarchosRepo_BlockedAsReserved', async () => {
    const fake = makeFakeFs({
      '/repo/package.json': JSON.stringify({ name: '@acme/consumer' }),
      '/repo/.exarchos/invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'dev',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('RESERVED_TIER');
    expect(result.error?.suggestedFix?.params.tier).toBe('user');
    expect(fake.files.get('/repo/.exarchos/invariants.md')).toBe(
      'invariants: []\n',
    );
  });

  /**
   * Catalog files are markdown with frontmatter. A commit must keep the prose body and the frontmatter
   * comment, and append the next id. The result must load through `loadInvariants` with both entries.
   * `loadInvariants` reads from disk, so the test writes the result to a temp file.
   */
  it('handleAdd_Commit_PreservesMarkdownBodyAndFrontmatterComments', async () => {
    const fenced =
      '---\n' +
      '# top-of-catalog comment\n' +
      'schema-version: 3\n' +
      'invariants:\n' +
      '  - id: U-1\n' +
      '    dimension: existing\n' +
      '    axis: authoring\n' +
      '    cost-of-load: reference-only\n' +
      '    applies-to: ["src/**"]\n' +
      '    summary: An existing entry.\n' +
      '    references: []\n' +
      '---\n' +
      '\n' +
      '# Heading\n' +
      '\n' +
      'Prose body.\n';
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': fenced,
      '/repo/.exarchos.yml':
        'invariants:\n  devCatalog: enabled\n  catalogs:\n    - { path: .exarchos/invariants.md, tier: user }\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: '.exarchos/invariants.md',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    const written = fake.files.get('/repo/.exarchos/invariants.md')!;
    expect(written).toContain('Prose body.');
    expect(written).toContain('# Heading');
    expect(written).toContain('# top-of-catalog comment');
    expect((result.data as { id: string }).id).toBe('U-2');
    expect(written).toMatch(/id: U-2/);

    const tmpDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'inv-rt-'));
    const tmpCatalog = nodePath.join(tmpDir, 'my-invariants.md');
    await fsp.writeFile(tmpCatalog, written, 'utf8');
    const entries = loadInvariants(
      tmpCatalog,
      { scope: 'all' },
      { invariants: { catalogs: [{ path: tmpCatalog, tier: 'dev' }] } },
    );
    expect(entries.map((e) => e.id)).toEqual(['U-1', 'U-2']);
    await rmrfAsync(tmpDir);
  });

  /** A bare YAML catalog with no fence and no body must still take a commit, and the commit adds no fence. */
  it('handleAdd_Commit_BareYamlCatalog_StillWorks', async () => {
    const fake = makeFakeFs({
      '/repo/docs/architecture/my-invariants.yml':
        'invariants:\n  - id: U-1\n    dimension: existing\n    axis: authoring\n    cost-of-load: reference-only\n    applies-to: ["src/**"]\n    summary: s\n    references: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: 'docs/architecture/my-invariants.yml',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    const written = fake.files.get('/repo/docs/architecture/my-invariants.yml')!;
    expect(written).not.toMatch(/^---/);
    expect(written).toMatch(/id: U-1/);
    expect(written).toMatch(/id: U-2/);
  });
});

describe('appendEntryToCatalog — #1487 helper unit tests', () => {
  const ENTRY = {
    id: 'U-9',
    dimension: 'd',
    axis: 'authoring',
    'cost-of-load': 'reference-only',
    'applies-to': ['src/**'],
    summary: 's',
    references: [],
  };

  /** The output keeps exactly one frontmatter open fence and one close fence. */
  it('appendEntryToCatalog_Fenced_PreservesBodyCommentAndAppends', () => {
    const fenced =
      '---\n# c\ninvariants:\n  - id: U-1\n    dimension: d\n---\n\n# Heading\n\nProse body.\n';
    const out = appendEntryToCatalog(fenced, ENTRY);
    expect(out).toContain('Prose body.');
    expect(out).toContain('# Heading');
    expect(out).toContain('# c');
    expect(out).toMatch(/id: U-1/);
    expect(out).toMatch(/id: U-9/);
    expect(out.match(/^---$/gm)?.length).toBe(2);
  });

  /** The scaffold starter file holds only frontmatter and no body. */
  it('appendEntryToCatalog_FrontmatterOnly_NoBody_RoundTripsClean', () => {
    const starter = '---\ninvariants: []\n---\n';
    const out = appendEntryToCatalog(starter, ENTRY);
    expect(out).toMatch(/id: U-9/);
    expect(out.match(/^---$/gm)?.length).toBe(2);
  });

  it('appendEntryToCatalog_BareYaml_NoFenceAdded', () => {
    const bare = 'invariants:\n  - id: U-1\n    dimension: d\n';
    const out = appendEntryToCatalog(bare, ENTRY);
    expect(out).not.toMatch(/^---/);
    expect(out).toMatch(/id: U-1/);
    expect(out).toMatch(/id: U-9/);
  });
});

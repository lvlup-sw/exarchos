/**
 * T8/T9 — `invariants_add` handler tests.
 *
 * T8: validate one entry through InvariantEntryV3Schema; with dryRun (default
 * true) return the rendered YAML entry + a file diff and write NOTHING. Map
 * ZodError → envelope { validTargets, expectedShape, suggestedFix }. The
 * `.strict()` enforcement DSL rejects embedded exec/script and unknown leaf
 * kinds (INV-4).
 *
 * T9: with dryRun:false, append the entry to the target catalog's invariants:
 * list, auto-assigning the next free id in the target namespace.
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

// ─── Harness ─────────────────────────────────────────────────────────────────

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

/**
 * Minimal in-memory DispatchContext stub. We only need `eventStore.append`
 * to be callable + record calls; the rest of the context is unused by add.
 */
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

// A valid mode:audit entry (no id — auto-assigned). Pure judgment (INV-6).
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
    // INV-12 next_actions.
    expect(data.next_actions).toContain('doctor');
    expect(data.next_actions).toContain('view invariants_effective');
    // Wrote NOTHING.
    expect(fake.writes.length).toBe(0);
  });

  it('handleAdd_DryRunDefault_NoWrite', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    // dryRun omitted → defaults to true (INV-5c).
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
            // Embedded exec escape hatch — rejected by the .strict() DSL (INV-4).
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
    // ZodError mapped to the carrier shape (INV-5b).
    expect(result.error!.expectedShape).toBeDefined();
    expect(result.error!.suggestedFix).toBeDefined();
    expect(fake.writes.length).toBe(0);
  });

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
            // `kind: 'shell'` is not a known leaf kind → UnknownCheckKindError.
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
    // U ids are not affected by INV ids and vice-versa.
    expect(allocateNextId(['INV-5', 'U-1'], 'U')).toBe('U-2');
    expect(allocateNextId(['INV-5', 'U-1'], 'INV')).toBe('INV-6');
  });

  it('allocateNextId_HandlesGaps_UsesMaxPlusOne', () => {
    // Gaps are tolerated — next id is max+1, never reusing a freed id.
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

  it('handleAdd_Commit_EmitsInvariantAuthoredAndCatalogRegistered', async () => {
    // P2/T11: committing emits invariant.authored, and the FIRST registration
    // of the catalog (it's not yet in .exarchos.yml) emits catalog.registered
    // (INV-1). The events land on the per-tier invariants stream.
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': 'invariants: []\n',
      // .exarchos.yml has no catalog registration → first registration.
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
    // When the catalog is already registered, only invariant.authored fires.
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

  it('handleAdd_Commit_NonSequenceInvariantsNode_RefusesStructurally', async () => {
    // #1487 review established that a malformed catalog whose `invariants:` is
    // a non-sequence (scalar/map) must not throw a raw TypeError on `.add`.
    // It originally satisfied that by resetting the node to an empty sequence
    // and appending — which silently DESTROYED the malformed content and made
    // the id-uniqueness denominator vacuous (task 068 / DR-24): every id looks
    // free when the entry list resolves to nothing.
    //
    // The contract is now the stronger form of the same intent: a structured
    // `CATALOG_UNREADABLE` refusal, not a raw TypeError and not a silent
    // overwrite. `appendEntryToCatalog`'s normalization survives as
    // defense-in-depth for direct callers (unit-tested below).
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
    // The malformed catalog is left exactly as it was found.
    expect(fake.writes).toHaveLength(0);
    expect(fake.files.get('/repo/.exarchos/invariants.md')).toBe(
      'invariants: not-a-list\n',
    );
  });

  it('handleAdd_DevTier_UsesInvNamespace', async () => {
    // The `dev`/INV-N tier is exarchos's own reserved substrate namespace, so it
    // is only reachable from the exarchos repo itself — identified by its
    // package.json name (#1489). Seed that so this exercises the legitimate
    // in-exarchos path rather than tripping the reserved-tier guard.
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

  it('handleAdd_DevTier_NonExarchosRepo_BlockedAsReserved', async () => {
    // A consumer repo (package.json name ≠ exarchos) authoring into tier:dev is
    // rejected as a reserved-namespace collision and redirected to tier:user.
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
    // Guard fires before any write — the catalog is untouched.
    expect(fake.files.get('/repo/.exarchos/invariants.md')).toBe(
      'invariants: []\n',
    );
  });

  it('handleAdd_Commit_PreservesMarkdownBodyAndFrontmatterComments', async () => {
    // #1487 review (HIGH): catalog files are markdown-with-frontmatter. The old
    // commit path ran parseDocument on the WHOLE file then toString()'d it,
    // which throws ("Document with errors cannot be stringified") and would
    // silently destroy the prose body. This is the round-trip the prior tests
    // omitted: commit an entry to a fenced catalog with a comment + body and
    // assert the body, the comment, and the new entry all survive.
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
    // (a) markdown body survives.
    expect(written).toContain('Prose body.');
    expect(written).toContain('# Heading');
    // (b) frontmatter comment survives.
    expect(written).toContain('# top-of-catalog comment');
    // (c) the auto-allocated next id is appended to invariants:.
    expect((result.data as { id: string }).id).toBe('U-2');
    expect(written).toMatch(/id: U-2/);

    // (d) the result re-parses via loadInvariants without throwing and yields
    // BOTH entries. loadInvariants reads from disk, so write to a real tmp file.
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

  it('handleAdd_Commit_BareYamlCatalog_StillWorks', async () => {
    // #1487 review (HIGH): the bare-YAML catalog shape (no fences, no body) must
    // still round-trip through the original parseDocument path. A user could
    // register a `.yml` catalog with no frontmatter fence.
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
    // No frontmatter fence introduced; both ids present.
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

  it('appendEntryToCatalog_Fenced_PreservesBodyCommentAndAppends', () => {
    const fenced =
      '---\n# c\ninvariants:\n  - id: U-1\n    dimension: d\n---\n\n# Heading\n\nProse body.\n';
    const out = appendEntryToCatalog(fenced, ENTRY);
    expect(out).toContain('Prose body.');
    expect(out).toContain('# Heading');
    expect(out).toContain('# c');
    expect(out).toMatch(/id: U-1/);
    expect(out).toMatch(/id: U-9/);
    // Exactly one frontmatter open + close fence (body fences not duplicated).
    expect(out.match(/^---$/gm)?.length).toBe(2);
  });

  it('appendEntryToCatalog_FrontmatterOnly_NoBody_RoundTripsClean', () => {
    // The scaffold starter file is frontmatter-only with no body.
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

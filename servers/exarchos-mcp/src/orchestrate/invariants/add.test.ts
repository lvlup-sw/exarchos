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

import type { DispatchContext } from '../../core/dispatch.js';
import { handleAdd } from './add.js';
import type { ScaffoldDeps } from './scaffold.js';
import { allocateNextId } from './add.js';

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
      '/repo/docs/architecture/my-invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: 'docs/architecture/my-invariants.md',
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
      '/repo/docs/architecture/my-invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    // dryRun omitted → defaults to true (INV-5c).
    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: 'docs/architecture/my-invariants.md',
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
      '/repo/docs/architecture/my-invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: 'docs/architecture/my-invariants.md',
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
      '/repo/docs/architecture/my-invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: 'docs/architecture/my-invariants.md',
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
      '/repo/docs/architecture/my-invariants.md': 'invariants: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: 'docs/architecture/my-invariants.md',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { committed: boolean }).committed).toBe(true);
    const written = fake.files.get('/repo/docs/architecture/my-invariants.md')!;
    expect(written).toMatch(/id: U-1/);
    expect(written).toMatch(/mode: audit/);
  });

  it('handleAdd_AutoId_NextFreeInNamespace', async () => {
    const fake = makeFakeFs({
      '/repo/docs/architecture/my-invariants.md':
        'invariants:\n  - id: U-1\n    dimension: d\n    axis: authoring\n    cost-of-load: reference-only\n    applies-to: ["src/**"]\n    summary: s\n    references: []\n  - id: U-2\n    dimension: d\n    axis: authoring\n    cost-of-load: reference-only\n    applies-to: ["src/**"]\n    summary: s\n    references: []\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: 'docs/architecture/my-invariants.md',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('U-3');
    const written = fake.files.get('/repo/docs/architecture/my-invariants.md')!;
    expect(written).toMatch(/id: U-3/);
  });

  it('handleAdd_Commit_EmitsInvariantAuthoredAndCatalogRegistered', async () => {
    // P2/T11: committing emits invariant.authored, and the FIRST registration
    // of the catalog (it's not yet in .exarchos.yml) emits catalog.registered
    // (INV-1). The events land on the per-tier invariants stream.
    const fake = makeFakeFs({
      '/repo/docs/architecture/my-invariants.md': 'invariants: []\n',
      // .exarchos.yml has no catalog registration → first registration.
      '/repo/.exarchos.yml': 'test: npm test\n',
    });
    const { ctx, appended } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: 'docs/architecture/my-invariants.md',
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
      '/repo/docs/architecture/my-invariants.md': 'invariants: []\n',
      '/repo/.exarchos.yml':
        'invariants:\n  catalogs:\n    - { path: docs/architecture/my-invariants.md, tier: user }\n',
    });
    const { ctx, appended } = makeCtx();

    await handleAdd(
      {
        repoRoot: '/repo',
        catalog: 'docs/architecture/my-invariants.md',
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

  it('handleAdd_Commit_NonSequenceInvariantsNode_NormalizesAndAppends', async () => {
    // #1487 review: a malformed catalog whose `invariants:` is a non-sequence
    // (scalar/map) must not throw a raw TypeError on `.add`. The handler resets
    // the node to an empty sequence, then appends the validated entry.
    const fake = makeFakeFs({
      '/repo/docs/architecture/my-invariants.md': 'invariants: not-a-list\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAdd(
      {
        repoRoot: '/repo',
        catalog: 'docs/architecture/my-invariants.md',
        tier: 'user',
        entry: { ...VALID_AUDIT_ENTRY },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { committed: boolean }).committed).toBe(true);
    const written = fake.files.get('/repo/docs/architecture/my-invariants.md')!;
    expect(written).toMatch(/id: U-1/);
    expect(written).toMatch(/mode: audit/);
  });

  it('handleAdd_DevTier_UsesInvNamespace', async () => {
    const fake = makeFakeFs({
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
});

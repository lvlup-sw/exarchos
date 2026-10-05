/**
 * Tests for the `invariants_amend` handler. An amendment changes an existing entry and does not scaffold a new one.
 *
 * - The id must exist, and the identity of the entry stays.
 * - Fields that the patch does not name stay verbatim.
 * - Other entries, the markdown body, and YAML comments stay.
 * - A dry run is the default. It writes nothing and shows a diff.
 * - A commit emits `invariant.amended` with the changed fields.
 * - After an amendment, the catalog still loads. A writer must not write a document that its reader rejects.
 */
// @oracle-sources: ../../../../src/architecture/invariants-loader.js, the hand-written FENCED_CATALOG fixture and per-field expectations in this file
//
// The loader and the hand-written fixture are two independent authorities.
// `amend.ts` imports the loader, so the tag does not name `./amend.js`. It is the same authority under a second name.
import { describe, it, expect } from 'vitest';

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import { handleAmend } from '../../../../src/verbs/invariants/amend.js';
import type { ScaffoldDeps } from '../../../../src/verbs/invariants/scaffold.js';
import { EXARCHOS_PACKAGE_NAME } from '../../../../src/verbs/invariants/reserved-tier-guard.js';
import { loadInvariants } from '../../../../src/architecture/invariants-loader.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const REPO_ROOT = '/repo';
const CATALOG = '.exarchos/invariants.md';
const CATALOG_ABS = `${REPO_ROOT}/${CATALOG}`;

interface FakeFs {
  files: Map<string, string>;
  deps: ScaffoldDeps;
  writes: Array<{ path: string; contents: string }>;
}

/** A fake filesystem with an exarchos `package.json`, because the reserved-tier guard reads it for `tier: 'dev'` fixtures. */
function makeFakeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(seed));
  files.set(
    `${REPO_ROOT}/package.json`,
    JSON.stringify({ name: EXARCHOS_PACKAGE_NAME }),
  );
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

function makeCtx(): {
  ctx: DispatchContext;
  appended: Array<{ stream: string; event: unknown }>;
} {
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

function errorOf(result: ToolResult): { code?: string; message?: string } {
  const err = (result as { error?: unknown }).error;
  if (err === null || typeof err !== 'object') return {};
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  };
}

/**
 * A fenced catalog with a prose body, YAML comments, and TWO entries. U-1 is
 * richly populated precisely so an amendment has un-named fields to preserve.
 */
const FENCED_CATALOG = `---
# Catalog comment that must survive an amendment.
schema-version: 3
invariants:
  - id: U-1
    dimension: boundary-integrity
    axis: authoring
    cost-of-load: reference-only
    applies-to:
      - "src/**/*.ts"
    summary: Original summary text.
    references:
      - docs/architecture/original.md
    severity:
      default: advisory
    integrity-class: user
    phase-affinity:
      - plan
    enforcement:
      mode: audit
      audit-prompt: Original prompt.
  - id: U-2
    dimension: second-dimension
    axis: authoring
    cost-of-load: reference-only
    applies-to:
      - "docs/**/*.md"
    summary: The second entry must be untouched.
    references: []
---

# Invariants

Prose body that a whole-file YAML round-trip would destroy.
`;

describe('handleAmend — dryRun (INV-5c default)', () => {
  it('handleAmend_DryRun_RendersDiffAndWritesNothing', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx, appended } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'Corrected summary text.' },
        dryRun: true,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      committed: boolean;
      id: string;
      patchedFields: string[];
      renderedEntry: string;
      diff: string;
      next_actions: string[];
    };
    expect(data.committed).toBe(false);
    expect(data.id).toBe('U-1');
    expect(data.patchedFields).toEqual(['summary']);
    expect(data.renderedEntry).toMatch(/Corrected summary text\./);
    expect(data.diff).toMatch(/-\s*summary: Original summary text\./);
    expect(data.diff).toMatch(/\+\s*summary: Corrected summary text\./);
    expect(data.next_actions).toContain('doctor');

    expect(fake.writes).toHaveLength(0);
    expect(appended).toHaveLength(0);
  });

  it('handleAmend_DryRunIsTheDefault', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'Corrected.' },
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { committed: boolean }).committed).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });
});

describe('handleAmend — identity and un-named fields survive', () => {
  it('handleAmend_Commit_UnnamedFieldsSurviveVerbatim', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'Corrected summary text.' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );
    expect(result.success).toBe(true);

    const written = fake.files.get(CATALOG_ABS)!;
    expect(written).toMatch(/summary: Corrected summary text\./);
    expect(written).not.toMatch(/Original summary text/);
    expect(written).toMatch(/dimension: boundary-integrity/);
    expect(written).toMatch(/cost-of-load: reference-only/);
    expect(written).toMatch(/docs\/architecture\/original\.md/);
    expect(written).toMatch(/integrity-class: user/);
    expect(written).toMatch(/audit-prompt: Original prompt\./);
    expect(written).toMatch(/- plan/);
  });

  /** The handler replaces the entry in place, so the catalog holds exactly one `U-1`. */
  it('handleAmend_Commit_IdentityIsPreserved', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx } = makeCtx();

    await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'Corrected.' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    const written = fake.files.get(CATALOG_ABS)!;
    expect(written).toMatch(/id: U-1/);
    expect(written.match(/id: U-1/g)).toHaveLength(1);
  });

  it('handleAmend_Commit_OtherEntriesBodyAndCommentsSurvive', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx } = makeCtx();

    await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'Corrected.' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    const written = fake.files.get(CATALOG_ABS)!;
    expect(written).toMatch(/id: U-2/);
    expect(written).toMatch(/The second entry must be untouched\./);
    expect(written).toContain('Prose body that a whole-file YAML round-trip would destroy.');
    expect(written).toContain('# Invariants');
    expect(written).toContain('# Catalog comment that must survive an amendment.');
    expect(written.match(/^---$/gm)?.length).toBe(2);
  });

  /** A patch field replaces the whole top-level value and does not deep-merge into it. The test pins this granularity as a decision. */
  it('handleAmend_Commit_ReplacesNamedFieldWholesale', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: {
          enforcement: { mode: 'audit', 'audit-prompt': 'Replacement prompt.' },
        },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    const written = fake.files.get(CATALOG_ABS)!;
    expect(written).toMatch(/audit-prompt: Replacement prompt\./);
    expect(written).not.toMatch(/Original prompt/);
    expect(written).toMatch(/summary: Original summary text\./);
  });
});

describe('handleAmend — the amendment is auditable', () => {
  it('handleAmend_Commit_EmitsInvariantAmendedNamingChangedFields', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx, appended } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'Corrected.', dimension: 'new-dimension' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { events: string[] }).events).toEqual([
      'invariant.amended',
    ]);

    expect(appended).toHaveLength(1);
    const entry = appended[0]!;
    expect(entry.stream).toBe('invariants/user');
    const event = entry.event as {
      type: string;
      data: { id: string; catalog: string; tier: string; fields: string[] };
    };
    expect(event.type).toBe('invariant.amended');
    expect(event.data.id).toBe('U-1');
    expect(event.data.catalog).toBe(CATALOG);
    expect(event.data.tier).toBe('user');
    expect(event.data.fields).toEqual(['summary', 'dimension']);
  });

  /** Emission is best-effort. The amendment is already on disk, so an event store failure does not fail the write. */
  it('handleAmend_Commit_EventStoreFailure_DoesNotFailTheWrite', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const ctx = {
      stateDir: '/tmp/state',
      enableTelemetry: false,
      eventStore: {
        append: async () => {
          throw new Error('event store unavailable');
        },
      },
    } as unknown as DispatchContext;

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'Corrected.' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { events: string[] }).events).toEqual([]);
    expect(fake.files.get(CATALOG_ABS)).toMatch(/summary: Corrected\./);
  });
});

describe('handleAmend — refusals', () => {
  /** The refusal lists the ids that it resolved, so "not found" differs from "nothing to look at". */
  it('handleAmend_UnknownId_FailsWithResolvedTargets', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-404',
        patch: { summary: 'x' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(errorOf(result).code).toBe('ENTRY_NOT_FOUND');
    const targets = (result as { error?: { validTargets?: string[] } }).error
      ?.validTargets;
    expect(targets).toEqual(['U-1', 'U-2']);
    expect(fake.writes).toHaveLength(0);
  });

  /**
   * The identity stays. A rename makes each reference to the old id stale, so the handler refuses an `id` in the patch.
   * The catalog still holds one `U-2`, so the rename to `U-2` wrote no duplicate.
   */
  it('handleAmend_PatchCarriesId_FailsAsImmutable', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { id: 'U-2', summary: 'x' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(errorOf(result).code).toBe('IMMUTABLE_FIELD');
    expect(fake.writes).toHaveLength(0);
    expect(fake.files.get(CATALOG_ABS)!.match(/id: U-2/g)).toHaveLength(1);
  });

  it('handleAmend_EmptyPatch_Fails', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: {},
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(errorOf(result).code).toBe('INVALID_INPUT');
    expect(fake.writes).toHaveLength(0);
  });

  /**
   * The handler validates the full merged entry, so an amendment cannot make an entry that the schema rejects.
   * The error carries a `suggestedFix` for `invariants_amend`.
   */
  it('handleAmend_PatchViolatesSchema_FailsWithCarrierShape', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { axis: 'not-a-valid-axis' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(errorOf(result).code).toBe('INVALID_INPUT');
    const fix = (
      result as { error?: { suggestedFix?: { params?: { action?: string } } } }
    ).error?.suggestedFix;
    expect(fix?.params?.action).toBe('invariants_amend');
    expect(fake.writes).toHaveLength(0);
  });

  /** The enforcement DSL is declarative only. An amendment cannot bypass the `.strict()` boundary that `invariants_add` enforces. */
  it('handleAmend_EnforcementDslRejectsExecutableEscape', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: {
          enforcement: { mode: 'check', check: { kind: 'exec', run: 'rm -rf /' } },
        },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });

  it('handleAmend_CatalogMissing_Fails', async () => {
    const fake = makeFakeFs({});
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'x' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(errorOf(result).code).toBe('CATALOG_NOT_FOUND');
  });

  /** The reserved-tier guard of `invariants_add` also guards the amend path. */
  it('handleAmend_DevTierOutsideExarchos_FailsReservedTier', async () => {
    const files = new Map<string, string>([
      [CATALOG_ABS, FENCED_CATALOG],
      [`${REPO_ROOT}/package.json`, JSON.stringify({ name: 'some-consumer' })],
    ]);
    const writes: Array<{ path: string; contents: string }> = [];
    const deps: ScaffoldDeps = {
      exists: (p) => files.has(p),
      read: (p) => files.get(p)!,
      write: (p, c) => {
        files.set(p, c);
        writes.push({ path: p, contents: c });
      },
    };
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'dev',
        id: 'U-1',
        patch: { summary: 'x' },
        dryRun: false,
      },
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(errorOf(result).code).toBe('RESERVED_TIER');
    expect(writes).toHaveLength(0);
  });
});

describe('handleAmend — non-empty denominator (DR-24)', () => {
  /**
   * "U-1 is not here" is true of an empty list, and does not tell the caller if the catalog is correct.
   * Thus the handler refuses with `CATALOG_EMPTY`, not `ENTRY_NOT_FOUND`.
   */
  it('handleAmend_ZeroResolvedEntries_FailsRatherThanReportingNotFound', async () => {
    const fake = makeFakeFs({
      [CATALOG_ABS]: '---\nschema-version: 3\ninvariants: []\n---\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'x' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(errorOf(result).code).toBe('CATALOG_EMPTY');
    expect(errorOf(result).code).not.toBe('ENTRY_NOT_FOUND');
    expect(fake.writes).toHaveLength(0);
  });

  /** An entry list that the handler cannot resolve must not read as a missing entry. */
  it('handleAmend_UnresolvableEntryList_Refuses', async () => {
    const fake = makeFakeFs({
      [CATALOG_ABS]: '---\nschema-version: 3\ninvariant_list:\n  - id: U-1\n---\n',
    });
    const { ctx } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'x' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(errorOf(result).code).toBe('CATALOG_UNREADABLE');
    expect(fake.writes).toHaveLength(0);
  });

  /**
   * `exists` and `read` are two syscalls, so the path can change between them.
   * A raw `ENOENT`, `EISDIR`, or `EACCES` must not escape to dispatch as a generic `INTERNAL_ERROR`.
   */
  it('Amend_CatalogVanishesBetweenExistsAndRead_ReturnsCodedEnvelope', async () => {
    for (const failure of [
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
      Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' }),
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    ]) {
      const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
      const { ctx } = makeCtx();
      const result = await handleAmend(
        {
          repoRoot: REPO_ROOT,
          catalog: CATALOG,
          tier: 'user',
          id: 'U-1',
          patch: { summary: 'x' },
          dryRun: false,
        },
        ctx,
        {
          ...fake.deps,
          exists: () => true,
          read: () => {
            throw failure;
          },
        },
      );

      expect(result.success).toBe(false);
      expect(errorOf(result).code).toBe('CATALOG_UNREADABLE');
      expect(fake.writes).toHaveLength(0);
    }
  });
});

describe('handleAmend — the catalog write returns an envelope, never throws', () => {
  /**
   * `deps.write` throws on a filesystem failure. Dispatch turns an escaped throw into a generic `INTERNAL_ERROR`, and the caller loses the code.
   * The cause stays in the message, and a failed write emits no audit event.
   */
  it('handleAmend_CatalogWriteThrows_ReturnsCodedEnvelope', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    fake.deps.write = () => {
      throw new Error('EACCES: permission denied');
    };
    const { ctx, appended } = makeCtx();

    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'Corrected summary text.' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(errorOf(result).code).toBe('CATALOG_WRITE_FAILED');
    expect(errorOf(result).message).toContain('EACCES: permission denied');
    expect(appended).toHaveLength(0);
  });

  /** `handleAmend` must settle and not reject. A test that reads only the resolved value passes vacuously when the call rejects first. */
  it('handleAmend_CatalogWriteThrows_DoesNotReject', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FENCED_CATALOG });
    fake.deps.write = () => {
      throw new Error('ENOSPC: no space left on device');
    };
    const { ctx } = makeCtx();

    const settled = await Promise.allSettled([
      handleAmend(
        {
          repoRoot: REPO_ROOT,
          catalog: CATALOG,
          tier: 'user',
          id: 'U-1',
          patch: { summary: 'Corrected summary text.' },
          dryRun: false,
        },
        ctx,
        fake.deps,
      ),
    ]);

    expect(settled[0]?.status).toBe('fulfilled');
  });
});

describe('handleAmend — round-trip: the reader accepts what the writer wrote', () => {
  /**
   * `loadInvariants` is the real reader, which throws `Duplicate invariant ID` on a repeated id. It must accept the amended file from a real disk.
   * The catalog also loads before the amendment, so a pass does not come from a loader that ignores the file.
   * The un-named fields stay in the loaded entry, not only in the text on disk.
   */
  it('handleAmend_Commit_AmendedCatalogStillLoadsThroughTheLoader', async () => {
    const tmp = await fsp.mkdtemp(
      nodePath.join(os.tmpdir(), 'imo-068-amend-roundtrip-'),
    );
    try {
      const catalogAbs = nodePath.join(tmp, '.exarchos', 'invariants.md');
      await fsp.mkdir(nodePath.dirname(catalogAbs), { recursive: true });
      await fsp.writeFile(catalogAbs, FENCED_CATALOG, 'utf8');
      await fsp.writeFile(
        nodePath.join(tmp, '.exarchos.yml'),
        `invariants:\n  catalogs:\n    - path: ${CATALOG}\n      tier: user\n`,
        'utf8',
      );

      const realDeps: ScaffoldDeps = {
        exists: (p) => fs.existsSync(p),
        read: (p) => fs.readFileSync(p, 'utf8'),
        write: (p, contents) => fs.writeFileSync(p, contents, 'utf8'),
      };
      const { ctx } = makeCtx();

      const before = loadInvariants(catalogAbs);
      expect(before.map((e) => e.id).sort()).toEqual(['U-1', 'U-2']);

      const result = await handleAmend(
        {
          repoRoot: tmp,
          catalog: CATALOG,
          tier: 'user',
          id: 'U-1',
          patch: {
            summary: 'Corrected summary text.',
            enforcement: {
              mode: 'audit',
              'audit-prompt': 'Corrected prompt.',
            },
          },
          dryRun: false,
        },
        ctx,
        realDeps,
      );
      expect(result.success).toBe(true);

      const after = loadInvariants(catalogAbs);
      expect(after.map((e) => e.id).sort()).toEqual(['U-1', 'U-2']);

      const amended = after.find((e) => e.id === 'U-1')!;
      expect(amended.summary).toBe('Corrected summary text.');
      expect(amended.enforcement).toEqual({
        mode: 'audit',
        'audit-prompt': 'Corrected prompt.',
      });
      expect(amended.dimension).toBe('boundary-integrity');
      expect(amended.appliesTo).toEqual(['src/**/*.ts']);
      expect(amended.references).toEqual(['docs/architecture/original.md']);

      const sibling = after.find((e) => e.id === 'U-2')!;
      expect(sibling.summary).toBe('The second entry must be untouched.');
    } finally {
      await rmrfAsync(tmp);
    }
  });
});

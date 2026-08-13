/**
 * Task 068 / DR-23 — `invariants_amend` handler tests.
 *
 * The verb exists because every sanctioned surface for correcting a shipped
 * invariant was closed: `invariants_add` only appends, and the
 * `/exarchos:invariants` skill forbids hand-writing catalog YAML.
 *
 * The properties that make an amendment an AMENDMENT rather than a
 * re-scaffolding are what this file pins:
 *
 *  - id-targeted: the entry must already exist, and its identity survives;
 *  - field-scoped: fields the patch does not name survive VERBATIM;
 *  - other entries, the markdown body, and YAML comments survive;
 *  - dryRun-first, writing nothing, with a before/after diff;
 *  - a commit emits `invariant.amended` naming the changed fields;
 *  - ROUND TRIP: after an amendment the catalog still LOADS. That is the
 *    property the whole task is about — a writer must not be able to author a
 *    document its own reader rejects.
 */
// @oracle-sources: ../../../../src/architecture/invariants-loader.js, the hand-written FENCED_CATALOG fixture and per-field expectations in this file
//
// The round-trip assertion compares what the READER (`loadInvariants`) projects
// off disk against expectations a human wrote here — the catalog fixture and
// the field values it should still carry after an amendment. Those are two
// independent authorities: the loader never sees the fixture's intent, and the
// fixture is not derived from the loader. Deliberately NOT declaring
// `./amend.js` alongside the loader: `amend.ts` imports the loader (it shares
// the primary-key rule rather than restating it — DR-6), so the two are
// statically reachable and would be one authority wearing two names.
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

// ─── Harness ─────────────────────────────────────────────────────────────────

const REPO_ROOT = '/repo';
const CATALOG = '.exarchos/invariants.md';
const CATALOG_ABS = `${REPO_ROOT}/${CATALOG}`;

interface FakeFs {
  files: Map<string, string>;
  deps: ScaffoldDeps;
  writes: Array<{ path: string; contents: string }>;
}

function makeFakeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(seed));
  // `tier: 'dev'` fixtures need the reserved-tier guard to see an exarchos repo.
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

// ─── dry-run ─────────────────────────────────────────────────────────────────

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
    // The diff shows the removal of the old value and the addition of the new.
    expect(data.diff).toMatch(/-\s*summary: Original summary text\./);
    expect(data.diff).toMatch(/\+\s*summary: Corrected summary text\./);
    expect(data.next_actions).toContain('doctor');

    // Nothing written, nothing emitted.
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
        // dryRun omitted entirely
      },
      ctx,
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { committed: boolean }).committed).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });
});

// ─── Amending is not re-scaffolding ──────────────────────────────────────────

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
        // Amend ONLY the summary.
        patch: { summary: 'Corrected summary text.' },
        dryRun: false,
      },
      ctx,
      fake.deps,
    );
    expect(result.success).toBe(true);

    const written = fake.files.get(CATALOG_ABS)!;
    // The amended field changed...
    expect(written).toMatch(/summary: Corrected summary text\./);
    expect(written).not.toMatch(/Original summary text/);
    // ...and every field the patch did NOT name survived.
    expect(written).toMatch(/dimension: boundary-integrity/);
    expect(written).toMatch(/cost-of-load: reference-only/);
    expect(written).toMatch(/docs\/architecture\/original\.md/);
    expect(written).toMatch(/integrity-class: user/);
    expect(written).toMatch(/audit-prompt: Original prompt\./);
    expect(written).toMatch(/- plan/);
  });

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
    // Exactly one U-1 — replaced in place, not appended alongside the original.
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
    // The sibling entry is untouched.
    expect(written).toMatch(/id: U-2/);
    expect(written).toMatch(/The second entry must be untouched\./);
    // The prose body survives (a whole-file round-trip would destroy it).
    expect(written).toContain('Prose body that a whole-file YAML round-trip would destroy.');
    expect(written).toContain('# Invariants');
    // The frontmatter's YAML comment survives.
    expect(written).toContain('# Catalog comment that must survive an amendment.');
    // Exactly one pair of frontmatter fences.
    expect(written.match(/^---$/gm)?.length).toBe(2);
  });

  it('handleAmend_Commit_ReplacesNamedFieldWholesale', async () => {
    // Field-scoped means top-level: naming `enforcement` swaps the whole
    // enforcement block rather than deep-merging into it. Pinned so the
    // granularity is a decision, not an accident.
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
    // Sibling top-level fields still survive.
    expect(written).toMatch(/summary: Original summary text\./);
  });
});

// ─── Audit trail ─────────────────────────────────────────────────────────────

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
    // The audit record names WHICH fields changed, not merely that something did.
    expect(event.data.fields).toEqual(['summary', 'dimension']);
  });

  it('handleAmend_Commit_EventStoreFailure_DoesNotFailTheWrite', async () => {
    // Emission is best-effort telemetry, mirroring invariants_add: the
    // amendment already landed on disk, so a telemetry failure must not report
    // the write as failed.
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

// ─── Refusals ────────────────────────────────────────────────────────────────

describe('handleAmend — refusals', () => {
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
    // Non-empty denominator evidence: the refusal names the ids it DID resolve,
    // so "not found" is distinguishable from "found nothing to look at".
    const targets = (result as { error?: { validTargets?: string[] } }).error
      ?.validTargets;
    expect(targets).toEqual(['U-1', 'U-2']);
    expect(fake.writes).toHaveLength(0);
  });

  it('handleAmend_PatchCarriesId_FailsAsImmutable', async () => {
    // Identity must survive an amendment. A rename is a different operation
    // (every reference to the old id goes stale) and is refused explicitly
    // rather than smuggled through the patch.
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
    // Critically: the collision the rename WOULD have caused never got a chance
    // to be written.
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

  it('handleAmend_PatchViolatesSchema_FailsWithCarrierShape', async () => {
    // The merged entry is re-validated in FULL, so an amendment cannot produce
    // an entry the schema would have rejected at authoring time.
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
    // INV-5b carrier shape, re-invokable against the verb actually used.
    const fix = (
      result as { error?: { suggestedFix?: { params?: { action?: string } } } }
    ).error?.suggestedFix;
    expect(fix?.params?.action).toBe('invariants_amend');
    expect(fake.writes).toHaveLength(0);
  });

  it('handleAmend_EnforcementDslRejectsExecutableEscape', async () => {
    // INV-4: the enforcement DSL is declarative-only. An amendment must not be
    // a way around the `.strict()` boundary `invariants_add` enforces.
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

  it('handleAmend_DevTierOutsideExarchos_FailsReservedTier', async () => {
    // #1489 parity with invariants_add: the reserved INV-N namespace is
    // guarded on the amend path too, or the guard would have a hole.
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

// ─── Non-empty denominator ───────────────────────────────────────────────────

describe('handleAmend — non-empty denominator (DR-24)', () => {
  it('handleAmend_ZeroResolvedEntries_FailsRatherThanReportingNotFound', async () => {
    // An amend against a resolvable-but-EMPTY catalog is vacuous: "U-1 is not
    // here" is trivially true of an empty list and tells the caller nothing
    // about whether they targeted the right catalog. Refuse instead.
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
    // Specifically NOT the not-found answer, which would read as a clean check.
    expect(errorOf(result).code).not.toBe('ENTRY_NOT_FOUND');
    expect(fake.writes).toHaveLength(0);
  });

  it('handleAmend_UnresolvableEntryList_Refuses', async () => {
    // A moved or renamed catalog must not read as "the entry simply isn't here".
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
});

// ─── ROUND TRIP: the amended catalog still loads ─────────────────────────────

describe('handleAmend — round-trip: the reader accepts what the writer wrote', () => {
  it('handleAmend_Commit_AmendedCatalogStillLoadsThroughTheLoader', async () => {
    // This is the property the whole task is about. `loadInvariants` is the
    // real reader — the same path that throws `Duplicate invariant ID` on a
    // catalog the old writer could produce. It must accept the amended file
    // off a REAL disk, not a fake fs.
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

      // Sanity: the catalog loads BEFORE the amendment, so a green result
      // after cannot be an artifact of the loader ignoring the file.
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

      // ── The reader accepts the amended file ──
      const after = loadInvariants(catalogAbs);
      expect(after.map((e) => e.id).sort()).toEqual(['U-1', 'U-2']);

      const amended = after.find((e) => e.id === 'U-1')!;
      expect(amended.summary).toBe('Corrected summary text.');
      expect(amended.enforcement).toEqual({
        mode: 'audit',
        'audit-prompt': 'Corrected prompt.',
      });
      // Un-named fields survived the round trip through the READER too, not
      // just as text on disk.
      expect(amended.dimension).toBe('boundary-integrity');
      expect(amended.appliesTo).toEqual(['src/**/*.ts']);
      expect(amended.references).toEqual(['docs/architecture/original.md']);

      // The sibling entry is byte-for-byte semantically unchanged.
      const sibling = after.find((e) => e.id === 'U-2')!;
      expect(sibling.summary).toBe('The second entry must be untouched.');
    } finally {
      await rmrfAsync(tmp);
    }
  });
});

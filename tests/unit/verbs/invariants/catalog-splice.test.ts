/**
 * An amendment writes back only the lines of the amended entry.
 *
 * The catalog digest covers its raw bytes, so a collateral re-wrap of a sibling
 * costs a contract re-approval. A parse-level comparison cannot see a re-wrap, so
 * the assertions compare raw text. The fixture concatenates hand-written blocks,
 * so `startsWith` and `endsWith` prove that siblings are byte-identical. Two
 * entries hold folded scalars wrapped at a column the serializer disagrees with.
 * Without them, a whole-document round-trip passes as a splice.
 */
// @oracle-sources: ../../../../src/verbs/invariants/amend.ts, the hand-written raw catalog bytes concatenated in this file
//
// `amend.ts` imports `./catalog-file.js`, so that module is not a second authority.
import { describe, it, expect } from 'vitest';

import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import { handleAmend } from '../../../../src/verbs/invariants/amend.js';
import { locateCatalogEntry } from '../../../../src/verbs/invariants/catalog-file.js';
import type { ScaffoldDeps } from '../../../../src/verbs/invariants/scaffold.js';
import { EXARCHOS_PACKAGE_NAME } from '../../../../src/verbs/invariants/reserved-tier-guard.js';
import { digestText } from '../../../../src/contract/authority-digest.js';

const HEAD = `---
# Catalog comment that must survive an amendment.
schema-version: 3
invariants:
`;

/**
 * The amend TARGET. Written in the serializer's own canonical form (plain
 * scalars, two-space nested sequences) so that an amendment which changes
 * nothing can be expected to produce a byte-identical file — see
 * `handleAmend_PatchToTheSameValue_LeavesTheFileByteIdentical`.
 */
const ENTRY_TARGET = `  - id: U-1
    dimension: boundary-integrity
    axis: authoring
    cost-of-load: reference-only
    applies-to:
      - src/**/*.ts
    summary: Original summary text.
    references:
      - docs/architecture/original.md
`;

/**
 * A sibling whose `summary` is a folded scalar that a human wrapped at 80
 * columns. A whole-document re-serialization moves its line breaks. This block
 * must come out unchanged.
 */
const ENTRY_FOLDED_A = `  - id: U-2
    dimension: second-dimension
    axis: authoring
    cost-of-load: reference-only
    applies-to:
      - docs/**/*.md
    summary: >-
      A folded scalar that is quite long and will be re-wrapped by the serializer
      when the whole document is re-stringified at the default line width of 80.
    references: []
`;

/**
 * A second folded sibling, and the last entry. It owns the tail of the
 * frontmatter, where an off-by-one splice adds a blank line before the closing fence.
 */
const ENTRY_FOLDED_B = `  - id: U-3
    dimension: third-dimension
    axis: substrate
    cost-of-load: archivable
    applies-to:
      - scripts/**/*.mjs
    summary: >-
      Another folded scalar, wrapped by a human at a column the serializer does
      not agree with, which is precisely how collateral re-wrap gets into a diff.
    references: []
`;

const TAIL = `---

# Invariants

Prose body that a whole-file YAML round-trip would destroy.
`;

const FOLDED_CATALOG = HEAD + ENTRY_TARGET + ENTRY_FOLDED_A + ENTRY_FOLDED_B + TAIL;

/** The three entries, each with the exact bytes that must survive amending it. */
const ENTRIES: ReadonlyArray<{
  readonly id: string;
  readonly block: string;
  readonly prefix: string;
  readonly suffix: string;
}> = [
  {
    id: 'U-1',
    block: ENTRY_TARGET,
    prefix: HEAD,
    suffix: ENTRY_FOLDED_A + ENTRY_FOLDED_B + TAIL,
  },
  {
    id: 'U-2',
    block: ENTRY_FOLDED_A,
    prefix: HEAD + ENTRY_TARGET,
    suffix: ENTRY_FOLDED_B + TAIL,
  },
  {
    id: 'U-3',
    block: ENTRY_FOLDED_B,
    prefix: HEAD + ENTRY_TARGET + ENTRY_FOLDED_A,
    suffix: TAIL,
  },
];

const REPO_ROOT = '/repo';
const CATALOG = '.exarchos/invariants.md';
const CATALOG_ABS = `${REPO_ROOT}/${CATALOG}`;

interface FakeFs {
  readonly files: Map<string, string>;
  readonly deps: ScaffoldDeps;
  readonly writes: Array<{ path: string; contents: string }>;
}

function makeFakeFs(seed: Record<string, string>): FakeFs {
  const files = new Map<string, string>(Object.entries(seed));
  files.set(`${REPO_ROOT}/package.json`, JSON.stringify({ name: EXARCHOS_PACKAGE_NAME }));
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

/** A test context, narrowed by a type guard instead of a cast. */
function makeCtx(): DispatchContext {
  const ctx: unknown = {
    stateDir: '/tmp/state',
    enableTelemetry: false,
    eventStore: { append: async () => undefined },
  };
  if (!isDispatchContextShaped(ctx)) throw new Error('test harness context is malformed');
  return ctx;
}

function isDispatchContextShaped(value: unknown): value is DispatchContext {
  if (value === null || typeof value !== 'object') return false;
  const store: unknown = Reflect.get(value, 'eventStore');
  if (store === null || typeof store !== 'object') return false;
  return typeof Reflect.get(store, 'append') === 'function';
}

/** Read `data.<field>` off a successful envelope without asserting its shape. */
function stringField(result: ToolResult, field: string): string {
  const data: unknown = Reflect.get(result, 'data');
  if (data === null || typeof data !== 'object') return '';
  const value: unknown = Reflect.get(data, field);
  return typeof value === 'string' ? value : '';
}

function errorCode(result: ToolResult): string {
  const err: unknown = Reflect.get(result, 'error');
  if (err === null || typeof err !== 'object') return '';
  const code: unknown = Reflect.get(err, 'code');
  return typeof code === 'string' ? code : '';
}

/** Commit an amendment against `catalog` and return the bytes actually written. */
async function amendAndRead(
  catalog: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<{ written: string; result: ToolResult; writes: number }> {
  const fake = makeFakeFs({ [CATALOG_ABS]: catalog });
  const result = await handleAmend(
    { repoRoot: REPO_ROOT, catalog: CATALOG, tier: 'user', id, patch, dryRun: false },
    makeCtx(),
    fake.deps,
  );
  return {
    written: fake.files.get(CATALOG_ABS) ?? '',
    result,
    writes: fake.writes.length,
  };
}

describe('invariants_amend — the write is a splice, proven on raw text (DR-3)', () => {
  /**
   * Everything before and after the amended entry stays byte-identical: the YAML
   * comment, both folded siblings, the closing fence and the prose body. Only the
   * amended entry's own lines change.
   */
  it('handleAmend_OneField_LeavesEveryOtherByteOfTheFileIdentical', async () => {
    const { written, result } = await amendAndRead(FOLDED_CATALOG, 'U-1', {
      summary: 'Corrected summary text.',
    });
    expect(result.success).toBe(true);

    expect(written.startsWith(HEAD)).toBe(true);
    expect(written.endsWith(ENTRY_FOLDED_A + ENTRY_FOLDED_B + TAIL)).toBe(true);

    const changed = written.slice(
      HEAD.length,
      written.length - (ENTRY_FOLDED_A + ENTRY_FOLDED_B + TAIL).length,
    );
    expect(changed).toContain('summary: Corrected summary text.');
    expect(changed).not.toContain('Original summary text');
    expect(changed).not.toContain('id: U-2');
    expect(changed).not.toContain('id: U-3');
  });

  /** For each entry, the amendment lands and the siblings stay byte-identical. */
  it.each(ENTRIES)(
    'handleAmend_AmendingOneEntry_LeavesItsSiblingsByteIdentical: $id',
    async ({ id, prefix, suffix }) => {
      const { written, result } = await amendAndRead(FOLDED_CATALOG, id, {
        summary: `Corrected summary for ${id}.`,
      });
      expect(result.success).toBe(true);
      expect(written.startsWith(prefix)).toBe(true);
      expect(written.endsWith(suffix)).toBe(true);
      expect(written).toContain(`Corrected summary for ${id}.`);
      expect(written).not.toBe(FOLDED_CATALOG);
    },
  );

  /**
   * The span of the last entry ends at the closing fence, with no trailing
   * newline inside the fences. A splice that always appends one adds a blank line
   * before `---`.
   */
  it('handleAmend_AmendingTheLastEntry_AddsNoBlankLineBeforeTheClosingFence', async () => {
    const { written } = await amendAndRead(FOLDED_CATALOG, 'U-3', {
      summary: 'Corrected tail entry.',
    });
    expect(written).toContain('summary: Corrected tail entry.\n    references: []\n---\n');
    expect(written).not.toContain('\n\n---\n\n# Invariants');
  });

  /** An amendment that changes no content changes no bytes. */
  it('handleAmend_PatchToTheSameValue_LeavesTheFileByteIdentical', async () => {
    const { written, result } = await amendAndRead(FOLDED_CATALOG, 'U-1', {
      summary: 'Original summary text.',
    });
    expect(result.success).toBe(true);
    expect(written).toBe(FOLDED_CATALOG);
  });
});

/**
 * The digest moves for the amendment and for nothing else. `authority-pin.ts`
 * digests the raw catalog text, so a reworded invariant cannot reach a generated
 * artifact without notice.
 */
describe('invariants_amend — the catalog digest moves for the amendment and nothing else', () => {
  it('handleAmend_WordingChange_MovesTheAuthorityDigest', async () => {
    const { written } = await amendAndRead(FOLDED_CATALOG, 'U-1', {
      summary: 'Corrected summary text.',
    });
    expect(digestText(written)).not.toBe(digestText(FOLDED_CATALOG));
  });

  /**
   * Putting the original entry bytes back restores the original digest. That
   * holds only if nothing outside the entry moved.
   */
  it('handleAmend_RestoringTheAmendedEntrysBytes_RestoresTheOriginalDigest', async () => {
    const { written } = await amendAndRead(FOLDED_CATALOG, 'U-1', {
      summary: 'Corrected summary text.',
    });
    const suffix = ENTRY_FOLDED_A + ENTRY_FOLDED_B + TAIL;
    const restored =
      written.slice(0, HEAD.length) +
      ENTRY_TARGET +
      written.slice(written.length - suffix.length);
    expect(digestText(restored)).toBe(digestText(FOLDED_CATALOG));
  });
});

describe('invariants_amend — the dry-run diff names the lines the commit writes', () => {
  /**
   * The `+` side of the preview diff is the region that the commit rewrites, and
   * the `-` side is the original entry. The splice keeps the `  - ` marker, so
   * the diff leaves it out.
   */
  it('handleAmend_DryRunDiff_MatchesTheCommittedRegionLineForLine', async () => {
    const fake = makeFakeFs({ [CATALOG_ABS]: FOLDED_CATALOG });
    const preview = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'Corrected summary text.' },
        dryRun: true,
      },
      makeCtx(),
      fake.deps,
    );
    expect(preview.success).toBe(true);
    expect(fake.writes).toHaveLength(0);

    const diff = stringField(preview, 'diff');
    const added = diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1));
    const removed = diff
      .split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .map((l) => l.slice(1));

    const { written } = await amendAndRead(FOLDED_CATALOG, 'U-1', {
      summary: 'Corrected summary text.',
    });
    const suffix = ENTRY_FOLDED_A + ENTRY_FOLDED_B + TAIL;
    const changed = written.slice(HEAD.length, written.length - suffix.length);

    expect(`  - ${added.join('\n')}\n`).toBe(changed);
    expect(`  - ${removed.join('\n')}\n`).toBe(ENTRY_TARGET);
  });
});

describe('locateCatalogEntry — a locate that matches nothing REFUSES', () => {
  /**
   * The locator matches a non-empty span on a real catalog, so the refusal tests
   * are not vacuous. The span holds only the entry's own lines, after the `- `
   * marker. The test strips the final newline, because the last span stops at
   * the closing fence.
   */
  it('locateCatalogEntry_EveryEntry_ResolvesToANonEmptySpanOfItsOwnLines', () => {
    for (const entry of ENTRIES) {
      const scan = locateCatalogEntry(FOLDED_CATALOG, entry.id);
      expect(scan.located).toBe(true);
      if (!scan.located) continue;
      expect(scan.entry.currentText.length).toBeGreaterThan(0);
      const stripEol = (t: string): string => t.replace(/\n$/, '');
      expect(stripEol(`  - ${scan.entry.currentText}`)).toBe(stripEol(entry.block));
    }
  });

  it('locateCatalogEntry_ZeroEntries_RefusesRatherThanReplacingNothing', () => {
    const scan = locateCatalogEntry('---\nschema-version: 3\ninvariants: []\n---\n', 'U-1');
    expect(scan.located).toBe(false);
    if (scan.located) return;
    expect(scan.reason).toMatch(/zero entries/);
  });

  it('locateCatalogEntry_IdAbsent_RefusesRatherThanWritingTheFileBackUnchanged', () => {
    const scan = locateCatalogEntry(FOLDED_CATALOG, 'U-404');
    expect(scan.located).toBe(false);
    if (scan.located) return;
    expect(scan.reason).toMatch(/match zero lines/);
  });

  /**
   * The locate is narrower than the id scan. An aliased entry has a readable id
   * but owns no node to rewrite, so the locate refuses it.
   */
  it('locateCatalogEntry_AliasedEntry_RefusesEvenThoughItsIdIsReadable', () => {
    const aliased = `---
schema-version: 3
anchors:
  base: &b
    id: U-1
    dimension: d
    axis: authoring
    cost-of-load: reference-only
    applies-to: []
    summary: s
    references: []
invariants:
  - *b
---
`;
    const scan = locateCatalogEntry(aliased, 'U-1');
    expect(scan.located).toBe(false);
    if (scan.located) return;
    expect(scan.reason).toMatch(/match zero lines/);
  });

  it('locateCatalogEntry_InvariantsIsNotASequence_Refuses', () => {
    const scan = locateCatalogEntry('---\ninvariants:\n  U-1: {}\n---\n', 'U-1');
    expect(scan.located).toBe(false);
    if (scan.located) return;
    expect(scan.reason).toMatch(/not a YAML sequence/);
  });

  it('locateCatalogEntry_UnparseableFrontmatter_Refuses', () => {
    const scan = locateCatalogEntry('---\ninvariants: [\n---\n', 'U-1');
    expect(scan.located).toBe(false);
    if (scan.located) return;
    expect(scan.reason).toMatch(/did not parse as YAML/);
  });
});

describe('invariants_amend — a write that would resolve zero entries fails', () => {
  /**
   * The id scan reads `U-1` off the aliased projection, so the handler passes its
   * not-found and empty-catalog checks. The locate stops it, and nothing is written.
   */
  it('handleAmend_AliasedEntry_FailsWithoutWriting', async () => {
    const aliased = `---
schema-version: 3
anchors:
  base: &b
    id: U-1
    dimension: d
    axis: authoring
    cost-of-load: reference-only
    applies-to: []
    summary: s
    references: []
invariants:
  - *b
---
`;
    const fake = makeFakeFs({ [CATALOG_ABS]: aliased });
    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'Corrected.' },
        dryRun: false,
      },
      makeCtx(),
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(fake.writes).toHaveLength(0);
    expect(fake.files.get(CATALOG_ABS)).toBe(aliased);
  });

  it('handleAmend_EmptyCatalog_FailsWithoutWriting', async () => {
    const fake = makeFakeFs({
      [CATALOG_ABS]: '---\nschema-version: 3\ninvariants: []\n---\n',
    });
    const result = await handleAmend(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'user',
        id: 'U-1',
        patch: { summary: 'Corrected.' },
        dryRun: false,
      },
      makeCtx(),
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(errorCode(result)).toBe('CATALOG_EMPTY');
    expect(fake.writes).toHaveLength(0);
  });
});

/**
 * `parseDocument` ranges are offsets into the exact string it receives, CRLF
 * included, and `splitCatalog` passes a substring of the original file. This
 * guard fails if a future `yaml` version normalizes line endings first.
 */
describe('invariants_amend — a CRLF checkout round-trips without corruption', () => {
  const crlf = (text: string): string => text.replace(/\n/g, '\r\n');

  /**
   * Line endings are the only difference, which also pins the bytes of the
   * amended entry. The amendment must land, so the check does not compare two
   * failed writes.
   */
  it('CatalogSplice_CrlfCatalog_MatchesTheLfWriteExactly', async () => {
    const patch = { summary: 'Corrected summary text.' };
    const lfRun = await amendAndRead(FOLDED_CATALOG, 'U-1', patch);
    const crlfRun = await amendAndRead(crlf(FOLDED_CATALOG), 'U-1', patch);

    expect(lfRun.result.success, JSON.stringify(lfRun.result)).toBe(true);
    expect(crlfRun.result.success, JSON.stringify(crlfRun.result)).toBe(true);

    expect(crlfRun.written).toBe(crlf(lfRun.written));

    expect(crlfRun.written).toContain('Corrected summary text.');
    expect(crlfRun.written).not.toContain('Original summary text');
    expect(/[^\r]\n/.test(crlfRun.written), 'a bare LF survived in a CRLF file').toBe(
      false,
    );
  });
});

/**
 * A rebuild from the `splitCatalog` parts drops trailing whitespace on the closing
 * fence line. It also cannot tell a missing final newline from an empty body. The
 * splice must carry each tail below through verbatim.
 */
describe('invariants_amend — the fence bytes survive shapes a rebuild normalises', () => {
  const variants: ReadonlyArray<{ readonly label: string; readonly tail: string }> = [
    {
      label: 'trailing spaces on the closing fence line',
      tail: '---   \n\n# Invariants\n\nProse body.\n',
    },
    { label: 'ends at the closing fence with no final newline', tail: '---' },
    { label: 'closing fence, newline, and nothing after it', tail: '---\n' },
  ];

  for (const { label, tail } of variants) {
    it(`CatalogSplice_${label.replace(/[^A-Za-z]/g, '')}_IsCarriedThroughVerbatim`, async () => {
      const catalog = HEAD + ENTRY_TARGET + ENTRY_FOLDED_A + ENTRY_FOLDED_B + tail;
      const { written, result } = await amendAndRead(catalog, 'U-1', {
        summary: 'Corrected summary text.',
      });

      expect(result.success, JSON.stringify(result)).toBe(true);
      const suffix = ENTRY_FOLDED_A + ENTRY_FOLDED_B + tail;
      expect(
        written.endsWith(suffix),
        `tail (${label}) was rewritten:\n${JSON.stringify(written.slice(-80))}`,
      ).toBe(true);
      expect(written.startsWith(HEAD)).toBe(true);
      expect(written).toContain('Corrected summary text.');
    });
  }
});

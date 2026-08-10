/**
 * Task 073 / DR-3 — an amendment writes back only the amended entry's lines.
 *
 * `invariants_amend` advertises itself as id-targeted and field-scoped, and
 * semantically it always was. What it was NOT was field-scoped in the FILE:
 * committing re-serialized the whole frontmatter document, so `yaml`'s
 * line-width folding re-wrapped folded scalars in entries the amendment never
 * named. Task 019's one-field edit to INV-17 came out as 69 inserts / 34
 * deletes, ~35 lines of which were cosmetic re-wrap of INV-2 and INV-11.
 *
 * 019 established that the drift is whitespace-only — parse before, parse
 * after, one semantic change, 21/21 entries intact. That is exactly why the
 * assertions here are made on RAW TEXT and not on the parsed form: a
 * parse-level comparison is blind to the entire defect. The catalog is a frozen
 * contract authority whose digest is taken over its raw bytes, so a collateral
 * re-wrap costs a contract re-approval just as much as the real edit does.
 *
 * The fixture is built by CONCATENATING hand-written blocks, so "the siblings
 * are byte-identical" can be asserted as `startsWith(prefix)` /
 * `endsWith(suffix)` against those exact bytes rather than by eyeballing a
 * diff. Two of the three entries carry folded scalars wrapped at a column the
 * serializer disagrees with — without them the whole-document round-trip is
 * indistinguishable from a splice and this file would pass against the writer
 * it was written to kill.
 */
// @oracle-sources: ./amend.js, the hand-written raw catalog bytes concatenated in this file
//
// One side is the production writer; the other is a block of bytes a human
// typed here, which no part of the writer has ever seen. Deliberately NOT
// declaring `./catalog-file.js` as the second authority: `amend.ts` imports it,
// so the static import graph makes them one authority wearing two names.
import { describe, it, expect } from 'vitest';

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { handleAmend } from './amend.js';
import { locateCatalogEntry } from './catalog-file.js';
import type { ScaffoldDeps } from './scaffold.js';
import { EXARCHOS_PACKAGE_NAME } from './reserved-tier-guard.js';
import { digestText } from '../../contract/authority-digest.js';

// ─── The kill fixture ────────────────────────────────────────────────────────

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
 * A sibling whose `summary` is a FOLDED scalar wrapped at 80 columns by a
 * human. Re-serializing the document re-folds it at the serializer's own
 * effective width and moves the line breaks — that is the whole defect, and
 * this block is the thing that must come out unchanged.
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

/** A second folded sibling, and the LAST entry — it owns the tail of the
 * frontmatter, where an off-by-one in the splice would show up as an inserted
 * blank line before the closing fence. */
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

// ─── Harness ─────────────────────────────────────────────────────────────────

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

function makeCtx(): DispatchContext {
  const ctx: unknown = {
    stateDir: '/tmp/state',
    enableTelemetry: false,
    eventStore: { append: async () => undefined },
  };
  // A structural check rather than a cast: the handler reads exactly these
  // three members, and asserting the shape would let a future field silently
  // arrive as `undefined`.
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

// ─── The kill fixture: raw text, not the parsed form ─────────────────────────

describe('invariants_amend — the write is a splice, proven on raw text (DR-3)', () => {
  it('handleAmend_OneField_LeavesEveryOtherByteOfTheFileIdentical', async () => {
    const { written, result } = await amendAndRead(FOLDED_CATALOG, 'U-1', {
      summary: 'Corrected summary text.',
    });
    expect(result.success).toBe(true);

    // ── The claim, stated on bytes ──
    // Everything before the amended entry, and everything after it — the YAML
    // comment, BOTH folded siblings, the closing fence and the prose body —
    // comes through unchanged. A document round-trip re-folds U-2 and U-3 and
    // fails both of these.
    expect(written.startsWith(HEAD)).toBe(true);
    expect(written.endsWith(ENTRY_FOLDED_A + ENTRY_FOLDED_B + TAIL)).toBe(true);

    // ...so the ONLY region that moved is the amended entry's own lines.
    const changed = written.slice(
      HEAD.length,
      written.length - (ENTRY_FOLDED_A + ENTRY_FOLDED_B + TAIL).length,
    );
    expect(changed).toContain('summary: Corrected summary text.');
    expect(changed).not.toContain('Original summary text');
    expect(changed).not.toContain('id: U-2');
    expect(changed).not.toContain('id: U-3');
  });

  it.each(ENTRIES)(
    'handleAmend_AmendingOneEntry_LeavesItsSiblingsByteIdentical: $id',
    async ({ id, prefix, suffix }) => {
      const { written, result } = await amendAndRead(FOLDED_CATALOG, id, {
        summary: `Corrected summary for ${id}.`,
      });
      expect(result.success).toBe(true);
      expect(written.startsWith(prefix)).toBe(true);
      expect(written.endsWith(suffix)).toBe(true);
      // Non-vacuity: the amendment did land, so the two assertions above are
      // not passing because nothing happened.
      expect(written).toContain(`Corrected summary for ${id}.`);
      expect(written).not.toBe(FOLDED_CATALOG);
    },
  );

  it('handleAmend_AmendingTheLastEntry_AddsNoBlankLineBeforeTheClosingFence', async () => {
    // The last entry's span runs to the end of the frontmatter with no trailing
    // newline inside the fences. A splice that always appends one would push a
    // blank line in front of `---` on every amendment of the final entry.
    const { written } = await amendAndRead(FOLDED_CATALOG, 'U-3', {
      summary: 'Corrected tail entry.',
    });
    expect(written).toContain('summary: Corrected tail entry.\n    references: []\n---\n');
    expect(written).not.toContain('\n\n---\n\n# Invariants');
  });

  it('handleAmend_PatchToTheSameValue_LeavesTheFileByteIdentical', async () => {
    // The crispest statement of "the digest moves for the amendment and for
    // nothing else": an amendment that changes no content changes no bytes. The
    // old writer moved every folded scalar in the document even for this.
    const { written, result } = await amendAndRead(FOLDED_CATALOG, 'U-1', {
      summary: 'Original summary text.',
    });
    expect(result.success).toBe(true);
    expect(written).toBe(FOLDED_CATALOG);
  });
});

// ─── The authority digest ────────────────────────────────────────────────────

describe('invariants_amend — the catalog digest moves for the amendment and nothing else', () => {
  it('handleAmend_WordingChange_MovesTheAuthorityDigest', async () => {
    // It SHOULD move: the catalog's wording is a load-bearing generation input,
    // and `authority-pin.ts` digests the raw file text precisely so a reworded
    // invariant cannot ride into a generated artifact unnoticed.
    const { written } = await amendAndRead(FOLDED_CATALOG, 'U-1', {
      summary: 'Corrected summary text.',
    });
    expect(digestText(written)).not.toBe(digestText(FOLDED_CATALOG));
  });

  it('handleAmend_RestoringTheAmendedEntrysBytes_RestoresTheOriginalDigest', async () => {
    // The digest movement is ATTRIBUTABLE: put the amended entry's original
    // bytes back into the file the writer produced, and the original digest
    // returns. It can only return if nothing outside that entry moved — under
    // the old writer the re-folded siblings keep the digest away from home.
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

// ─── The dry-run preview IS the write ────────────────────────────────────────

describe('invariants_amend — the dry-run diff names the lines the commit writes', () => {
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

    // The preview's `+` side is exactly the region the commit rewrites (the
    // `  - ` marker is not rewritten — the splice keeps it).
    expect(`  - ${added.join('\n')}\n`).toBe(changed);
    // ...and the `-` side is exactly the bytes that were there before.
    expect(`  - ${removed.join('\n')}\n`).toBe(ENTRY_TARGET);
  });
});

// ─── Non-empty denominator (DR-3 / DR-24) ────────────────────────────────────

describe('locateCatalogEntry — a locate that matches nothing REFUSES', () => {
  it('locateCatalogEntry_EveryEntry_ResolvesToANonEmptySpanOfItsOwnLines', () => {
    // The anti-vacuity arm for every refusal below: the locator really does
    // match lines on a real catalog, so a green refusal test is not green
    // because the locator matches nothing at all.
    for (const entry of ENTRIES) {
      const scan = locateCatalogEntry(FOLDED_CATALOG, entry.id);
      expect(scan.located).toBe(true);
      if (!scan.located) continue;
      expect(scan.entry.currentText.length).toBeGreaterThan(0);
      // The span is the entry's OWN lines: the `- ` marker sits outside it and
      // no sibling's bytes are inside it. Trailing newlines are normalised
      // because the LAST entry's span stops at the closing fence, which owns
      // the newline before it.
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

  it('locateCatalogEntry_AliasedEntry_RefusesEvenThoughItsIdIsReadable', () => {
    // The locate is deliberately NARROWER than the id scan: an aliased entry
    // resolves to a readable id through a projection but owns no node of its
    // own to rewrite. Splicing "the entry" would have to rewrite the anchor,
    // which is somebody else's text.
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

// ─── The handler refuses on the same terms ───────────────────────────────────

describe('invariants_amend — a write that would resolve zero entries fails', () => {
  it('handleAmend_AliasedEntry_FailsWithoutWriting', async () => {
    // End-to-end: the id scan can read `U-1` off the aliased projection, so the
    // handler gets past its own not-found and empty-catalog refusals; the
    // locate is what stops it. Nothing is written and nothing is reported as
    // amended.
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

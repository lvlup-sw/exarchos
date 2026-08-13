import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BINDING_MARKER_END,
  BINDING_MARKER_START,
  insertManagedBlock,
  type InsertManagedBlockDeps,
} from './managed-block.js';

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

let tmpDir: string;
let counter = 0;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-managed-block-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A fresh, unique file path inside the per-test tmp dir (not yet created). */
function freshPath(name = `f-${counter++}.md`): string {
  return path.join(tmpDir, name);
}

/** Count non-overlapping occurrences of `needle` in `hay`. */
function occurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** Everything OUTSIDE a single clean managed block (the consumer-owned bytes). */
function outsideContent(text: string): string {
  const s = text.indexOf(BINDING_MARKER_START);
  const e = text.indexOf(BINDING_MARKER_END);
  const oneStart = occurrences(text, BINDING_MARKER_START) === 1;
  const oneEnd = occurrences(text, BINDING_MARKER_END) === 1;
  if (oneStart && oneEnd && e > s) {
    return (text.slice(0, s) + text.slice(e + BINDING_MARKER_END.length)).trim();
  }
  return text.trim();
}

// ─── insertManagedBlock — core semantics ──────────────────────────────────────

describe('insertManagedBlock', () => {
  it('insertManagedBlock_IncompletePair_TreatsAbsentAppendsFresh', () => {
    const filePath = freshPath();
    // Only a START marker (a broken pair) plus consumer content.
    const original = `# Consumer notes\n${BINDING_MARKER_START}\nleftover fragment\n`;
    fs.writeFileSync(filePath, original, 'utf8');

    const result = insertManagedBlock({ filePath, content: 'Use Exarchos for SDLC.', provenance: 'binding.md' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Treated as ABSENT → append a fresh block, never claiming the stray marker.
    expect(result.action).toBe('created');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/incomplete|duplicated/i);

    const written = fs.readFileSync(filePath, 'utf8');
    // Original consumer content (and the stray marker) preserved verbatim.
    expect(written.startsWith(original)).toBe(true);
    expect(written).toContain('leftover fragment');
    // Exactly one END and a freshly-appended complete block now exist.
    expect(occurrences(written, BINDING_MARKER_END)).toBe(1);
    expect(occurrences(written, BINDING_MARKER_START)).toBe(2); // stray + fresh
    expect(written).toContain('Use Exarchos for SDLC.');
  });

  it('insertManagedBlock_SecondInsertOnMalformedFile_IdempotentNoAccumulation', () => {
    const filePath = freshPath();
    // A broken pair (stray START) beside consumer content — the malformed path.
    const original = `# Consumer notes\n${BINDING_MARKER_START}\nleftover fragment\n`;
    fs.writeFileSync(filePath, original, 'utf8');

    const first = insertManagedBlock({ filePath, content: 'Use Exarchos for SDLC.', provenance: 'binding.md' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.action).toBe('created');
    const afterFirst = fs.readFileSync(filePath, 'utf8');
    // First append leaves the file STILL malformed (stray START + our clean block).
    expect(occurrences(afterFirst, BINDING_MARKER_START)).toBe(2);
    expect(occurrences(afterFirst, BINDING_MARKER_END)).toBe(1);

    // Second insert with the SAME content must NOT stack another block (the
    // pre-fix bug: each run re-appends because locateBlock still sees 'malformed').
    let writes = 0;
    const second = insertManagedBlock(
      { filePath, content: 'Use Exarchos for SDLC.', provenance: 'binding.md' },
      { writeFileAtomic: () => { writes += 1; } },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe('unchanged'); // no-op: our block is already present
    expect(writes).toBe(0); // no write at all
    // No spurious "concurrent writer" round-trip warning on the no-op path.
    expect(second.warnings.join(' ')).not.toMatch(/concurrent writer/i);

    const afterSecond = fs.readFileSync(filePath, 'utf8');
    expect(afterSecond).toBe(afterFirst); // byte-identical — nothing accumulated
    // Still exactly ONE managed block (the stray START is unchanged; our block once).
    expect(occurrences(afterSecond, BINDING_MARKER_END)).toBe(1);
  });

  it('insertManagedBlock_IdenticalContent_NoWriteNoBackup', () => {
    const filePath = freshPath();
    // Seed a real block via a first (default-deps) insert.
    const seed = insertManagedBlock({ filePath, content: 'Same content', provenance: 'binding.md' });
    expect(seed.ok).toBe(true);
    const seededBytes = fs.readFileSync(filePath, 'utf8');

    // Second insert with identical content: assert NO write and NO backup happen.
    let writes = 0;
    let copies = 0;
    const deps: InsertManagedBlockDeps = {
      writeFileAtomic: () => {
        writes += 1;
      },
      copyFileSync: () => {
        copies += 1;
      },
    };
    const result = insertManagedBlock({ filePath, content: 'Same content', provenance: 'binding.md' }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('unchanged');
    expect(result.backupPath).toBeUndefined();
    expect(writes).toBe(0);
    expect(copies).toBe(0);
    // File bytes untouched.
    expect(fs.readFileSync(filePath, 'utf8')).toBe(seededBytes);
    // No backup file was created alongside.
    expect(fs.existsSync(`${filePath}.exarchos.bak`)).toBe(false);
  });

  it('insertManagedBlock_ChangedBlock_BacksUpOnceThenReplacesInPlace', () => {
    const filePath = freshPath();
    // Build a file with a v1 block AND surrounding consumer content.
    insertManagedBlock({ filePath, content: 'VERSION ONE', provenance: 'binding.md' });
    const withHeader = `TOP HEADER\n\n${fs.readFileSync(filePath, 'utf8')}\nBOTTOM FOOTER\n`;
    fs.writeFileSync(filePath, withHeader, 'utf8');
    const beforeReplace = fs.readFileSync(filePath, 'utf8');

    let copies = 0;
    const deps: InsertManagedBlockDeps = {
      copyFileSync: (src, dest) => {
        copies += 1;
        fs.copyFileSync(src, dest);
      },
    };
    const result = insertManagedBlock({ filePath, content: 'VERSION TWO', provenance: 'binding.md' }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('replaced');
    // Backed up EXACTLY once, to the returned path, with the pre-change bytes.
    expect(copies).toBe(1);
    expect(result.backupPath).toBe(`${filePath}.exarchos.bak`);
    expect(fs.readFileSync(result.backupPath!, 'utf8')).toBe(beforeReplace);

    const after = fs.readFileSync(filePath, 'utf8');
    // Block replaced in place; surrounding content untouched.
    expect(after).toContain('VERSION TWO');
    expect(after).not.toContain('VERSION ONE');
    expect(after).toContain('TOP HEADER');
    expect(after).toContain('BOTTOM FOOTER');
    expect(occurrences(after, BINDING_MARKER_START)).toBe(1);
    expect(occurrences(after, BINDING_MARKER_END)).toBe(1);
    // Consumer-owned bytes are byte-invariant across the replace.
    expect(outsideContent(after)).toBe(outsideContent(beforeReplace));
  });

  it('insertManagedBlock_CrlfFile_PreservesLineEndings', () => {
    const filePath = freshPath();
    // A CRLF consumer file.
    fs.writeFileSync(filePath, `# Header\r\nsome consumer text\r\n`, 'utf8');

    const result = insertManagedBlock({
      filePath,
      content: 'Line A\nLine B',
      provenance: 'binding.md',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lineEnding).toBe('crlf');

    const written = fs.readFileSync(filePath, 'utf8');
    // Every newline is a CRLF — after stripping all CRLF, no stray LF remains.
    expect(written.split('\r\n').join('').includes('\n')).toBe(false);
    // Block markers present with CRLF; internal content LF was normalized to CRLF.
    expect(written).toContain(`${BINDING_MARKER_START}\r\n`);
    expect(written).toContain(`Line A\r\nLine B`);
  });

  it('insertManagedBlock_MissingFile_CreatesWithBlock', () => {
    const filePath = freshPath('does-not-exist-yet.md');
    expect(fs.existsSync(filePath)).toBe(false);

    const result = insertManagedBlock({ filePath, content: 'Fresh block body', provenance: 'binding.md' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('created');
    expect(result.lineEnding).toBe('lf');

    const written = fs.readFileSync(filePath, 'utf8');
    // File contains ONLY the block (one clean pair, nothing outside it).
    expect(occurrences(written, BINDING_MARKER_START)).toBe(1);
    expect(occurrences(written, BINDING_MARKER_END)).toBe(1);
    expect(written.trim().startsWith(BINDING_MARKER_START)).toBe(true);
    expect(written.trim().endsWith(BINDING_MARKER_END)).toBe(true);
    expect(written).toContain('Fresh block body');
    expect(outsideContent(written)).toBe('');
  });

  it('insertManagedBlock_UnwritableTarget_StructuredError', () => {
    const filePath = freshPath('unwritable.md');
    const deps: InsertManagedBlockDeps = {
      writeFileAtomic: () => {
        throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
      },
    };

    const result = insertManagedBlock({ filePath, content: 'body', provenance: 'binding.md' }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MANAGED_BLOCK_WRITE_FAILED');
    expect(result.error.suggestedFix).toBeTruthy();
    expect(result.error.suggestedFix.length).toBeGreaterThan(0);
    expect(result.error.cause).toContain('EACCES');
    // The failed write left no file behind.
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('insertManagedBlock_Provenance_LineInsideBlock', () => {
    const filePath = freshPath();
    const result = insertManagedBlock({ filePath, content: 'B', provenance: 'binding.md v9' });
    expect(result.ok).toBe(true);
    const written = fs.readFileSync(filePath, 'utf8');
    // Provenance descriptor + a content hash live inside the fenced region.
    expect(written).toContain('exarchos-managed:');
    expect(written).toContain('binding.md v9');
    expect(written).toMatch(/content-sha256:[0-9a-f]{16}/);
  });
});

// ─── Cross-package equality guard ─────────────────────────────────────────────

describe('fence constants', () => {
  it('fenceConstants_MatchRootBindingSource', () => {
    // Read the ROOT package's binding.ts SOURCE TEXT (no runtime import — the MCP
    // server cannot import across the package boundary; this catches drift).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rootBindingPath = path.resolve(here, '../binding.ts');
    const source = fs.readFileSync(rootBindingPath, 'utf8');

    const startLiteral = source.match(/BINDING_MARKER_START\s*=\s*'([^']*)'/)?.[1];
    const endLiteral = source.match(/BINDING_MARKER_END\s*=\s*'([^']*)'/)?.[1];

    // Guard against a regex miss producing a vacuous pass.
    expect(startLiteral).toBeTruthy();
    expect(endLiteral).toBeTruthy();

    expect(startLiteral).toBe(BINDING_MARKER_START);
    expect(endLiteral).toBe(BINDING_MARKER_END);
  });
});

// ─── Property: consumer-owned content is invariant ────────────────────────────

describe('managed block properties', () => {
  it('outsideContent_InvariantUnderAnyBlockOperationSequence', () => {
    // Consumer content and block payloads never embed the Exarchos markers.
    const noMarker = (s: string): boolean => !s.includes('exarchos:binding');
    const arbConsumer = fc.string({ maxLength: 200 }).filter(noMarker);
    const arbPayloads = fc.array(fc.string({ maxLength: 120 }).filter(noMarker), {
      minLength: 1,
      maxLength: 5,
    });

    fc.assert(
      fc.property(arbConsumer, arbPayloads, (consumer, payloads) => {
        const filePath = freshPath(`prop-${counter++}.md`);
        fs.writeFileSync(filePath, consumer, 'utf8');

        for (const payload of payloads) {
          const result = insertManagedBlock({ filePath, content: payload, provenance: 'binding.md' });
          expect(result.ok).toBe(true);
        }

        const final = fs.readFileSync(filePath, 'utf8');
        // Consumer-owned bytes survive ANY sequence of block operations.
        expect(outsideContent(final)).toBe(consumer.trim());
        // Never accumulates: exactly one clean block always.
        expect(occurrences(final, BINDING_MARKER_START)).toBe(1);
        expect(occurrences(final, BINDING_MARKER_END)).toBe(1);
      }),
      { numRuns: 60 },
    );
  });
});

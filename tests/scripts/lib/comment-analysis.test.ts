/**
 * @fileoverview Tests for the analysis that every comment rule shares.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadPolicy } from '../../../tools/audit/lib/comment-policy.mjs';
import { fingerprint, type CommentBlock } from '../../../tools/audit/lib/comment-baseline.mjs';
import { analyzeFile, liveEntries, CONTENT_RULE } from '../../../tools/audit/lib/comment-analysis.mjs';

const policy = loadPolicy(path.resolve(import.meta.dirname, '../../../.exarchos/comment-policy.json'));

/** A one-line block at a given line. */
function block(raw: string, line: number): CommentBlock {
  return { kind: 'line', ownLine: true, start: line * 100, end: line * 100 + raw.length, line, endLine: line, raw, text: raw.replace(/^\/\/\s?/, '') };
}

describe('analyzeFile', () => {
  it('AnalyzeFile_ContentViolation_IsAFindingOfTheContentRule', () => {
    const { analyzed } = analyzeFile({ relPath: 'src/a.ts', blocks: [block('// DR-7 needs this', 1)], policy, entries: undefined });

    expect(analyzed[0]?.findings.map((f) => [f.rule, f.checkId])).toEqual([[CONTENT_RULE, 'design-requirement']]);
    expect(analyzed[0]?.suppressed).toBe(false);
  });

  it('AnalyzeFile_ExemptPath_HasNoContentFindings', () => {
    const { analyzed } = analyzeFile({
      relPath: 'tools/audit/__fixtures__/comment-hygiene/offenders.ts',
      blocks: [block('// DR-7 needs this', 1)],
      policy,
      entries: undefined,
    });

    expect(analyzed[0]?.findings).toEqual([]);
  });

  it('AnalyzeFile_BaselineCount_SuppressesOnlyThatManyViolatingCopies', () => {
    const raw = '// DR-7 needs this';
    const entries = new Map([[fingerprint(raw), 1]]);
    const { analyzed } = analyzeFile({ relPath: 'src/a.ts', blocks: [block(raw, 1), block(raw, 2)], policy, entries });

    expect(analyzed.map((item) => item.suppressed)).toEqual([true, false]);
  });

  it('AnalyzeFile_EntryWithoutAViolatingBlock_IsStale', () => {
    const entries = new Map([[fingerprint('// DR-7 needs this'), 2]]);
    const { stale } = analyzeFile({ relPath: 'src/a.ts', blocks: [block('// DR-7 needs this', 1)], policy, entries });

    expect(stale).toEqual([{ hash: fingerprint('// DR-7 needs this'), count: 2, live: 1 }]);
  });

  it('LiveEntries_CountsViolatingBlocksPerHash', () => {
    const raw = '// DR-7 needs this';
    const { analyzed } = analyzeFile({ relPath: 'src/a.ts', blocks: [block(raw, 1), block(raw, 2), block('// clean', 3)], policy, entries: undefined });

    expect(liveEntries(analyzed)).toEqual(new Map([[fingerprint(raw), 2]]));
  });
});

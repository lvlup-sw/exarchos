import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadDataset } from './dataset-loader.js';
import type { EvalCase } from './types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

function tmpFile(name: string): string {
  return path.join(tmpDir, name);
}

function makeCase(overrides: Partial<EvalCase> & { id: string }): EvalCase {
  return {
    type: 'single',
    description: `Case ${overrides.id}`,
    input: { data: 'test' },
    expected: { output: 'expected' },
    tags: [],
    ...overrides,
  };
}

function toJsonl(cases: EvalCase[]): string {
  return cases.map((c) => JSON.stringify(c)).join('\n');
}

// ─── Setup/Teardown ─────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-dataset-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Unit Tests ─────────────────────────────────────────────────────────────

describe('loadDataset', () => {
  it('LoadDataset_ValidJsonl_ReturnsAllCases', async () => {
    // Arrange
    const cases = [makeCase({ id: 'c-1' }), makeCase({ id: 'c-2' })];
    await fs.writeFile(tmpFile('data.jsonl'), toJsonl(cases));

    // Act
    const result = await loadDataset(tmpFile('data.jsonl'));

    // Assert
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('c-1');
    expect(result[1].id).toBe('c-2');
  });

  it('LoadDataset_InvalidJson_ThrowsWithLineNumber', async () => {
    // Arrange
    const lines = [
      JSON.stringify(makeCase({ id: 'c-1' })),
      '{ not valid json }',
    ];
    await fs.writeFile(tmpFile('bad.jsonl'), lines.join('\n'));

    // Act & Assert
    await expect(loadDataset(tmpFile('bad.jsonl'))).rejects.toThrow(/line 2/i);
  });

  it('LoadDataset_SchemaViolation_ThrowsWithFieldAndLineNumber', async () => {
    // Arrange — missing required 'type' field
    const lines = [
      JSON.stringify({ id: 'c-1', description: 'test', input: {}, expected: {} }),
    ];
    await fs.writeFile(tmpFile('schema-bad.jsonl'), lines.join('\n'));

    // Act & Assert
    await expect(loadDataset(tmpFile('schema-bad.jsonl'))).rejects.toThrow(/line 1/i);
    await expect(loadDataset(tmpFile('schema-bad.jsonl'))).rejects.toThrow(/type/i);
  });

  it('LoadDataset_TagFilter_ReturnsOnlyMatchingCases', async () => {
    // Arrange
    const cases = [
      makeCase({ id: 'c-1', tags: ['regression'] }),
      makeCase({ id: 'c-2', tags: ['smoke'] }),
      makeCase({ id: 'c-3', tags: ['regression', 'smoke'] }),
    ];
    await fs.writeFile(tmpFile('tags.jsonl'), toJsonl(cases));

    // Act
    const result = await loadDataset(tmpFile('tags.jsonl'), { tags: ['smoke'] });

    // Assert
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(['c-2', 'c-3']);
  });

  it('LoadDataset_TagFilter_NoMatches_ReturnsEmptyArray', async () => {
    // Arrange
    const cases = [makeCase({ id: 'c-1', tags: ['regression'] })];
    await fs.writeFile(tmpFile('no-match.jsonl'), toJsonl(cases));

    // Act
    const result = await loadDataset(tmpFile('no-match.jsonl'), { tags: ['nonexistent'] });

    // Assert
    expect(result).toEqual([]);
  });

  it('LoadDataset_EmptyFile_ReturnsEmptyArray', async () => {
    // Arrange
    await fs.writeFile(tmpFile('empty.jsonl'), '');

    // Act
    const result = await loadDataset(tmpFile('empty.jsonl'));

    // Assert
    expect(result).toEqual([]);
  });

  it('LoadDataset_FileNotFound_ThrowsError', async () => {
    // Act & Assert
    await expect(loadDataset(tmpFile('nonexistent.jsonl'))).rejects.toThrow();
  });

  it('LoadDataset_BlankLines_SkipsGracefully', async () => {
    // Arrange
    const case1 = JSON.stringify(makeCase({ id: 'c-1' }));
    const case2 = JSON.stringify(makeCase({ id: 'c-2' }));
    const content = `${case1}\n\n   \n${case2}\n\n`;
    await fs.writeFile(tmpFile('blanks.jsonl'), content);

    // Act
    const result = await loadDataset(tmpFile('blanks.jsonl'));

    // Assert
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('c-1');
    expect(result[1].id).toBe('c-2');
  });

  it('LoadDataset_MultipleValidCases_ReturnsAll', async () => {
    // Arrange
    const cases = Array.from({ length: 10 }, (_, i) =>
      makeCase({ id: `c-${i + 1}` })
    );
    await fs.writeFile(tmpFile('many.jsonl'), toJsonl(cases));

    // Act
    const result = await loadDataset(tmpFile('many.jsonl'));

    // Assert
    expect(result).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(result[i].id).toBe(`c-${i + 1}`);
    }
  });
});

// ─── Real Dataset Loading Tests ──────────────────────────────────────────────

describe('loadDataset_RealDatasets', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const REPO_EVALS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'evals');

  it('LoadDataset_BrainstormingGolden_ParsesWithoutErrors', async () => {
    const cases = await loadDataset(path.join(REPO_EVALS_DIR, 'brainstorming', 'datasets', 'golden.jsonl'));
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  it('LoadDataset_ImplementationPlanningGolden_ParsesWithoutErrors', async () => {
    const cases = await loadDataset(path.join(REPO_EVALS_DIR, 'implementation-planning', 'datasets', 'golden.jsonl'));
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  it('LoadDataset_RefactorGolden_ParsesWithoutErrors', async () => {
    const cases = await loadDataset(path.join(REPO_EVALS_DIR, 'refactor', 'datasets', 'golden.jsonl'));
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  it('LoadDataset_DebugGolden_ParsesWithoutErrors', async () => {
    const cases = await loadDataset(path.join(REPO_EVALS_DIR, 'debug', 'datasets', 'golden.jsonl'));
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Property Tests ─────────────────────────────────────────────────────────

describe('loadDataset Property Tests', () => {
  const arbEvalCaseType = fc.constantFrom('single' as const, 'trace' as const);

  const arbEvalCase = fc.record({
    id: fc.string({ minLength: 1 }).filter((s) => !s.includes('\n') && !s.includes('\r')),
    type: arbEvalCaseType,
    description: fc.string().filter((s) => !s.includes('\n') && !s.includes('\r')),
    input: fc.constant({ data: 'test' } as Record<string, unknown>),
    expected: fc.constant({ output: 'expected' } as Record<string, unknown>),
    tags: fc.array(fc.string().filter((s) => !s.includes('\n') && !s.includes('\r'))),
  });

  it('Roundtrip_ValidEvalCases_SerializedAndLoadedEqualsOriginal', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbEvalCase, { minLength: 1, maxLength: 5 }), async (cases) => {
        const filePath = tmpFile(`roundtrip-${Date.now()}-${Math.random()}.jsonl`);
        const jsonl = cases.map((c) => JSON.stringify(c)).join('\n');
        await fs.writeFile(filePath, jsonl);

        const loaded = await loadDataset(filePath);

        expect(loaded).toHaveLength(cases.length);
        for (let i = 0; i < cases.length; i++) {
          expect(loaded[i].id).toBe(cases[i].id);
          expect(loaded[i].type).toBe(cases[i].type);
          expect(loaded[i].description).toBe(cases[i].description);
          expect(loaded[i].input).toEqual(cases[i].input);
          expect(loaded[i].expected).toEqual(cases[i].expected);
          expect(loaded[i].tags).toEqual(cases[i].tags);
        }
      }),
      { numRuns: 20 }
    );
  });

  it('Idempotence_LoadingSameFileTwice_ProducesIdenticalResults', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbEvalCase, { minLength: 1, maxLength: 5 }), async (cases) => {
        const filePath = tmpFile(`idempotent-${Date.now()}-${Math.random()}.jsonl`);
        const jsonl = cases.map((c) => JSON.stringify(c)).join('\n');
        await fs.writeFile(filePath, jsonl);

        const first = await loadDataset(filePath);
        const second = await loadDataset(filePath);

        expect(first).toEqual(second);
      }),
      { numRuns: 20 }
    );
  });
});

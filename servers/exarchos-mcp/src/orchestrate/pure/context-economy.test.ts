import { describe, it, expect } from 'vitest';
import {
  checkContextEconomy,
  type ContextEconomyResult,
  type ContextEconomyFinding,
} from './context-economy.js';

/**
 * Helper to build a minimal unified diff from file content.
 * Simulates `git diff` output with one file and all lines added.
 */
function makeDiff(fileName: string, lines: string[]): string {
  const header = `diff --git a/${fileName} b/${fileName}
--- /dev/null
+++ b/${fileName}
@@ -0,0 +1,${lines.length} @@`;
  const body = lines.map((l) => `+${l}`).join('\n');
  return `${header}\n${body}`;
}

/**
 * Helper to build a unified diff with multiple files.
 */
function makeMultiFileDiff(
  files: Array<{ name: string; lines: string[] }>,
): string {
  return files.map((f) => makeDiff(f.name, f.lines)).join('\n');
}

describe('checkContextEconomy', () => {
  // ----------------------------------------------------------
  // Input validation
  // ----------------------------------------------------------

  describe('input validation', () => {
    it('returns pass with empty diff', () => {
      const result = checkContextEconomy('');
      expect(result.pass).toBe(true);
      expect(result.findings).toHaveLength(0);
    });

    it('handles whitespace-only diff', () => {
      const result = checkContextEconomy('   \n  \n  ');
      expect(result.pass).toBe(true);
      expect(result.findings).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Check 1: Source file length (>400 added lines for .ts/.js)
  // ----------------------------------------------------------

  describe('source file length', () => {
    it('passes when added lines are within budget (400 lines)', () => {
      const lines = Array.from({ length: 400 }, (_, i) => `const x${i} = ${i};`);
      const diff = makeDiff('src/small.ts', lines);
      const result = checkContextEconomy(diff);

      const fileLengthFindings = result.findings.filter((f) =>
        f.message.includes('exceeds 400 lines'),
      );
      expect(fileLengthFindings).toHaveLength(0);
    });

    it('flags .ts files exceeding 400 added lines', () => {
      const lines = Array.from({ length: 401 }, (_, i) => `const x${i} = ${i};`);
      const diff = makeDiff('src/big-file.ts', lines);
      const result = checkContextEconomy(diff);

      expect(result.pass).toBe(false);
      const finding = result.findings.find((f) =>
        f.message.includes('exceeds 400 lines'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('MEDIUM');
      expect(finding!.message).toContain('big-file.ts');
      expect(finding!.message).toContain('401');
    });

    it('flags .js files exceeding 400 added lines', () => {
      const lines = Array.from({ length: 450 }, (_, i) => `var x${i} = ${i};`);
      const diff = makeDiff('lib/legacy.js', lines);
      const result = checkContextEconomy(diff);

      const finding = result.findings.find((f) =>
        f.message.includes('exceeds 400 lines'),
      );
      expect(finding).toBeDefined();
      expect(finding!.message).toContain('legacy.js');
    });

    it('ignores non-ts/js files even if they exceed 400 lines', () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
      const diff = makeDiff('README.md', lines);
      const result = checkContextEconomy(diff);

      const fileLengthFindings = result.findings.filter((f) =>
        f.message.includes('exceeds 400 lines'),
      );
      expect(fileLengthFindings).toHaveLength(0);
    });

    it('counts only added lines (lines starting with +), not context or removed', () => {
      // Build a diff where the raw added lines exceed 400 but the +lines don't
      const diffContent = `diff --git a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,200 +1,200 @@
${Array.from({ length: 200 }, (_, i) => `-const old${i} = ${i};`).join('\n')}
${Array.from({ length: 200 }, (_, i) => `+const new${i} = ${i};`).join('\n')}
${Array.from({ length: 300 }, (_, i) => ` const ctx${i} = ${i};`).join('\n')}`;

      const result = checkContextEconomy(diffContent);
      const fileLengthFindings = result.findings.filter((f) =>
        f.message.includes('exceeds 400 lines'),
      );
      expect(fileLengthFindings).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Check 2: Function/method length (>80 lines) - diff-mode skip
  // ----------------------------------------------------------

  describe('function length', () => {
    it('skips function length check in diff-only mode (no repo root)', () => {
      // In diff-only mode, function length checking is skipped
      // because it requires access to actual files for brace analysis
      const lines = Array.from({ length: 100 }, (_, i) => `  console.log(${i});`);
      const allLines = [
        'export function bigFunction() {',
        ...lines,
        '}',
      ];
      const diff = makeDiff('src/file.ts', allLines);
      const result = checkContextEconomy(diff);

      // Should not produce a function length finding in diff-only mode
      const funcFindings = result.findings.filter((f) =>
        f.message.includes('Function/method'),
      );
      expect(funcFindings).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Check 3: Diff breadth (>30 files changed)
  // ----------------------------------------------------------

  describe('diff breadth', () => {
    it('passes when 30 or fewer files changed', () => {
      const files = Array.from({ length: 30 }, (_, i) => ({
        name: `src/file${i}.ts`,
        lines: ['const x = 1;'],
      }));
      const diff = makeMultiFileDiff(files);
      const result = checkContextEconomy(diff);

      const breadthFindings = result.findings.filter((f) =>
        f.message.includes('Diff breadth'),
      );
      expect(breadthFindings).toHaveLength(0);
    });

    it('flags when more than 30 files changed', () => {
      const files = Array.from({ length: 31 }, (_, i) => ({
        name: `src/file${i}.ts`,
        lines: ['const x = 1;'],
      }));
      const diff = makeMultiFileDiff(files);
      const result = checkContextEconomy(diff);

      expect(result.pass).toBe(false);
      const finding = result.findings.find((f) =>
        f.message.includes('Diff breadth'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('MEDIUM');
      expect(finding!.message).toContain('31');
      expect(finding!.message).toContain('30');
    });

    it('exactly 30 files does not trigger finding (boundary)', () => {
      const files = Array.from({ length: 30 }, (_, i) => ({
        name: `src/file${i}.ts`,
        lines: ['const x = 1;'],
      }));
      const diff = makeMultiFileDiff(files);
      const result = checkContextEconomy(diff);

      const breadthFindings = result.findings.filter((f) =>
        f.message.includes('Diff breadth'),
      );
      expect(breadthFindings).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Check 4: Large generated files (>1000 added lines with marker)
  // ----------------------------------------------------------

  describe('large generated files', () => {
    it('flags files with >1000 added lines and auto-generated marker', () => {
      const lines = [
        '// AUTO-GENERATED - do not edit',
        ...Array.from({ length: 1001 }, (_, i) => `export const val${i} = ${i};`),
      ];
      const diff = makeDiff('src/generated-types.ts', lines);
      const result = checkContextEconomy(diff);

      const finding = result.findings.find((f) =>
        f.message.includes('Generated file'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('LOW');
    });

    it('flags files with >1000 added lines even without marker as possible generated', () => {
      const lines = Array.from(
        { length: 1001 },
        (_, i) => `export const val${i} = ${i};`,
      );
      const diff = makeDiff('src/huge.ts', lines);
      const result = checkContextEconomy(diff);

      const finding = result.findings.find(
        (f) => f.message.includes('possible generated file'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('LOW');
      expect(finding!.message).toContain('1001');
    });

    it('does not flag files with 1000 or fewer added lines', () => {
      const lines = Array.from(
        { length: 1000 },
        (_, i) => `export const val${i} = ${i};`,
      );
      const diff = makeDiff('src/big-but-ok.ts', lines);
      const result = checkContextEconomy(diff);

      const generatedFindings = result.findings.filter(
        (f) =>
          f.message.includes('Generated file') ||
          f.message.includes('possible generated'),
      );
      expect(generatedFindings).toHaveLength(0);
    });

    it('detects various auto-generated markers', () => {
      const markers = [
        '// @generated',
        '/* Auto-Generated */',
        '// DO NOT EDIT',
        '// generated by protobuf',
        '// This file is generated',
        '// Machine generated',
      ];

      for (const marker of markers) {
        const lines = [
          marker,
          ...Array.from({ length: 1001 }, (_, i) => `const x${i} = ${i};`),
        ];
        const diff = makeDiff('src/gen.ts', lines);
        const result = checkContextEconomy(diff);

        const finding = result.findings.find((f) =>
          f.message.includes('Generated file'),
        );
        expect(finding).toBeDefined();
      }
    });
  });

  // ----------------------------------------------------------
  // File-level aggregation
  // ----------------------------------------------------------

  describe('file-level aggregation', () => {
    it('aggregates findings across multiple files', () => {
      const files = [
        {
          name: 'src/big1.ts',
          lines: Array.from({ length: 450 }, (_, i) => `const a${i} = ${i};`),
        },
        {
          name: 'src/big2.ts',
          lines: Array.from({ length: 500 }, (_, i) => `const b${i} = ${i};`),
        },
        {
          name: 'src/small.ts',
          lines: ['const x = 1;'],
        },
      ];
      const diff = makeMultiFileDiff(files);
      const result = checkContextEconomy(diff);

      const fileLengthFindings = result.findings.filter((f) =>
        f.message.includes('exceeds 400 lines'),
      );
      expect(fileLengthFindings).toHaveLength(2);
    });
  });

  // ----------------------------------------------------------
  // Result structure
  // ----------------------------------------------------------

  describe('result structure', () => {
    it('returns checksRun and checksPassed counts', () => {
      const diff = makeDiff('src/small.ts', ['const x = 1;']);
      const result = checkContextEconomy(diff);

      expect(result.checksRun).toBeGreaterThan(0);
      expect(result.checksPassed).toBeLessThanOrEqual(result.checksRun);
      expect(typeof result.pass).toBe('boolean');
      expect(Array.isArray(result.findings)).toBe(true);
    });

    it('pass is true when no findings', () => {
      const diff = makeDiff('src/clean.ts', ['const x = 1;']);
      const result = checkContextEconomy(diff);
      expect(result.pass).toBe(true);
      expect(result.findings).toHaveLength(0);
    });

    it('pass is false when findings exist', () => {
      const lines = Array.from({ length: 401 }, (_, i) => `const x${i} = ${i};`);
      const diff = makeDiff('src/big.ts', lines);
      const result = checkContextEconomy(diff);
      expect(result.pass).toBe(false);
      expect(result.findings.length).toBeGreaterThan(0);
    });

    it('findings have severity and message fields', () => {
      const lines = Array.from({ length: 401 }, (_, i) => `const x${i} = ${i};`);
      const diff = makeDiff('src/big.ts', lines);
      const result = checkContextEconomy(diff);

      for (const finding of result.findings) {
        expect(finding.severity).toMatch(/^(HIGH|MEDIUM|LOW)$/);
        expect(typeof finding.message).toBe('string');
        expect(finding.message.length).toBeGreaterThan(0);
      }
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  checkOperationalResilience,
  type OperationalResilienceResult,
  type OperationalResilienceFinding,
} from './operational-resilience.js';

/**
 * Helper to build a minimal unified diff from file content.
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

describe('checkOperationalResilience', () => {
  // ----------------------------------------------------------
  // Input validation
  // ----------------------------------------------------------

  describe('input validation', () => {
    it('returns pass with empty diff', () => {
      const result = checkOperationalResilience('');
      expect(result.pass).toBe(true);
      expect(result.findings).toHaveLength(0);
    });

    it('handles whitespace-only diff', () => {
      const result = checkOperationalResilience('   \n  \n  ');
      expect(result.pass).toBe(true);
      expect(result.findings).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Check 1: Empty catch blocks
  // ----------------------------------------------------------

  describe('empty catch blocks', () => {
    it('detects empty catch block: catch (e) { }', () => {
      const lines = [
        'try {',
        '  doSomething();',
        '} catch (e) { }',
      ];
      const diff = makeDiff('src/handler.ts', lines);
      const result = checkOperationalResilience(diff);

      expect(result.pass).toBe(false);
      const finding = result.findings.find((f) =>
        f.message.includes('Empty catch block'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('HIGH');
      expect(finding!.message).toContain('handler.ts');
    });

    it('detects empty catch block without parameter: catch { }', () => {
      const lines = [
        'try {',
        '  doSomething();',
        '} catch { }',
      ];
      const diff = makeDiff('src/handler.ts', lines);
      const result = checkOperationalResilience(diff);

      const finding = result.findings.find((f) =>
        f.message.includes('Empty catch block'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('HIGH');
    });

    it('does not flag catch blocks with body', () => {
      const lines = [
        'try {',
        '  doSomething();',
        '} catch (e) {',
        '  console.error(e);',
        '}',
      ];
      const diff = makeDiff('src/handler.ts', lines);
      const result = checkOperationalResilience(diff);

      const emptyCatchFindings = result.findings.filter((f) =>
        f.message.includes('Empty catch block'),
      );
      expect(emptyCatchFindings).toHaveLength(0);
    });

    it('detects empty catch blocks in .js files', () => {
      const lines = [
        'try { doSomething(); } catch (err) {}',
      ];
      const diff = makeDiff('src/legacy.js', lines);
      const result = checkOperationalResilience(diff);

      const finding = result.findings.find((f) =>
        f.message.includes('Empty catch block'),
      );
      expect(finding).toBeDefined();
    });

    it('ignores non-source files', () => {
      const lines = [
        'try { doSomething(); } catch (e) { }',
      ];
      const diff = makeDiff('docs/example.md', lines);
      const result = checkOperationalResilience(diff);

      const emptyCatchFindings = result.findings.filter((f) =>
        f.message.includes('Empty catch block'),
      );
      expect(emptyCatchFindings).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Check 2: Swallowed errors (catch without rethrow/log/return)
  // ----------------------------------------------------------

  describe('swallowed errors', () => {
    it('detects catch block without throw/console/return', () => {
      const lines = [
        'try {',
        '  doSomething();',
        '} catch (e) {',
        '  const x = 1;',
        '}',
      ];
      const diff = makeDiff('src/service.ts', lines);
      const result = checkOperationalResilience(diff);

      const finding = result.findings.find((f) =>
        f.message.includes('swallowed error'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('MEDIUM');
      expect(finding!.message).toContain('service.ts');
    });

    it('does not flag catch block that rethrows', () => {
      const lines = [
        'try {',
        '  doSomething();',
        '} catch (e) {',
        '  throw new Error("wrapped", { cause: e });',
        '}',
      ];
      const diff = makeDiff('src/service.ts', lines);
      const result = checkOperationalResilience(diff);

      const swallowedFindings = result.findings.filter((f) =>
        f.message.includes('swallowed error'),
      );
      expect(swallowedFindings).toHaveLength(0);
    });

    it('does not flag catch block that logs with console.error', () => {
      const lines = [
        'try {',
        '  doSomething();',
        '} catch (e) {',
        '  console.error("failed:", e);',
        '}',
      ];
      const diff = makeDiff('src/service.ts', lines);
      const result = checkOperationalResilience(diff);

      const swallowedFindings = result.findings.filter((f) =>
        f.message.includes('swallowed error'),
      );
      expect(swallowedFindings).toHaveLength(0);
    });

    it('does not flag catch block with reject call', () => {
      const lines = [
        'try {',
        '  doSomething();',
        '} catch (e) {',
        '  reject(e);',
        '}',
      ];
      const diff = makeDiff('src/service.ts', lines);
      const result = checkOperationalResilience(diff);

      const swallowedFindings = result.findings.filter((f) =>
        f.message.includes('swallowed error'),
      );
      expect(swallowedFindings).toHaveLength(0);
    });

    it('does not double-report empty catch blocks as swallowed errors', () => {
      const lines = [
        'try { doSomething(); } catch (e) { }',
      ];
      const diff = makeDiff('src/handler.ts', lines);
      const result = checkOperationalResilience(diff);

      // Should have empty catch finding but NOT swallowed error finding
      const emptyCatch = result.findings.filter((f) =>
        f.message.includes('Empty catch block'),
      );
      const swallowed = result.findings.filter((f) =>
        f.message.includes('swallowed error'),
      );
      expect(emptyCatch).toHaveLength(1);
      expect(swallowed).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Check 3: console.log in non-test source files
  // ----------------------------------------------------------

  describe('console.log in production code', () => {
    it('flags console.log in source files', () => {
      const lines = [
        'export function process(data: string) {',
        '  console.log("processing:", data);',
        '  return data.toUpperCase();',
        '}',
      ];
      const diff = makeDiff('src/processor.ts', lines);
      const result = checkOperationalResilience(diff);

      const finding = result.findings.find((f) =>
        f.message.includes('console.log'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('MEDIUM');
      expect(finding!.message).toContain('processor.ts');
    });

    it('excludes test files from console.log check', () => {
      const lines = [
        'it("should work", () => {',
        '  console.log("debug output");',
        '  expect(true).toBe(true);',
        '});',
      ];
      const testFiles = [
        'src/processor.test.ts',
        'src/processor.spec.ts',
        'src/__tests__/processor.ts',
        'tests/processor.test.js',
      ];

      for (const testFile of testFiles) {
        const diff = makeDiff(testFile, lines);
        const result = checkOperationalResilience(diff);

        const consoleFindings = result.findings.filter((f) =>
          f.message.includes('console.log'),
        );
        expect(consoleFindings).toHaveLength(0);
      }
    });

    it('does not flag console.error or console.warn', () => {
      const lines = [
        'export function process() {',
        '  console.error("something went wrong");',
        '  console.warn("deprecated usage");',
        '}',
      ];
      const diff = makeDiff('src/processor.ts', lines);
      const result = checkOperationalResilience(diff);

      const consoleLogFindings = result.findings.filter((f) =>
        f.message.includes('console.log'),
      );
      expect(consoleLogFindings).toHaveLength(0);
    });

    it('ignores non-source files', () => {
      const lines = [
        'console.log("example code");',
      ];
      const diff = makeDiff('docs/guide.md', lines);
      const result = checkOperationalResilience(diff);

      const consoleFindings = result.findings.filter((f) =>
        f.message.includes('console.log'),
      );
      expect(consoleFindings).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Check 4: Unbounded retries
  // ----------------------------------------------------------

  describe('unbounded retries', () => {
    it('flags while(true) without break or max', () => {
      const lines = [
        'function poll() {',
        '  while (true) {',
        '    fetch("/status");',
        '  }',
        '}',
      ];
      const diff = makeDiff('src/poller.ts', lines);
      const result = checkOperationalResilience(diff);

      const finding = result.findings.find((f) =>
        f.message.includes('Unbounded retry'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('MEDIUM');
    });

    it('flags for(;;) without break or max', () => {
      const lines = [
        'function loop() {',
        '  for (;;) {',
        '    doWork();',
        '  }',
        '}',
      ];
      const diff = makeDiff('src/worker.ts', lines);
      const result = checkOperationalResilience(diff);

      const finding = result.findings.find((f) =>
        f.message.includes('Unbounded retry'),
      );
      expect(finding).toBeDefined();
    });

    it('does not flag while(true) with break', () => {
      const lines = [
        'function poll() {',
        '  while (true) {',
        '    if (done) break;',
        '    fetch("/status");',
        '  }',
        '}',
      ];
      const diff = makeDiff('src/poller.ts', lines);
      const result = checkOperationalResilience(diff);

      const unboundedFindings = result.findings.filter((f) =>
        f.message.includes('Unbounded retry'),
      );
      expect(unboundedFindings).toHaveLength(0);
    });

    it('does not flag while(true) with maxRetries', () => {
      const lines = [
        'function retry() {',
        '  const maxRetries = 3;',
        '  while (true) {',
        '    if (count > maxRetries) return;',
        '    doWork();',
        '  }',
        '}',
      ];
      const diff = makeDiff('src/retrier.ts', lines);
      const result = checkOperationalResilience(diff);

      const unboundedFindings = result.findings.filter((f) =>
        f.message.includes('Unbounded retry'),
      );
      expect(unboundedFindings).toHaveLength(0);
    });

    it('does not flag while(true) with MAX_ constant', () => {
      const lines = [
        'const MAX_ATTEMPTS = 5;',
        'function retry() {',
        '  while (true) {',
        '    doWork();',
        '  }',
        '}',
      ];
      const diff = makeDiff('src/retrier.ts', lines);
      const result = checkOperationalResilience(diff);

      const unboundedFindings = result.findings.filter((f) =>
        f.message.includes('Unbounded retry'),
      );
      expect(unboundedFindings).toHaveLength(0);
    });

    it('excludes test files from unbounded retry check', () => {
      const lines = [
        'function testHelper() {',
        '  while (true) {',
        '    doWork();',
        '  }',
        '}',
      ];
      const diff = makeDiff('src/helper.test.ts', lines);
      const result = checkOperationalResilience(diff);

      const unboundedFindings = result.findings.filter((f) =>
        f.message.includes('Unbounded retry'),
      );
      expect(unboundedFindings).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Test files exclusion
  // ----------------------------------------------------------

  describe('test file exclusion', () => {
    it('excludes .test.ts files from console.log and unbounded retry checks', () => {
      const lines = [
        'console.log("debug");',
        'while (true) { doWork(); }',
      ];
      const diff = makeDiff('src/file.test.ts', lines);
      const result = checkOperationalResilience(diff);

      const consoleFindings = result.findings.filter((f) =>
        f.message.includes('console.log'),
      );
      const retryFindings = result.findings.filter((f) =>
        f.message.includes('Unbounded retry'),
      );
      expect(consoleFindings).toHaveLength(0);
      expect(retryFindings).toHaveLength(0);
    });

    it('excludes .spec.js files from console.log and unbounded retry checks', () => {
      const lines = [
        'console.log("test output");',
        'for (;;) { poll(); }',
      ];
      const diff = makeDiff('tests/api.spec.js', lines);
      const result = checkOperationalResilience(diff);

      const consoleFindings = result.findings.filter((f) =>
        f.message.includes('console.log'),
      );
      const retryFindings = result.findings.filter((f) =>
        f.message.includes('Unbounded retry'),
      );
      expect(consoleFindings).toHaveLength(0);
      expect(retryFindings).toHaveLength(0);
    });

    it('excludes __tests__ directory files', () => {
      const lines = [
        'console.log("test");',
      ];
      const diff = makeDiff('src/__tests__/handler.ts', lines);
      const result = checkOperationalResilience(diff);

      const consoleFindings = result.findings.filter((f) =>
        f.message.includes('console.log'),
      );
      expect(consoleFindings).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Clean diff (no anti-patterns)
  // ----------------------------------------------------------

  describe('clean diff', () => {
    it('passes with properly written code', () => {
      const lines = [
        'export async function fetchData(url: string): Promise<string> {',
        '  try {',
        '    const response = await fetch(url);',
        '    if (!response.ok) {',
        '      throw new Error(`HTTP ${response.status}`);',
        '    }',
        '    return await response.text();',
        '  } catch (error: unknown) {',
        '    const message = error instanceof Error ? error.message : String(error);',
        '    throw new Error(`Failed to fetch ${url}: ${message}`);',
        '  }',
        '}',
      ];
      const diff = makeDiff('src/fetcher.ts', lines);
      const result = checkOperationalResilience(diff);

      expect(result.pass).toBe(true);
      expect(result.findings).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Multiple findings across files
  // ----------------------------------------------------------

  describe('multiple findings', () => {
    it('reports findings across multiple files', () => {
      const files = [
        {
          name: 'src/a.ts',
          lines: ['try { x(); } catch (e) { }'],
        },
        {
          name: 'src/b.ts',
          lines: ['console.log("debug");'],
        },
      ];
      const diff = makeMultiFileDiff(files);
      const result = checkOperationalResilience(diff);

      expect(result.pass).toBe(false);
      expect(result.findings.length).toBeGreaterThanOrEqual(2);

      const emptyCatch = result.findings.find((f) =>
        f.message.includes('Empty catch block'),
      );
      const consoleLog = result.findings.find((f) =>
        f.message.includes('console.log'),
      );
      expect(emptyCatch).toBeDefined();
      expect(consoleLog).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // Result structure
  // ----------------------------------------------------------

  describe('result structure', () => {
    it('returns findingCount in result', () => {
      const lines = ['try { x(); } catch (e) { }'];
      const diff = makeDiff('src/bad.ts', lines);
      const result = checkOperationalResilience(diff);

      expect(result.findingCount).toBeGreaterThan(0);
      expect(result.findingCount).toBe(result.findings.length);
    });

    it('pass is true when no findings', () => {
      const diff = makeDiff('src/clean.ts', ['const x = 1;']);
      const result = checkOperationalResilience(diff);
      expect(result.pass).toBe(true);
    });

    it('pass is false when findings exist', () => {
      const diff = makeDiff('src/bad.ts', ['try { x(); } catch (e) { }']);
      const result = checkOperationalResilience(diff);
      expect(result.pass).toBe(false);
    });

    it('findings have severity and message fields', () => {
      const diff = makeDiff('src/bad.ts', [
        'try { x(); } catch (e) { }',
        'console.log("x");',
      ]);
      const result = checkOperationalResilience(diff);

      for (const finding of result.findings) {
        expect(finding.severity).toMatch(/^(HIGH|MEDIUM|LOW)$/);
        expect(typeof finding.message).toBe('string');
        expect(finding.message.length).toBeGreaterThan(0);
      }
    });
  });
});

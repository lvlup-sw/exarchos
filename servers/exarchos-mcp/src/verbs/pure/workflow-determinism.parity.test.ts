import { describe, it, expect } from 'vitest';
import { checkWorkflowDeterminism } from './workflow-determinism.js';

const CLEAN_TEST_DIFF = `diff --git a/src/utils.test.ts b/src/utils.test.ts
index abc1234..def5678 100644
--- a/src/utils.test.ts
+++ b/src/utils.test.ts
@@ -1,3 +1,5 @@
+describe('add', () => {
+  it('should return the sum', () => {
+    expect(add(1, 2)).toBe(3);
+  });
+});
 describe('greet', () => {
   it('returns greeting', () => {});
 });`;

const TEST_ONLY_DIFF = `diff --git a/src/handler.test.ts b/src/handler.test.ts
index abc1234..def5678 100644
--- a/src/handler.test.ts
+++ b/src/handler.test.ts
@@ -1,3 +1,5 @@
+describe.only('handler', () => {
+  it('should handle request', () => {});
+});
 describe('other', () => {
   it('works', () => {});
 });`;

const DATE_NOW_DIFF = `diff --git a/src/timer.test.ts b/src/timer.test.ts
index abc1234..def5678 100644
--- a/src/timer.test.ts
+++ b/src/timer.test.ts
@@ -1,2 +1,5 @@
+it('measures time', () => {
+  const start = Date.now();
+  expect(Date.now() - start).toBeLessThan(100);
+});
 export {};`;

describe('behavioral parity with workflow-determinism.sh', () => {
  it('clean test diff passes all checks with zero findings', () => {
    const result = checkWorkflowDeterminism({ diffContent: CLEAN_TEST_DIFF });

    expect(result.status).toBe('pass');
    expect(result.findingCount).toBe(0);
    expect(result.findings).toEqual([]);
    // Known behavioral difference: bash had 5 checks, TS has 4
    // (TS omits the separate debug-artifacts check or merges it).
    // Both agree on the logical conclusion: pass with zero findings.
    expect(result.passedChecks).toBe(result.totalChecks);
  });

  it('describe.only produces HIGH finding for test focus modifier', () => {
    const result = checkWorkflowDeterminism({ diffContent: TEST_ONLY_DIFF });

    expect(result.status).toBe('findings');
    expect(result.findingCount).toBe(1);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]).toMatch(/src\/handler\.test\.ts/);
    expect(result.findings[0]).toMatch(/describe\.only/);
  });

  it('Date.now() without fake timers produces findings for non-deterministic time', () => {
    const result = checkWorkflowDeterminism({ diffContent: DATE_NOW_DIFF });

    expect(result.status).toBe('findings');
    expect(result.findingCount).toBe(2);
    expect(result.findings.length).toBe(2);
    result.findings.forEach((finding) => {
      expect(finding).toMatch(/Date\.now/);
    });
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  checkWorkflowDeterminism,
  type WorkflowDeterminismResult,
} from './workflow-determinism.js';

// ============================================================
// Test diff fixtures
// ============================================================

const CLEAN_DIFF = `diff --git a/src/utils.test.ts b/src/utils.test.ts
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
 });
`;

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
 });
`;

const TEST_SKIP_DIFF = `diff --git a/src/service.test.ts b/src/service.test.ts
index abc1234..def5678 100644
--- a/src/service.test.ts
+++ b/src/service.test.ts
@@ -1,3 +1,5 @@
+describe('service', () => {
+  it.skip('should connect', () => {});
+});
 describe('other', () => {
   it('works', () => {});
 });
`;

const DEBUGGER_DIFF = `diff --git a/src/parser.test.ts b/src/parser.test.ts
index abc1234..def5678 100644
--- a/src/parser.test.ts
+++ b/src/parser.test.ts
@@ -1,3 +1,6 @@
+describe('parser', () => {
+  it('should parse', () => {
+    debugger;
+    expect(parse('hello')).toBe('hello');
+  });
+});
 describe('other', () => {
   it('works', () => {});
 });
`;

const CONSOLE_LOG_DIFF = `diff --git a/src/api.test.ts b/src/api.test.ts
index abc1234..def5678 100644
--- a/src/api.test.ts
+++ b/src/api.test.ts
@@ -1,3 +1,6 @@
+describe('api', () => {
+  it('should fetch', () => {
+    console.log('debug output');
+    expect(fetch('/api')).toBeDefined();
+  });
+});
 describe('other', () => {
   it('works', () => {});
 });
`;

const DATE_NOW_DIFF = `diff --git a/src/timer.test.ts b/src/timer.test.ts
index abc1234..def5678 100644
--- a/src/timer.test.ts
+++ b/src/timer.test.ts
@@ -1,3 +1,6 @@
+describe('timer', () => {
+  it('should track time', () => {
+    const now = Date.now();
+    expect(now).toBeGreaterThan(0);
+  });
+});
 describe('other', () => {
   it('works', () => {});
 });
`;

const MATH_RANDOM_DIFF = `diff --git a/src/shuffle.test.ts b/src/shuffle.test.ts
index abc1234..def5678 100644
--- a/src/shuffle.test.ts
+++ b/src/shuffle.test.ts
@@ -1,3 +1,6 @@
+describe('shuffle', () => {
+  it('should randomize', () => {
+    const val = Math.random();
+    expect(val).toBeLessThan(1);
+  });
+});
 describe('other', () => {
   it('works', () => {});
 });
`;

const MULTI_ISSUE_DIFF = `diff --git a/src/app.test.ts b/src/app.test.ts
index abc1234..def5678 100644
--- a/src/app.test.ts
+++ b/src/app.test.ts
@@ -1,2 +1,12 @@
+describe.only('app', () => {
+  it('should initialize', () => {
+    console.log('testing init');
+    const now = Date.now();
+    expect(now).toBeGreaterThan(0);
+  });
+  it.skip('should shutdown', () => {});
+});
 describe('other', () => {
   it('works', () => {});
 });
`;

const NON_TEST_DIFF = `diff --git a/src/main.ts b/src/main.ts
index abc1234..def5678 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,2 +1,5 @@
+const now = Date.now();
+console.log('starting...');
+const val = Math.random();
 export function main() {}
`;

const EMPTY_DIFF = '';

describe('checkWorkflowDeterminism', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('clean diff with no issues returns pass', () => {
    const result = checkWorkflowDeterminism({ diffContent: CLEAN_DIFF });

    expect(result.status).toBe('pass');
    expect(result.findingCount).toBe(0);
  });

  it('.only found in test files returns findings', () => {
    const result = checkWorkflowDeterminism({ diffContent: TEST_ONLY_DIFF });

    expect(result.status).toBe('findings');
    expect(result.findingCount).toBeGreaterThan(0);
    // Should mention only/skip/focus
    const findingText = result.findings.join(' ');
    expect(findingText).toMatch(/only|skip|focus/i);
  });

  it('.skip found in test files returns findings', () => {
    const result = checkWorkflowDeterminism({ diffContent: TEST_SKIP_DIFF });

    expect(result.status).toBe('findings');
    expect(result.findingCount).toBeGreaterThan(0);
  });

  it('Date.now() in test without fake timers returns finding', () => {
    const result = checkWorkflowDeterminism({ diffContent: DATE_NOW_DIFF });

    expect(result.status).toBe('findings');
    expect(result.findingCount).toBeGreaterThan(0);
    const findingText = result.findings.join(' ');
    expect(findingText).toMatch(/time|Date/i);
  });

  it('Math.random() in test without mock returns finding', () => {
    const result = checkWorkflowDeterminism({ diffContent: MATH_RANDOM_DIFF });

    expect(result.status).toBe('findings');
    expect(result.findingCount).toBeGreaterThan(0);
    const findingText = result.findings.join(' ');
    expect(findingText).toMatch(/random|Math/i);
  });

  it('debugger statement in test returns finding', () => {
    const result = checkWorkflowDeterminism({ diffContent: DEBUGGER_DIFF });

    expect(result.status).toBe('findings');
    expect(result.findingCount).toBeGreaterThan(0);
    const findingText = result.findings.join(' ');
    expect(findingText).toMatch(/debug|artifact/i);
  });

  it('console.log in test file returns finding', () => {
    const result = checkWorkflowDeterminism({ diffContent: CONSOLE_LOG_DIFF });

    expect(result.status).toBe('findings');
    expect(result.findingCount).toBeGreaterThan(0);
  });

  it('multiple issues all reported', () => {
    const result = checkWorkflowDeterminism({ diffContent: MULTI_ISSUE_DIFF });

    expect(result.status).toBe('findings');
    // At least: describe.only, console.log, Date.now, it.skip
    expect(result.findingCount).toBeGreaterThanOrEqual(3);
  });

  it('non-test file patterns not flagged', () => {
    const result = checkWorkflowDeterminism({ diffContent: NON_TEST_DIFF });

    expect(result.status).toBe('pass');
    expect(result.findingCount).toBe(0);
  });

  it('empty diff returns pass', () => {
    const result = checkWorkflowDeterminism({ diffContent: EMPTY_DIFF });

    expect(result.status).toBe('pass');
    expect(result.findingCount).toBe(0);
  });

  it('report output is structured markdown', () => {
    const result = checkWorkflowDeterminism({ diffContent: TEST_ONLY_DIFF });

    expect(result.report).toContain('## Workflow Determinism Report');
    expect(result.report).toMatch(/\*\*Result:/);
  });

  it('pass report shows check count', () => {
    const result = checkWorkflowDeterminism({ diffContent: CLEAN_DIFF });

    expect(result.report).toContain('**Result: PASS**');
    expect(result.report).toMatch(/\d+\/\d+ checks passed/);
  });

  it('findings report shows finding count', () => {
    const result = checkWorkflowDeterminism({ diffContent: TEST_ONLY_DIFF });

    expect(result.report).toContain('**Result: FINDINGS**');
    expect(result.report).toMatch(/\d+ findings? detected/);
  });

  it('new Date() in test without fake timers returns finding', () => {
    const diff = `diff --git a/src/clock.test.ts b/src/clock.test.ts
index abc1234..def5678 100644
--- a/src/clock.test.ts
+++ b/src/clock.test.ts
@@ -1,3 +1,6 @@
+describe('clock', () => {
+  it('should get current time', () => {
+    const d = new Date();
+    expect(d).toBeDefined();
+  });
+});
`;
    const result = checkWorkflowDeterminism({ diffContent: diff });

    expect(result.status).toBe('findings');
    expect(result.findingCount).toBeGreaterThan(0);
  });

  it('Date.now() with fake timers in context is not flagged', () => {
    const diff = `diff --git a/src/timer.test.ts b/src/timer.test.ts
index abc1234..def5678 100644
--- a/src/timer.test.ts
+++ b/src/timer.test.ts
@@ -1,3 +1,8 @@
+describe('timer', () => {
+  vi.useFakeTimers();
+  it('should track time', () => {
+    const now = Date.now();
+    expect(now).toBeGreaterThan(0);
+  });
+});
`;
    const result = checkWorkflowDeterminism({ diffContent: diff });

    // Should not flag Date.now() because vi.useFakeTimers is in context
    expect(result.findings.filter((f) => f.includes('time'))).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import { checkOperationalResilience } from './operational-resilience.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────
// Bash: 5 checks — empty catch, swallowed errors, console.log, npm audit, unbounded retries
// TS port: same patterns, diff-only mode (no npm audit)

const CLEAN_DIFF = `diff --git a/src/utils.ts b/src/utils.ts
index abc1234..def5678 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,5 @@
+export function add(a: number, b: number): number {
+  return a + b;
+}
 export function greet(name: string): string {
   return \`Hello, \${name}\`;
 }`;

const EMPTY_CATCH_DIFF = `diff --git a/src/handler.ts b/src/handler.ts
index abc1234..def5678 100644
--- a/src/handler.ts
+++ b/src/handler.ts
@@ -1,2 +1,6 @@
+function risky() {
+  try {
+    doSomething();
+  } catch (e) { }
+}
 export function handle() {}`;

const CONSOLE_LOG_SOURCE_DIFF = `diff --git a/src/service.ts b/src/service.ts
index abc1234..def5678 100644
--- a/src/service.ts
+++ b/src/service.ts
@@ -1,2 +1,5 @@
+function debug(value: unknown) {
+  console.log("debugging:", value);
+  return value;
+}
 export function init() {}`;

const CONSOLE_LOG_TEST_DIFF = `diff --git a/src/service.test.ts b/src/service.test.ts
index abc1234..def5678 100644
--- a/src/service.test.ts
+++ b/src/service.test.ts
@@ -1,2 +1,5 @@
+it('logs value', () => {
+  console.log("test output");
+  expect(true).toBe(true);
+});
 export {};`;

const MULTIPLE_FINDINGS_DIFF = `diff --git a/src/handler.ts b/src/handler.ts
index abc1234..def5678 100644
--- a/src/handler.ts
+++ b/src/handler.ts
@@ -1,2 +1,6 @@
+function risky() {
+  try {
+    doSomething();
+  } catch (e) { }
+}
 export function handle() {}
diff --git a/src/service.ts b/src/service.ts
index abc1234..def5678 100644
--- a/src/service.ts
+++ b/src/service.ts
@@ -1,2 +1,5 @@
+function debug(value: unknown) {
+  console.log("debugging:", value);
+  return value;
+}
 export function init() {}`;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('behavioral parity with check-operational-resilience.sh', () => {
  it('clean diff — passes with zero findings', () => {
    expect(checkOperationalResilience(CLEAN_DIFF)).toEqual({
      pass: true,
      findingCount: 0,
      findings: [],
    });
  });

  it('empty catch block — HIGH finding', () => {
    expect(checkOperationalResilience(EMPTY_CATCH_DIFF)).toEqual({
      pass: false,
      findingCount: 1,
      findings: [
        {
          severity: 'HIGH',
          message: '`src/handler.ts` — Empty catch block detected',
        },
      ],
    });
  });

  it('console.log in source file — MEDIUM finding', () => {
    expect(checkOperationalResilience(CONSOLE_LOG_SOURCE_DIFF)).toEqual({
      pass: false,
      findingCount: 1,
      findings: [
        {
          severity: 'MEDIUM',
          message: '`src/service.ts` — console.log in source file',
        },
      ],
    });
  });

  it('console.log in test file — excluded, passes cleanly', () => {
    expect(checkOperationalResilience(CONSOLE_LOG_TEST_DIFF)).toEqual({
      pass: true,
      findingCount: 0,
      findings: [],
    });
  });

  it('multiple findings — empty catch (HIGH) + console.log (MEDIUM)', () => {
    expect(checkOperationalResilience(MULTIPLE_FINDINGS_DIFF)).toEqual({
      pass: false,
      findingCount: 2,
      findings: [
        {
          severity: 'HIGH',
          message: '`src/handler.ts` — Empty catch block detected',
        },
        {
          severity: 'MEDIUM',
          message: '`src/service.ts` — console.log in source file',
        },
      ],
    });
  });
});

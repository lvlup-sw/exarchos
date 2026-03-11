import { describe, it, expect } from 'vitest';
import { checkOperationalResilience } from './operational-resilience.js';

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

describe('behavioral parity with operational-resilience.sh', () => {
  it('clean diff passes with zero findings', () => {
    const result = checkOperationalResilience(CLEAN_DIFF);

    expect(result.pass).toBe(true);
    expect(result.findingCount).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('empty catch block produces HIGH finding', () => {
    const result = checkOperationalResilience(EMPTY_CATCH_DIFF);

    expect(result.pass).toBe(false);
    expect(result.findingCount).toBe(1);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.severity).toBe('HIGH');
    // TS Finding has {severity, message} — file name is embedded in message
    expect(result.findings[0]!.message).toMatch(/handler\.ts/);
    expect(result.findings[0]!.message).toMatch(/[Ee]mpty catch/i);
  });

  it('console.log in source file produces MEDIUM finding', () => {
    const result = checkOperationalResilience(CONSOLE_LOG_SOURCE_DIFF);

    expect(result.pass).toBe(false);
    expect(result.findingCount).toBe(1);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.severity).toBe('MEDIUM');
    // TS Finding has {severity, message} — file name is embedded in message
    expect(result.findings[0]!.message).toMatch(/service\.ts/);
    expect(result.findings[0]!.message).toMatch(/console\.log/i);
  });

  it('console.log in test file is excluded and passes', () => {
    const result = checkOperationalResilience(CONSOLE_LOG_TEST_DIFF);

    expect(result.pass).toBe(true);
    expect(result.findingCount).toBe(0);
    expect(result.findings).toEqual([]);
  });
});

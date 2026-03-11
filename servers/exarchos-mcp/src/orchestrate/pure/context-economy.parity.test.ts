import { describe, it, expect } from 'vitest';
import { checkContextEconomy } from './context-economy.js';

function makeCleanDiff(): string {
  return `diff --git a/src/utils.ts b/src/utils.ts
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
}

function makeLongFileDiff(): string {
  const lines = Array.from({ length: 450 }, (_, i) => `+export const var_${i + 1} = ${i + 1};`);
  return `diff --git a/src/huge.ts b/src/huge.ts
index abc1234..def5678 100644
--- /dev/null
+++ b/src/huge.ts
@@ -0,0 +1,450 @@
${lines.join('\n')}`;
}

function makeWideDiff(): string {
  const parts: string[] = [];
  for (let i = 1; i <= 35; i++) {
    parts.push(`diff --git a/src/file-${i}.ts b/src/file-${i}.ts
index abc1234..def5678 100644
--- a/src/file-${i}.ts
+++ b/src/file-${i}.ts
@@ -1,1 +1,2 @@
+export const x = ${i};
 export {};`);
  }
  return parts.join('\n');
}

describe('behavioral parity with context-economy.sh', () => {
  it('clean diff passes with all checks passing and no findings', () => {
    const result = checkContextEconomy(makeCleanDiff());

    expect(result.pass).toBe(true);
    expect(result.checksRun).toBe(4);
    expect(result.checksPassed).toBe(4);
    expect(result.findings).toEqual([]);
  });

  it('long file diff (450 added lines) produces MEDIUM finding for file exceeding 400 lines', () => {
    const result = checkContextEconomy(makeLongFileDiff());

    expect(result.pass).toBe(false);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.severity).toBe('MEDIUM');
    expect(result.findings[0]!.message).toMatch(/src\/huge\.ts/);
    expect(result.findings[0]!.message).toMatch(/450/);
  });

  it('wide diff (35 files) produces MEDIUM finding for exceeding file breadth threshold', () => {
    const result = checkContextEconomy(makeWideDiff());

    expect(result.pass).toBe(false);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.severity).toBe('MEDIUM');
    expect(result.findings[0]!.message).toMatch(/35/);
    expect(result.findings[0]!.message).toMatch(/30/);
  });

  it('empty diff passes with no findings (bash: 4/4, TS: 0/0 — no files to check)', () => {
    // Known behavioral difference: bash always counted 4 checks even for empty input.
    // The TS implementation returns 0 checks when there are no files to analyze.
    // Both agree on the logical conclusion: pass with zero findings.
    const result = checkContextEconomy('');

    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
    // TS implementation: no files parsed → 0 checks run (vs bash's hardcoded 4)
    expect(result.checksRun).toBe(result.checksPassed);
  });
});

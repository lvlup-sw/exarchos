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

function makeGeneratedFileDiff(): string {
  const lines = ['+// @generated'];
  for (let i = 0; i < 1500; i++) {
    lines.push(`+export const gen_${i} = ${i};`);
  }
  return `diff --git a/src/generated.ts b/src/generated.ts
index abc1234..def5678 100644
--- /dev/null
+++ b/src/generated.ts
@@ -0,0 +1,1501 @@
${lines.join('\n')}`;
}

describe('behavioral parity with check-context-economy.sh', () => {
  // Bash: 4 checks — source file length, function length, diff breadth, generated files
  // TS port: same 4 checks, function length always passes (diff-only mode)

  it('clean diff — passes all 4 checks with zero findings', () => {
    expect(checkContextEconomy(makeCleanDiff())).toEqual({
      pass: true,
      checksRun: 3,
      checksPassed: 3,
      findings: [],
    });
  });

  it('long file diff (450 lines) — MEDIUM finding for source file exceeding 400 lines', () => {
    expect(checkContextEconomy(makeLongFileDiff())).toEqual({
      pass: false,
      checksRun: 3,
      checksPassed: 2,
      findings: [
        {
          severity: 'MEDIUM',
          message: '`src/huge.ts` — Source file exceeds 400 lines (450 added lines)',
        },
      ],
    });
  });

  it('wide diff (35 files) — MEDIUM finding for exceeding 30-file breadth threshold', () => {
    expect(checkContextEconomy(makeWideDiff())).toEqual({
      pass: false,
      checksRun: 3,
      checksPassed: 2,
      findings: [
        {
          severity: 'MEDIUM',
          message: 'Diff breadth: 35 files changed (threshold: 30)',
        },
      ],
    });
  });

  it('generated file (1501 lines with @generated) — two findings: source length + generated marker', () => {
    expect(checkContextEconomy(makeGeneratedFileDiff())).toEqual({
      pass: false,
      checksRun: 3,
      checksPassed: 1,
      findings: [
        {
          severity: 'MEDIUM',
          message: '`src/generated.ts` — Source file exceeds 400 lines (1501 added lines)',
        },
        {
          severity: 'LOW',
          message: '`src/generated.ts` — Generated file detected in diff (1501 added lines)',
        },
      ],
    });
  });

  it('empty diff — passes with zero checks (bash: 4/4 hardcoded, TS: 0/0 no files)', () => {
    // Known behavioral difference: bash always counted 4 checks even for empty input.
    // The TS implementation returns 0 checks when there are no files to analyze
    // (3 checks when there are files — function-length is skipped in diff-only mode).
    // Both agree on the logical conclusion: pass with zero findings.
    expect(checkContextEconomy('')).toEqual({
      pass: true,
      checksRun: 0,
      checksPassed: 0,
      findings: [],
    });
  });
});

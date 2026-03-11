import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: vi.fn(() => ({
    appendEvent: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./gate-utils.js', () => ({
  emitGateEvent: vi.fn().mockResolvedValue(undefined),
  getDiff: vi.fn(),
}));

import { handleSecurityScan } from './security-scan.js';

/**
 * Behavioral parity tests for security-scan.ts against the original
 * scripts/security-scan.sh bash script.
 *
 * Bash script behavior (security-scan.sh):
 *   - Clean diff (exit 0): "**Result: CLEAN** (0 findings)"
 *   - API key    (exit 1): 2 findings — both HIGH: Hardcoded secret/credential
 *   - eval()     (exit 1): 1 finding  — HIGH: eval() usage
 *   - innerHTML  (exit 1): 1 finding  — MEDIUM: innerHTML assignment
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

const APIKEY_DIFF = `diff --git a/src/config.ts b/src/config.ts
index abc1234..def5678 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,2 +1,4 @@
+const API_KEY = "sk-1234567890abcdef";
+const SECRET_TOKEN = "ghp_ABCDEFghijklmnop";
 export const config = {
   timeout: 5000,
 };`;

const EVAL_DIFF = `diff --git a/src/handler.ts b/src/handler.ts
index abc1234..def5678 100644
--- a/src/handler.ts
+++ b/src/handler.ts
@@ -1,2 +1,3 @@
+const result = eval(userInput);
 export function handle() {}`;

const INNERHTML_DIFF = `diff --git a/src/render.ts b/src/render.ts
index abc1234..def5678 100644
--- a/src/render.ts
+++ b/src/render.ts
@@ -1,2 +1,3 @@
+document.getElementById('output').innerHTML = userContent;
 export function render() {}`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('behavioral parity with security-scan.sh', () => {
  const stateDir = '/tmp/test-state';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clean diff — passes with 0 findings (bash: exit 0, "CLEAN")', async () => {
    const result = await handleSecurityScan(
      { featureId: 'test-feature', diffContent: CLEAN_DIFF },
      stateDir,
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      passed: boolean;
      findingCount: number;
      findings: readonly unknown[];
      report: string;
    };

    expect(data.passed).toBe(true);
    expect(data.findingCount).toBe(0);
    expect(data.findings).toEqual([]);
    expect(data.report).toContain('**Result: CLEAN** (0 findings)');
  });

  it('API key diff — fails with 2 HIGH findings (bash: exit 1, 2 hardcoded secrets)', async () => {
    const result = await handleSecurityScan(
      { featureId: 'test-feature', diffContent: APIKEY_DIFF },
      stateDir,
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      passed: boolean;
      findingCount: number;
      findings: readonly { file: string; pattern: string; severity: string }[];
      report: string;
    };

    expect(data.passed).toBe(false);
    expect(data.findingCount).toBe(2);

    // Both findings should be HIGH severity for hardcoded secrets
    for (const finding of data.findings) {
      expect(finding.severity).toBe('HIGH');
      expect(finding.pattern).toBe('Hardcoded secret/credential');
      expect(finding.file).toBe('src/config.ts');
    }
  });

  it('eval diff — fails with 1 HIGH finding (bash: exit 1, eval() usage)', async () => {
    const result = await handleSecurityScan(
      { featureId: 'test-feature', diffContent: EVAL_DIFF },
      stateDir,
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      passed: boolean;
      findingCount: number;
      findings: readonly { file: string; pattern: string; severity: string }[];
    };

    expect(data.passed).toBe(false);
    expect(data.findingCount).toBe(1);
    expect(data.findings[0].severity).toBe('HIGH');
    expect(data.findings[0].pattern).toBe('eval() usage');
    expect(data.findings[0].file).toBe('src/handler.ts');
  });

  it('innerHTML diff — fails with 1 MEDIUM finding (bash: exit 1, innerHTML assignment)', async () => {
    const result = await handleSecurityScan(
      { featureId: 'test-feature', diffContent: INNERHTML_DIFF },
      stateDir,
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      passed: boolean;
      findingCount: number;
      findings: readonly { file: string; pattern: string; severity: string }[];
    };

    expect(data.passed).toBe(false);
    expect(data.findingCount).toBe(1);
    expect(data.findings[0].severity).toBe('MEDIUM');
    expect(data.findings[0].pattern).toBe('innerHTML assignment');
    expect(data.findings[0].file).toBe('src/render.ts');
  });

  it('empty diff content — passes with 0 findings', async () => {
    const result = await handleSecurityScan(
      { featureId: 'test-feature', diffContent: '' },
      stateDir,
    );

    expect(result.success).toBe(true);

    const data = result.data as { passed: boolean; findingCount: number };

    expect(data.passed).toBe(true);
    expect(data.findingCount).toBe(0);
  });
});

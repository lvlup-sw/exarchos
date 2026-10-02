// Parity tests that pin `security-scan.ts` to the behavior of the bash script `security-scan.sh`.
// A clean diff passes. Two hardcoded secrets give two HIGH findings, `eval()` gives one HIGH finding,
// and an `innerHTML` assignment gives one MEDIUM finding.
//
// The gate-utils double includes `sameOperationGateKey`, because a stub module without it swallows a
// TypeError and leaves the emission unexercised. Its `requireGateEvent` always succeeds, because these
// cases test the scanner and not the append failure path.
// The phase-gate runner is a stub that calls only the provider. `gate-runner.test.ts` tests the runner
// against a real store.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateEventStore: vi.fn(() => ({
    appendEvent: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  emitGateEvent: vi.fn().mockResolvedValue(undefined),
  requireGateEvent: vi.fn().mockResolvedValue(undefined),
  sameOperationGateKey: vi.fn((gateName: string) => `gate.executed:${gateName}:op-fixture`),
  getDiff: vi.fn(),
}));

vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: vi.fn(async (request) => {
    try {
      return await request.executeProvider(
        {
          gateClass: request.gateClass,
          providerRef: 'test-provider',
          actionName: 'test-provider',
        },
        request.providerInput,
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GATE_PROVIDER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }),
}));

import { handleSecurityScan } from '../../../../src/verbs/gates/security-scan.js';

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

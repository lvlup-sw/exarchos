// ─── Security Scan Action Tests ─────────────────────────────────────────────
//
// Tests for the pure TypeScript security scan implementation.
// No bash script dependency — scans diff content directly in TypeScript.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../event-store/store.js';

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

import { handleSecurityScan, scanDiffContent } from './security-scan.js';
import type { SecurityFinding } from './security-scan.js';

const STATE_DIR = '/tmp/test-security-scan';

// ─── Diff Fixture Helpers ───────────────────────────────────────────────────

function makeCleanDiff(): string {
  return [
    'diff --git a/src/utils.ts b/src/utils.ts',
    'index abc1234..def5678 100644',
    '--- a/src/utils.ts',
    '+++ b/src/utils.ts',
    '@@ -1,3 +1,5 @@',
    '+export function add(a: number, b: number): number {',
    '+  return a + b;',
    '+}',
    ' export function greet(name: string): string {',
    '   return `Hello, ${name}`;',
    ' }',
  ].join('\n');
}

function makeApiKeyDiff(): string {
  return [
    'diff --git a/src/config.ts b/src/config.ts',
    'index abc1234..def5678 100644',
    '--- a/src/config.ts',
    '+++ b/src/config.ts',
    '@@ -1,2 +1,4 @@',
    '+const API_KEY = "sk-1234567890abcdef1234567890abcdef";',
    '+const SECRET_TOKEN = "ghp_ABCDEFghijklmnop1234567890";',
    ' export const config = {',
    '   timeout: 5000,',
    ' };',
  ].join('\n');
}

function makeEvalDiff(): string {
  return [
    'diff --git a/src/handler.ts b/src/handler.ts',
    'index abc1234..def5678 100644',
    '--- a/src/handler.ts',
    '+++ b/src/handler.ts',
    '@@ -1,2 +1,4 @@',
    '+function execute(code: string) {',
    '+  return eval(code);',
    '+}',
    ' export function handle() {}',
  ].join('\n');
}

function makeSqlDiff(): string {
  return [
    'diff --git a/src/db.ts b/src/db.ts',
    'index abc1234..def5678 100644',
    '--- a/src/db.ts',
    '+++ b/src/db.ts',
    '@@ -1,2 +1,4 @@',
    '+function query(userId: string) {',
    '+  return db.execute("SELECT * FROM users WHERE id = " + userId);',
    '+}',
    ' export function connect() {}',
  ].join('\n');
}

function makeInnerHtmlDiff(): string {
  return [
    'diff --git a/src/render.ts b/src/render.ts',
    'index abc1234..def5678 100644',
    '--- a/src/render.ts',
    '+++ b/src/render.ts',
    '@@ -1,2 +1,4 @@',
    '+function render(content: string) {',
    "+  document.getElementById('app').innerHTML = content;",
    '+}',
    ' export function init() {}',
  ].join('\n');
}

function makeDangerouslySetInnerHTMLDiff(): string {
  return [
    'diff --git a/src/component.tsx b/src/component.tsx',
    'index abc1234..def5678 100644',
    '--- a/src/component.tsx',
    '+++ b/src/component.tsx',
    '@@ -1,2 +1,4 @@',
    '+function Component({ html }: { html: string }) {',
    '+  return <div dangerouslySetInnerHTML={{ __html: html }} />;',
    '+}',
    ' export default Component;',
  ].join('\n');
}

function makeMultiIssueDiff(): string {
  return [
    'diff --git a/src/app.ts b/src/app.ts',
    'index abc1234..def5678 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,2 +1,10 @@',
    '+const PASSWORD = "hunter2";',
    '+function run(input: string) {',
    '+  eval(input);',
    '+}',
    '+function renderHtml(html: string) {',
    '+  element.innerHTML = html;',
    '+}',
    '+function getUser(id: string) {',
    '+  return db.query("SELECT * FROM users WHERE id = " + id);',
    '+}',
    ' export function main() {}',
  ].join('\n');
}

// ─── Tests: scanDiffContent (pure function) ─────────────────────────────────

describe('scanDiffContent', () => {
  it('scanDiffContent_CleanDiff_ReturnsNoFindings', () => {
    const findings = scanDiffContent(makeCleanDiff());
    expect(findings).toEqual([]);
  });

  it('scanDiffContent_EmptyDiff_ReturnsNoFindings', () => {
    const findings = scanDiffContent('');
    expect(findings).toEqual([]);
  });

  it('scanDiffContent_HardcodedApiKey_DetectsFindings', () => {
    const findings = scanDiffContent(makeApiKeyDiff());
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.some((f: SecurityFinding) => f.severity === 'HIGH')).toBe(true);
    expect(findings.some((f: SecurityFinding) => f.pattern === 'Hardcoded secret/credential')).toBe(true);
    expect(findings.every((f: SecurityFinding) => f.file === 'src/config.ts')).toBe(true);
  });

  it('scanDiffContent_EvalUsage_DetectsFindings', () => {
    const findings = scanDiffContent(makeEvalDiff());
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f: SecurityFinding) => f.pattern === 'eval() usage')).toBe(true);
    expect(findings[0].severity).toBe('HIGH');
    expect(findings[0].file).toBe('src/handler.ts');
  });

  it('scanDiffContent_SqlConcatenation_DetectsFindings', () => {
    const findings = scanDiffContent(makeSqlDiff());
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f: SecurityFinding) => f.pattern === 'SQL string concatenation')).toBe(true);
    expect(findings[0].severity).toBe('HIGH');
  });

  it('scanDiffContent_InnerHtml_DetectsFindings', () => {
    const findings = scanDiffContent(makeInnerHtmlDiff());
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f: SecurityFinding) => f.pattern === 'innerHTML assignment')).toBe(true);
    expect(findings[0].severity).toBe('MEDIUM');
  });

  it('scanDiffContent_DangerouslySetInnerHTML_DetectsFindings', () => {
    const findings = scanDiffContent(makeDangerouslySetInnerHTMLDiff());
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f: SecurityFinding) => f.pattern === 'dangerouslySetInnerHTML usage')).toBe(true);
    expect(findings[0].severity).toBe('MEDIUM');
  });

  it('scanDiffContent_MultipleIssues_DetectsAllPatterns', () => {
    const findings = scanDiffContent(makeMultiIssueDiff());
    // Should detect at least: PASSWORD credential, eval(), innerHTML, SQL concat
    expect(findings.length).toBeGreaterThanOrEqual(4);
    const patterns = findings.map((f: SecurityFinding) => f.pattern);
    expect(patterns).toContain('Hardcoded secret/credential');
    expect(patterns).toContain('eval() usage');
    expect(patterns).toContain('innerHTML assignment');
    expect(patterns).toContain('SQL string concatenation');
  });

  it('scanDiffContent_OnlyScansAddedLines_IgnoresRemovedLines', () => {
    const diff = [
      'diff --git a/src/config.ts b/src/config.ts',
      'index abc1234..def5678 100644',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,3 +1,3 @@',
      '-const API_KEY = "old-secret-key-value";',
      '+const config = {};',
      ' export default config;',
    ].join('\n');
    const findings = scanDiffContent(diff);
    expect(findings).toEqual([]);
  });

  it('scanDiffContent_TracksFileNames_FromDiffHeaders', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index abc1234..def5678 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      '+const API_KEY = "secret123";',
      ' export default {};',
      'diff --git a/src/b.ts b/src/b.ts',
      'index abc1234..def5678 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,2 +1,3 @@',
      '+const TOKEN = "tok_abc123";',
      ' export default {};',
    ].join('\n');
    const findings = scanDiffContent(diff);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.some((f: SecurityFinding) => f.file === 'src/a.ts')).toBe(true);
    expect(findings.some((f: SecurityFinding) => f.file === 'src/b.ts')).toBe(true);
  });

  it('scanDiffContent_TracksLineNumbers_FromHunkHeaders', () => {
    const diff = [
      'diff --git a/src/config.ts b/src/config.ts',
      'index abc1234..def5678 100644',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -10,2 +10,3 @@',
      '+const API_KEY = "secret123";',
      ' export default {};',
    ].join('\n');
    const findings = scanDiffContent(diff);
    expect(findings.length).toBe(1);
    expect(findings[0].line).toBe(10);
  });

  it('scanDiffContent_TruncatesLongContext', () => {
    const longValue = 'x'.repeat(200);
    const diff = [
      'diff --git a/src/config.ts b/src/config.ts',
      'index abc1234..def5678 100644',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,2 +1,3 @@',
      `+const API_KEY = "${longValue}";`,
      ' export default {};',
    ].join('\n');
    const findings = scanDiffContent(diff);
    expect(findings.length).toBe(1);
    expect(findings[0].context.length).toBeLessThanOrEqual(120);
    expect(findings[0].context.endsWith('...')).toBe(true);
  });
});

// ─── Tests: handleSecurityScan (handler integration) ────────────────────────

describe('handleSecurityScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleSecurityScan_MissingFeatureId_ReturnsError', async () => {
      const args = { featureId: '', diffContent: '' };
      const result = await handleSecurityScan(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });

    it('handleSecurityScan_MissingDiffContent_ReturnsError', async () => {
      const args = { featureId: 'feat-1' };
      const result = await handleSecurityScan(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('diffContent');
    });
  });

  // ─── No Findings ────────────────────────────────────────────────────────

  describe('no findings', () => {
    it('handleSecurityScan_CleanDiff_ReturnsPassed', async () => {
      const args = { featureId: 'feat-1', diffContent: makeCleanDiff() };
      const result = await handleSecurityScan(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        findings: SecurityFinding[];
        report: string;
      };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
      expect(data.findings).toEqual([]);
      expect(data.report).toContain('No security patterns detected');
    });

    it('handleSecurityScan_EmptyDiff_ReturnsPassed', async () => {
      const args = { featureId: 'feat-1', diffContent: '' };
      const result = await handleSecurityScan(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
      };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
    });
  });

  // ─── Findings Detected ─────────────────────────────────────────────────

  describe('findings detected', () => {
    it('handleSecurityScan_FindingsDetected_ReturnsFailWithCount', async () => {
      const args = { featureId: 'feat-1', diffContent: makeApiKeyDiff() };
      const result = await handleSecurityScan(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        findings: SecurityFinding[];
        report: string;
      };
      expect(data.passed).toBe(false);
      expect(data.findingCount).toBeGreaterThanOrEqual(2);
      expect(data.findings.length).toBeGreaterThanOrEqual(2);
      expect(data.report).toContain('FINDINGS');
    });

    it('handleSecurityScan_MultipleIssues_ReturnsAllFindings', async () => {
      const args = { featureId: 'feat-1', diffContent: makeMultiIssueDiff() };
      const result = await handleSecurityScan(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        findings: SecurityFinding[];
      };
      expect(data.passed).toBe(false);
      expect(data.findingCount).toBeGreaterThanOrEqual(4);
    });
  });

  // ─── Gate Event Emission ──────────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handleSecurityScan_CleanDiff_EmitsGatePassedEvent', async () => {
      const args = { featureId: 'feat-1', diffContent: makeCleanDiff() };
      await handleSecurityScan(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      expect(appendCall[0]).toBe('feat-1');
      const event = appendCall[1] as {
        type: string;
        data: {
          gateName: string;
          layer: string;
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(event.type).toBe('gate.executed');
      expect(event.data.gateName).toBe('security-scan');
      expect(event.data.layer).toBe('quality');
      expect(event.data.passed).toBe(true);
      expect(event.data.details).toEqual({
        dimension: 'D1',
        phase: 'review',
        findingCount: 0,
      });
    });

    it('handleSecurityScan_WithFindings_EmitsGateFailedEvent', async () => {
      const args = { featureId: 'feat-1', diffContent: makeApiKeyDiff() };
      await handleSecurityScan(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      const event = appendCall[1] as {
        type: string;
        data: {
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(event.data.passed).toBe(false);
      expect((event.data.details.findingCount as number)).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Phase in Gate Event Details ──────────────────────────────────────────

  describe('phase in gate event details', () => {
    it('handleSecurityScan_EmitsGateEvent_IncludesPhaseInDetails', async () => {
      const args = { featureId: 'feat-1', diffContent: makeCleanDiff() };
      await handleSecurityScan(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      const event = appendCall[1] as {
        type: string;
        data: { details: Record<string, unknown> };
      };
      expect(event.data.details.phase).toBe('review');
    });
  });

  // ─── Report Format ──────────────────────────────────────────────────────

  describe('report format', () => {
    it('handleSecurityScan_CleanReport_ContainsMarkdownHeading', async () => {
      const args = { featureId: 'feat-1', diffContent: makeCleanDiff() };
      const result = await handleSecurityScan(args, STATE_DIR, mockStore as unknown as EventStore);

      const data = result.data as { report: string };
      expect(data.report).toContain('## Security Scan Report');
    });

    it('handleSecurityScan_FindingsReport_ContainsMarkdownHeading', async () => {
      const args = { featureId: 'feat-1', diffContent: makeApiKeyDiff() };
      const result = await handleSecurityScan(args, STATE_DIR, mockStore as unknown as EventStore);

      const data = result.data as { report: string };
      expect(data.report).toContain('## Security Scan Report');
      expect(data.report).toContain('Findings');
    });
  });
});

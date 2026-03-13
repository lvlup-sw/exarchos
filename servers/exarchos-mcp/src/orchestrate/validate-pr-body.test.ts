// ─── Validate PR Body Tests ──────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleValidatePrBody } from './validate-pr-body.js';

// Mock child_process and fs
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

const VALID_BODY = [
  '## Summary',
  'This PR does things.',
  '',
  '## Changes',
  '- Changed stuff',
  '',
  '## Test Plan',
  '- Tested stuff',
].join('\n');

describe('handleValidatePrBody', () => {
  it('AllSectionsPresent_ReturnsPassed', async () => {
    const result = await handleValidatePrBody({ body: VALID_BODY });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; missingSections: readonly string[]; report: string };
    expect(data.passed).toBe(true);
    expect(data.missingSections).toEqual([]);
  });

  it('MissingSection_ReturnsFailed', async () => {
    const body = '## Summary\nSome summary\n';
    const result = await handleValidatePrBody({ body });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; missingSections: readonly string[]; report: string };
    expect(data.passed).toBe(false);
    expect(data.missingSections).toContain('Changes');
    expect(data.missingSections).toContain('Test Plan');
  });

  it('ReadsFromPrNumber', async () => {
    mockedExecFileSync.mockReturnValue(
      JSON.stringify({ body: VALID_BODY, author: { login: 'human' }, headRefName: 'feat/cool' }),
    );

    const result = await handleValidatePrBody({ pr: 42 });

    expect(result.success).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'view', '42']),
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(true);
  });

  it('ReadsFromBodyFile', async () => {
    mockedReadFileSync.mockReturnValue(VALID_BODY);

    const result = await handleValidatePrBody({ bodyFile: '/tmp/pr-body.md' });

    expect(result.success).toBe(true);
    expect(mockedReadFileSync).toHaveBeenCalledWith('/tmp/pr-body.md', 'utf-8');
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(true);
  });

  it('ReadsFromDirectBody', async () => {
    const result = await handleValidatePrBody({ body: VALID_BODY });

    expect(result.success).toBe(true);
    // Should not call execFileSync or readFileSync
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });

  it('NoInputSource_ReturnsError', async () => {
    const result = await handleValidatePrBody({});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/no input source/i);
  });

  it('GhFailure_ReturnsError', async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('gh: not found');
    });

    const result = await handleValidatePrBody({ pr: 999 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GH_ERROR');
  });

  it('ReportListsMissingSections', async () => {
    const body = '## Summary\nSome summary\n';
    const result = await handleValidatePrBody({ body });

    const data = result.data as { passed: boolean; missingSections: readonly string[]; report: string };
    expect(data.report).toContain('Missing: ## Changes');
    expect(data.report).toContain('Missing: ## Test Plan');
  });

  it('SkipsBotAuthors', async () => {
    mockedExecFileSync.mockReturnValue(
      JSON.stringify({ body: '', author: { login: 'renovate[bot]' }, headRefName: 'renovate/foo' }),
    );

    const result = await handleValidatePrBody({ pr: 10 });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; skipped: boolean };
    expect(data.passed).toBe(true);
    expect(data.skipped).toBe(true);
  });

  it('SkipsMergeQueuePRs', async () => {
    mockedExecFileSync.mockReturnValue(
      JSON.stringify({ body: '', author: { login: 'human' }, headRefName: 'gh-readonly-queue/main/pr-123' }),
    );

    const result = await handleValidatePrBody({ pr: 10 });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; skipped: boolean };
    expect(data.passed).toBe(true);
    expect(data.skipped).toBe(true);
  });

  it('TemplateExtractsSections', async () => {
    const templateContent = '## Motivation\n\n## Approach\n\n## Risks\n';
    mockedReadFileSync.mockReturnValue(templateContent);

    const body = '## Motivation\nWhy\n\n## Approach\nHow\n\n## Risks\nNone\n';
    const result = await handleValidatePrBody({ body, template: '/tmp/template.md' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(true);
    // readFileSync called once for template
    expect(mockedReadFileSync).toHaveBeenCalledWith('/tmp/template.md', 'utf-8');
  });

  it('CaseInsensitiveMatching', async () => {
    const body = '## summary\nSome text\n\n## changes\nStuff\n\n## test plan\nTests\n';
    const result = await handleValidatePrBody({ body });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(true);
  });
});

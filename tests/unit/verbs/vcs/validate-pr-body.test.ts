// Tests for `handleValidatePrBody`. The `node:child_process` mock keeps the
// real exports, because modules in the import graph call `promisify(execFile)`
// at load. It replaces only `execFileSync`, which the handler calls for
// `gh pr view`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleValidatePrBody } from '../../../../src/verbs/vcs/validate-pr-body.js';
import type { EventStore } from '../../../../src/events/store.js';
import { deriveIntent, INTENT_GROUNDING_MARKER } from '../../../../src/verbs/tasks/extract-intent.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
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

  /**
   * Under `enforce`, a missing section must be a refusal. A failure policy
   * reads the envelope, not the payload, so only a refusal can stop a later
   * step. The refusal message keeps the report.
   */
  it('MissingSectionUnderEnforce_ReturnsRefusalNamingTheSections', async () => {
    const body = '## Summary\nSome summary\n';
    const result = await handleValidatePrBody({ body, enforce: true });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PR_BODY_INCOMPLETE');
    expect(result.error?.message).toContain('Changes');
    expect(result.error?.message).toContain('Test Plan');
    expect(result.error?.message).toContain('PR body validation failed.');
  });

  /** `enforce` changes only the failure path. A passing body gets the same result as without it. */
  it('AllSectionsPresentUnderEnforce_StillReturnsThePassingCarrier', async () => {
    const result = await handleValidatePrBody({ body: VALID_BODY, enforce: true });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; missingSections: readonly string[] };
    expect(data.passed).toBe(true);
    expect(data.missingSections).toEqual([]);
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

/**
 * With a `featureId`, an event store, and a meaningful `artifacts.intent`, the
 * handler adds an advisory `intentGrounded` flag and a report line. The flag
 * does not change `passed`. Without these inputs, the grounding fields are
 * absent. The test store sets `artifacts.intent` through the real projection.
 */
describe('ValidatePrBody_WithIntent_GroundsBody (DR-1 task 006)', () => {
  interface GroundedResult {
    passed: boolean;
    missingSections: readonly string[];
    report: string;
    intentGrounded?: boolean;
  }

  function storeWithIntent(patch: Record<string, unknown>): EventStore {
    return {
      query: vi.fn().mockResolvedValue([
        {
          streamId: 'feat-x',
          sequence: 1,
          type: 'state.patched',
          timestamp: new Date().toISOString(),
          data: { patch },
        },
      ]),
    } as unknown as EventStore;
  }

  /** The body carries the grounding marker that `create_pr` adds. */
  it('GroundedBody_IntentReferenced_AdvisoryGroundedTrue', async () => {
    const intent = deriveIntent(['servers/a.ts', 'docs/b.md']);
    const body = `${VALID_BODY}\n\n## Intent\n\n${INTENT_GROUNDING_MARKER}\n\n${intent.summary}`;
    const store = storeWithIntent({ 'artifacts.intent': intent });

    const result = await handleValidatePrBody({ body, featureId: 'feat-x' }, undefined, store);

    expect(result.success).toBe(true);
    const data = result.data as GroundedResult;
    expect(data.passed).toBe(true);
    expect(data.intentGrounded).toBe(true);
    expect(data.report).toMatch(/grounded in artifacts\.intent/i);
  });

  /**
   * The body has all sections but no reference to the marker, the summary or
   * the surfaces of the intent. `passed` stays true.
   */
  it('UngroundedBody_IntentNotReferenced_AdvisoryGroundedFalse_PassUnchanged', async () => {
    const intent = deriveIntent(['servers/a.ts', 'docs/b.md']);
    const body = '## Summary\nUnrelated.\n\n## Changes\n- x\n\n## Test Plan\n- y\n';
    const store = storeWithIntent({ 'artifacts.intent': intent });

    const result = await handleValidatePrBody({ body, featureId: 'feat-x' }, undefined, store);

    const data = result.data as GroundedResult;
    expect(data.intentGrounded).toBe(false);
    expect(data.passed).toBe(true);
    expect(data.report).toMatch(/does NOT reference artifacts\.intent/i);
  });

  /**
   * Two required sections are missing, so `passed` must be false whatever the
   * grounding result. The advisory flag still shows.
   */
  it('Advisory_NeverChangesPassed_OnMissingSections', async () => {
    const intent = deriveIntent(['servers/a.ts']);
    const body = '## Summary\nOnly summary.\n';
    const store = storeWithIntent({ 'artifacts.intent': intent });

    const result = await handleValidatePrBody({ body, featureId: 'feat-x' }, undefined, store);

    const data = result.data as GroundedResult;
    expect(data.passed).toBe(false);
    expect(data.missingSections).toContain('Changes');
    expect(data.missingSections).toContain('Test Plan');
    expect(typeof data.intentGrounded).toBe('boolean');
  });

  it('NoFeatureId_GroundingFieldsAbsent_LegacyResult', async () => {
    const result = await handleValidatePrBody({ body: VALID_BODY });

    const data = result.data as GroundedResult;
    expect(data.passed).toBe(true);
    expect(data.intentGrounded).toBeUndefined();
    expect(data.report).not.toMatch(/artifacts\.intent/i);
  });

  /** A stored intent with no changed files is not meaningful, so the grounding fields are absent. */
  it('EmptyIntent_NotMeaningful_GroundingFieldsAbsent', async () => {
    const empty = deriveIntent([]);
    const store = storeWithIntent({ 'artifacts.intent': empty });

    const result = await handleValidatePrBody({ body: VALID_BODY, featureId: 'feat-x' }, undefined, store);

    const data = result.data as GroundedResult;
    expect(data.passed).toBe(true);
    expect(data.intentGrounded).toBeUndefined();
  });
});

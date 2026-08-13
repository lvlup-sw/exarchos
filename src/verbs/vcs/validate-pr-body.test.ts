// ─── Validate PR Body Tests ──────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleValidatePrBody } from './validate-pr-body.js';
import type { EventStore } from '../../events/store.js';
import { deriveIntent, INTENT_GROUNDING_MARKER } from '../tasks/extract-intent.js';

// Mock child_process and fs. We partially mock `node:child_process` —
// preserving the real exports (e.g. `execFile`, which `compensation.ts`
// `promisify`s at import time on the now-wider intent-grounding module graph)
// and overriding only `execFileSync`, which this handler calls for `gh pr view`.
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

// ─── DR-1 task 006: advisory intent-grounding ────────────────────────────────
//
// When `featureId` + an event store are supplied and a meaningful
// `artifacts.intent` resolves, the handler surfaces an ADVISORY `intentGrounded`
// flag + report line. It is advisory ONLY — never changes the `passed`
// (required-sections) gate. With no featureId / intent / event store the
// grounding fields are absent (unchanged legacy result).
// ─────────────────────────────────────────────────────────────────────────────

describe('ValidatePrBody_WithIntent_GroundsBody (DR-1 task 006)', () => {
  interface GroundedResult {
    passed: boolean;
    missingSections: readonly string[];
    report: string;
    intentGrounded?: boolean;
  }

  /**
   * An event store whose `query` returns a real `state.patched` event so
   * `resolveWorkflowState` materializes `artifacts.intent` through the REAL
   * projection — the exact read path the handler uses.
   */
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

  it('GroundedBody_IntentReferenced_AdvisoryGroundedTrue', async () => {
    const intent = deriveIntent(['servers/a.ts', 'docs/b.md']);
    // Body carries the grounding marker (the create_pr enrichment).
    const body = `${VALID_BODY}\n\n## Intent\n\n${INTENT_GROUNDING_MARKER}\n\n${intent.summary}`;
    const store = storeWithIntent({ 'artifacts.intent': intent });

    const result = await handleValidatePrBody({ body, featureId: 'feat-x' }, undefined, store);

    expect(result.success).toBe(true);
    const data = result.data as GroundedResult;
    expect(data.passed).toBe(true); // required sections still present
    expect(data.intentGrounded).toBe(true);
    expect(data.report).toMatch(/grounded in artifacts\.intent/i);
  });

  it('UngroundedBody_IntentNotReferenced_AdvisoryGroundedFalse_PassUnchanged', async () => {
    const intent = deriveIntent(['servers/a.ts', 'docs/b.md']);
    // Valid sections, but NO reference to the intent's marker / summary / surfaces.
    const body = '## Summary\nUnrelated.\n\n## Changes\n- x\n\n## Test Plan\n- y\n';
    const store = storeWithIntent({ 'artifacts.intent': intent });

    const result = await handleValidatePrBody({ body, featureId: 'feat-x' }, undefined, store);

    const data = result.data as GroundedResult;
    expect(data.intentGrounded).toBe(false);
    // Advisory does NOT flip the required-sections gate — body has all sections.
    expect(data.passed).toBe(true);
    expect(data.report).toMatch(/does NOT reference artifacts\.intent/i);
  });

  it('Advisory_NeverChangesPassed_OnMissingSections', async () => {
    const intent = deriveIntent(['servers/a.ts']);
    // Missing Changes + Test Plan — required gate must FAIL regardless of grounding.
    const body = '## Summary\nOnly summary.\n';
    const store = storeWithIntent({ 'artifacts.intent': intent });

    const result = await handleValidatePrBody({ body, featureId: 'feat-x' }, undefined, store);

    const data = result.data as GroundedResult;
    expect(data.passed).toBe(false); // gate stays the gate
    expect(data.missingSections).toContain('Changes');
    expect(data.missingSections).toContain('Test Plan');
    // Grounding advisory is still surfaced alongside the failing gate.
    expect(typeof data.intentGrounded).toBe('boolean');
  });

  it('NoFeatureId_GroundingFieldsAbsent_LegacyResult', async () => {
    // No featureId / event store → unchanged legacy result, no grounding fields.
    const result = await handleValidatePrBody({ body: VALID_BODY });

    const data = result.data as GroundedResult;
    expect(data.passed).toBe(true);
    expect(data.intentGrounded).toBeUndefined();
    expect(data.report).not.toMatch(/artifacts\.intent/i);
  });

  it('EmptyIntent_NotMeaningful_GroundingFieldsAbsent', async () => {
    // A persisted but empty intent (changedFiles: []) is not meaningful — omit.
    const empty = deriveIntent([]);
    const store = storeWithIntent({ 'artifacts.intent': empty });

    const result = await handleValidatePrBody({ body: VALID_BODY, featureId: 'feat-x' }, undefined, store);

    const data = result.data as GroundedResult;
    expect(data.passed).toBe(true);
    expect(data.intentGrounded).toBeUndefined();
  });
});

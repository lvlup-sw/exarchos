// ─── Check PR Comments Action Tests ─────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

// ─── Mock child_process ─────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

import { handleCheckPrComments } from './check-pr-comments.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** No comments on PR */
const FIXTURE_NO_COMMENTS: unknown[] = [];

/** All top-level comments have replies */
const FIXTURE_ALL_RESOLVED = [
  { id: 1, in_reply_to_id: null, user: { login: 'alice' }, path: 'src/foo.ts', line: 10, original_line: 10, body: 'Please fix this' },
  { id: 2, in_reply_to_id: 1, user: { login: 'bob' }, path: 'src/foo.ts', line: 10, original_line: 10, body: 'Fixed!' },
  { id: 3, in_reply_to_id: null, user: { login: 'alice' }, path: 'src/bar.ts', line: 20, original_line: 20, body: 'Rename this' },
  { id: 4, in_reply_to_id: 3, user: { login: 'bob' }, path: 'src/bar.ts', line: 20, original_line: 20, body: 'Done' },
];

/** Some top-level comments have no replies */
const FIXTURE_UNRESOLVED = [
  { id: 1, in_reply_to_id: null, user: { login: 'alice' }, path: 'src/foo.ts', line: 10, original_line: 10, body: 'Please fix this' },
  { id: 2, in_reply_to_id: 1, user: { login: 'bob' }, path: 'src/foo.ts', line: 10, original_line: 10, body: 'Fixed!' },
  { id: 3, in_reply_to_id: null, user: { login: 'alice' }, path: 'src/bar.ts', line: 20, original_line: 20, body: 'Rename this variable to something clearer' },
  // No reply to comment 3 — unresolved
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleCheckPrComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── No Comments ────────────────────────────────────────────────────────

  it('handleCheckPrComments_NoComments_ReturnsPassed', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(FIXTURE_NO_COMMENTS)));

    const result = handleCheckPrComments({ pr: 42, repo: 'owner/repo' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; totalComments: number; unresolvedThreads: number };
    expect(data.passed).toBe(true);
    expect(data.totalComments).toBe(0);
    expect(data.unresolvedThreads).toBe(0);
  });

  // ─── All Resolved ──────────────────────────────────────────────────────

  it('handleCheckPrComments_AllResolved_ReturnsPassed', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(FIXTURE_ALL_RESOLVED)));

    const result = handleCheckPrComments({ pr: 42, repo: 'owner/repo' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; totalComments: number; unresolvedThreads: number };
    expect(data.passed).toBe(true);
    expect(data.totalComments).toBe(4);
    expect(data.unresolvedThreads).toBe(0);
  });

  // ─── Unresolved Threads ────────────────────────────────────────────────

  it('handleCheckPrComments_UnresolvedThreads_ReturnsFailed', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(FIXTURE_UNRESOLVED)));

    const result = handleCheckPrComments({ pr: 42, repo: 'owner/repo' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; totalComments: number; unresolvedThreads: number };
    expect(data.passed).toBe(false);
    expect(data.totalComments).toBe(3);
    expect(data.unresolvedThreads).toBe(1);
  });

  // ─── Missing PR Number ────────────────────────────────────────────────

  it('handleCheckPrComments_MissingPrNumber_ReturnsError', () => {
    const result = handleCheckPrComments({ pr: 0, repo: 'owner/repo' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('pr');
  });

  // ─── GH CLI Failure ───────────────────────────────────────────────────

  it('handleCheckPrComments_GhCliFailure_ReturnsError', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('gh: command not found');
    });

    const result = handleCheckPrComments({ pr: 42, repo: 'owner/repo' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GH_API_ERROR');
    expect(result.error?.message).toContain('gh');
  });

  // ─── Report Contains Analysis ─────────────────────────────────────────

  it('handleCheckPrComments_ReportContainsAnalysis', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(FIXTURE_UNRESOLVED)));

    const result = handleCheckPrComments({ pr: 99, repo: 'owner/repo' });

    expect(result.success).toBe(true);
    const data = result.data as { report: string };
    expect(data.report).toContain('PR #99');
    expect(data.report).toContain('Top-level comments:');
    expect(data.report).toContain('Unaddressed:');
    expect(data.report).toContain('FAIL');
    expect(data.report).toContain('alice');
    expect(data.report).toContain('src/bar.ts');
  });
});

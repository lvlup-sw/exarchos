// ─── Generate Traceability Matrix Tests ──────────────────────────────────────
//
// Tests for the generate-traceability handler that produces a traceability
// matrix from design and plan markdown documents.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock node:fs ───────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { handleGenerateTraceability } from './generate-traceability.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const DESIGN_WITH_SECTIONS = `# Design Doc

## Authentication
Authentication handles user login.

## Data Storage
Database layer.
`;

const PLAN_WITH_MATCHING_TASKS = `# Implementation Plan

### Task 1: Implement Authentication
Build the auth module.

### Task 2: Build Data Storage Layer
Create database adapters.

### Task 3: Add Logging
Set up structured logging.
`;

const DESIGN_WITH_SUBSECTIONS = `# Design Doc

## Authentication
Authentication handles user login.

### Token Management
Token refresh logic.

## Data Storage
Database layer.
`;

const PLAN_WITH_BODY_MATCH = `# Implementation Plan

### Task 1: Build Widget
This task covers token management and refresh logic.

### Task 2: Setup Infrastructure
General infrastructure setup.
`;

const PLAN_WITH_NO_MATCHES = `# Implementation Plan

### Task 1: Unrelated Feature
Something completely different.

### Task 2: Another Unrelated Feature
Nothing to see here.
`;

const DESIGN_NO_SECTIONS = `# Design Doc

Just some text without any ## or ### headers.
`;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleGenerateTraceability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  // ─── Covered sections ─────────────────────────────────────────────────

  describe('design with sections + plan with matching tasks', () => {
    it('returns covered table with matched task IDs', () => {
      mockReadFileSync
        .mockReturnValueOnce(DESIGN_WITH_SECTIONS)
        .mockReturnValueOnce(PLAN_WITH_MATCHING_TASKS);

      const result = handleGenerateTraceability({
        designFile: '/tmp/design.md',
        planFile: '/tmp/plan.md',
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        report: string;
        sections: number;
        coveredCount: number;
        uncoveredCount: number;
      };
      expect(data.passed).toBe(true);
      expect(data.report).toContain('Authentication');
      expect(data.report).toContain('Data Storage');
      expect(data.report).toContain('Covered');
      // Authentication matches Task 1, Data Storage matches Task 2
      expect(data.report).toContain('| 1 |');
      expect(data.report).toContain('| 2 |');
      expect(data.coveredCount).toBeGreaterThan(0);
    });
  });

  // ─── Uncovered sections ───────────────────────────────────────────────

  describe('design sections with no matching tasks', () => {
    it('returns uncovered status for unmatched sections', () => {
      mockReadFileSync
        .mockReturnValueOnce(DESIGN_WITH_SECTIONS)
        .mockReturnValueOnce(PLAN_WITH_NO_MATCHES);

      const result = handleGenerateTraceability({
        designFile: '/tmp/design.md',
        planFile: '/tmp/plan.md',
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        report: string;
        uncoveredCount: number;
      };
      expect(data.passed).toBe(false);
      expect(data.report).toContain('Uncovered');
      expect(data.uncoveredCount).toBeGreaterThan(0);
    });
  });

  // ─── Body content match ───────────────────────────────────────────────

  describe('match via plan body content', () => {
    it('marks section as covered with "?" task ID for body-only matches', () => {
      mockReadFileSync
        .mockReturnValueOnce(DESIGN_WITH_SUBSECTIONS)
        .mockReturnValueOnce(PLAN_WITH_BODY_MATCH);

      const result = handleGenerateTraceability({
        designFile: '/tmp/design.md',
        planFile: '/tmp/plan.md',
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        report: string;
        coveredCount: number;
      };
      // "Token Management" should match via body content with "?"
      expect(data.report).toContain('?');
      expect(data.report).toContain('Covered');
    });
  });

  // ─── No design sections ──────────────────────────────────────────────

  describe('no design sections found', () => {
    it('returns error when design has no ## or ### headers', () => {
      mockReadFileSync
        .mockReturnValueOnce(DESIGN_NO_SECTIONS)
        .mockReturnValueOnce(PLAN_WITH_MATCHING_TASKS);

      const result = handleGenerateTraceability({
        designFile: '/tmp/design.md',
        planFile: '/tmp/plan.md',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_SECTIONS');
      expect(result.error?.message).toContain('No ## or ### headers');
    });
  });

  // ─── Design file not found ────────────────────────────────────────────

  describe('design file not found', () => {
    it('returns error when design file does not exist', () => {
      mockExistsSync.mockImplementation((p) =>
        String(p) === '/tmp/plan.md',
      );

      const result = handleGenerateTraceability({
        designFile: '/tmp/missing-design.md',
        planFile: '/tmp/plan.md',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_NOT_FOUND');
      expect(result.error?.message).toContain('Design file not found');
    });
  });

  // ─── Plan file not found ──────────────────────────────────────────────

  describe('plan file not found', () => {
    it('returns error when plan file does not exist', () => {
      mockExistsSync.mockImplementation((p) =>
        String(p) === '/tmp/design.md',
      );

      const result = handleGenerateTraceability({
        designFile: '/tmp/design.md',
        planFile: '/tmp/missing-plan.md',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_NOT_FOUND');
      expect(result.error?.message).toContain('Plan file not found');
    });
  });

  // ─── Output to file ──────────────────────────────────────────────────

  describe('output to file', () => {
    it('writes markdown table to outputFile when specified', () => {
      mockReadFileSync
        .mockReturnValueOnce(DESIGN_WITH_SECTIONS)
        .mockReturnValueOnce(PLAN_WITH_MATCHING_TASKS);

      const result = handleGenerateTraceability({
        designFile: '/tmp/design.md',
        planFile: '/tmp/plan.md',
        outputFile: '/tmp/traceability.md',
      });

      expect(result.success).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/traceability.md',
        expect.stringContaining('Traceability Matrix'),
        'utf-8',
      );
    });
  });

  // ─── Case-insensitive matching ────────────────────────────────────────

  describe('case-insensitive matching', () => {
    it('matches design sections to tasks regardless of case', () => {
      const designUpper = `# Design

## AUTHENTICATION
Auth section.
`;
      const planLower = `# Plan

### Task 1: implement authentication
Build auth.
`;
      mockReadFileSync
        .mockReturnValueOnce(designUpper)
        .mockReturnValueOnce(planLower);

      const result = handleGenerateTraceability({
        designFile: '/tmp/design.md',
        planFile: '/tmp/plan.md',
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        report: string;
        coveredCount: number;
      };
      expect(data.report).toContain('Covered');
      expect(data.coveredCount).toBeGreaterThan(0);
    });
  });
});

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
// node:fs is mocked above; node:fs/promises stays REAL so corpus-regression
// tests can read the shipped docs/specs/ fixture from disk.
import { readFile as readFileReal } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleGenerateTraceability } from './generate-traceability.js';

// Repo root: this file lives at servers/exarchos-mcp/src/orchestrate/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const WLM_SPEC_PATH = resolve(REPO_ROOT, 'docs/specs/2026-07-03-wlm-6-surface-and-workflow-fixes.md');

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

  // ─── DR-N sections via **Implements:** annotations (issue #1544) ────────
  describe('DR-N sections resolved via **Implements:** annotations (#1544)', () => {
    it('marks a DR-N section Covered when a task implements it (agrees with provenance)', () => {
      const design = `# Design

### DR-1: First requirement
Some prose.

### DR-2: Second requirement
More prose.
`;
      const plan = `# Plan

### Task 1: Build the widget
**Implements:** DR-1

### Task 2: Add the API client
**Implements:** DR-2
`;
      mockReadFileSync.mockReturnValueOnce(design).mockReturnValueOnce(plan);

      const result = handleGenerateTraceability({
        designFile: '/tmp/design.md',
        planFile: '/tmp/plan.md',
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        coveredCount: number;
        uncoveredCount: number;
        report: string;
      };
      // Title substring matching would have flagged both DR rows Uncovered;
      // the **Implements:** annotation resolves them Covered, matching the
      // authoritative check_provenance_chain (9/9-style) result.
      expect(data.uncoveredCount).toBe(0);
      expect(data.coveredCount).toBe(2);
      expect(data.report).not.toContain('Uncovered');
    });
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

  // ─── Unified docs/specs/ template shape (#1654, DR-1) ────────────────────
  describe('unified spec template shape (#1654, DR-1)', () => {
    const UNIFIED_SPEC = [
      '# Spec: Widget Pipeline',
      '',
      '## Design & Rationale',
      '',
      '### Problem Statement',
      '',
      'The widget pipeline drops records under load.',
      '',
      '### Requirements (DR-N)',
      '',
      '#### DR-1: Bounded queue backpressure',
      '',
      'Records queue with backpressure instead of dropping.',
      '',
      '#### DR-2: Structured drop metrics',
      '',
      'Rejected records emit a structured metric.',
      '',
      '### Technical Design',
      '',
      'A `BoundedQueue` wraps the ingest path.',
      '',
      '## Decomposition',
      '',
      '### Tasks',
      '',
      '#### Task 001: Add the bounded queue',
      '',
      '**Implements:** DR-1',
      '',
      '#### Task 002: Emit rejection counters',
      '',
      '**Implements:** DR-2',
    ].join('\n');

    it('UnifiedSpec_TemplateVerbatim_ParsesDrsAndTasks', () => {
      // One unified artifact: designFile === planFile.
      mockReadFileSync.mockReturnValue(UNIFIED_SPEC);

      const result = handleGenerateTraceability({
        designFile: '/tmp/spec.md',
        planFile: '/tmp/spec.md',
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        sections: number;
        coveredCount: number;
        uncoveredCount: number;
        report: string;
      };
      // DR-preference: only the two `#### DR-N:` sections become matrix rows —
      // narrative headers (Problem Statement, Technical Design, …) do not.
      expect(data.sections).toBe(2);
      expect(data.coveredCount).toBe(2);
      expect(data.uncoveredCount).toBe(0);
      expect(data.passed).toBe(true);
      // Real section names and the implementing task ids appear in the rows.
      expect(data.report).toContain('DR-1: Bounded queue backpressure');
      expect(data.report).toContain('DR-2: Structured drop metrics');
      expect(data.report).toContain('001');
      expect(data.report).toContain('002');
    });

    it('LegacyPair_TwoFileShape_Unchanged', () => {
      // Legacy two-file shape with NO DR-N sections: ALL ##/### headers stay
      // matrix rows and h3 tasks resolve them — pre-#1654 behavior unchanged.
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
        sections: number;
        coveredCount: number;
        uncoveredCount: number;
        report: string;
      };
      expect(data.sections).toBe(2);
      expect(data.coveredCount).toBe(2);
      expect(data.uncoveredCount).toBe(0);
      expect(data.passed).toBe(true);
      expect(data.report).toContain('| Authentication |');
      expect(data.report).toContain('| Data Storage |');
    });

    it('WlmCorpusSpec_UnifiedShape_ParsesFourDrsSevenTasks', async () => {
      // Regression pin against the real shipped corpus file (#1654 acceptance
      // criterion): 4 DR rows, all covered by the 7 h4 tasks' Implements lines.
      const wlmSpec = await readFileReal(WLM_SPEC_PATH, 'utf-8');
      mockReadFileSync.mockReturnValue(wlmSpec);

      const result = handleGenerateTraceability({
        designFile: WLM_SPEC_PATH,
        planFile: WLM_SPEC_PATH,
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        sections: number;
        coveredCount: number;
        uncoveredCount: number;
        report: string;
      };
      expect(data.sections).toBe(4);
      expect(data.coveredCount).toBe(4);
      expect(data.uncoveredCount).toBe(0);
      expect(data.passed).toBe(true);
      for (const dr of ['DR-1', 'DR-2', 'DR-3', 'DR-4']) {
        expect(data.report).toContain(dr);
      }
      // Task ids resolved from the h4 `#### Task NNN:` headers.
      expect(data.report).toContain('001');
      expect(data.report).toContain('007');
    });
  });
});

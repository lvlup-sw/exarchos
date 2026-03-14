// ─── Plan Coverage Action Tests ──────────────────────────────────────────────
//
// Tests for pure TypeScript plan-coverage validation functions.
// Replaces bash script invocation with native TypeScript logic.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: () => mockStore,
  getOrCreateMaterializer: () => ({}),
}));

// ─── Mock fs for handlePlanCoverage ──────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import {
  parseDesignSections,
  parsePlanTasks,
  extractKeywords,
  keywordMatch,
  parseDeferredSections,
  computeCoverage,
  handlePlanCoverage,
  detectGwtSections,
  parseAcceptanceTestTasks,
  checkAcceptanceTestCoverage,
} from './plan-coverage.js';

const STATE_DIR = '/tmp/test-plan-coverage';

// ─── parseDesignSections Tests ──────────────────────────────────────────────

describe('parseDesignSections', () => {
  it('ParseDesignSections_TechnicalDesignHeader_ExtractsSubsections', () => {
    const markdown = [
      '# Feature Design',
      '',
      '## Problem Statement',
      '',
      'Some problem.',
      '',
      '## Technical Design',
      '',
      '### Component 1',
      '',
      'Description of component 1.',
      '',
      '### Component 2',
      '',
      'Description of component 2.',
      '',
      '## Testing Strategy',
      '',
      'Unit tests.',
    ].join('\n');

    const result = parseDesignSections(markdown);
    expect(result).toEqual(['Component 1', 'Component 2']);
  });

  it('ParseDesignSections_RequirementsHeader_ExtractsSubsections', () => {
    const markdown = [
      '# Feature Design',
      '',
      '## Design Requirements',
      '',
      '### DR-1',
      '',
      'First requirement.',
      '',
      '### DR-2',
      '',
      'Second requirement.',
      '',
      '## Out of Scope',
      '',
      'Nothing.',
    ].join('\n');

    const result = parseDesignSections(markdown);
    expect(result).toEqual(['DR-1', 'DR-2']);
  });

  it('ParseDesignSections_CaseInsensitive_AcceptsLowercaseHeaders', () => {
    const markdown = [
      '# Feature Design',
      '',
      '## technical design',
      '',
      '### Widget Component',
      '',
      'Renders widgets.',
      '',
      '## testing strategy',
      '',
      'Tests.',
    ].join('\n');

    const result = parseDesignSections(markdown);
    expect(result).toEqual(['Widget Component']);
  });

  it('ParseDesignSections_HierarchicalPreference_PrefersH4OverH3', () => {
    const markdown = [
      '# Feature Design',
      '',
      '## Technical Design',
      '',
      '### Component 1',
      '',
      'High-level description.',
      '',
      '#### SubA',
      '',
      'Sub-component A.',
      '',
      '#### SubB',
      '',
      'Sub-component B.',
      '',
      '## Testing Strategy',
      '',
      'Tests.',
    ].join('\n');

    const result = parseDesignSections(markdown);
    expect(result).toEqual(['SubA', 'SubB']);
  });

  it('ParseDesignSections_MixedHierarchy_UsesH4WhenAvailableH3Otherwise', () => {
    const markdown = [
      '# Feature Design',
      '',
      '## Technical Design',
      '',
      '### Stream 1: Auth Module',
      '',
      '#### Token Validation',
      '',
      'Validate JWT tokens.',
      '',
      '#### Session Management',
      '',
      'Handle sessions.',
      '',
      '### API Client',
      '',
      'Handles data fetching.',
      '',
      '## Testing Strategy',
      '',
      'Tests.',
    ].join('\n');

    const result = parseDesignSections(markdown);
    expect(result).toEqual(['Token Validation', 'Session Management', 'API Client']);
  });

  it('ParseDesignSections_NoDesignSection_ReturnsEmptyArray', () => {
    const markdown = [
      '# Feature Design',
      '',
      '## Problem Statement',
      '',
      'Some problem.',
      '',
      '## Testing Strategy',
      '',
      'Tests.',
    ].join('\n');

    const result = parseDesignSections(markdown);
    expect(result).toEqual([]);
  });

  it('ParseDesignSections_RequirementsAlternateHeader_Works', () => {
    const markdown = [
      '# Feature',
      '',
      '## Requirements',
      '',
      '### DR-1: Widget',
      '',
      'Build widget.',
      '',
      '### DR-2: Cache',
      '',
      'Build cache.',
    ].join('\n');

    const result = parseDesignSections(markdown);
    expect(result).toEqual(['DR-1: Widget', 'DR-2: Cache']);
  });
});

// ─── parsePlanTasks Tests ────────────────────────────────────────────────────

describe('parsePlanTasks', () => {
  it('ParsePlanTasks_StandardFormat_ExtractsTitles', () => {
    const markdown = [
      '# Implementation Plan',
      '',
      '## Tasks',
      '',
      '### Task T-01: Extract hydrate function',
      '',
      'Build the hydration layer.',
      '',
      '### Task T-02: Add validation',
      '',
      'Build validation.',
    ].join('\n');

    const result = parsePlanTasks(markdown);
    expect(result).toEqual([
      { id: 'T-01', title: 'Extract hydrate function' },
      { id: 'T-02', title: 'Add validation' },
    ]);
  });

  it('ParsePlanTasks_NumericFormat_ExtractsTitles', () => {
    const markdown = [
      '# Implementation Plan',
      '',
      '### Task 001: Create Widget Component',
      '',
      'Build the widget.',
      '',
      '### Task 002: Create API Client',
      '',
      'Build the API.',
    ].join('\n');

    const result = parsePlanTasks(markdown);
    expect(result).toEqual([
      { id: '001', title: 'Create Widget Component' },
      { id: '002', title: 'Create API Client' },
    ]);
  });

  it('ParsePlanTasks_NoTasks_ReturnsEmptyArray', () => {
    const markdown = [
      '# Implementation Plan',
      '',
      '## Overview',
      '',
      'This is the overview.',
    ].join('\n');

    const result = parsePlanTasks(markdown);
    expect(result).toEqual([]);
  });

  it('ParsePlanTasks_MixedFormats_ExtractsAll', () => {
    const markdown = [
      '### Task 1: Simple number',
      '',
      '### Task T-05: Dash format',
      '',
      '### Task 123: Three digit',
    ].join('\n');

    const result = parsePlanTasks(markdown);
    expect(result).toEqual([
      { id: '1', title: 'Simple number' },
      { id: 'T-05', title: 'Dash format' },
      { id: '123', title: 'Three digit' },
    ]);
  });
});

// ─── extractKeywords Tests ──────────────────────────────────────────────────

describe('extractKeywords', () => {
  it('ExtractKeywords_StopWordsFiltered_ReturnsSignificantWords', () => {
    const result = extractKeywords('The unified events hydration function');
    expect(result).toEqual(['unified', 'events', 'hydration', 'function']);
  });

  it('ExtractKeywords_ShortWordsFiltered_SkipsUnderThreeChars', () => {
    const result = extractKeywords('UI is a go');
    // 'ui' is 2 chars, 'is' is stop word + 2 chars, 'a' is stop word + 1 char, 'go' is 2 chars
    expect(result).toEqual([]);
  });

  it('ExtractKeywords_CaseInsensitive_ReturnsLowercase', () => {
    const result = extractKeywords('Token Validation');
    expect(result).toEqual(['token', 'validation']);
  });

  it('ExtractKeywords_NonAlphaStripped_SplitsOnPunctuation', () => {
    const result = extractKeywords('DR-1: Sensitive Document Removal');
    // Should split on non-alpha, filter short words and stop words
    expect(result).toContain('sensitive');
    expect(result).toContain('document');
    expect(result).toContain('removal');
  });
});

// ─── keywordMatch Tests ─────────────────────────────────────────────────────

describe('keywordMatch', () => {
  it('KeywordMatch_TwoKeywordsFound_ReturnsTrue', () => {
    const sectionKeywords = ['token', 'validation'];
    const targetText = 'Implement token validation for JWT';
    expect(keywordMatch(sectionKeywords, targetText)).toBe(true);
  });

  it('KeywordMatch_OneKeywordOnly_ReturnsFalse', () => {
    const sectionKeywords = ['token', 'validation'];
    const targetText = 'Build the token generation module';
    expect(keywordMatch(sectionKeywords, targetText)).toBe(false);
  });

  it('KeywordMatch_SingleKeyword_MatchesOnOne', () => {
    const sectionKeywords = ['monitoring'];
    const targetText = 'Add monitoring to the system';
    expect(keywordMatch(sectionKeywords, targetText)).toBe(true);
  });

  it('KeywordMatch_CaseInsensitive_MatchesAcrossCase', () => {
    const sectionKeywords = ['widget', 'component'];
    const targetText = 'Create Widget Component';
    expect(keywordMatch(sectionKeywords, targetText)).toBe(true);
  });

  it('KeywordMatch_NoKeywordsMatch_ReturnsFalse', () => {
    const sectionKeywords = ['cache', 'layer'];
    const targetText = 'Build the authentication module';
    expect(keywordMatch(sectionKeywords, targetText)).toBe(false);
  });
});

// ─── parseDeferredSections Tests ────────────────────────────────────────────

describe('parseDeferredSections', () => {
  it('ParseDeferredSections_TraceabilityTable_ExtractsDeferredNames', () => {
    const planContent = [
      '## Spec Traceability',
      '',
      '| Design Section | Task ID(s) | Status |',
      '|----------------|-----------|--------|',
      '| Component A | T001 | Covered |',
      '| Component B | Deferred | Operational process. |',
    ].join('\n');

    const result = parseDeferredSections(planContent);
    expect(result).toEqual(['Component B']);
  });

  it('ParseDeferredSections_NoDeferredRows_ReturnsEmpty', () => {
    const planContent = [
      '## Spec Traceability',
      '',
      '| Design Section | Task ID(s) | Status |',
      '|----------------|-----------|--------|',
      '| Component A | T001 | Covered |',
      '| Component B | T002 | Covered |',
    ].join('\n');

    const result = parseDeferredSections(planContent);
    expect(result).toEqual([]);
  });

  it('ParseDeferredSections_NumberPrefix_StripsPrefix', () => {
    const planContent = [
      '## Spec Traceability',
      '',
      '| Design Section | Task ID(s) | Status |',
      '|----------------|-----------|--------|',
      '| 1.4 Monitoring | Deferred | Phase 2 work. |',
    ].join('\n');

    const result = parseDeferredSections(planContent);
    expect(result).toEqual(['Monitoring']);
  });

  it('ParseDeferredSections_CaseInsensitive_MatchesDeferred', () => {
    const planContent = [
      '## Spec Traceability',
      '',
      '| Design Section | Task ID(s) | Status |',
      '|----------------|-----------|--------|',
      '| Cache Layer | deferred | Will add later. |',
    ].join('\n');

    const result = parseDeferredSections(planContent);
    expect(result).toEqual(['Cache Layer']);
  });

  it('ParseDeferredSections_OutsideTraceabilityTable_IgnoresRows', () => {
    const planContent = [
      '## Tasks',
      '',
      '| Status | Notes |',
      '|--------|-------|',
      '| Deferred | Some task body table |',
    ].join('\n');

    const result = parseDeferredSections(planContent);
    expect(result).toEqual([]);
  });
});

// ─── computeCoverage Tests ──────────────────────────────────────────────────

describe('computeCoverage', () => {
  it('ComputeCoverage_AllSectionsCovered_ReturnsPass', () => {
    const designSections = ['Widget Component', 'API Client', 'State Manager'];
    const tasks = [
      { id: '001', title: 'Create Widget Component' },
      { id: '002', title: 'Create API Client' },
      { id: '003', title: 'Create State Manager' },
    ];
    const planContent = [
      '### Task 001: Create Widget Component',
      'Design section: Widget Component',
      '### Task 002: Create API Client',
      'Design section: API Client',
      '### Task 003: Create State Manager',
      'Design section: State Manager',
    ].join('\n');
    const deferredSections: string[] = [];

    const result = computeCoverage(designSections, tasks, planContent, deferredSections);
    expect(result.passed).toBe(true);
    expect(result.coverage.gaps).toBe(0);
    expect(result.coverage.covered).toBe(3);
    expect(result.coverage.total).toBe(3);
  });

  it('ComputeCoverage_DeferredSection_CountedAsDeferred', () => {
    const designSections = ['Auth Module', 'Monitoring'];
    const tasks = [
      { id: '001', title: 'Implement auth module' },
    ];
    const planContent = '### Task 001: Implement auth module\nBuild authentication.';
    const deferredSections = ['Monitoring'];

    const result = computeCoverage(designSections, tasks, planContent, deferredSections);
    expect(result.passed).toBe(true);
    expect(result.coverage.deferred).toBe(1);
    expect(result.coverage.covered).toBe(1);
    expect(result.coverage.gaps).toBe(0);
    expect(result.coverage.total).toBe(2);
  });

  it('ComputeCoverage_MissingSections_ReportsGaps', () => {
    const designSections = ['Widget Component', 'API Client', 'Cache Layer'];
    const tasks = [
      { id: '001', title: 'Create Widget Component' },
      { id: '002', title: 'Create API Client' },
    ];
    const planContent = [
      '### Task 001: Create Widget Component',
      '### Task 002: Create API Client',
    ].join('\n');
    const deferredSections: string[] = [];

    const result = computeCoverage(designSections, tasks, planContent, deferredSections);
    expect(result.passed).toBe(false);
    expect(result.coverage.gaps).toBe(1);
    expect(result.coverage.covered).toBe(2);
    expect(result.coverage.total).toBe(3);
    expect(result.gapSections).toContain('Cache Layer');
  });

  it('ComputeCoverage_DeferredAndGap_ReportsOnlyGapsAsFailing', () => {
    const designSections = ['Auth Module', 'Cache Layer', 'Rate Limiting'];
    const tasks = [
      { id: '001', title: 'Implement auth module' },
    ];
    const planContent = '### Task 001: Implement auth module\nBuild authentication.';
    const deferredSections = ['Cache Layer'];

    const result = computeCoverage(designSections, tasks, planContent, deferredSections);
    expect(result.passed).toBe(false);
    expect(result.coverage.gaps).toBe(1);
    expect(result.coverage.deferred).toBe(1);
    expect(result.coverage.covered).toBe(1);
    expect(result.gapSections).toContain('Rate Limiting');
    expect(result.gapSections).not.toContain('Cache Layer');
  });

  it('ComputeCoverage_KeywordMatchInPlanBody_CountsAsCovered', () => {
    const designSections = ['Token Validation'];
    const tasks = [
      { id: '001', title: 'Implement auth module' },
    ];
    // The plan body mentions token and validation keywords
    const planContent = [
      '### Task 001: Implement auth module',
      '',
      'This task includes token validation logic.',
    ].join('\n');
    const deferredSections: string[] = [];

    const result = computeCoverage(designSections, tasks, planContent, deferredSections);
    expect(result.passed).toBe(true);
    expect(result.coverage.covered).toBe(1);
    expect(result.coverage.gaps).toBe(0);
  });
});

// ─── Acceptance Test Coverage Tests ──────────────────────────────────────────

describe('detectGwtSections', () => {
  it('DetectGwtSections_GivenWhenThenPresent_ReturnsSectionName', () => {
    const designContent = [
      '## Design Requirements',
      '',
      '### DR-1: User Authentication',
      '',
      '**Given** a user with valid credentials',
      '**When** they submit the login form',
      '**Then** they receive an auth token',
      '',
      '### DR-2: Dashboard Layout',
      '',
      '- Must display widgets',
      '- Must be responsive',
    ].join('\n');

    const result = detectGwtSections(designContent);
    expect(result).toEqual(['DR-1: User Authentication']);
  });

  it('DetectGwtSections_NoneHaveGwt_ReturnsEmpty', () => {
    const designContent = [
      '## Design Requirements',
      '',
      '### DR-1: Simple Feature',
      '',
      '- Must do thing A',
      '- Must do thing B',
    ].join('\n');

    const result = detectGwtSections(designContent);
    expect(result).toEqual([]);
  });
});

describe('parseAcceptanceTestTasks', () => {
  it('ParseAcceptanceTestTasks_TestLayerAcceptance_ReturnsTask', () => {
    const planContent = [
      '### Task T-01: Build widget',
      '',
      '**Implements:** DR-1',
      '**Test Layer:** unit',
      '',
      '### Task T-02: Acceptance test for auth',
      '',
      '**Implements:** DR-1',
      '**Test Layer:** acceptance',
    ].join('\n');

    const result = parseAcceptanceTestTasks(planContent);
    expect(result).toEqual([
      { taskId: 'T-02', taskTitle: 'Acceptance test for auth', implementsDrs: ['DR-1'] },
    ]);
  });

  it('ParseAcceptanceTestTasks_NoAcceptanceTasks_ReturnsEmpty', () => {
    const planContent = [
      '### Task T-01: Build widget',
      '',
      '**Implements:** DR-1',
      '**Test Layer:** unit',
    ].join('\n');

    const result = parseAcceptanceTestTasks(planContent);
    expect(result).toEqual([]);
  });
});

describe('acceptance test coverage in computeCoverage', () => {
  it('checkPlanCoverage_DRWithGivenWhenThen_RequiresAcceptanceTestTask', () => {
    const designContent = [
      '## Design Requirements',
      '',
      '### DR-1: User Authentication',
      '',
      '**Given** a user with valid credentials',
      '**When** they submit the login form',
      '**Then** they receive an auth token',
    ].join('\n');

    const designSections = parseDesignSections(designContent);
    const planContent = [
      '### Task T-01: Implement user authentication',
      '',
      '**Implements:** DR-1',
      '**Test Layer:** unit',
      '',
      'Build the auth module.',
    ].join('\n');

    const tasks = parsePlanTasks(planContent);
    const deferredSections: string[] = [];

    const result = computeCoverage(designSections, tasks, planContent, deferredSections, designContent);
    // The section is covered (task matches), but advisory should flag missing acceptance test
    expect(result.advisories).toBeDefined();
    expect(result.advisories!.length).toBeGreaterThan(0);
    expect(result.advisories![0]).toContain('DR-1');
    expect(result.advisories![0]).toContain('acceptance');
  });

  it('checkPlanCoverage_AcceptanceTestTaskPresent_Passes', () => {
    const designContent = [
      '## Design Requirements',
      '',
      '### DR-1: User Authentication',
      '',
      '**Given** a user with valid credentials',
      '**When** they submit the login form',
      '**Then** they receive an auth token',
    ].join('\n');

    const designSections = parseDesignSections(designContent);
    const planContent = [
      '### Task T-01: Implement user authentication',
      '',
      '**Implements:** DR-1',
      '**Test Layer:** unit',
      '',
      'Build the auth module.',
      '',
      '### Task T-02: Acceptance test for user authentication',
      '',
      '**Implements:** DR-1',
      '**Test Layer:** acceptance',
      '',
      'Verify Given/When/Then scenarios.',
    ].join('\n');

    const tasks = parsePlanTasks(planContent);
    const deferredSections: string[] = [];

    const result = computeCoverage(designSections, tasks, planContent, deferredSections, designContent);
    // No advisories — acceptance test task exists for DR-1
    expect(result.advisories ?? []).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('checkPlanCoverage_DRWithBulletPoints_NoAcceptanceTestRequired', () => {
    const designContent = [
      '## Design Requirements',
      '',
      '### DR-2: Dashboard Layout',
      '',
      '- Must display widgets in a grid',
      '- Must be responsive on mobile',
      '- Must support dark mode',
    ].join('\n');

    const designSections = parseDesignSections(designContent);
    const planContent = [
      '### Task T-01: Build dashboard layout',
      '',
      '**Implements:** DR-2',
      '**Test Layer:** unit',
      '',
      'Create the dashboard grid layout.',
    ].join('\n');

    const tasks = parsePlanTasks(planContent);
    const deferredSections: string[] = [];

    const result = computeCoverage(designSections, tasks, planContent, deferredSections, designContent);
    // No advisories — DR-2 only has bullet-point criteria, no GWT
    expect(result.advisories ?? []).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

// ─── handlePlanCoverage Tests ───────────────────────────────────────────────

describe('handlePlanCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handlePlanCoverage_MissingFeatureId_ReturnsError', async () => {
      const args = { featureId: '', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' };
      const result = await handlePlanCoverage(args, STATE_DIR);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });

    it('handlePlanCoverage_MissingDesignPath_ReturnsError', async () => {
      const args = { featureId: 'feat-1', designPath: '', planPath: '/tmp/plan.md' };
      const result = await handlePlanCoverage(args, STATE_DIR);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('designPath');
    });

    it('handlePlanCoverage_MissingPlanPath_ReturnsError', async () => {
      const args = { featureId: 'feat-1', designPath: '/tmp/design.md', planPath: '' };
      const result = await handlePlanCoverage(args, STATE_DIR);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('planPath');
    });
  });

  // ─── Full integration via handlePlanCoverage ──────────────────────────────

  describe('HandlePlanCoverage_RealDesignDoc_NoCrash', () => {
    it('handlePlanCoverage_WithValidContent_ReturnsStructuredResult', async () => {
      const designContent = [
        '# Feature Design',
        '',
        '## Technical Design',
        '',
        '### Widget Component',
        '',
        'Renders the main UI.',
        '',
        '### API Client',
        '',
        'Handles data fetching.',
        '',
        '## Testing Strategy',
        '',
        'Unit tests.',
      ].join('\n');

      const planContent = [
        '# Implementation Plan',
        '',
        '## Tasks',
        '',
        '### Task 001: Create Widget Component',
        '',
        'Build the widget rendering layer.',
        '',
        '### Task 002: Create API Client',
        '',
        'Build the API integration.',
      ].join('\n');

      vi.mocked(readFile).mockImplementation(async (path: Parameters<typeof readFile>[0]) => {
        const pathStr = String(path);
        if (pathStr.includes('design')) return designContent;
        if (pathStr.includes('plan')) return planContent;
        throw new Error(`File not found: ${pathStr}`);
      });

      const args = {
        featureId: 'feat-1',
        designPath: '/tmp/design.md',
        planPath: '/tmp/plan.md',
      };

      const result = await handlePlanCoverage(args, STATE_DIR);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        coverage: { covered: number; gaps: number; deferred: number; total: number };
        report: string;
      };
      expect(data.passed).toBe(true);
      expect(data.coverage.covered).toBe(2);
      expect(data.coverage.gaps).toBe(0);
      expect(data.coverage.total).toBe(2);
      expect(data.report).toContain('Plan Coverage Report');
    });
  });

  // ─── Gate Event Emission ─────────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handlePlanCoverage_EmitsGateExecutedEvent', async () => {
      const designContent = [
        '## Technical Design',
        '### Widget',
        'Widget desc.',
      ].join('\n');

      const planContent = [
        '### Task 001: Build Widget',
        'Widget implementation.',
      ].join('\n');

      vi.mocked(readFile).mockImplementation(async (path: Parameters<typeof readFile>[0]) => {
        const pathStr = String(path);
        if (pathStr.includes('design')) return designContent;
        return planContent;
      });

      const args = {
        featureId: 'feat-1',
        designPath: '/tmp/design.md',
        planPath: '/tmp/plan.md',
      };

      await handlePlanCoverage(args, STATE_DIR);

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
      expect(event.data.gateName).toBe('plan-coverage');
      expect(event.data.layer).toBe('planning');
      expect(event.data.passed).toBe(true);
      expect(event.data.details).toEqual({
        dimension: 'D1',
        phase: 'plan',
        covered: 1,
        gaps: 0,
        deferred: 0,
        totalSections: 1,
      });
    });
  });

  // ─── File Read Error ────────────────────────────────────────────────────

  describe('file read errors', () => {
    it('handlePlanCoverage_FileNotFound_ReturnsError', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('ENOENT: no such file'));

      const args = {
        featureId: 'feat-1',
        designPath: '/tmp/nonexistent.md',
        planPath: '/tmp/plan.md',
      };

      const result = await handlePlanCoverage(args, STATE_DIR);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_ERROR');
    });
  });

  // ─── Empty Design ────────────────────────────────────────────────────────

  describe('empty design', () => {
    it('handlePlanCoverage_NoDesignSections_ReturnsError', async () => {
      const designContent = '# Feature Design\n\n## Problem Statement\n\nSome problem.';
      const planContent = '### Task 001: Something\n\nSome task.';

      vi.mocked(readFile).mockImplementation(async (path: Parameters<typeof readFile>[0]) => {
        const pathStr = String(path);
        if (pathStr.includes('design')) return designContent;
        return planContent;
      });

      const args = {
        featureId: 'feat-1',
        designPath: '/tmp/design.md',
        planPath: '/tmp/plan.md',
      };

      const result = await handlePlanCoverage(args, STATE_DIR);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_DESIGN_SECTIONS');
    });
  });

  // ─── No Tasks ─────────────────────────────────────────────────────────────

  describe('no tasks in plan', () => {
    it('handlePlanCoverage_NoTasks_ReturnsFailResult', async () => {
      const designContent = [
        '## Technical Design',
        '### Widget Component',
        'Build widget.',
      ].join('\n');
      const planContent = '# Plan\n\n## Overview\n\nJust an overview.';

      vi.mocked(readFile).mockImplementation(async (path: Parameters<typeof readFile>[0]) => {
        const pathStr = String(path);
        if (pathStr.includes('design')) return designContent;
        return planContent;
      });

      const args = {
        featureId: 'feat-1',
        designPath: '/tmp/design.md',
        planPath: '/tmp/plan.md',
      };

      const result = await handlePlanCoverage(args, STATE_DIR);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_PLAN_TASKS');
    });
  });
});

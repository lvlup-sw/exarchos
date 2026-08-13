// ─── Design Completeness — DEPRECATED alias delegation tests (#1581 task 013) ─
//
// The design+plan collapse turned check_design_completeness into a deprecated
// alias that delegates to check_plan_coverage. These tests pin the delegation
// contract: the resolved artifact path is forwarded as BOTH designPath and
// planPath, plan-coverage's result is returned verbatim with a deprecation
// marker (so the folded acceptance-criteria finding still reaches callers), and
// the path resolves from workflow-state artifacts when not supplied explicitly.
// The pure design-completeness checks remain covered in
// `pure/design-completeness.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';

// Mock the delegate target and the state resolver.
vi.mock('./plan-coverage.js', () => ({
  handlePlanCoverage: vi.fn(),
}));
vi.mock('../resolve-state.js', () => ({
  resolveWorkflowState: vi.fn(),
}));

import { handlePlanCoverage } from './plan-coverage.js';
import { resolveWorkflowState } from '../resolve-state.js';
import {
  handleDesignCompleteness,
  DESIGN_COMPLETENESS_DEPRECATION_NOTICE,
} from './design-completeness.js';

const mockPlanCoverage = vi.mocked(handlePlanCoverage);
const mockResolveState = vi.mocked(resolveWorkflowState);

const STATE_DIR = '/tmp/test-design-completeness';
const mockStore = { append: vi.fn(), query: vi.fn() };

type ResolvedState = Awaited<ReturnType<typeof resolveWorkflowState>>;

describe('handleDesignCompleteness (deprecated alias → check_plan_coverage, #1581 task 013)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('input validation', () => {
    it('handleDesignCompleteness_MissingFeatureId_ReturnsError', async () => {
      const result = await handleDesignCompleteness(
        { featureId: '' },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
      expect(mockPlanCoverage).not.toHaveBeenCalled();
    });
  });

  describe('delegation', () => {
    it('CheckDesignCompleteness_DeprecatedAlias_DelegatesToPlanCoverage', async () => {
      mockPlanCoverage.mockResolvedValue({
        success: true,
        data: {
          passed: true,
          coverage: { covered: 2, gaps: 0, deferred: 0, total: 2 },
          report: '## Plan Coverage Report',
          gapSections: [],
          advisories: ['Advisory: DR entries missing acceptance criteria: DR-3'],
        },
      } as ToolResult);

      const result = await handleDesignCompleteness(
        { featureId: 'feat-1', designPath: '/tmp/specs/feat.md' },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      // Delegated to plan-coverage with the unified artifact path as BOTH
      // designPath and planPath; no state re-resolution when path is explicit.
      expect(mockPlanCoverage).toHaveBeenCalledTimes(1);
      const [args] = mockPlanCoverage.mock.calls[0];
      expect(args).toEqual({
        featureId: 'feat-1',
        designPath: '/tmp/specs/feat.md',
        planPath: '/tmp/specs/feat.md',
      });
      expect(mockResolveState).not.toHaveBeenCalled();

      // plan-coverage's result is returned verbatim + a deprecation marker, so
      // the folded acceptance-criteria finding still reaches the caller.
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        coverage: { covered: number };
        advisories: string[];
        deprecated: boolean;
        deprecationNotice: string;
      };
      expect(data.passed).toBe(true);
      expect(data.coverage.covered).toBe(2);
      expect(data.advisories).toContain(
        'Advisory: DR entries missing acceptance criteria: DR-3',
      );
      expect(data.deprecated).toBe(true);
      expect(data.deprecationNotice).toBe(DESIGN_COMPLETENESS_DEPRECATION_NOTICE);
    });

    it('handleDesignCompleteness_ResolvesArtifactFromState_WhenNoExplicitPath', async () => {
      mockResolveState.mockResolvedValue({
        state: { artifacts: { plan: '/tmp/specs/from-state.md' } },
      } as unknown as ResolvedState);
      mockPlanCoverage.mockResolvedValue({
        success: true,
        data: {
          passed: true,
          coverage: { covered: 1, gaps: 0, deferred: 0, total: 1 },
          report: 'r',
          gapSections: [],
        },
      } as ToolResult);

      const result = await handleDesignCompleteness(
        { featureId: 'feat-1' },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      expect(result.success).toBe(true);
      const [args] = mockPlanCoverage.mock.calls[0];
      expect(args.designPath).toBe('/tmp/specs/from-state.md');
      expect(args.planPath).toBe('/tmp/specs/from-state.md');
    });

    it('handleDesignCompleteness_DelegationFailure_ReturnedVerbatim', async () => {
      mockPlanCoverage.mockResolvedValue({
        success: false,
        error: { code: 'NO_PLAN_TASKS', message: 'no tasks' },
      } as ToolResult);

      const result = await handleDesignCompleteness(
        { featureId: 'feat-1', designPath: '/tmp/specs/feat.md' },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      // A delegate failure passes through unchanged (no spurious deprecated
      // marker bolted onto an error envelope).
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_PLAN_TASKS');
    });
  });

  describe('artifact resolution failure', () => {
    it('handleDesignCompleteness_UnresolvableArtifact_ReturnsDeprecationError', async () => {
      mockResolveState.mockResolvedValue({
        state: { artifacts: {} },
      } as unknown as ResolvedState);

      const result = await handleDesignCompleteness(
        { featureId: 'feat-1' },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('deprecated');
      expect(mockPlanCoverage).not.toHaveBeenCalled();
    });
  });
});

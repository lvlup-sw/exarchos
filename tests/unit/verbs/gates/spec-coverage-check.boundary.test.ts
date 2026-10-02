/**
 * Dispatch-boundary tests for `spec_coverage_check`. `dispatch()` forwards only `parsed.data`, and Zod v4 strips unknown keys.
 * So a parameter reaches the handler only when the registry schema declares it.
 * `spec-coverage-check.test.ts` calls the handler directly and cannot see this boundary.
 * This file is separate because that suite mocks `node:fs` and `node:child_process`, and the registry must load unmocked.
 */

import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { TOOL_REGISTRY, buildRegistrationSchema } from '../../../../src/registry.js';

/** The registry schema dispatch actually parses `spec_coverage_check` args with. */
function specCoverageSchema(): z.ZodType {
  const tool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
  if (!tool) throw new Error('exarchos_orchestrate missing from TOOL_REGISTRY');
  const action = tool.actions.find((a) => a.name === 'spec_coverage_check');
  if (!action) throw new Error('spec_coverage_check missing from the orchestrate registry');
  return action.schema as z.ZodType;
}

describe('spec_coverage_check — the dispatch boundary (WFQ-010)', () => {
  /** The strip is silent, so the parse succeeds either way. Only the surviving key shows that the schema declares it. */
  it('registrySchema_PlanPhaseArg_SurvivesTheParse', () => {
    const parsed = specCoverageSchema().safeParse({
      featureId: 'feature-under-test',
      planFile: 'docs/specs/plan.md',
      repoRoot: '.',
      coveragePhase: 'plan',
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as { coveragePhase?: string }).coveragePhase).toBe('plan');
  });

  it('registrySchema_PostImplementationPhaseArg_SurvivesTheParse', () => {
    const parsed = specCoverageSchema().safeParse({
      featureId: 'feature-under-test',
      planFile: 'docs/specs/plan.md',
      repoRoot: '.',
      coveragePhase: 'post-implementation',
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as { coveragePhase?: string }).coveragePhase).toBe('post-implementation');
  });

  /** Negative control. A free-form string field passes the two tests above, but the schema must constrain the value. */
  it('registrySchema_UnknownPhaseValue_IsRejected', () => {
    const parsed = specCoverageSchema().safeParse({
      featureId: 'feature-under-test',
      planFile: 'docs/specs/plan.md',
      repoRoot: '.',
      coveragePhase: 'during-implementation',
    });
    expect(parsed.success).toBe(false);
  });

  /**
   * `buildRegistrationSchema` flattens the field names of the actions in a tool. One name with two base types throws at server start, before `initialize`.
   * A field named `phase` collides with the free-form `phase` of `check_test_adequacy`, so this field is `coveragePhase`.
   * The check runs per tool, because the MCP adapter builds one registration schema for each tool.
   * The non-empty check keeps the loop from passing on an empty registry.
   */
  it('registrySchema_BuildsWithoutAFieldCollision', () => {
    expect(TOOL_REGISTRY.length).toBeGreaterThan(0);
    for (const tool of TOOL_REGISTRY) {
      expect(
        () => buildRegistrationSchema([...tool.actions]),
        `tool ${tool.name} has a field-name collision across its actions`,
      ).not.toThrow();
    }
  });

  /** The gate records its evidence on the stream that `featureId` names. So the parse, not the handler, must refuse a call without it. */
  it('registrySchema_FeatureIdOmitted_IsRejected', () => {
    const parsed = specCoverageSchema().safeParse({
      planFile: 'docs/specs/plan.md',
      repoRoot: '.',
    });
    expect(parsed.success).toBe(false);
  });

  /** `coveragePhase` is optional, so a caller reaches the handler default, `post-implementation`, by omission. */
  it('registrySchema_PhaseOmitted_StillParses', () => {
    const parsed = specCoverageSchema().safeParse({
      featureId: 'feature-under-test',
      planFile: 'docs/specs/plan.md',
      repoRoot: '.',
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as { coveragePhase?: string }).coveragePhase).toBeUndefined();
  });
});

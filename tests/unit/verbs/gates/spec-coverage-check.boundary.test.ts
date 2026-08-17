// ─── Spec Coverage Check — dispatch-boundary tests (WFQ-010) ─────────────────
//
// `spec-coverage-check.test.ts` calls `handleSpecCoverageCheck` DIRECTLY, which
// is why WFQ-010's `phase` parameter could be missing from the registry schema
// without a single one of those tests going red. `dispatch()` forwards only
// `parsed.data` and Zod v4 strips unknown keys, so an undeclared `phase` never
// reached the handler: the whole `runPlanSyntaxCheck` branch was unreachable in
// production while its unit suite passed. A parameter is only delivered if it
// survives the boundary, so that is what these assertions measure.
//
// Deliberately a separate file: the handler suite mocks `node:fs` and
// `node:child_process` wholesale, and the registry must be imported unmocked.
// ─────────────────────────────────────────────────────────────────────────────

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
  it('registrySchema_PlanPhaseArg_SurvivesTheParse', () => {
    const parsed = specCoverageSchema().safeParse({
      planFile: 'docs/specs/plan.md',
      repoRoot: '.',
      coveragePhase: 'plan',
    });
    expect(parsed.success).toBe(true);
    // The strip is SILENT — the parse succeeds either way, so `success` proves
    // nothing here. Only the surviving key distinguishes declared from dropped.
    expect((parsed.data as { coveragePhase?: string }).coveragePhase).toBe('plan');
  });

  it('registrySchema_PostImplementationPhaseArg_SurvivesTheParse', () => {
    const parsed = specCoverageSchema().safeParse({
      planFile: 'docs/specs/plan.md',
      repoRoot: '.',
      coveragePhase: 'post-implementation',
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as { coveragePhase?: string }).coveragePhase).toBe('post-implementation');
  });

  it('registrySchema_UnknownPhaseValue_IsRejected', () => {
    // Negative control. Without this, a `phase: z.string().optional()` would pass
    // the two assertions above while leaving the value unconstrained — INV-5a
    // requires the constraint at the schema level, not a prose hint the handler
    // re-checks later.
    const parsed = specCoverageSchema().safeParse({
      planFile: 'docs/specs/plan.md',
      repoRoot: '.',
      coveragePhase: 'during-implementation',
    });
    expect(parsed.success).toBe(false);
  });

  it('registrySchema_BuildsWithoutAFieldCollision', () => {
    // The field is `coveragePhase`, not `phase`, and this is why.
    // `buildRegistrationSchema` flattens field names across EVERY action, so two
    // actions declaring the same name with different base types is a hard error at
    // server construction — not a warning. Naming this one `phase` collided with
    // `check_test_adequacy`'s free-form `phase: z.string()` legacy carrier and took
    // the whole MCP server down: it threw before `initialize`, so every process
    // test failed with "server process exited before initialize completed" rather
    // than anything naming the real cause.
    //
    // Widening this field to `z.string()` to match would have removed the collision
    // by removing the constraint, which INV-5a forbids. Hence the rename, and hence
    // this assertion — the collision is invisible to a unit test that only calls the
    // handler.
    // PER TOOL, because that is the registration set the server composes
    // (`adapters/mcp.ts`: `buildRegistrationSchema(tool.actions)`). Flattening
    // every tool's actions into one call would invent collisions that cannot
    // occur — `check_post_merge.prUrl` and `cleanup.prUrl` live in different
    // tools and legitimately differ — and a test that fails for an impossible
    // reason teaches people to ignore it.
    expect(TOOL_REGISTRY.length).toBeGreaterThan(0); // non-empty denominator
    for (const tool of TOOL_REGISTRY) {
      expect(
        () => buildRegistrationSchema([...tool.actions]),
        `tool ${tool.name} has a field-name collision across its actions`,
      ).not.toThrow();
    }
  });

  it('registrySchema_PhaseOmitted_StillParses', () => {
    // `phase` stays optional: the handler's documented back-compat default
    // (post-implementation) must remain reachable by omission.
    const parsed = specCoverageSchema().safeParse({
      planFile: 'docs/specs/plan.md',
      repoRoot: '.',
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as { coveragePhase?: string }).coveragePhase).toBeUndefined();
  });
});

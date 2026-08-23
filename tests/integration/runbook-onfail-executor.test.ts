import { describe, it, expect, vi } from 'vitest';
import { handleRunbook } from '../../src/runbooks/handler.js';
import { findActionInRegistry } from '../../src/registry.js';
import type { RunbookDefinition } from '../../src/runbooks/types.js';

// A step carrying a policy no reader can honor. It cannot be written in
// `definitions.ts` — the union rejects it there — so it is injected past the
// compiler to reach the runtime guard, which is the only form of the rule a
// test can observe: `tests/integration/**` is excluded from the tests tsconfig,
// so a type-level assertion here would be checked by nothing.
const { RETRY_PROBE } = vi.hoisted(() => ({
  RETRY_PROBE: {
    id: 'retry-policy-probe',
    phase: 'delegate',
    description: 'Injected: declares a failure policy that does not exist.',
    steps: [{ tool: 'exarchos_orchestrate', action: 'task_complete', onFail: 'retry' }],
    templateVars: [],
    autoEmits: [],
  } as unknown as RunbookDefinition,
}));

vi.mock('../../src/runbooks/definitions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runbooks/definitions.js')>();
  return { ...actual, ALL_RUNBOOKS: [...actual.ALL_RUNBOOKS, RETRY_PROBE] };
});

interface ProjectedRunbook {
  readonly onFailContract?: unknown;
  readonly steps: ReadonlyArray<{
    readonly seq: number;
    readonly tool: string;
    readonly action: string;
    readonly onFail: string;
  }>;
}

// The runbook surface projects a plan and never dispatches a step. These tests
// pin that reading — and the two things that keep the projection honest about
// it — so that wiring an executor here later has to confront them.
describe('runbook onFail is projected, not executed', () => {
  it('Runbook_DetailProjection_StatesTheAdvisoryOnFailContract', async () => {
    const result = await handleRunbook({ id: 'quality-evaluation' });
    expect(result.success).toBe(true);

    const contract = (result.data as ProjectedRunbook).onFailContract;
    expect(typeof contract, 'detail mode projects onFail but states no contract for it').toBe(
      'string',
    );
    expect(contract as string).toMatch(/advisory/i);
    expect(contract as string).toMatch(/never dispatches/i);
  });

  it('Runbook_ListProjection_MakesNoOnFailClaim', async () => {
    // List mode carries no steps, so it has no onFail to qualify. The contract
    // belongs where the values are, not on every summary.
    const result = await handleRunbook({});
    expect(result.success).toBe(true);
    for (const summary of result.data as ReadonlyArray<Record<string, unknown>>) {
      expect(summary).not.toHaveProperty('onFailContract');
      expect(summary).not.toHaveProperty('steps');
    }
  });

  it('Runbook_EveryDeclaredOnFail_IsStopOrContinue', async () => {
    // Read the real registry, not this file's probe-augmented mock.
    const { ALL_RUNBOOKS } = await vi.importActual<
      typeof import('../../src/runbooks/definitions.js')
    >('../../src/runbooks/definitions.js');

    const declared = ALL_RUNBOOKS.flatMap((runbook) =>
      runbook.steps.map((step) => `${runbook.id}/${step.action}: ${String(step.onFail)}`),
    );
    // Assert the denominator: a policy census over an empty tree passes by
    // measuring nothing.
    expect(declared.length, 'no runbook step declares onFail — the census is vacuous').toBeGreaterThan(
      50,
    );

    const values = new Set(ALL_RUNBOOKS.flatMap((r) => r.steps.map((s) => String(s.onFail))));
    expect([...values].sort()).toEqual(['continue', 'stop']);
  });

  it('Runbook_RetryPolicy_IsRejectedAtProjection', async () => {
    const result = await handleRunbook({ id: RETRY_PROBE.id });

    expect(result.success, "'retry' was projected instead of rejected").toBe(false);
    expect(result.error?.code).toBe('INVALID_FAILURE_POLICY');
    expect(result.error?.message).toContain('retry');
  });

  it('Chain_StopStep_DoesNotTruncateTheProjection', async () => {
    // Characterization. `quality-evaluation` opens with a blocking gate step
    // declaring 'stop'; every later step still comes back, because there is no
    // failure for the projector to observe. This is the measured shape of the
    // chain ordering, and it is what an executor would have to change.
    const result = await handleRunbook({ id: 'quality-evaluation' });
    expect(result.success).toBe(true);

    const { steps } = result.data as ProjectedRunbook;
    expect(steps[0]?.onFail).toBe('stop');
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.map((s) => s.seq)).toEqual(steps.map((_, i) => i + 1));
    expect(steps.some((s) => s.onFail === 'continue')).toBe(true);
  });

  it('Runbook_ResolvedStepAction_ExposesNoCallable', async () => {
    // Why an executor cannot be added at this seam without a new execution
    // surface: what the handler resolves a step against is a declaration —
    // schema, description, gate metadata — with no function to invoke.
    const result = await handleRunbook({ id: 'quality-evaluation' });
    expect(result.success).toBe(true);

    const { steps } = result.data as ProjectedRunbook;
    const resolvable = steps.filter((s) => !s.tool.startsWith('native:') && s.tool !== 'none');
    expect(resolvable.length, 'no resolvable step to inspect').toBeGreaterThan(0);

    for (const step of resolvable) {
      const action = findActionInRegistry(step.tool, step.action);
      expect(action, `${step.tool}.${step.action} is unregistered`).toBeDefined();
      const callables = Object.entries(action as object)
        .filter(([, value]) => typeof value === 'function')
        .map(([key]) => key);
      expect(callables, `${step.action} gained a callable — an executor is now possible`).toEqual([]);
    }
  });
});

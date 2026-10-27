/**
 * Tests the `repoRoot` wire field of `exarchos_orchestrate`.
 *
 * The flattened schema of the tool takes the first declaration of a field, with its refinements and its description.
 * The MCP SDK validates each call against that schema. A gate call passes `repoRoot: 'auto'`, so the first declaration
 * carries no pattern and no description. The declaration of `prepare_delegation` comes first.
 * A copy of the action list with the absolute pattern on that declaration refuses the gate call, so the case has teeth.
 *
 * @oracle-sources: ../../../src/registry/actions/orchestrate/index.ts, the literal gate call of the runbook steps, and the literal wire field of the tools-list golden
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orchestrateActions } from '../../../src/registry/actions/orchestrate/index.js';
import { buildRegistrationSchema } from '../../../src/registry/schema-builders.js';
import { ABSOLUTE_REPO_ROOT } from '../../../src/verbs/prepare/prepare-scope.js';

/** A gate call in the form of the runbook steps and of the recoveries of `task_complete`. */
const GATE_CALL = { action: 'check_static_analysis', featureId: 'feat-wire', taskId: 'T-1', repoRoot: 'auto' };

describe('the repoRoot wire field of exarchos_orchestrate', () => {
  /**
   * The case finds the first declaration, parses the gate call against the whole list, and reads the JSON Schema of the field.
   * Then it puts the absolute pattern on the first declaration of a copy of the list, and the same call is refused.
   */
  it('OrchestrateWire_AGateCallWithRepoRootAuto_ParsesAgainstTheFlattenedSchema', () => {
    const firstDeclaration = orchestrateActions.find((action) => 'repoRoot' in action.schema.shape);
    expect(firstDeclaration?.name).toBe('prepare_delegation');

    const flattened = buildRegistrationSchema(orchestrateActions);
    expect(flattened.safeParse(GATE_CALL).success).toBe(true);

    const wireField = z.toJSONSchema(flattened).properties?.repoRoot;
    expect(wireField).not.toHaveProperty('pattern');
    expect(wireField).not.toHaveProperty('description');
    expect(wireField).toEqual({ type: 'string', minLength: 1 });

    const patterned = orchestrateActions.map((action) =>
      action === firstDeclaration
        ? { ...action, schema: action.schema.extend({ repoRoot: z.string().min(1).regex(ABSOLUTE_REPO_ROOT).optional() }) }
        : action,
    );
    const refused = buildRegistrationSchema(patterned).safeParse(GATE_CALL);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path.join('.'))).toContain('repoRoot');
  });
});

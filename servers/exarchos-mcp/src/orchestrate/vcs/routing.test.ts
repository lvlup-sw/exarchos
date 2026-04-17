// ─── VCS Action Routing Tests ───────────────────────────────────────────────
//
// Verifies VCS actions are registered in the TOOL_REGISTRY and that the
// ACTION_HANDLER_KEYS in composite.ts include them.
//
// Because composite.ts has deep transitive imports that hit the pre-existing
// zod v4 / DoctorOutputSchema.innerType breakage, we verify handler
// registration by reading the source file instead of importing it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY } from '../../registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VCS_ACTIONS = [
  'create_pr',
  'merge_pr',
  'check_ci',
  'list_prs',
  'get_pr_comments',
  'add_pr_comment',
  'create_issue',
] as const;

describe('VCS action routing registration', () => {
  it('VcsActions_AllRegisteredInCompositeHandlerSource', () => {
    // Read composite.ts source and verify each VCS action key appears in ACTION_HANDLERS
    const compositeSource = readFileSync(
      resolve(__dirname, '..', 'composite.ts'),
      'utf-8',
    );

    for (const action of VCS_ACTIONS) {
      expect(
        compositeSource.includes(`${action}:`),
        `VCS action '${action}' not found as a key in composite.ts ACTION_HANDLERS`,
      ).toBe(true);
    }
  });

  it('VcsActions_AllRegisteredInToolRegistry', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate).toBeDefined();
    const registryActionNames = orchestrate!.actions.map((a) => a.name);

    for (const action of VCS_ACTIONS) {
      expect(
        registryActionNames.includes(action),
        `VCS action '${action}' missing from registry.ts orchestrateActions`,
      ).toBe(true);
    }
  });

  it('VcsActions_SchemasAreValid', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate).toBeDefined();

    for (const action of VCS_ACTIONS) {
      const actionDef = orchestrate!.actions.find((a) => a.name === action);
      expect(actionDef, `VCS action '${action}' not found in registry`).toBeDefined();
      expect(actionDef!.schema).toBeDefined();
      expect(actionDef!.description.length).toBeGreaterThan(0);
    }
  });

  it('VcsActions_MutatingActionsHaveAutoEmits', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate).toBeDefined();

    const mutatingActions = ['create_pr', 'merge_pr', 'add_pr_comment', 'create_issue'];
    for (const action of mutatingActions) {
      const actionDef = orchestrate!.actions.find((a) => a.name === action);
      expect(actionDef, `VCS action '${action}' not found in registry`).toBeDefined();
      expect(
        actionDef!.autoEmits && actionDef!.autoEmits.length > 0,
        `Mutating VCS action '${action}' should have autoEmits`,
      ).toBe(true);
    }
  });

  it('VcsActions_ReadOnlyActionsNoAutoEmits', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate).toBeDefined();

    const readOnlyActions = ['check_ci', 'list_prs', 'get_pr_comments'];
    for (const action of readOnlyActions) {
      const actionDef = orchestrate!.actions.find((a) => a.name === action);
      expect(actionDef, `VCS action '${action}' not found in registry`).toBeDefined();
      expect(
        !actionDef!.autoEmits || actionDef!.autoEmits.length === 0,
        `Read-only VCS action '${action}' should NOT have autoEmits`,
      ).toBe(true);
    }
  });

  it('VcsActions_CreatePrSchema_ValidatesInput', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    const createPr = orchestrate!.actions.find((a) => a.name === 'create_pr');
    expect(createPr).toBeDefined();

    // Valid input
    const validResult = createPr!.schema.safeParse({
      title: 'feat: test',
      body: 'body',
      base: 'main',
      head: 'feature/test',
    });
    expect(validResult.success).toBe(true);

    // Invalid input (missing required field)
    const invalidResult = createPr!.schema.safeParse({
      title: 'feat: test',
      // missing body, base, head
    });
    expect(invalidResult.success).toBe(false);
  });

  it('VcsActions_MergePrSchema_ValidatesStrategy', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    const mergePr = orchestrate!.actions.find((a) => a.name === 'merge_pr');
    expect(mergePr).toBeDefined();

    // Valid strategies
    for (const strategy of ['squash', 'rebase', 'merge']) {
      const result = mergePr!.schema.safeParse({ prId: '42', strategy });
      expect(result.success, `Strategy '${strategy}' should be valid`).toBe(true);
    }

    // Invalid strategy
    const invalidResult = mergePr!.schema.safeParse({ prId: '42', strategy: 'fast-forward' });
    expect(invalidResult.success).toBe(false);
  });

  it('VcsActions_CompositeImportsAllHandlers', () => {
    const compositeSource = readFileSync(
      resolve(__dirname, '..', 'composite.ts'),
      'utf-8',
    );

    const expectedImports = [
      'handleCreatePr',
      'handleMergePr',
      'handleCheckCi',
      'handleListPrs',
      'handleGetPrComments',
      'handleAddPrComment',
      'handleCreateIssue',
    ];

    for (const importName of expectedImports) {
      expect(
        compositeSource.includes(importName),
        `Expected import '${importName}' not found in composite.ts`,
      ).toBe(true);
    }
  });
});

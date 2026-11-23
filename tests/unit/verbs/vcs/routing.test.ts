// Tests that the VCS actions are in `TOOL_REGISTRY` and that `composite.ts`
// has a handler key for each one. The key check reads the `composite.ts`
// source as text and does not import it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_ACTIONS, TOOL_REGISTRY, contractEmissionsOf } from '../../../../src/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VCS_ACTIONS = [
  'check_ci',
  'list_prs',
  'get_pr_comments',
] as const;

/** The provider writers that the retired-action table refuses. */
const RETIRED_WRITERS: readonly string[] = ['create_pr', 'merge_pr', 'add_pr_comment', 'create_issue'];

describe('VCS action routing registration', () => {
  it('VcsActions_AllRegisteredInCompositeHandlerSource', () => {
    const compositeSource = readFileSync(
      resolve(__dirname, '../../../../src/verbs/composite.ts'),
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

  /** A retired writer has no registry entry and no handler key, and the retired-action table refuses it with the one closed code. */
  it('VcsActions_RetiredWriters_AreAbsentAndRefused', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate).toBeDefined();
    const compositeSource = readFileSync(
      resolve(__dirname, '../../../../src/verbs/composite.ts'),
      'utf-8',
    );

    for (const action of RETIRED_WRITERS) {
      expect(orchestrate!.actions.some((a) => a.name === action), action).toBe(false);
      expect(compositeSource.includes(`  ${action}:`), action).toBe(false);
      const row = RETIRED_ACTIONS.find((entry) => entry.tool === 'exarchos_orchestrate' && entry.action === action);
      expect(row?.code, action).toBe('PROVIDER_WRITE_RETIRED');
      expect(row?.message, action).toContain('The harness');
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
        contractEmissionsOf(actionDef!).length === 0,
        `Read-only VCS action '${action}' should not declare catalog emissions`,
      ).toBe(true);
    }
  });

  it('VcsActions_CompositeImportsAllHandlers', () => {
    const compositeSource = readFileSync(
      resolve(__dirname, '../../../../src/verbs/composite.ts'),
      'utf-8',
    );

    const expectedImports = [
      'handleCheckCi',
      'handleListPrs',
      'handleGetPrComments',
    ];

    for (const importName of expectedImports) {
      expect(
        compositeSource.includes(importName),
        `Expected import '${importName}' not found in composite.ts`,
      ).toBe(true);
    }
  });
});

/**
 * Prove that the retired VCS actions have no `TOOL_REGISTRY` entry and no handler key in `composite.ts`.
 * The retired-action table refuses each of them with its one closed code.
 * The key check reads the `composite.ts` source as text and does not import it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_ACTIONS, TOOL_REGISTRY } from '../../../../src/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The provider writers that the retired-action table refuses. */
const RETIRED_WRITERS: readonly string[] = ['create_pr', 'merge_pr', 'add_pr_comment', 'create_issue'];

/** The provider reads that the retired-action table refuses. */
const RETIRED_READS: readonly string[] = ['check_ci', 'list_prs', 'get_pr_comments'];

/** Assert that each action has no registry entry and no handler key, and that its row carries `code` and names the harness. */
function expectRetired(actions: readonly string[], code: string): void {
  const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
  expect(orchestrate).toBeDefined();
  const compositeSource = readFileSync(
    resolve(__dirname, '../../../../src/verbs/composite.ts'),
    'utf-8',
  );

  for (const action of actions) {
    expect(orchestrate?.actions.some((a) => a.name === action), action).toBe(false);
    expect(compositeSource.includes(`  ${action}:`), action).toBe(false);
    const row = RETIRED_ACTIONS.find((entry) => entry.tool === 'exarchos_orchestrate' && entry.action === action);
    expect(row?.code, action).toBe(code);
    expect(row?.message, action).toContain('The harness');
  }
}

describe('VCS action routing registration', () => {
  /** A retired writer has no registry entry and no handler key, and the retired-action table refuses it with the one closed code. */
  it('VcsActions_RetiredWriters_AreAbsentAndRefused', () => {
    expectRetired(RETIRED_WRITERS, 'PROVIDER_WRITE_RETIRED');
  });

  /** A retired read has no registry entry and no handler key, and the retired-action table refuses it with the one closed code. */
  it('VcsActions_RetiredReads_AreAbsentAndRefused', () => {
    expectRetired(RETIRED_READS, 'PROVIDER_READ_RETIRED');
  });

  /** `composite.ts` imports no handler of a retired read. */
  it('VcsActions_CompositeImportsNoRetiredReadHandler', () => {
    const compositeSource = readFileSync(
      resolve(__dirname, '../../../../src/verbs/composite.ts'),
      'utf-8',
    );

    for (const importName of ['handleCheckCi', 'handleListPrs', 'handleGetPrComments']) {
      expect(compositeSource.includes(importName), importName).toBe(false);
    }
  });
});

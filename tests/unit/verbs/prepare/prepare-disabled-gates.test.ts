/**
 * The prepare handler drops each gate that the checkout config disables from the pattern text of the capsule.
 *
 * The case drives the handler against a real event store and a real bundle store in a temp directory.
 * A seam answers the three git reads, and the checkout is a temp directory with a real config file.
 * The handler computes the disabled gates from the config of the checkout, so the compiler test alone cannot see this wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { ExarchosCapsuleV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { handlePrepare } from '../../../../src/verbs/prepare/handler.js';
import type { ScopeGit } from '../../../../src/verbs/prepare/prepare-scope.js';
import { canonicalPath } from '../../../../src/utils/git-tree.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STREAM = 'feat-prepare-disabled-gates';
const INTEGRATION_BRANCH = 'feature/prepare-disabled-gates';
const COMPILED_AT = '2026-10-25T00:00:00.000Z';
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos'];
/** The commit that the seam resolves for the base. */
const BASE_COMMIT = '5'.repeat(40);

/** A checkout config that disables the kill probe, one gate of the segment of a medium task. */
const DISABLING_CONFIG = 'review:\n  gates:\n    check_test_adequacy:\n      enabled: false\n';

let stateDir: string;
let store: EventStore;
let checkout: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-disabled-gates-'));
  store = new EventStore(stateDir);
  await store.initialize();
  checkout = canonicalPath(await mkdtemp(path.join(tmpdir(), 'prepare-disabled-gates-checkout-')));
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  await rmrfAsync(checkout);
});

/** The git reads of a seam whose repository is the `.git` of the checkout. No tag has the name of the base. */
function seam(): ScopeGit {
  return {
    observe: async () => ({ kind: 'repository', toplevel: checkout, repository: `${checkout}/.git` }),
    commitOf: async (_checkout, ref) =>
      ref.startsWith('refs/tags/') ? { kind: 'absent' } : { kind: 'commit', commit: BASE_COMMIT },
    isAncestor: async () => ({ kind: 'ancestor' }),
  };
}

function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'prepare-disabled-gates' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

/** A feature workflow in `delegate` with one ready medium task off the boundary, and an integration branch. */
async function seed(): Promise<void> {
  await store.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await store.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await store.append(STREAM, {
    type: 'state.patched',
    data: {
      patch: {
        'synthesis.integrationBranch': INTEGRATION_BRANCH,
        tasks: [{ id: 'T-1', title: 'medium', status: 'pending', blockedBy: [], riskTier: 'medium', boundaryTouching: false }],
      },
    },
  });
}

/** The fields of a receipt that the case reads. The parse checks them, so the case does not trust the shape of the data. */
const ReceiptView = z.object({ capsuleVersion: z.number().int(), capsule: ExarchosCapsuleV1Schema });

/** One prepare of the stream from the checkout, and the capsule version and the pattern statements of its receipt. */
async function prepared(): Promise<{ readonly capsuleVersion: number; readonly patterns: readonly string[] }> {
  const result: ToolResult = await runWithDispatchContext(correlation(), () =>
    handlePrepare({ featureId: STREAM, repoRoot: checkout }, stateDir, wiring(), { now: () => COMPILED_AT, scopeGit: seam() }),
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  const receipt = ReceiptView.parse(result.success ? result.data : undefined);
  return {
    capsuleVersion: receipt.capsuleVersion,
    patterns: receipt.capsule.knowledge.patterns.map((pattern) => pattern.statement),
  };
}

describe('prepare drops the gates that the checkout config disables from the pattern text', () => {
  /**
   * The twin comes first: with no config, the pattern of the medium task names the kill probe.
   * Then the checkout config disables the kill probe. The config edit compiles the next capsule version, and its pattern does not name that gate.
   */
  it('Prepare_TheCheckoutConfigDisablesAGate_ThePatternTextNamesItNot', async () => {
    await seed();
    const twin = await prepared();
    expect(twin.capsuleVersion).toBe(1);
    expect(twin.patterns).toContain(
      'A task at riskTier=medium, boundaryTouching=false is verified at settlement by: check_static_analysis, check_test_adequacy.',
    );

    await writeFile(path.join(checkout, '.exarchos.yml'), DISABLING_CONFIG);
    const disabled = await prepared();
    expect(disabled.capsuleVersion).toBe(2);
    expect(disabled.patterns).toContain(
      'A task at riskTier=medium, boundaryTouching=false is verified at settlement by: check_static_analysis.',
    );
    expect(disabled.patterns.filter((statement) => statement.includes('check_test_adequacy'))).toEqual([]);
  });
});

/**
 * `settle` over the full shipped task-completion runbook, when the capsule pins an unresolved static-analysis check.
 *
 * The task is low tier, so the policy skips the probe, and the real static analysis and `task_complete` run.
 * The capsule pins a profile whose `lint` check is unresolved. The claimed worktree holds the `lint`, `typecheck` and `quality-check` scripts.
 * Only the pin can give the skip, so the case proves that the settle path hands the pinned profile to the real gate.
 * The stream must hold no completion, and the refusal must name the route that works under a pin.
 *
 * @oracle-sources: ../../../../src/verbs/settle/handler.ts, the rows a real event store holds after the batch, read back by type rather than off the receipt
 */

import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { CapsuleScope, ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule as corpusCapsule, baseValidDefinition } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { productionExecuteDeps } from '../../../../src/verbs/execute/executor.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { inScopeObserver, scopeOfCheckout, withScope } from '../../../helpers/scoped-capsule.js';
import { UNRESOLVED_LINT_REASON, unresolvedLintProfile } from '../../../helpers/verification-profile.js';

const STREAM = 'feat-settle-pinned-unresolved';

/** Bind the corpus fixture to the stream that records its custody. */
function baseValidCapsule() {
  const capsule = corpusCapsule();
  return { ...capsule, identity: { ...capsule.identity, workflowId: STREAM } };
}
const TASK = 'task-verify';
const CAPSULE_VERSION = 9;
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The cheapest npm script that exits 0. */
const OK = 'node -e ""';

let stateDir: string;
let store: EventStore;
let worktreePath: string;
/** The scope that the seeded capsule pins: a temp checkout with no config, so its digest matches. */
let scope: CapsuleScope;

/** The wiring of one call. The observer of a claimed worktree finds each claimed path in the pinned scope. */
function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false, treeObserver: inScopeObserver(scope) };
}

/** A caller with the capabilities of the composed leaves. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-pinned-unresolved' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

/** The base capsule, with its one required task stamped low-tier and the profile with the unresolved check. */
function pinnedCapsule(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    identity: { ...base.identity, capsuleVersion: CAPSULE_VERSION },
    settlementContract: {
      ...base.settlementContract,
      taskVerification: { [TASK]: { riskTier: 'low', boundaryTouching: false, baseRef: 'main' } },
      verificationProfile: unresolvedLintProfile(),
    },
  };
}

/** Records the capsule as prepared, through the production commit. */
async function seedPrepared(capsule: ExarchosCapsuleV1): Promise<void> {
  await runWithDispatchContext(correlation(), () =>
    commitPreparedCapsule(wiring(), {
      streamId: STREAM,
      operationId: `seed:${capsule.identity.capsuleVersion}`,
      requestDigest: `sha256:seed-${capsule.identity.capsuleVersion}`,
      workflowType: WorkflowDefinitionV1Schema.parse(baseValidDefinition()).name,
      capsule: withScope(capsule, scope),
      definition: WorkflowDefinitionV1Schema.parse(baseValidDefinition()),
    }),
  );
}

async function settle(raw: Record<string, unknown>): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handleSettle(raw, stateDir, wiring(), { execute: productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate') }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The data of each row of the given type. */
async function rowsOf(type: string): Promise<readonly Record<string, unknown>[]> {
  return (await store.query(STREAM)).filter((event) => event.type === type).map((event) => (isRecord(event.data) ? event.data : {}));
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'settle-pinned-unresolved-'));
  store = new EventStore(stateDir);
  await store.initialize();
  await seedActivePhaseAttempt(store, STREAM);
  scope = await scopeOfCheckout(path.join(stateDir, 'checkout'));
  worktreePath = await realpath(await mkdtemp(path.join(tmpdir(), 'settle-pinned-unresolved-worktree-')));
  const scripts = { lint: OK, typecheck: OK, 'quality-check': OK };
  await writeFile(path.join(worktreePath, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts }), 'utf-8');
  await seedPrepared(pinnedCapsule());
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  await rmrfAsync(worktreePath);
});

describe('settle — a pinned unresolved check', () => {
  /**
   * The worktree holds the script, and the pin says that the check is unresolved. The pin decides, so a change in the worktree changes nothing.
   * A skip does not halt the segment, so `task_complete` runs and refuses. The batch halts on that refusal, and no task is accepted.
   * The killing assertion: the old gate reads the worktree, its three scripts pass, and no refusal names the route of a pin.
   */
  it('Settle_APinnedUnresolvedCheck_NamesTheCheckoutANewPrepareAndANewBatch', async () => {
    const result = await settle({
      featureId: STREAM,
      capsuleVersion: CAPSULE_VERSION,
      batchId: 'batch-pinned-unresolved',
      claims: [{ taskId: TASK, fields: { passed: true, worktreePath }, evidence: [] }],
    });

    expect(result.success, JSON.stringify(result)).toBe(false);
    expect(result.error?.code).toBe('INTENT_SEGMENT_FAILED');
    expect(await rowsOf('task.completed')).toEqual([]);
    const [gate] = (await rowsOf('gate.executed')).filter((row) => row.gateName === 'static-analysis');
    expect(gate?.passed).toBe(false);
    expect(gate?.details).toMatchObject({
      skipped: true,
      discriminant: 'profile-unresolved',
      reason: expect.stringContaining(`pinned by capsule v${CAPSULE_VERSION}. ${UNRESOLVED_LINT_REASON}`),
    });
    const message = result.error?.message ?? '';
    expect(message).toContain("halted on 'task_complete'");
    expect(message).toContain(`A rerun under capsule v${CAPSULE_VERSION} gives the same skip.`);
    expect(message).toContain('at the checkout');
    expect(message).toContain('Then prepare again, and claim the task in a new batch.');
  });
});

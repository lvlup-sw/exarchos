/**
 * `settle` over the full shipped task-completion runbook, when the capsule pins no contract tool.
 *
 * The task is low tier and touches a boundary, so the policy runs contract drift and static analysis and skips the probe.
 * The capsule pins the shared Node profile, whose `contract.codegen` and `contract.diff` are unresolved. The real gates run, and the task settles.
 * The skip is advisory, so it does not halt the segment. The trace of the task must name it with the one discriminant of an unresolved term.
 *
 * @oracle-sources: ../../../../src/verbs/settle/handler.ts, the receipt of the batch, and the `gate.executed` rows that a real event store holds after it
 */

import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { CapsuleScope, ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule, baseValidDefinition } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
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
import { nodeTestProfile } from '../../../helpers/verification-profile.js';

const STREAM = 'feat-settle-unresolved-qualifier';
const TASK = 'task-verify';
const CAPSULE_VERSION = 11;
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
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-unresolved-qualifier' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

/** The base capsule, with one required low-tier task that touches a boundary, and the shared Node profile. */
function pinnedCapsule(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    identity: { ...base.identity, capsuleVersion: CAPSULE_VERSION },
    settlementContract: {
      ...base.settlementContract,
      taskVerification: { [TASK]: { riskTier: 'low', boundaryTouching: true, baseRef: 'main' } },
      verificationProfile: nodeTestProfile(),
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
      workflowType: 'feature',
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
  stateDir = await mkdtemp(path.join(tmpdir(), 'settle-unresolved-qualifier-'));
  store = new EventStore(stateDir);
  await store.initialize();
  await seedActivePhaseAttempt(store, STREAM);
  scope = await scopeOfCheckout(path.join(stateDir, 'checkout'));
  worktreePath = await realpath(await mkdtemp(path.join(tmpdir(), 'settle-unresolved-qualifier-worktree-')));
  const scripts = { lint: OK, typecheck: OK };
  await writeFile(path.join(worktreePath, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts }), 'utf-8');
  await seedPrepared(pinnedCapsule());
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  await rmrfAsync(worktreePath);
});

describe('settle — a contract drift skip with no tool', () => {
  /**
   * The skip is advisory, so the task is accepted, and the trace marks the gate as skipped.
   * The killing assertion: the old carrier states `skipped: true` and no discriminant, so the qualifier of the trace names neither the discriminant nor a reason.
   */
  it('Settle_ANoContractToolSkip_GivesASkippedQualifierWithProfileUnresolved', async () => {
    const result = await settle({
      featureId: STREAM,
      capsuleVersion: CAPSULE_VERSION,
      batchId: 'batch-no-contract-tool',
      claims: [{ taskId: TASK, fields: { passed: true, worktreePath }, evidence: [] }],
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({
      outcome: 'settled',
      verification: [
        expect.objectContaining({
          taskId: TASK,
          outcome: 'verified',
          qualifiers: [
            {
              gate: 'contract-drift',
              mark: 'skipped',
              discriminant: 'profile-unresolved',
              reason: expect.stringMatching(new RegExp(`^pinned by capsule v${CAPSULE_VERSION}\\. contract\\.codegen: .* contract\\.diff: `)),
            },
          ],
        }),
      ],
    });
    const [gate] = (await rowsOf('gate.executed')).filter((row) => row.gateName === 'contract-drift');
    expect(gate?.details).toMatchObject({ skipped: true, discriminant: 'profile-unresolved' });
    expect(await rowsOf('task.completed')).toHaveLength(1);
  });
});

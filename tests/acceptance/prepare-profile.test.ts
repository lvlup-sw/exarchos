/**
 * `prepare` pins the verification profile of the checkout, through the real dispatcher and real git.
 *
 * The call goes through `dispatch` with a real caller identity and capability resolver, and with telemetry at its shipped default.
 * The workflow is seeded as rows of the event store only, so the case writes no state document.
 * The repository comes from the scoped repository helper. The case spawns git, so it sets its own timeout.
 *
 * @oracle-sources: ../../src/verbs/prepare/handler.ts, the package manifests that the case writes and the commits that real git reports
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { ExarchosCapsuleV1Schema } from '../../src/contract/capsule/exarchos-capsule.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type ScopedRepository } from '../helpers/scoped-repository.js';

const STREAM = 'feat-prepare-profile-acceptance';
const INTEGRATION_BRANCH = 'feature/prepare-profile';
/** The budget of one case. The case spawns about ten git processes. */
const CASE_TIMEOUT_MS = 60_000 * WIN32_SPAWN_HEADROOM;

/** The text of a package manifest with the given scripts. */
function manifest(scripts: Readonly<Record<string, string>>): string {
  return `${JSON.stringify({ name: 'prepare-profile-fixture', private: true, scripts })}\n`;
}

/** The scripts of the integration branch. They hold no `lint` script. */
const SCRIPTS: Readonly<Record<string, string>> = { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' };

let stateDir: string;
let eventStore: EventStore;
let repository: ScopedRepository;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-profile-acceptance-'));
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  repository = await scopedRepository({
    integrationBranch: INTEGRATION_BRANCH,
    files: { 'package.json': manifest(SCRIPTS), 'src/index.js': 'export const value = 1;\n' },
  });
});

afterEach(async () => {
  eventStore.close();
  await rmrfAsync(stateDir);
  await rmrfAsync(repository.root);
});

/** The dispatch context of an agent, with telemetry at its shipped default. */
function callerContext(): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: true,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'prepare-profile-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

/** The fields of a receipt that the case reads. The parse checks them, so the case does not trust the shape of the data. */
const ReceiptView = z.object({
  success: z.literal(true),
  data: z.object({ capsuleVersion: z.number().int(), capsule: ExarchosCapsuleV1Schema }),
});

type Receipt = z.infer<typeof ReceiptView>['data'];

/** One prepare of the stream through the real dispatcher, from the checkout of the repository. */
async function prepare(): Promise<Receipt> {
  const result = await dispatch(
    'exarchos_orchestrate',
    { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout },
    callerContext(),
  );
  return ReceiptView.parse(result).data;
}

/** A feature workflow in `delegate` with one low-risk ready task and an integration branch, as rows of the event store only. */
async function seed(): Promise<void> {
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: {
      patch: {
        'synthesis.integrationBranch': INTEGRATION_BRANCH,
        tasks: [{ id: 'task-a', title: 'task-a', status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false }],
      },
    },
  });
}

/** The command of the `lint` check that a capsule pins. */
function lintCheckOf(receipt: Receipt): unknown {
  const staticAnalysis = receipt.capsule.settlementContract.verificationProfile?.staticAnalysis;
  if (staticAnalysis?.state !== 'resolved') throw new Error('the capsule pins no static-analysis checks');
  return staticAnalysis.checks.find((check) => check.name === 'lint')?.command;
}

describe('prepare pins the profile of the checkout', () => {
  /**
   * A new `lint` script at the checkout changes the profile, and no other input of the compilation.
   * The edit is not committed, so the base commit stays, and it is not a config edit, so the config digest stays.
   * So the next capsule version comes only from the profile, and it pins the new check.
   * A third call with the checkout unchanged replays that version.
   */
  it('Prepare_AnEditedPackageScript_CompilesTheNextVersion', async () => {
    await seed();
    const first = await prepare();
    expect(first.capsuleVersion).toBe(1);
    expect(lintCheckOf(first)).toStrictEqual({ state: 'unresolved', reason: expect.stringContaining("no 'lint' script") });

    await writeFile(path.join(repository.checkout, 'package.json'), manifest({ ...SCRIPTS, lint: 'eslint .' }));
    const next = await prepare();

    expect(next.capsuleVersion).toBe(2);
    expect(lintCheckOf(next)).toStrictEqual({ state: 'resolved', argv: ['npm', 'run', 'lint'], source: 'detection' });
    expect(next.capsule.settlementContract.scope).toStrictEqual(first.capsule.settlementContract.scope);
    expect(next.capsule.settlementContract.taskVerification).toStrictEqual(first.capsule.settlementContract.taskVerification);

    expect((await prepare()).capsuleVersion).toBe(2);
  }, CASE_TIMEOUT_MS);
});

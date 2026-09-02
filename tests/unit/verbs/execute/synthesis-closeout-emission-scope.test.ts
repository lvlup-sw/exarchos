// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the rows a real EventStore holds on both the subject stream and the shared vcs stream after each arm runs — read back from the store rather than off the receipt, so a receipt that claims events nobody wrote cannot satisfy either arm
//
// ─── The cross-stream observation mechanism, killed and revived ─────────────
//
// The composition-parity comparison for this intent lives in
// `synthesis-closeout-parity.test.ts`: `create_pr`'s two journal rows are a
// real denominator once the provider is stubbed at the factory, so the
// two-store comparison is not the vacuous one an earlier reading of this
// segment assumed.
//
// What this file adds is a kill probe on the one mechanism parity cannot
// separate, because both of its paths share it. `create_pr` journals its intent
// and its result onto the shared `vcs` stream; the emissions are observed there
// because the ACTION DECLARES that stream on its resource axis. Strip it
// and the observation falls back to the subject stream, where the handler wrote
// nothing — and the leaf must be refused for breaking a contract it kept.
//
// One variable between the arms: the declared stream resource. The failure
// policy is `continue` in BOTH, so the arm that fails is also showing that an
// emission-contract violation halts whatever the step's policy says.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { declared, findActionInRegistry, type ToolAction } from '../../../../src/registry.js';
import { ALL_RUNBOOKS, SYNTHESIS_CLOSEOUT } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition } from '../../../../src/runbooks/types.js';
import type { VcsProvider } from '../../../../src/vcs/provider.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import {
  handleExecuteIntent,
  type ExecuteIntentDeps,
} from '../../../../src/verbs/execute/executor.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { fixtureCorrelation, fixtureWiring, receiptOf } from './fixtures.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';

const INTENT = 'synthesis-closeout';
const STREAM = 'wf-synthesis-emission-scope';
const VCS_STREAM = 'vcs';
const TOOL = 'exarchos_orchestrate';

const ARGS = {
  title: 'feat: prove the mechanism is load-bearing',
  prBody: ['## Summary', '', 'x', '', '## Changes', '', '## Test Plan', ''].join('\n'),
  baseBranch: 'main',
  headBranch: 'feature/emission-scope',
};

let stateDir: string;
let store: EventStore;

function makeProvider(): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn().mockResolvedValue({ number: 7, url: 'https://example.invalid/pr/7' }),
    listPrs: vi.fn().mockResolvedValue([]),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
  } as unknown as VcsProvider;
}

/**
 * The runbook as shipped, except that the create step says `continue`.
 *
 * Held constant across both arms so the failure policy is not the variable. In
 * the stripped arm it is also the thing being overridden: an integrity failure
 * halts regardless of what the step asked for.
 */
function advisoryCreateStep(): readonly RunbookDefinition[] {
  const permissive: RunbookDefinition = {
    ...SYNTHESIS_CLOSEOUT,
    steps: SYNTHESIS_CLOSEOUT.steps.map((step) =>
      step.action === 'create_pr' ? { ...step, onFail: 'continue' as const } : step,
    ),
  };
  return ALL_RUNBOOKS.map((runbook) => (runbook.id === INTENT ? permissive : runbook));
}

/** The live `create_pr` declaration with its declared stream resource removed. */
function withoutDeclaredStream(): ToolAction {
  const real = findActionInRegistry(TOOL, 'create_pr');
  if (real?.actionContract === undefined) throw new Error('create_pr is not registered');
  const contract = real.actionContract;
  const resources = contract.touches.resources;
  if (resources.kind !== 'declared') throw new Error('create_pr declares no resources to strip');
  const kept = resources.values.filter((resource) => resource.kind !== 'stream');
  // The strip has to actually remove something, or the two arms are the same
  // arm and the probe proves nothing.
  expect(kept.length).toBeLessThan(resources.values.length);
  return {
    ...real,
    actionContract: {
      ...contract,
      touches: { ...contract.touches, resources: declared(...kept) },
    },
  };
}

function deps(input: {
  readonly findAction?: ExecuteIntentDeps['findAction'];
}): ExecuteIntentDeps {
  return {
    runbookTable: advisoryCreateStep(),
    findAction: input.findAction ?? findActionInRegistry,
    argSchemas: INTENT_ARG_SCHEMAS,
    handlers: ACTION_HANDLERS,
    handlerTool: TOOL,
  };
}

async function execute(operationId: string, executeDeps: ExecuteIntentDeps): Promise<ToolResult> {
  return runWithDispatchContext(fixtureCorrelation(), () =>
    handleExecuteIntent(
      { intent: INTENT, streamId: STREAM, args: ARGS, operationId },
      stateDir,
      fixtureWiring(stateDir, store),
      executeDeps,
    ),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(createVcsProvider).mockResolvedValue(makeProvider());
  stateDir = await mkdtemp(path.join(tmpdir(), 'synthesis-emission-scope-'));
  store = new EventStore(stateDir);
  await store.initialize();
  await seedActivePhaseAttempt(store, STREAM, { phase: 'synthesize' });
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

describe('the declared observation stream is load-bearing', () => {
  it('SynthesisCloseout_WithoutTheDeclaredStream_LeafIsRefusedForItsOwnEmissions', async () => {
    const stripped = withoutDeclaredStream();
    const result = await execute('op-emission-scope-killed', {
      ...deps({
        findAction: (tool, action) =>
          tool === TOOL && action === 'create_pr' ? stripped : findActionInRegistry(tool, action),
      }),
    });
    const receipt = receiptOf(result);

    // The handler did its work — the rows are on `vcs`, exactly where they
    // always were. What changed is where the executor looked for them.
    const vcsRows = await store.query(VCS_STREAM);
    expect(vcsRows.map((row) => row.type).sort()).toEqual([
      'pr.create.executed',
      'pr.create.requested',
    ]);

    expect(result.success).toBe(false);
    expect(receipt.outcome).toBe('failed');
    expect(receipt.failedLeaf).toBe('create_pr');
    expect(receipt.failure?.code).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    // Both declared events are named, not just the first one to come up short.
    expect(receipt.failure?.message).toContain('pr.create.requested');
    expect(receipt.failure?.message).toContain('pr.create.executed');
    // `continue` did not soften it: an integrity failure is not a verdict the
    // step's failure policy gets to overrule.
    expect(receipt.leaves.at(-1)?.status).toBe('failed');
  });

  it('SynthesisCloseout_WithTheShippedDeclaration_TheSameSegmentPasses', async () => {
    const result = await execute('op-emission-scope-shipped', deps({}));
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.status)).toEqual(['passed', 'passed']);
    expect(receipt.failure).toBeUndefined();

    // Same rows, same stream, same handler. Only the declaration differed.
    const vcsRows = await store.query(VCS_STREAM);
    expect(vcsRows.map((row) => row.type).sort()).toEqual([
      'pr.create.executed',
      'pr.create.requested',
    ]);
  });
});

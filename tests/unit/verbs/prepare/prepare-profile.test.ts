/**
 * `prepare` resolves the verification profile of the checkout and pins it once in the settlement contract.
 *
 * Each prepare case drives the handler against a real event store and a real bundle store in a temp directory.
 * A seam answers the three git reads, and each checkout is a temp directory with real files.
 * Each prepare case asserts the term that the capsule pins, so it fails when the handler or the compiler pins no profile.
 * The compiler cases call the compiler directly, because only a direct caller can pass no profile.
 *
 * @oracle-sources: ../../../../src/verbs/prepare/handler.ts, the files that each case writes at its checkout and the terms that it writes by hand from those files
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { WIN32_SPAWN_HEADROOM } from '../../../../vitest.config.js';
import { ExarchosCapsuleV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { estimateOutputTokens } from '../../../../src/dispatch/core/economy.js';
import { enforceResponseEconomy } from '../../../../src/dispatch/core/response-economy.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import { ECONOMY_META_TRUNCATED, type ToolResult } from '../../../../src/format.js';
import { canonicalPath } from '../../../../src/utils/git-tree.js';
import {
  compileDelegationCapsule,
  PREPARE_COMPILER_VERSION,
  type CompileCapsuleInput,
} from '../../../../src/verbs/prepare/compile-capsule.js';
import { PREPARE_ECONOMY_BUDGET_TOKENS } from '../../../../src/verbs/prepare/economy.js';
import { handlePrepare } from '../../../../src/verbs/prepare/handler.js';
import { lowerBuiltInDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import { partitionDelegationBatch } from '../../../../src/verbs/prepare/partition-tasks.js';
import type { ScopeGit } from '../../../../src/verbs/prepare/prepare-scope.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { resolveVerificationPolicy } from '../../../../src/workflow/verification-policy-resolver.js';
import type { VerificationProfile } from '../../../../src/workflow/verification/profile.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { scopedRepository } from '../../../helpers/scoped-repository.js';
import { nodeTestProfile } from '../../../helpers/verification-profile.js';

const STREAM = 'feat-prepare-profile';
const INTEGRATION_BRANCH = 'feature/prepare-profile';
const COMPILED_AT = '2026-10-30T00:00:00.000Z';
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos'];
/** The commit that each seam resolves for the base. */
const BASE_COMMIT = '6'.repeat(40);
/** The budget of the one case that makes a real repository. That case spawns git, so it does not raise the budget of its tier. */
const GIT_CASE_TIMEOUT_MS = 20_000 * WIN32_SPAWN_HEADROOM;

/** The manifest of a Node checkout with each script that the seeds read. */
const NODE_MANIFEST = `${JSON.stringify({
  name: 'prepare-profile-fixture',
  private: true,
  scripts: { 'test:files': 'vitest run', 'test:run': 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
})}\n`;

/** The files of one checkout: the path of each file relative to the root, and its text. */
type CheckoutFiles = Readonly<Record<string, string>>;

let stateDir: string;
let store: EventStore;
const scratch: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-profile-unit-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  for (const dir of scratch.splice(0)) await rmrfAsync(dir);
});

/** A new temp directory in canonical form, which the case deletes after it ends. */
async function tempDir(prefix: string): Promise<string> {
  const dir = canonicalPath(await mkdtemp(path.join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

/** A new temp checkout with the given files. */
async function checkoutWith(files: CheckoutFiles): Promise<string> {
  const checkout = await tempDir('prepare-profile-checkout-');
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(checkout, file), text);
  return checkout;
}

/** The git reads of a seam whose repository is the `.git` of the given checkout. No tag has the name of the base. */
function seamAt(checkout: string): ScopeGit {
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
  const identity = deriveMcpCallerIdentity({ sessionId: 'prepare-profile-unit' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

/** A feature workflow in `delegate` with two ready tasks and an integration branch. */
async function seed(stream: string): Promise<void> {
  await store.append(stream, { type: 'workflow.started', data: { featureId: stream, workflowType: 'feature' } });
  await store.append(stream, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await store.append(stream, {
    type: 'state.patched',
    data: {
      patch: {
        'synthesis.integrationBranch': INTEGRATION_BRANCH,
        tasks: [
          { id: 'T-1', title: 'first', status: 'pending', blockedBy: [] },
          { id: 'T-2', title: 'second', status: 'pending', blockedBy: [] },
        ],
      },
    },
  });
}

/** One prepare of a stream from the given checkout, through its seam, with the real resolvers. */
async function prepareFrom(checkout: string, stream: string = STREAM): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handlePrepare({ featureId: stream, repoRoot: checkout }, stateDir, wiring(), {
      now: () => COMPILED_AT,
      scopeGit: seamAt(checkout),
    }),
  );
}

/** The fields of a receipt that the cases read. The parse checks them, so no case trusts the shape of the data. */
const ReceiptView = z.object({
  capsuleVersion: z.number().int(),
  capsule: ExarchosCapsuleV1Schema,
});

type Receipt = z.infer<typeof ReceiptView>;

function receiptOf(result: ToolResult): Receipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  return ReceiptView.parse(result.success ? result.data : undefined);
}

/** The profile that a receipt pins. A receipt that pins none fails the case that reads it. */
function profileOf(receipt: Receipt): VerificationProfile {
  const profile = receipt.capsule.settlementContract.verificationProfile;
  if (profile === undefined) throw new Error('the capsule pins no verification profile');
  return profile;
}

/** The profile that a first prepare pins for a new checkout with the given files. A refused prepare fails the case. */
async function pinnedFor(files: CheckoutFiles, stream: string = STREAM): Promise<VerificationProfile> {
  await seed(stream);
  return profileOf(receiptOf(await prepareFrom(await checkoutWith(files), stream)));
}

/** The one check of the given name in a resolved static-analysis term. */
function checkNamed(profile: VerificationProfile, name: string): VerificationProfile['integration']['command'] {
  const { staticAnalysis } = profile;
  if (staticAnalysis.state !== 'resolved') throw new Error(staticAnalysis.reason);
  const check = staticAnalysis.checks.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`the profile has no check named ${name}`);
  return check.command;
}

/** The number of `workflow.prepared` rows on the stream. */
async function preparedRowCount(stream: string = STREAM): Promise<number> {
  return (await store.query(stream)).filter((event) => event.type === 'workflow.prepared').length;
}

/** The input of a direct compilation of a batch of one ready task. */
function compileInput(profile?: VerificationProfile): CompileCapsuleInput {
  const lowered = lowerBuiltInDefinition('feature');
  if (lowered === undefined) throw new Error('the feature workflow did not lower');
  const partition = partitionDelegationBatch([{ id: 'T-1', title: 'first', status: 'pending', blockedBy: [] }]);
  if (!partition.ok) throw new Error(partition.refusal.message);
  return {
    workflowId: STREAM,
    capsuleVersion: 1,
    lowered,
    batch: partition.batch,
    catalogInvariants: [],
    designRef: undefined,
    designVersion: 1,
    designRevisions: [],
    acceptedChanges: [],
    compilerVersion: PREPARE_COMPILER_VERSION,
    baseRef: INTEGRATION_BRANCH,
    ...(profile !== undefined ? { verificationProfile: profile } : {}),
    executionProfile: { capabilities: CAPABILITIES },
    verificationSequence: (riskTier, boundaryTouching) => resolveVerificationPolicy(riskTier, boundaryTouching).sequence,
    compiledAt: COMPILED_AT,
  };
}

describe('prepare pins the profile of the checkout', () => {
  /** A Node checkout with each seeded script pins the profile of the shared Node fake, term by term. */
  it('Prepare_TheCapsule_PinsTheProfileOfTheCheckout', async () => {
    expect(await pinnedFor({ 'package.json': NODE_MANIFEST })).toStrictEqual(nodeTestProfile());
  });

  /**
   * The checkout holds no manifest, and its config empties the test globs. So the glob term and each command term are unresolved.
   * prepare still records the capsule, and the capsule pins each reason for the gate that needs the term.
   */
  it('Prepare_AnUnresolvedTerm_IsPinnedWithItsReasonAndNothingIsRefused', async () => {
    const profile = await pinnedFor({ '.exarchos.yml': 'verification:\n  tests:\n    globs: []\n' });

    expect(profile.toolchains).toStrictEqual([]);
    expect(profile.tests.globs).toStrictEqual({
      state: 'unresolved',
      reason: expect.stringContaining('verification.tests.globs is empty'),
    });
    expect(profile.tests.probe.command).toStrictEqual({
      state: 'unresolved',
      reason: expect.stringContaining('verification.tests.probe.command'),
    });
    expect(profile.staticAnalysis).toStrictEqual({
      state: 'unresolved',
      reason: expect.stringContaining('Set verification.staticAnalysis'),
    });
    expect(profile.integration.command).toStrictEqual({
      state: 'unresolved',
      reason: expect.stringContaining('verification.integration.command'),
    });
    expect(profile.contract.typecheck).toStrictEqual({
      state: 'unresolved',
      reason: expect.stringContaining('Set typecheck:'),
    });
    expect(await preparedRowCount()).toBe(1);
  });

  /**
   * One checkout names a first-party glob that leaves the root, and the other names no glob. Both configs load.
   * Neither gives `CAPSULE_UNSOUND`. The killing assertion: with the task reverted, the capsule pins no profile.
   */
  it('Prepare_AFirstPartyValueOutsideTheProfileBound_PinsAnUnresolvedTermAndIsNotRefused', async () => {
    const outside = await pinnedFor({ '.exarchos.yml': "ownership:\n  firstParty:\n    - '../shared/src/**'\n" }, `${STREAM}-outside`);
    expect(outside.firstParty).toStrictEqual({
      state: 'unresolved',
      reason: expect.stringContaining('ownership.firstParty'),
    });

    const empty = await pinnedFor({ '.exarchos.yml': 'ownership:\n  firstParty: []\n' }, `${STREAM}-empty`);
    expect(empty.firstParty).toStrictEqual({ state: 'resolved', globs: [], source: 'config' });
  });

  /**
   * A retry from the same checkout replays the claim of the first call. The replayed capsule holds the profile.
   * The second call appends no prepared row, so it compiled nothing.
   */
  it('Prepare_AnUnchangedCheckout_ReplaysTheRecordedProfiledCapsule', async () => {
    await seed(STREAM);
    const checkout = await checkoutWith({ 'package.json': NODE_MANIFEST });

    const first = receiptOf(await prepareFrom(checkout));
    const replayed = receiptOf(await prepareFrom(checkout));

    expect(replayed).toStrictEqual(first);
    expect(profileOf(replayed)).toStrictEqual(nodeTestProfile());
    expect(replayed.capsuleVersion).toBe(1);
    expect(await preparedRowCount()).toBe(1);
  });

  /**
   * The seam puts the checkout below a real git repository whose config sets `lint`.
   * The config search of the default loader runs git, finds that root and reads that config.
   * prepare hands its own read to the resolver, so the pinned check comes from the package script.
   */
  it('Prepare_TheProfile_ComesFromTheReadOfPrepareAndNotFromASearchWithGit', async () => {
    const parent = await scopedRepository({
      integrationBranch: INTEGRATION_BRANCH,
      files: { '.exarchos.yml': 'lint: parent-repository-lint\n', 'checkout/package.json': NODE_MANIFEST },
    });
    scratch.push(parent.root);
    const checkout = path.posix.join(parent.checkout, 'checkout');
    await seed(STREAM);

    const profile = profileOf(receiptOf(await prepareFrom(checkout)));

    expect(checkNamed(profile, 'lint')).toStrictEqual({ state: 'resolved', argv: ['npm', 'run', 'lint'], source: 'detection' });
  }, GIT_CASE_TIMEOUT_MS);

  /**
   * The receipt of a real prepare holds the profile, and the estimator of the dispatcher measures it within the budget.
   * So the dispatcher returns the whole receipt, not a summary.
   */
  it('PrepareEconomy_AReceiptWithAProfile_FitsTheBudget', async () => {
    await seed(STREAM);
    const result = await prepareFrom(await checkoutWith({ 'package.json': NODE_MANIFEST }));

    expect(profileOf(receiptOf(result))).toStrictEqual(nodeTestProfile());
    expect(estimateOutputTokens(result.data)).toBeLessThanOrEqual(PREPARE_ECONOMY_BUDGET_TOKENS);

    const dispatched = enforceResponseEconomy(result, 'exarchos_orchestrate', 'prepare');
    expect(dispatched._meta ?? {}).not.toHaveProperty(ECONOMY_META_TRUNCATED);
    expect(dispatched.data).toStrictEqual(result.data);
  });
});

describe('prepare pins each term from its key', () => {
  /** `verification.tests.support` replaces each seeded segment. */
  it('Prepare_ATestsSupportKey_PinsItsSegments', async () => {
    const profile = await pinnedFor({
      'package.json': NODE_MANIFEST,
      '.exarchos.yml': 'verification:\n  tests:\n    support:\n      - harness\n',
    });

    expect(profile.tests.support).toStrictEqual({ segments: ['harness'], source: 'config' });
  });

  /** `verification.integration.command` replaces the resolved test command. The two unset keys come from the seeds. */
  it('Prepare_AnIntegrationKey_PinsItsCommand', async () => {
    const profile = await pinnedFor({
      'package.json': NODE_MANIFEST,
      '.exarchos.yml': 'verification:\n  integration:\n    command: npm run test:wave\n',
    });

    expect(profile.integration).toStrictEqual({
      command: { state: 'resolved', argv: ['npm', 'run', 'test:wave'], source: 'config' },
      report: 'exit-code',
      failureExitCodes: { codes: [1], source: 'detection' },
    });
  });

  /** `verification.integration.report` replaces the default report. */
  it('Prepare_AnIntegrationReportKey_PinsTheReport', async () => {
    const profile = await pinnedFor({
      'package.json': NODE_MANIFEST,
      '.exarchos.yml': 'verification:\n  integration:\n    command: npm run test:wave\n    report: vitest-json\n',
    });

    expect(profile.integration.report).toBe('vitest-json');
  });

  /** `verification.integration.failureExitCodes` replaces the red codes of the seed row. */
  it('Prepare_AnIntegrationFailureExitCodesKey_PinsTheCodes', async () => {
    const profile = await pinnedFor({
      'package.json': NODE_MANIFEST,
      '.exarchos.yml': 'verification:\n  integration:\n    command: npm run test:wave\n    failureExitCodes: [3, 7]\n',
    });

    expect(profile.integration.failureExitCodes).toStrictEqual({ codes: [3, 7], source: 'config' });
  });

  /** The checkout holds only a Makefile. Its two targets give the two checks, and no toolchain seeds them. */
  it('Prepare_ATaskRunnerLintOrTypecheckTarget_PinsACheck', async () => {
    const profile = await pinnedFor({ Makefile: 'lint:\n\t@true\ntypecheck:\n\t@true\n' });

    expect(profile.staticAnalysis).toStrictEqual({
      state: 'resolved',
      checks: [
        { name: 'lint', command: { state: 'resolved', argv: ['make', 'lint'], source: 'task-runner' } },
        { name: 'typecheck', command: { state: 'resolved', argv: ['make', 'typecheck'], source: 'task-runner' } },
      ],
      source: 'task-runner',
    });
  });

  /**
   * A quote is in the safe-command class, so both commands load, and neither splits into tokens.
   * The split error stays in the resolver. It gives an unresolved term that names the key, and prepare records the capsule.
   */
  it('Prepare_AnUnterminatedQuoteInACommand_PinsAnUnresolvedTermAndIsNotRefused', async () => {
    const profile = await pinnedFor({
      'package.json': NODE_MANIFEST,
      '.exarchos.yml': 'lint: npm run "lint\nverification:\n  integration:\n    command: npm run "wave\n',
    });

    expect(checkNamed(profile, 'lint')).toStrictEqual({
      state: 'unresolved',
      reason: expect.stringContaining('the command of lint: does not split into tokens'),
    });
    expect(profile.integration.command).toStrictEqual({
      state: 'unresolved',
      reason: expect.stringContaining('the command of verification.integration.command does not split into tokens'),
    });
    expect(await preparedRowCount()).toBe(1);
  });

  /** The two keys of the top-level `contract:` block resolve the two contract commands from the config. */
  it('Prepare_AContractCommandKey_PinsItResolved', async () => {
    const profile = await pinnedFor({
      'package.json': NODE_MANIFEST,
      '.exarchos.yml': 'contract:\n  codegen: npm run codegen\n  diff: npm run contract:diff\n',
    });

    expect(profile.contract.codegen).toStrictEqual({ state: 'resolved', argv: ['npm', 'run', 'codegen'], source: 'config' });
    expect(profile.contract.diff).toStrictEqual({ state: 'resolved', argv: ['npm', 'run', 'contract:diff'], source: 'config' });
  });

  /**
   * An empty block loads. A resolved term of no check is outside the schema of the capsule, so it gives `CAPSULE_UNSOUND`.
   * The block gives an unresolved term, and prepare records the capsule.
   */
  it('Prepare_AnEmptyStaticAnalysisBlock_PinsAnUnresolvedTermAndIsNotRefused', async () => {
    const profile = await pinnedFor({
      'package.json': NODE_MANIFEST,
      '.exarchos.yml': 'verification:\n  staticAnalysis: {}\n',
    });

    expect(profile.staticAnalysis).toStrictEqual({
      state: 'unresolved',
      reason: expect.stringContaining('verification.staticAnalysis is empty'),
    });
    expect(await preparedRowCount()).toBe(1);
  });
});

describe('the compiler writes the profile into the settlement contract', () => {
  /** The compiler pins the profile of its input once, beside the terms of each task. */
  it('CompileCapsule_AProfileInTheInput_IsWrittenIntoTheSettlementContract', () => {
    const outcome = compileDelegationCapsule(compileInput(nodeTestProfile()));
    if (!outcome.ok) throw new Error(outcome.refusal.message);

    expect(outcome.capsule.settlementContract.verificationProfile).toStrictEqual(nodeTestProfile());
  });

  /** A direct caller that passes no profile gets a capsule with no profile key, as an earlier compiler wrote it. */
  it('CompileCapsule_ACallerThatPassesNoProfile_GetsNone', () => {
    const outcome = compileDelegationCapsule(compileInput());
    if (!outcome.ok) throw new Error(outcome.refusal.message);

    expect(outcome.capsule.settlementContract).not.toHaveProperty('verificationProfile');
  });
});

/**
 * `prepare` reads the config and the catalog of the checkout that `repoRoot` names, and it compares the repository with the latest capsule.
 *
 * Each case drives the handler against a real event store and a real bundle store in a temp directory.
 * A seam answers the three git reads, and each checkout is a temp directory with real files.
 * The config digest cases read real files, and their expected digests are written by hand.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';
import { z } from 'zod';

import { resolveConfig } from '../../../../src/config/resolve.js';
import { ExarchosCapsuleV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  baseValidCapsule,
  baseValidDefinition,
  scopedValidCapsule,
} from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { BundleRefV1Schema, type BundleRefV1 } from '../../../../src/events/bundle/digest-references.js';
import type { RunBundleStore } from '../../../../src/events/bundle/run-bundle-store.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { handlePrepare, type PrepareDeps } from '../../../../src/verbs/prepare/handler.js';
import { configDigestAt, type ScopeGit } from '../../../../src/verbs/prepare/prepare-scope.js';
import { decodePreparedBundle, encodePreparedBundle } from '../../../../src/verbs/prepare/prepared-record.js';
import { canonicalPath } from '../../../../src/utils/git-tree.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STREAM = 'feat-prepare-scope';
const INTEGRATION_BRANCH = 'feature/prepare-scope';
const COMPILED_AT = '2026-10-24T00:00:00.000Z';
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos'];
/** The commit that each seam resolves for the base. */
const BASE_COMMIT = '9'.repeat(40);

let stateDir: string;
let store: EventStore;
const scratch: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-scope-unit-'));
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

/** The git reads of a seam whose repository is the `.git` of the given checkout. Each landed commit is on the base. */
function seamAt(checkout: string): ScopeGit {
  return {
    observe: async () => ({ kind: 'repository', toplevel: checkout, repository: `${checkout}/.git` }),
    commitOf: async () => ({ kind: 'commit', commit: BASE_COMMIT }),
    isAncestor: async () => ({ kind: 'ancestor' }),
  };
}

function wiring(extra: Partial<DispatchContext> = {}): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false, ...extra };
}

function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'prepare-scope-unit' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

/** A feature workflow in `delegate` with two ready tasks and an integration branch. */
async function seed(streamId = STREAM): Promise<void> {
  await store.append(streamId, { type: 'workflow.started', data: { featureId: streamId, workflowType: 'feature' } });
  await store.append(streamId, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await store.append(streamId, {
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

/** One prepare of a stream from the given checkout, through the given seam and dependencies. */
async function prepareFrom(
  checkout: string,
  deps: PrepareDeps,
  options: { readonly streamId?: string; readonly ctx?: Partial<DispatchContext> } = {},
): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handlePrepare({ featureId: options.streamId ?? STREAM, repoRoot: checkout }, stateDir, wiring(options.ctx), {
      now: () => COMPILED_AT,
      scopeGit: seamAt(checkout),
      ...deps,
    }),
  );
}

/** The fields of a receipt that the cases read. The parse checks them, so no case trusts the shape of the data. */
const ReceiptView = z.object({
  capsuleVersion: z.number().int(),
  capsule: ExarchosCapsuleV1Schema,
  bundleRefs: z.array(BundleRefV1Schema).min(1),
});

type Receipt = z.infer<typeof ReceiptView>;

function receiptOf(result: ToolResult): Receipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  return ReceiptView.parse(result.success ? result.data : undefined);
}

async function preparedCount(streamId = STREAM): Promise<number> {
  return (await store.query(streamId)).filter((event) => event.type === 'workflow.prepared').length;
}

/** The digest of the prepared bundle that a receipt names. */
function bundleDigestOf(receipt: Receipt): BundleRefV1['digest'] {
  const ref = receipt.bundleRefs[0];
  if (ref === undefined) throw new Error('the receipt names no bundle');
  return ref.digest;
}

/** A user catalog with one entry outside the reserved id namespaces. */
const USER_CATALOG = [
  '---',
  'schema-version: 3',
  'invariants:',
  '  - id: team-no-console',
  '    dimension: lint',
  '    axis: substrate',
  '    cost-of-load: always-load',
  '    applies-to:',
  '      - src/**',
  '    summary: No console.log in committed code.',
  '    references: []',
  '---',
  '# User catalog body',
  '',
].join('\n');

/** The sha256 of a text, in bare hex. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('prepare reads the checkout of repoRoot', () => {
  /**
   * The server context holds a policy and a directory of its own. The checkout config holds another policy.
   * The capsule states the gates of the checkout policy, and none of the server policy.
   */
  it('Prepare_TheCheckoutConfig_DecidesTheGateSequence', async () => {
    await seed();
    const checkout = await tempDir('prepare-scope-checkout-');
    const server = await tempDir('prepare-scope-server-');
    await writeFile(
      path.join(checkout, '.exarchos.yml'),
      'verification:\n  policy:\n    medium: [check_static_analysis, check_mock_boundary]\n',
    );
    const serverConfig = resolveConfig({ verification: { policy: { medium: ['check_contract_drift'] } } });

    const receipt = receiptOf(
      await prepareFrom(checkout, { catalogInvariants: () => [] }, { ctx: { cwd: server, projectConfig: serverConfig } }),
    );
    const patterns = receipt.capsule.knowledge.patterns.map((pattern) => pattern.statement);
    expect(patterns).toContain(
      'A task at riskTier=medium, boundaryTouching=false is verified at settlement by: check_static_analysis, check_mock_boundary.',
    );
    expect(patterns.join(' ')).not.toContain('check_contract_drift');
    expect(receipt.capsule.settlementContract.scope?.checkout).toBe(checkout);
  });

  /**
   * The checkout config registers a user catalog by a relative path, and the catalog file is in the checkout.
   * The dispatch workspace is an empty directory. The real resolver binds the user entry from the checkout.
   */
  it('Prepare_ARelativeCatalogPath_ResolvesAgainstTheCheckout', async () => {
    await seed();
    const checkout = await tempDir('prepare-scope-catalog-');
    const workspace = await tempDir('prepare-scope-workspace-');
    await writeFile(path.join(checkout, '.exarchos.yml'), 'invariants:\n  catalogs:\n    - team-invariants.md\n');
    await writeFile(path.join(checkout, 'team-invariants.md'), USER_CATALOG);

    const receipt = receiptOf(await prepareFrom(checkout, {}, { ctx: { cwd: workspace } }));
    const bound = receipt.capsule.authority.invariants.find((invariant) => invariant.id === 'team-no-console');
    expect(bound?.statement).toBe('No console.log in committed code.');
  });
});

describe('prepare compares the repository with the latest capsule', () => {
  /**
   * The first capsule pins the repository of one checkout. A call from another clone compiles new inputs, so the comparison runs.
   * The refusal names both repositories and the recovery, and the call records nothing and writes no blob.
   */
  it('Prepare_AnotherCloneThanTheEarlierCapsule_IsRefusedAndNamesBothRepositoriesAndTheRecovery', async () => {
    await seed();
    const pinned = await tempDir('prepare-scope-pinned-');
    const clone = await tempDir('prepare-scope-clone-');
    const first = receiptOf(await prepareFrom(pinned, { catalogInvariants: () => [] }));
    expect(first.capsule.settlementContract.scope?.repository).toBe(`${pinned}/.git`);
    expect(await store.bundleStore.has(bundleDigestOf(first))).toBe('ok');

    const refused = await prepareFrom(clone, { catalogInvariants: () => [] });
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error('unreachable');
    expect(refused.error?.code).toBe('SCOPE_UNRESOLVED');
    expect(refused.error?.message).toContain(`pins the repository '${pinned}/.git'`);
    expect(refused.error?.message).toContain(`is in the repository '${clone}/.git'`);
    expect(refused.error?.message).toContain(`Run prepare with a repoRoot in a checkout of '${pinned}/.git'`);
    expect(refused.error?.message).toContain('start a new workflow');
    expect(await preparedCount()).toBe(1);
  });

  /**
   * A second stream records a capsule of another repository. A seam answers the read of the latest capsule of the first stream with those bytes.
   * They decode, and they do not match the digest of the record, so custody cannot return the capsule and prepare compares nothing.
   * The seam records one read of that bundle, and the new capsule pins the scope of the call.
   */
  it('Prepare_ALatestCapsuleThatCustodyCannotReturn_IsNotComparedAndCompiles', async () => {
    await seed();
    await seed(`${STREAM}-other`);
    const pinned = await tempDir('prepare-scope-pinned-');
    const elsewhere = await tempDir('prepare-scope-elsewhere-');
    const first = receiptOf(await prepareFrom(pinned, { catalogInvariants: () => [] }));
    const other = receiptOf(await prepareFrom(elsewhere, { catalogInvariants: () => [] }, { streamId: `${STREAM}-other` }));
    expect(other.capsule.settlementContract.scope?.repository).toBe(`${elsewhere}/.git`);

    const asked = bundleDigestOf(first);
    const answer = bundleDigestOf(other);
    const real = store.bundleStore;
    const read: string[] = [];
    const bundles: RunBundleStore = Object.create(real);
    bundles.resolve = async (digest, signal) => {
      read.push(digest.value);
      return real.resolve(digest.value === asked.value ? answer : digest, signal);
    };

    const next = receiptOf(await prepareFrom(elsewhere, { catalogInvariants: () => [], bundleStore: bundles }));
    expect(read).toEqual([asked.value]);
    expect(next.capsuleVersion).toBe(2);
    expect(next.capsule.settlementContract.scope?.repository).toBe(`${elsewhere}/.git`);
    expect(next.capsule.settlementContract.scope?.checkout).toBe(elsewhere);
    expect(await preparedCount()).toBe(2);
  });
});

describe('the config digest of a checkout', () => {
  /**
   * The digest covers one entry for each config name, in a fixed order. A checkout with no config file gives two entries with no bytes.
   * The expected digest is the sha256 of the canonical JSON of those two entries, written here by hand.
   */
  it('ConfigDigest_NoConfigFile_IsTheDigestOfTwoAbsentEntries', async () => {
    const checkout = await tempDir('prepare-scope-digest-');
    expect(await configDigestAt(checkout)).toBe(
      sha256('[{"digest":null,"name":".exarchos.yml"},{"digest":null,"name":".exarchos.yaml"}]'),
    );
    expect(await configDigestAt(path.join(checkout, 'not-a-directory'))).toBe(
      sha256('[{"digest":null,"name":".exarchos.yml"},{"digest":null,"name":".exarchos.yaml"}]'),
    );
  });

  /**
   * Each edit of either file gives a new digest. The entry of a present file holds the sha256 of its bytes, and the expected digest is written by hand.
   */
  it('ConfigDigest_AnEditOfEitherFile_ChangesTheDigest', async () => {
    const checkout = await tempDir('prepare-scope-edit-');
    const absent = await configDigestAt(checkout);

    await writeFile(path.join(checkout, '.exarchos.yml'), 'review: {}\n');
    const yml = await configDigestAt(checkout);
    expect(yml).toBe(
      sha256(`[{"digest":"${sha256('review: {}\n')}","name":".exarchos.yml"},{"digest":null,"name":".exarchos.yaml"}]`),
    );

    await writeFile(path.join(checkout, '.exarchos.yml'), 'review: {}\n# edited\n');
    const editedYml = await configDigestAt(checkout);

    await writeFile(path.join(checkout, '.exarchos.yaml'), 'review: {}\n');
    const yaml = await configDigestAt(checkout);

    await writeFile(path.join(checkout, '.exarchos.yaml'), 'review: {}\n# edited\n');
    const editedYaml = await configDigestAt(checkout);

    expect(new Set([absent, yml, editedYml, yaml, editedYaml]).size).toBe(5);
  });
});

describe('a prepared bundle with a scope', () => {
  /**
   * A bundle of this compiler holds a scope and a base commit, and it reads back with both.
   * A bundle of an earlier compiler holds neither, and the strict decoder still reads it.
   */
  it('DecodePreparedBundle_ACapsuleWithAScope_DecodesAndACapsuleWithoutOneStillDecodes', () => {
    const definition = WorkflowDefinitionV1Schema.parse(baseValidDefinition());

    const scoped = decodePreparedBundle(encodePreparedBundle({ capsule: scopedValidCapsule(), definition }));
    expect(scoped.capsule.settlementContract.scope).toStrictEqual({
      repository: '/repos/capsule-corpus/.git',
      checkout: '/repos/capsule-corpus',
      configDigest: sha256('[]'),
    });
    expect(scoped.capsule.settlementContract.taskVerification?.['task-verify']?.baseCommit).toBe('c'.repeat(40));

    const earlier = decodePreparedBundle(encodePreparedBundle({ capsule: baseValidCapsule(), definition }));
    expect(earlier.capsule.settlementContract.scope).toBeUndefined();
    expect(earlier.capsule.settlementContract.taskVerification?.['task-verify']).toStrictEqual({
      riskTier: 'low',
      boundaryTouching: false,
      baseRef: 'feature/capsule-corpus',
    });
  });
});

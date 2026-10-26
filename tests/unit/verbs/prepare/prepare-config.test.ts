/**
 * `prepare` compiles from the config, the catalogs and the design record of the checkout, and it refuses a broken source.
 *
 * Each case drives the handler against a real event store and a real bundle store in a temp directory.
 * A seam answers the three git reads, and each checkout is a temp directory with real files.
 * No case injects a catalog, so the real resolver reads the catalogs that the checkout config registers.
 * The expected digests of the design bytes are written by hand from the text that each case writes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
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

const STREAM = 'feat-prepare-config';
const INTEGRATION_BRANCH = 'feature/prepare-config';
const COMPILED_AT = '2026-10-25T00:00:00.000Z';
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos'];
/** The commit that each seam resolves for the base. */
const BASE_COMMIT = '7'.repeat(40);

let stateDir: string;
let store: EventStore;
const scratch: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-config-unit-'));
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
  const identity = deriveMcpCallerIdentity({ sessionId: 'prepare-config-unit' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

/** A feature workflow in `delegate` with two ready tasks, an integration branch and, when the case gives one, a design reference. */
async function seed(design?: string): Promise<void> {
  await store.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await store.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await store.append(STREAM, {
    type: 'state.patched',
    data: {
      patch: {
        'synthesis.integrationBranch': INTEGRATION_BRANCH,
        ...(design !== undefined ? { 'artifacts.design': design } : {}),
        tasks: [
          { id: 'T-1', title: 'first', status: 'pending', blockedBy: [] },
          { id: 'T-2', title: 'second', status: 'pending', blockedBy: [] },
        ],
      },
    },
  });
}

/** One prepare of the stream from the given checkout, through its seam, with the real catalog resolver. */
async function prepareFrom(checkout: string): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handlePrepare({ featureId: STREAM, repoRoot: checkout }, stateDir, wiring(), {
      now: () => COMPILED_AT,
      scopeGit: seamAt(checkout),
    }),
  );
}

/** The fields of a receipt that the cases read. The parse checks them, so no case trusts the shape of the data. */
const ReceiptView = z.object({
  operationId: z.string(),
  capsuleVersion: z.number().int(),
  capsule: ExarchosCapsuleV1Schema,
});

type Receipt = z.infer<typeof ReceiptView>;

function receiptOf(result: ToolResult): Receipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  return ReceiptView.parse(result.success ? result.data : undefined);
}

/** The code and the message of a refusal. */
function refusalOf(result: ToolResult): { readonly code: string | undefined; readonly message: string } {
  expect(result.success, JSON.stringify(result)).toBe(false);
  if (result.success) throw new Error('unreachable');
  return { code: result.error?.code, message: result.error?.message ?? '' };
}

/** The provenance sources of a capsule that pin its design of record. */
function designSourcesOf(receipt: Receipt): { readonly sourceId: string; readonly digest: string }[] {
  return receipt.capsule.provenance.sources.filter(
    (source) => source.sourceId === 'design-record' || source.sourceId === 'design-reference',
  );
}

/** The sha256 of a text, in bare hex. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Prepares the seeded stream from a checkout whose config the case wrote, and expects a refusal that records nothing.
 * It returns the refusal, so the case reads its code and its message.
 */
async function refusedFrom(checkout: string): Promise<{ readonly code: string | undefined; readonly message: string }> {
  await seed();
  const before = await store.query(STREAM);
  const refusal = refusalOf(await prepareFrom(checkout));
  const after = await store.query(STREAM);
  expect(after).toHaveLength(before.length);
  expect(after.filter((event) => event.type === 'workflow.prepared')).toEqual([]);
  return refusal;
}

describe('prepare refuses a config or a catalog of the checkout that does not load', () => {
  /** The file parses, and a key that no schema knows fails the strict schema. The refusal names the file. */
  it('Prepare_AnInvalidConfig_IsRefusedAndNamesTheFile', async () => {
    const checkout = await tempDir('prepare-config-invalid-');
    await writeFile(path.join(checkout, '.exarchos.yml'), 'notARealKey: 1\n');

    const refusal = await refusedFrom(checkout);
    expect(refusal.code).toBe('SCOPE_UNRESOLVED');
    expect(refusal.message).toContain(`the config '${path.resolve(checkout, '.exarchos.yml')}'`);
    expect(refusal.message).toContain('notARealKey');
    expect(refusal.message).toContain('then prepare again');
  });

  /** The config name is a directory, so the search finds it and the read fails. The refusal names the file and the read error. */
  it('Prepare_AnUnreadableConfig_IsRefusedAndNamesTheFile', async () => {
    const checkout = await tempDir('prepare-config-unreadable-');
    await mkdir(path.join(checkout, '.exarchos.yml'));

    const refusal = await refusedFrom(checkout);
    expect(refusal.code).toBe('SCOPE_UNRESOLVED');
    expect(refusal.message).toContain(`the config '${path.resolve(checkout, '.exarchos.yml')}'`);
    expect(refusal.message).toContain('Failed to read');
  });

  /**
   * The config registers a user catalog by a relative path, and no file is at that path in the checkout.
   * The refusal names the registered path and the path that the resolver tried.
   */
  it('Prepare_AnUnresolvedRegisteredCatalog_IsRefusedAndNamesTheFile', async () => {
    const checkout = await tempDir('prepare-config-catalog-');
    await writeFile(path.join(checkout, '.exarchos.yml'), 'invariants:\n  catalogs:\n    - team-missing.md\n');

    const refusal = await refusedFrom(checkout);
    expect(refusal.code).toBe('SCOPE_UNRESOLVED');
    expect(refusal.message).toContain("the user invariant catalog 'team-missing.md'");
    expect(refusal.message).toContain(`no file is at '${path.join(checkout, 'team-missing.md')}'`);
    expect(refusal.message).toContain('remove its registration');
  });
});

describe('prepare refuses a static analysis that the checkout config does not make blocking', () => {
  /** A disabled dimension D2 disables the static analysis. */
  it('Prepare_ADisabledStaticAnalysis_IsRefusedAsScopeUnresolved', async () => {
    const checkout = await tempDir('prepare-config-disabled-');
    await writeFile(path.join(checkout, '.exarchos.yml'), 'review:\n  dimensions:\n    D2: disabled\n');

    const refusal = await refusedFrom(checkout);
    expect(refusal.code).toBe('SCOPE_UNRESOLVED');
    expect(refusal.message).toContain(`the config of the checkout '${checkout}' makes check_static_analysis disabled`);
  });

  /** A gate entry that is not blocking makes the static analysis warning-only. */
  it('Prepare_AWarningOnlyStaticAnalysis_IsRefusedAsScopeUnresolved', async () => {
    const checkout = await tempDir('prepare-config-warning-');
    await writeFile(
      path.join(checkout, '.exarchos.yml'),
      'review:\n  gates:\n    check_static_analysis:\n      blocking: false\n',
    );

    const refusal = await refusedFrom(checkout);
    expect(refusal.code).toBe('SCOPE_UNRESOLVED');
    expect(refusal.message).toContain(`the config of the checkout '${checkout}' makes check_static_analysis warning-only`);
  });
});

describe('prepare pins the bytes of a design record under the checkout', () => {
  /**
   * The record is a file of the checkout. A second call with the record unchanged replays the receipt.
   * An edit of the record compiles the next capsule version, which pins the digest of the new bytes.
   */
  it('Prepare_AnEditedDesignRecord_CompilesTheNextCapsuleVersionAndAnUnchangedOneReplays', async () => {
    const checkout = await tempDir('prepare-config-record-');
    await mkdir(path.join(checkout, 'docs', 'specs'), { recursive: true });
    await writeFile(path.join(checkout, 'docs', 'specs', 'record.md'), '# The first design\n');
    await seed('docs/specs/record.md');

    const first = receiptOf(await prepareFrom(checkout));
    expect(first.capsuleVersion).toBe(1);
    expect(designSourcesOf(first)).toEqual([{ sourceId: 'design-record', digest: sha256('# The first design\n') }]);

    const replayed = receiptOf(await prepareFrom(checkout));
    expect(replayed.capsuleVersion).toBe(1);
    expect(replayed.operationId).toBe(first.operationId);

    await writeFile(path.join(checkout, 'docs', 'specs', 'record.md'), '# The second design\n');
    const next = receiptOf(await prepareFrom(checkout));
    expect(next.capsuleVersion).toBe(2);
    expect(designSourcesOf(next)).toEqual([{ sourceId: 'design-record', digest: sha256('# The second design\n') }]);
    expect((await store.query(STREAM)).filter((event) => event.type === 'workflow.prepared')).toHaveLength(2);
  });

  /**
   * The checkout holds `docs/specs` as a directory link to a temp directory outside it, as this repository does.
   * The text of the reference stays under the checkout, so prepare reads the record through the link.
   * The link is a junction on win32, so the case needs no privilege. An edit through the link compiles the next capsule version.
   */
  it('Prepare_ADesignRecordUnderALinkedDirectory_IsPinnedByItsBytes', async () => {
    const checkout = await tempDir('prepare-config-linked-');
    const mount = await tempDir('prepare-config-mount-');
    await mkdir(path.join(checkout, 'docs'));
    await symlink(mount, path.join(checkout, 'docs', 'specs'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(mount, 'linked.md'), '# The linked design\n');
    await seed('docs/specs/linked.md');

    const first = receiptOf(await prepareFrom(checkout));
    expect(designSourcesOf(first)).toEqual([{ sourceId: 'design-record', digest: sha256('# The linked design\n') }]);

    await writeFile(path.join(mount, 'linked.md'), '# The linked design, edited\n');
    const next = receiptOf(await prepareFrom(checkout));
    expect(next.capsuleVersion).toBe(2);
    expect(designSourcesOf(next)).toEqual([
      { sourceId: 'design-record', digest: sha256('# The linked design, edited\n') },
    ]);
  });

  /**
   * The reference is `../outside.md`, and that file exists beside the checkout. Only the text rule refuses the read.
   * The design source pins the reference, and the rationale still names it.
   */
  it('Prepare_ADesignReferenceWhoseTextLeavesTheCheckout_IsPinnedByItsReference', async () => {
    const parent = await tempDir('prepare-config-parent-');
    const checkout = path.posix.join(parent, 'checkout');
    await mkdir(checkout);
    await writeFile(path.join(parent, 'outside.md'), '# A design outside the checkout\n');
    await seed('../outside.md');

    const receipt = receiptOf(await prepareFrom(checkout));
    expect(designSourcesOf(receipt)).toEqual([{ sourceId: 'design-reference', digest: contentDigest('../outside.md') }]);
    expect(receipt.capsule.knowledge.rationale.map((entry) => entry.statement)).toEqual([
      'The design of record is ../outside.md.',
    ]);
  });
});

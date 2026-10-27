/**
 * `check_invariant_conformance` does not approve when the config or a registered catalog does not load.
 * With no `repoRoot`, it reads the config and the catalog from one root.
 *
 * The root is the checkout of the latest prepared capsule of the workflow. A capsule that custody cannot return gives the process directory.
 * The two root cases run inside the hermetic environment, so the process directory is an empty temp directory.
 * Each catalog is a real file, and the real resolver reads it. The tests stub the phase-gate runner down to its provider call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';
import { z } from 'zod';

import { contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { scopedValidCapsule, baseValidDefinition } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { WorkflowPreparedData } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { canonicalPath } from '../../../../src/utils/git-tree.js';
import { handleCheckInvariantConformance } from '../../../../src/verbs/gates/check-invariant-conformance.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { withHermeticEnv } from '../../../helpers/hermetic.js';

vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: vi.fn(async (request) => request.executeProvider(
    { gateClass: request.gateClass, providerRef: 'test-provider', actionName: 'test-provider' },
    request.providerInput,
  )),
}));

let stateDir: string;
let store: EventStore;
const scratch: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'inv-unresolved-state-'));
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

/** A user catalog with one audit-mode entry of the given id. The gate lists each audit-mode id that it evaluates. */
function auditCatalog(id: string): string {
  return [
    '---',
    'schema-version: 3',
    'invariants:',
    `  - id: ${id}`,
    '    dimension: lint',
    '    axis: substrate',
    '    cost-of-load: always-load',
    '    applies-to:',
    '      - "**"',
    `    summary: The audit of ${id}.`,
    '    references: []',
    '    enforcement:',
    '      mode: audit',
    `      audit-prompt: Does the change keep the rule of ${id}?`,
    '---',
    '# User catalog body',
    '',
  ].join('\n');
}

/** Writes a config that registers one relative user catalog, and the catalog with one audit-mode entry of the given id. */
async function registerCatalog(dir: string, file: string, id: string): Promise<void> {
  await writeFile(path.join(dir, '.exarchos.yml'), `invariants:\n  catalogs:\n    - ${file}\n`);
  await writeFile(path.join(dir, file), auditCatalog(id));
}

/** The fields of a gate result that the cases read. The parse checks them, so no case trusts the shape of the data. */
const ConformanceView = z.object({
  verdict: z.string(),
  high: z.number(),
  findings: z.array(z.object({ source: z.string(), severity: z.string(), message: z.string() })),
  auditInvariantIds: z.array(z.string()),
});

function viewOf(result: ToolResult): z.infer<typeof ConformanceView> {
  expect(result.success, JSON.stringify(result)).toBe(true);
  return ConformanceView.parse(result.success ? result.data : undefined);
}

/** One review-phase run of the gate on a stream, with an empty diff and the given root. */
function conformance(featureId: string, repoRoot?: string): Promise<ToolResult> {
  return handleCheckInvariantConformance(
    { featureId, workflowType: 'feature', phase: 'review', diffContent: '', ...(repoRoot !== undefined ? { repoRoot } : {}) },
    stateDir,
    store,
  );
}

/**
 * Commits a prepared capsule on a stream, in custody, whose scope pins the given checkout.
 * The definition of the bundle is the parsed fixture definition, and the capsule names its digest.
 */
async function prepareInCustody(featureId: string, checkout: string): Promise<void> {
  const definition = WorkflowDefinitionV1Schema.parse(baseValidDefinition());
  const fixture = scopedValidCapsule();
  const scope = fixture.settlementContract.scope;
  if (scope === undefined) throw new Error('the scoped fixture pins no scope');
  const capsule = {
    ...fixture,
    identity: { ...fixture.identity, workflowId: featureId, definitionVersion: contentDigest(definition) },
    settlementContract: { ...fixture.settlementContract, scope: { ...scope, checkout } },
  };
  await commitPreparedCapsule(
    { stateDir, eventStore: store, enableTelemetry: false },
    {
      streamId: featureId,
      operationId: `prepare:${featureId}`,
      requestDigest: contentDigest(featureId),
      workflowType: 'feature',
      capsule,
      definition,
    },
  );
}

/** Appends a prepared record on a stream whose bundle is not in custody, so custody cannot return its capsule. */
async function prepareOutOfCustody(featureId: string): Promise<void> {
  await store.append(featureId, {
    type: 'workflow.prepared',
    data: WorkflowPreparedData.parse({
      operationId: `prepare:${featureId}`,
      workflowId: featureId,
      workflowType: 'feature',
      capsuleVersion: 1,
      definitionVersion: 'definition-1',
      designVersion: 'design-v1',
      capsuleDigest: 'd'.repeat(64),
      compilerVersion: 'exarchos-prepare-4',
      taskCount: 1,
      requestDigest: `request:${featureId}`,
      bundleRefs: [
        { artifactId: `run-bundle:prepared-capsule:${featureId}:1`, digest: { algorithm: 'sha256', value: 'a'.repeat(64) } },
      ],
    }),
  });
}

describe('check_invariant_conformance does not approve a source that does not load', () => {
  /**
   * The config of `repoRoot` registers a user catalog that is not there. The diff is empty, so no invariant fires.
   * The unresolved catalog alone gives a HIGH finding that names it, and the verdict is not APPROVED.
   */
  it('InvariantConformance_AnUnresolvedRegisteredCatalog_IsNotApproved', async () => {
    const root = await tempDir('inv-unresolved-catalog-');
    await writeFile(path.join(root, '.exarchos.yml'), 'invariants:\n  catalogs:\n    - team-missing.md\n');

    const view = viewOf(await conformance('feat-inv-unresolved', root));
    const finding = view.findings.find((f) => f.source === 'effective-catalog' && f.message.includes('team-missing.md'));
    expect(finding?.severity).toBe('HIGH');
    expect(view.high).toBeGreaterThanOrEqual(1);
    expect(view.verdict).not.toBe('APPROVED');
  });

  /** The config of `repoRoot` holds a key that no schema knows, so it does not load. The finding is HIGH, and the verdict is not APPROVED. */
  it('InvariantConformance_AConfigThatDoesNotLoad_IsNotApproved', async () => {
    const root = await tempDir('inv-unresolved-config-');
    await writeFile(path.join(root, '.exarchos.yml'), 'notARealKey: 1\n');

    const view = viewOf(await conformance('feat-inv-config', root));
    const finding = view.findings.find((f) => f.source === 'exarchos-config-load');
    expect(finding?.severity).toBe('HIGH');
    expect(finding?.message).toContain('notARealKey');
    expect(view.verdict).not.toBe('APPROVED');
  });
});

describe('check_invariant_conformance with no repoRoot reads one root', () => {
  /**
   * The process directory holds no config. The latest capsule of the stream pins a checkout whose config registers a relative user catalog.
   * The gate loads that config, resolves the catalog against the checkout, and evaluates its entry.
   */
  it('InvariantConformance_NoRepoRoot_LoadsTheConfigAndTheUserCatalogOfTheCheckoutOfTheLatestCapsule', async () => {
    await withHermeticEnv(async () => {
      const checkout = await tempDir('inv-root-checkout-');
      await registerCatalog(checkout, 'team-invariants.md', 'team-checkout-audit');
      await prepareInCustody('feat-inv-root', checkout);

      const view = viewOf(await conformance('feat-inv-root'));
      expect(view.auditInvariantIds).toContain('team-checkout-audit');
      expect(view.findings.filter((f) => f.severity === 'HIGH')).toEqual([]);
    });
  }, 30_000);

  /**
   * The process directory and the checkout each register a user catalog with an entry of their own.
   * On a stream whose latest capsule is in custody, the gate evaluates the entry of the checkout.
   * On a second stream, the latest prepared record cites a bundle that is not in custody. There the gate evaluates the entry of the process directory, and it does not throw.
   */
  it('InvariantConformance_ALatestCapsuleThatCustodyCannotReturn_FallsBackToTheCwdWhereAReadableOneGivesTheCheckout', async () => {
    await withHermeticEnv(async (env) => {
      const checkout = await tempDir('inv-custody-checkout-');
      await registerCatalog(checkout, 'team-invariants.md', 'team-checkout-audit');
      await registerCatalog(env.cwdDir, 'cwd-invariants.md', 'team-cwd-audit');
      await prepareInCustody('feat-inv-custody', checkout);
      await prepareOutOfCustody('feat-inv-lost');

      const readable = viewOf(await conformance('feat-inv-custody'));
      expect(readable.auditInvariantIds).toContain('team-checkout-audit');
      expect(readable.auditInvariantIds).not.toContain('team-cwd-audit');

      const lost = viewOf(await conformance('feat-inv-lost'));
      expect(lost.auditInvariantIds).toContain('team-cwd-audit');
      expect(lost.auditInvariantIds).not.toContain('team-checkout-audit');
    });
  }, 30_000);
});

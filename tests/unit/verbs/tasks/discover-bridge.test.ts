/**
 * Tests the deep-rung discover bridge from plan authoring to the discover research workflow.
 * The bridge is opt-in, so nothing spawns without author confirmation.
 * A confirmed bridge links the spec and the discover workflow with one `correlationId`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import { handleDiscoverBridge } from '../../../../src/verbs/tasks/discover-bridge.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

let tempDir: string;
let store: EventStore;
const stateDir = '/tmp/discover-bridge-test';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'discover-bridge-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

interface BridgeData {
  bridged: boolean;
  spawned: boolean;
  eventLinked?: boolean;
  correlationId: string;
  discoverFeatureId: string;
  reportPath: string | null;
  specCitation?: { artifact: string; reportPath: string | null; correlationId: string };
  affordance?: { verb: string; optIn: boolean };
}

describe('handleDiscoverBridge (DR-7, task 018)', () => {
  /** Without confirmation, the bridge describes the affordance, spawns nothing, and appends no event. */
  it('DiscoverBridge_NoAuthorConfirm_NoSilentSpawn', async () => {
    const featureId = 'feat-deep';
    const result = await handleDiscoverBridge(
      { featureId, artifact: 'docs/specs/2026-06-22-feat-deep.md' },
      stateDir,
      store,
    );
    expect(result.success).toBe(true);
    const data = result.data as BridgeData;
    expect(data.bridged).toBe(false);
    expect(data.spawned).toBe(false);
    expect(data.affordance?.optIn).toBe(true);
    expect(data.affordance?.verb).toBe('discover_bridge');

    const events = await store.query(featureId, { sinceSequence: 0 });
    expect(events.length).toBe(0);
  });

  /**
   * With confirmation and a report, the spec citation and the discover link share one `correlationId`.
   * The discover stream id comes from the feature id. A `state.patched` event on the feature stream records the same link.
   */
  it('DiscoverBridge_CorrelationId_StitchesReportToSpec', async () => {
    const featureId = 'feat-deep';
    const artifact = 'docs/specs/2026-06-22-feat-deep.md';
    const reportPath = 'docs/research/2026-06-22-feat-deep-discovery.md';
    const result = await handleDiscoverBridge(
      { featureId, artifact, confirm: true, reportPath },
      stateDir,
      store,
    );
    expect(result.success).toBe(true);
    const data = result.data as BridgeData;
    expect(data.bridged).toBe(true);
    expect(data.spawned).toBe(true);
    expect(data.eventLinked).toBe(true);

    expect(data.specCitation?.correlationId).toBe(data.correlationId);
    expect(data.specCitation?.artifact).toBe(artifact);
    expect(data.specCitation?.reportPath).toBe(reportPath);
    expect(data.discoverFeatureId).toBe('feat-deep-discover');

    const events = (await store.query(featureId, { sinceSequence: 0 })) as unknown as Array<{
      type: string;
      correlationId?: string;
      data?: { patch?: { discoverBridge?: { reportPath?: string; specPath?: string; correlationId?: string } } };
    }>;
    const linkEvent = events.find((e) => e.type === 'state.patched');
    expect(linkEvent).toBeDefined();
    expect(linkEvent!.correlationId).toBe(data.correlationId);
    const bridge = linkEvent!.data?.patch?.discoverBridge;
    expect(bridge?.reportPath).toBe(reportPath);
    expect(bridge?.specPath).toBe(artifact);
    expect(bridge?.correlationId).toBe(data.correlationId);
  });

  /** The bridge derives the `correlationId` from the `featureId`, so two confirmations give the same link. */
  it('DiscoverBridge_Confirmed_DeterministicCorrelationId', async () => {
    const featureId = 'feat-x';
    const args = { featureId, artifact: 'docs/specs/x.md', confirm: true } as const;
    const a = (await handleDiscoverBridge(args, stateDir, store)).data as BridgeData;
    const b = (await handleDiscoverBridge(args, stateDir, store)).data as BridgeData;
    expect(a.correlationId).toBe('discover-bridge:feat-x');
    expect(b.correlationId).toBe(a.correlationId);
  });

  it('DiscoverBridge_MissingArtifact_ReturnsError', async () => {
    const result = await handleDiscoverBridge({ featureId: 'feat-x' }, stateDir, store);
    expect(result.success).toBe(false);
    expect((result.error as { code: string }).code).toBe('INVALID_INPUT');
  });

  /** Without an event store, the bridge still returns the deterministic link, so the discover init of the author can adopt it. */
  it('DiscoverBridge_ConfirmedNoEventStore_DegradesToLinkage', async () => {
    const result = await handleDiscoverBridge(
      { featureId: 'feat-y', artifact: 'docs/specs/y.md', confirm: true },
      stateDir,
      undefined,
    );
    expect(result.success).toBe(true);
    const data = result.data as BridgeData;
    expect(data.bridged).toBe(true);
    expect(data.eventLinked).toBe(false);
    expect(data.correlationId).toBe('discover-bridge:feat-y');
  });
});

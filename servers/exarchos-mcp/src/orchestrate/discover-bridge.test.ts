import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { handleDiscoverBridge } from './discover-bridge.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

// ─── DR-7 (#1581 task 018): the deep-rung discover bridge ────────────────────
//
// Event-linked, correlationId-stitched escalation from PLAN authoring to the
// discover research workflow. Opt-in: nothing spawns without author confirmation.

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
  it('DiscoverBridge_NoAuthorConfirm_NoSilentSpawn', async () => {
    // GIVEN a deep-rung feature, WHEN the bridge is invoked WITHOUT confirmation,
    // THEN it describes the affordance but spawns nothing and emits no event.
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

    // No silent spawn — the feature stream has NO event from the unconfirmed bridge.
    const events = await store.query(featureId, { sinceSequence: 0 });
    expect(events.length).toBe(0);
  });

  it('DiscoverBridge_CorrelationId_StitchesReportToSpec', async () => {
    // GIVEN confirmation + a discover report, WHEN the bridge runs, THEN the spec
    // citation and the discover linkage share ONE correlationId, and that link is
    // recorded on the feature stream (event-linked).
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

    // The stitch: citation correlationId === the bridge correlationId, and the
    // discover stream id is derived from the feature.
    expect(data.specCitation?.correlationId).toBe(data.correlationId);
    expect(data.specCitation?.artifact).toBe(artifact);
    expect(data.specCitation?.reportPath).toBe(reportPath);
    expect(data.discoverFeatureId).toBe('feat-deep-discover');

    // Event-linked: a state.patched event on the feature stream carries the same
    // correlationId and records the report path stitched to the spec.
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

  it('DiscoverBridge_Confirmed_DeterministicCorrelationId', async () => {
    // The stitch correlationId is deterministic (replay-safe), derived from the
    // featureId — two confirmations re-derive the same link.
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

  it('DiscoverBridge_ConfirmedNoEventStore_DegradesToLinkage', async () => {
    // File-based dispatch (no event store): the escalation still returns the
    // deterministic linkage so the author's discover init can adopt it.
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

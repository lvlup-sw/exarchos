/**
 * Tests for the verification profile in the adapter of a ladder gate.
 *
 * The profile of a gate comes only from the dispatch context. The adapter replaces or removes a value that the args carry.
 * So a wire caller cannot pin a profile. Each case calls the adapter with a gate that records its args.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import type { ToolResult } from '../../../src/format.js';
import { adaptLadderGate } from '../../../src/verbs/composite.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { pinnedTestProfile } from '../../helpers/verification-profile.js';

let stateDir: string;
let store: EventStore;

/** The context of a call outside a segment. The composition root sets no profile. */
function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

/** The adapted form of a gate that records the args of each call. */
function recordingGate(): {
  readonly calls: Record<string, unknown>[];
  readonly gate: ReturnType<typeof adaptLadderGate>;
} {
  const calls: Record<string, unknown>[] = [];
  const gate = adaptLadderGate(async (args: Record<string, unknown>): Promise<ToolResult> => {
    calls.push(args);
    return { success: true };
  });
  return { calls, gate };
}

beforeEach(() => {
  stateDir = makeTempDir('ladder-gate-profile-');
  store = new EventStore(stateDir);
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

describe('adaptLadderGate — the verification profile', () => {
  /** The context profile wins over a value of the args, so a caller cannot choose the terms that judge it. */
  it('LadderGateAdapter_AProfileInTheArgs_IsReplacedByTheContextProfile', async () => {
    const pinned = pinnedTestProfile(2);
    const { calls, gate } = recordingGate();

    await gate({ taskId: 'task-1', verificationProfile: pinnedTestProfile(1) }, stateDir, {
      ...wiring(),
      verificationProfile: pinned,
    });

    expect(calls).toStrictEqual([{ taskId: 'task-1', verificationProfile: pinned }]);
  });

  /** A call with no profile in its context reaches the gate with no profile, so the gate resolves one live at its root. */
  it('LadderGateAdapter_NoContextProfile_RemovesTheProfileOfTheArgs', async () => {
    const { calls, gate } = recordingGate();

    await gate({ taskId: 'task-1', verificationProfile: pinnedTestProfile(1) }, stateDir, wiring());

    expect(calls).toStrictEqual([{ taskId: 'task-1' }]);
  });
});

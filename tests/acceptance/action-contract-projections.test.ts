import { describe, expect, it } from 'vitest';
import {
  generatedProjectionsMatchLive,
  measureLiveRegisteredActions,
  readRegisteredActionsSnapshot,
  snapshotMatchesLiveRegistry,
} from '../../src/contract/registered-actions-denominator.js';

describe('generated contract projection rebuild', () => {
  it('GeneratedContract_Rebuild_IsIdempotent', () => {
    expect(generatedProjectionsMatchLive()).toBe(true);
  });
});

describe('registered-actions snapshot denominator', () => {
  it('RegisteredActionsSnapshot_EqualsLiveRegistry', () => {
    const live = measureLiveRegisteredActions();
    const recorded = readRegisteredActionsSnapshot();
    expect(snapshotMatchesLiveRegistry(recorded, live)).toBe(true);

    const mutilated = {
      ...recorded,
      counts: { ...recorded.counts, actions: recorded.counts.actions - 1 },
      tools: recorded.tools.map((tool, index) =>
        index === 0 ? { ...tool, actions: tool.actions.slice(1) } : tool,
      ),
    };
    expect(snapshotMatchesLiveRegistry(mutilated, live)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { handleSubagentStop } from './subagent-stop.js';

// #1476 (T11): subagent-stop is a lifecycle observer — fire-and-report,
// never blocking. See docs/adrs/2026-05-24-hook-layer-observe-only.md.
describe('handleSubagentStop — observer', () => {
  it('SubagentStop_Always_ObservesWithoutBlocking', async () => {
    const result = await handleSubagentStop({
      hook_event_name: 'SubagentStop',
      subagent_type: 'exarchos-implementer',
    });
    expect(result.observed).toBe(true);
    expect(result.subagentType).toBe('exarchos-implementer');
    // Observers never produce a policy error.
    expect(result.error).toBeUndefined();
  });

  it('SubagentStop_MissingSubagentType_DefaultsToUnknown', async () => {
    const result = await handleSubagentStop({});
    expect(result.observed).toBe(true);
    expect(result.subagentType).toBe('unknown');
    expect(result.error).toBeUndefined();
  });
});

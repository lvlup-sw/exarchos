/**
 * The grant of the local process must cover each need that the registry
 * declares.
 *
 * Admission denies an ActionId when the caller does not hold its declared
 * `needs`. The CLI and the MCP server are one binary, and their grant is
 * `defaultProcessCapabilityIds()`. An action that needs a capability outside
 * that grant is unreachable from both surfaces. The drift is silent until an
 * end-to-end call fails, so this suite compares the two sides.
 *
 * @oracle-sources: ../../src/workflow/capabilities/resolver.ts, ../../src/registry.ts
 */
import { describe, expect, it } from 'vitest';
import {
  capabilityNeedSatisfied,
  defaultProcessCapabilityIds,
} from '../../src/workflow/capabilities/resolver.js';
import { normalizeActionContract } from '../../src/registry/action-contract.js';
import { getFullRegistry } from '../../src/registry.js';

interface DeclaredNeed {
  readonly actionId: string;
  readonly needs: readonly string[];
}

function actionsDeclaringNeeds(): readonly DeclaredNeed[] {
  const rows: DeclaredNeed[] = [];
  for (const tool of getFullRegistry()) {
    for (const action of tool.actions) {
      if (!('actionContract' in action)) continue;
      let contract;
      try {
        contract = normalizeActionContract(Reflect.get(action, 'actionContract'));
      } catch {
        continue;
      }
      if (contract.needs.kind !== 'declared') continue;
      rows.push({ actionId: `${tool.name}.${action.name}`, needs: contract.needs.values });
    }
  }
  return rows;
}

describe('action contract process grant', () => {
  /**
   * Asserts the denominator first. If the registry exposes no contracts, or
   * the reader finds none, the filter passes on an empty list.
   */
  it('ProcessGrant_EveryDeclaredNeed_IsHeldByTheLocalProcess', () => {
    const held = new Set(defaultProcessCapabilityIds());
    const rows = actionsDeclaringNeeds();

    expect(rows.length).toBeGreaterThanOrEqual(40);

    const unreachable = rows
      .filter((row) => !row.needs.every((need) => capabilityNeedSatisfied(held, need)))
      .map((row) => `${row.actionId} needs [${row.needs.join(', ')}]`);

    expect(unreachable).toEqual([]);
  });

  /**
   * The `mcp:exarchos` family has tiers, and the grant names only the full
   * tier. An action that needs read access alone must still admit. The grant
   * and those contracts use different literals.
   */
  it('ProcessGrant_FullMcpTier_SubsumesTheReadonlyNeed', () => {
    const held = new Set(defaultProcessCapabilityIds());
    expect(held.has('mcp:exarchos')).toBe(true);
    expect(held.has('mcp:exarchos:readonly')).toBe(false);
    expect(capabilityNeedSatisfied(held, 'mcp:exarchos:readonly')).toBe(true);
  });

  /** Proves that the predicate can deny. Without this, the tests above prove nothing. */
  it('ProcessGrant_UngrantedCapability_StillDenies', () => {
    const held = new Set(defaultProcessCapabilityIds());
    expect(capabilityNeedSatisfied(held, 'isolation:worktree')).toBe(false);
    expect(capabilityNeedSatisfied(held, 'team:agent-teams')).toBe(false);
  });
});

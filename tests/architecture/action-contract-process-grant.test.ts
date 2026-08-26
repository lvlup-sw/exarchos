/**
 * The grant the local process holds must cover what the registry declares.
 *
 * Admission denies an ActionId whose declared `needs` the caller does not
 * hold. The CLI and the MCP server are the same binary governing the machine
 * they run on, so their grant is `defaultProcessCapabilityIds()` — and any
 * action needing a capability outside it is unreachable from BOTH surfaces,
 * which is a shipped-dead verb rather than a policy decision. A contract that
 * names a capability nothing grants reads exactly like a contract that names
 * one everything grants, so the drift is silent until an end-to-end call
 * fails; asserting the two sides against each other here is what makes it
 * loud.
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
  it('ProcessGrant_EveryDeclaredNeed_IsHeldByTheLocalProcess', () => {
    const held = new Set(defaultProcessCapabilityIds());
    const rows = actionsDeclaringNeeds();

    // Assert the denominator first. A registry that stopped exposing
    // contracts, or a reader that stopped finding them, would otherwise
    // make the loop below pass by iterating nothing.
    expect(rows.length).toBeGreaterThanOrEqual(40);

    const unreachable = rows
      .filter((row) => !row.needs.every((need) => capabilityNeedSatisfied(held, need)))
      .map((row) => `${row.actionId} needs [${row.needs.join(', ')}]`);

    expect(unreachable).toEqual([]);
  });

  it('ProcessGrant_FullMcpTier_SubsumesTheReadonlyNeed', () => {
    // The `mcp:exarchos` family is tiered, so the grant spells only the full
    // tier. Actions that need read access alone must still admit — pinned
    // here because the grant and those contracts use different literals.
    const held = new Set(defaultProcessCapabilityIds());
    expect(held.has('mcp:exarchos')).toBe(true);
    expect(held.has('mcp:exarchos:readonly')).toBe(false);
    expect(capabilityNeedSatisfied(held, 'mcp:exarchos:readonly')).toBe(true);
  });

  it('ProcessGrant_UngrantedCapability_StillDenies', () => {
    // The check above is only meaningful if the predicate can say no.
    const held = new Set(defaultProcessCapabilityIds());
    expect(capabilityNeedSatisfied(held, 'isolation:worktree')).toBe(false);
    expect(capabilityNeedSatisfied(held, 'team:agent-teams')).toBe(false);
  });
});

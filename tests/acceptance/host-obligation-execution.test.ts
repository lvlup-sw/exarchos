/**
 * Which host-owned actions run their handler, and which return an obligation.
 *
 * `executionAuthority: { kind: 'host' }` says the HOST owes something. It does
 * not by itself say the handler must be skipped, and conflating the two broke
 * the two actions whose obligation is discharged USING the handler's output:
 * `agent_spec` returned `{obligation:'agent-spawn'}` where the delegating
 * orchestrator expected the spec text, and `prepare_review` returned it where
 * the review packet belonged.
 *
 * The existing coverage could not see this. Both prior tests picked an action
 * whose obligation genuinely blocks (`cutover_decide`, `check_coderabbit`), so
 * the short-circuit looked correct from every angle the suite had. This suite
 * drives the WHOLE host-owned population instead of a sample, which is what
 * makes the distinction falsifiable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  dispatch,
  stubCompositeHandler,
  type DispatchContext,
} from '../../src/dispatch/core/dispatch.js';
import { deriveLocalOperatorIdentity } from '../../src/dispatch/caller-identity.js';
import { buildDefaultProcessResolver } from '../../src/workflow/capabilities/resolver.js';
import { getFullRegistry } from '../../src/registry.js';
import {
  isBlockingHostObligation,
  normalizeActionContract,
} from '../../src/registry/action-contract.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

interface HostAction {
  readonly action: string;
  readonly obligation: string;
  readonly blocking: boolean;
}

/** Every host-owned action the live registry ships, read from the contracts. */
function hostOwnedActions(): readonly HostAction[] {
  const rows: HostAction[] = [];
  for (const tool of getFullRegistry()) {
    if (tool.name !== 'exarchos_orchestrate') continue;
    for (const action of tool.actions) {
      if (!('actionContract' in action)) continue;
      let contract;
      try {
        contract = normalizeActionContract(Reflect.get(action, 'actionContract'));
      } catch {
        continue;
      }
      const authority = contract.executionAuthority;
      if (authority.kind !== 'host') continue;
      rows.push({
        action: action.name,
        obligation: authority.obligation,
        blocking: isBlockingHostObligation(authority.obligation),
      });
    }
  }
  return rows;
}

/** Minimal args each host-owned action needs to get past schema validation. */
const ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  agent_spec: { agent: 'implementer' },
  prepare_review: { featureId: 'feat-host-obligation' },
  check_coderabbit: { owner: 'acme', repo: 'widgets', prNumbers: [1] },
  discover_bridge: { featureId: 'feat-host-obligation', artifact: 'docs/specs/example.md' },
};

describe('host-owned actions — execute vs return the obligation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-obligation-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  function ctx(): DispatchContext {
    return {
      stateDir: tmpDir,
      enableTelemetry: false,
      callerIdentity: deriveLocalOperatorIdentity(tmpDir),
      capabilityResolver: buildDefaultProcessResolver(),
    } as DispatchContext;
  }

  it('HostObligations_Population_IsNonEmptyAndCarriesBothKinds', () => {
    // The denominator, asserted before anything loops over it. A registry that
    // stopped declaring host authority would make every case below vacuous.
    const rows = hostOwnedActions();

    // PR #1867 reclassified `cutover_decide` from implicit host authority
    // (the pre-PR default when no executionAuthority was declared) to
    // explicit local authority: the cutover handler now discharges the
    // decision in-process rather than returning a host obligation for an
    // operator to fulfill. The host-owned population went from five to
    // four, not because a row was deleted but because its executionAuthority
    // became explicit local. The two blocking obligations (interactive-authentication
    // on `check_coderabbit`, human-approval on `discover_bridge`) and the
    // two non-blocking obligations (agent-spawn on `agent_spec` and
    // `prepare_review`) are still covered — the assertion that fires next
    // (rows.filter(...).length > 0) is what kept the test honest before
    // and what keeps it honest now.
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.filter((r) => r.blocking).length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.blocking).length).toBeGreaterThan(0);
    // Every one is exercised below; an unlisted action would silently skip.
    for (const row of rows) {
      expect(ARGS[row.action], `no args fixture for ${row.action}`).toBeDefined();
    }
  });

  it('HostObligations_AgentSpawn_RunsTheHandler', async () => {
    const rows = hostOwnedActions().filter((r) => !r.blocking);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      let handlerCalls = 0;
      const restore = stubCompositeHandler('exarchos_orchestrate', async () => {
        handlerCalls += 1;
        return { success: true, data: { ran: true } };
      });
      try {
        const result = await dispatch(
          'exarchos_orchestrate',
          { action: row.action, ...ARGS[row.action] },
          ctx(),
        );
        expect(
          handlerCalls,
          `${row.action} (${row.obligation}) must reach its handler — its obligation is ` +
            'discharged using what the handler returns',
        ).toBe(1);
        expect(result.data).not.toEqual({ obligation: row.obligation });
      } finally {
        restore();
      }
    }
  });

  it('HostObligations_Blocking_ReturnTheObligationWithoutExecuting', async () => {
    const rows = hostOwnedActions().filter((r) => r.blocking);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      let handlerCalls = 0;
      const restore = stubCompositeHandler('exarchos_orchestrate', async () => {
        handlerCalls += 1;
        return { success: true, data: { ran: true } };
      });
      try {
        const result = await dispatch(
          'exarchos_orchestrate',
          { action: row.action, ...ARGS[row.action] },
          ctx(),
        );
        expect(result.success, result.error?.message).toBe(true);
        expect(result.data).toEqual({ obligation: row.obligation });
        expect(
          handlerCalls,
          `${row.action} (${row.obligation}) must not run — the host owes this before ` +
            'the handler could do anything useful',
        ).toBe(0);
      } finally {
        restore();
      }
    }
  });

  it('HostObligations_AgentSpec_ReturnsTheSpecNotTheObligation', async () => {
    // The concrete regression, spelled out: `/delegate` reads this payload to
    // spawn with, so an obligation here is not a lesser answer, it is the
    // wrong one.
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'agent_spec', agent: 'implementer' },
      ctx(),
    );

    expect(result.success, result.error?.message).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.obligation).toBeUndefined();
    expect(data.agent).toBe('implementer');
    expect(typeof data.systemPrompt).toBe('string');
    expect((data.systemPrompt as string).length).toBeGreaterThan(0);
  });
});

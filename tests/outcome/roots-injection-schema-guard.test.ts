// ─── #1838 — roots inference must never inject into a schema that forbids it ──
//
// The roots-based `featureId` resolver ran for every action not on a
// three-name latency skip list, then injected the resolved id into the
// forwarded args. Actions whose own schema does not declare `featureId` were
// then refused by their own strict parse — naming a parameter the caller never
// sent and the server itself added. 59 of 124 registered actions failed that
// way, including `orchestrate.doctor` (the diagnostic of record) and 22 of the
// 26 `exarchos_view` read actions.
//
// The bug reproduced ONLY where roots resolution SUCCEEDS. The repo's own
// suite never resolves a workspace, so the entire surface stayed green.
//
// Breadth is asserted over the registry through the exported predicate rather
// than by dispatching 59 handlers — `merge_pr`, `create_pr` and `create_issue`
// are among them, and a guard must not perform the side effects it guards.
// Depth is one real end-to-end dispatch on the action from the report.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TOOL_REGISTRY } from '../../src/registry.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import {
  actionAcceptsInferredValue,
  INFERRABLE_FIELDS,
} from '../../src/dispatch/core/inferred-values.js';
import { EventStore } from '../../src/events/store.js';
import { handleInit } from '../../src/workflow/tools.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import type { RootsClient } from '../../src/runtime/workspace/discovery.js';

/** Temp workspaces created by this suite, removed on teardown. */
const created: string[] = [];

async function mkWorkspace(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), label));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

/** The live latency shortcut in `dispatch.ts`. Skipped names never reach inference at all. */
const LATENCY_SKIP =
  INFERRABLE_FIELDS.find((f) => f.field === 'featureId')?.skipActions ??
  new Set<string>();

interface ActionRef {
  readonly tool: string;
  readonly action: string;
}

function partitionRegistry(): {
  readonly declaring: readonly ActionRef[];
  readonly omitting: readonly ActionRef[];
} {
  const declaring: ActionRef[] = [];
  const omitting: ActionRef[] = [];
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) {
      const ref = { tool: tool.name, action: action.name };
      if (actionAcceptsInferredValue(action, 'featureId')) declaring.push(ref);
      else omitting.push(ref);
    }
  }
  return { declaring, omitting };
}

describe('Roots featureId inference is gated on the receiving schema (#1838)', () => {
  it('RootsInference_ActionOmittingFeatureId_IsNeverEligibleForInjection', () => {
    const { declaring, omitting } = partitionRegistry();

    // Denominator first — a cover assertion that enumerates nothing passes
    // trivially, which is the failure mode this repo keeps rediscovering.
    // These are the measured counts at the time of the fix; they are lower
    // bounds, so adding actions never turns the guard vacuous.
    //
    // RE-PINNED after the gate-population triage, which retired nine actions
    // and added one: 124 -> 116, and the partition moved with it — declaring
    // 59 -> 54, omitting 65 -> 62. Re-measured rather than lowered by the one
    // the CI failure named: a floor left eight below the live count would sit
    // out the next eight silent removals, which is the same vacuity these
    // assertions exist to refuse.
    expect(omitting.length).toBeGreaterThanOrEqual(62);
    expect(declaring.length).toBeGreaterThanOrEqual(54);
    expect(omitting.length + declaring.length).toBe(
      TOOL_REGISTRY.reduce((n, t) => n + t.actions.length, 0),
    );

    // The population the bug actually broke: omits `featureId` AND was not
    // rescued by the latency skip list.
    const exposed = omitting.filter((r) => !LATENCY_SKIP.has(r.action));
    // Same re-pin, same reason: 59 -> 56 across the retirement.
    expect(exposed.length).toBeGreaterThanOrEqual(56);

    // Every one of them must be ineligible for injection.
    for (const ref of exposed) {
      const tool = TOOL_REGISTRY.find((t) => t.name === ref.tool);
      const action = tool?.actions.find((a) => a.name === ref.action);
      expect(action, `${ref.tool}.${ref.action} missing from registry`).toBeDefined();
      expect(
        actionAcceptsInferredValue(action!, 'featureId'),
        `${ref.tool}.${ref.action} omits featureId but is eligible for injection`,
      ).toBe(false);
    }
  });

  it('RootsInference_NamedRegressionVictims_AreIneligible', () => {
    // Spot-pins from the report and from the measured blast radius, so a
    // refactor that silently narrows the predicate is named rather than
    // absorbed into an aggregate count.
    const victims: readonly ActionRef[] = [
      { tool: 'exarchos_event', action: 'append' },
      { tool: 'exarchos_event', action: 'batch_append' },
      { tool: 'exarchos_event', action: 'query' },
      { tool: 'exarchos_orchestrate', action: 'doctor' },
      { tool: 'exarchos_view', action: 'pipeline' },
      { tool: 'exarchos_workflow', action: 'feedback' },
    ];
    for (const v of victims) {
      const action = TOOL_REGISTRY.find((t) => t.name === v.tool)?.actions.find(
        (a) => a.name === v.action,
      );
      expect(action, `${v.tool}.${v.action} not found`).toBeDefined();
      expect(
        actionAcceptsInferredValue(action!, 'featureId'),
        `${v.tool}.${v.action} must not receive an inferred featureId`,
      ).toBe(false);
    }

    // And the converse — the predicate must still admit the actions that DO
    // take a featureId, or the fix would have disabled inference wholesale.
    const beneficiary = TOOL_REGISTRY.find((t) => t.name === 'exarchos_workflow')?.actions.find(
      (a) => a.name === 'get',
    );
    expect(beneficiary).toBeDefined();
    expect(actionAcceptsInferredValue(beneficiary!, 'featureId')).toBe(true);
  });

  it('Dispatch_EveryReadOnlyVictimUnderResolvingRoots_IsNotRefusedForInjectedFeatureId', async () => {
    // ─── the wiring, not just the predicate ─────────────────────────────────
    //
    // The registry assertions above prove `actionAcceptsInferredFeatureId`
    // classifies correctly. They do NOT prove dispatch consults it: delete the
    // call in `dispatch()` and every one of them still passes, because the
    // predicate remains correct while nothing asks it. A control that is not
    // reachable in the shipped composition is not a control.
    //
    // So this dispatches the victims for real. It is restricted to the
    // READ-ONLY ones — `exarchos_view` is declared `'*'` read-only by
    // READ_ONLY_ACTIONS, so executing them mutates nothing — which is what
    // makes exercising the whole population safe. The mutating victims
    // (`merge_pr`, `create_pr`, `create_issue`) stay excluded on purpose: a
    // guard must not perform the side effects it guards.
    const workspace = await mkWorkspace('outcome-1838-wiring-');
    const stateDir = path.join(workspace, 'docs', 'workflow-state');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(workspace, '.exarchos.yml'), '', 'utf8');

    const featureId = 'outcome-1838-wiring';
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    expect((await handleInit({ featureId, workflowType: 'feature' }, stateDir, eventStore)).success).toBe(true);

    const resolver = createInMemoryResolver([]);
    resolver.snapshot({ capabilities: { roots: { listChanged: true } } });
    const rootsClient: RootsClient = {
      async list() {
        return [{ uri: `file://${workspace}` }];
      },
    };
    const ctx = {
      stateDir,
      eventStore,
      enableTelemetry: false,
      capabilityResolver: resolver,
      rootsClient,
      cwd: workspace,
    };

    const viewTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
    expect(viewTool).toBeDefined();
    const victims = viewTool!.actions
      .filter((a) => !actionAcceptsInferredValue(a, 'featureId') && !LATENCY_SKIP.has(a.name))
      .map((a) => a.name);

    // Denominator: if this population ever empties, the loop below proves
    // nothing and would pass in silence.
    expect(victims.length).toBeGreaterThanOrEqual(20);

    const refused: string[] = [];
    for (const action of victims) {
      const result = await dispatch('exarchos_view', { action }, ctx);
      // The assertion is NOT that the call succeeds — several of these need
      // arguments or external state. It is that whatever goes wrong, it is
      // never dispatch refusing a parameter it injected itself.
      if (/unrecognized parameter\(s\).*featureId/.test(result.error?.message ?? '')) {
        refused.push(action);
      }
    }

    expect(
      refused,
      `dispatch injected featureId into ${refused.length} action(s) whose schema forbids it`,
    ).toEqual([]);
  }, 60_000);

  it('Dispatch_EventAppendUnderResolvingRoots_IsNotRefusedForInjectedFeatureId', async () => {
    const workspace = await mkWorkspace('outcome-1838-');
    const stateDir = path.join(workspace, 'docs', 'workflow-state');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(workspace, '.exarchos.yml'), '', 'utf8');

    const featureId = 'outcome-1838-roots';
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    const init = await handleInit({ featureId, workflowType: 'feature' }, stateDir, eventStore);
    expect(init.success).toBe(true);

    // A client that declares roots AND resolves successfully — the condition
    // under which the defect fires. Without this the branch never runs.
    const resolver = createInMemoryResolver([]);
    resolver.snapshot({ capabilities: { roots: { listChanged: true } } });
    const rootsClient: RootsClient = {
      async list() {
        return [{ uri: `file://${workspace}` }];
      },
    };

    const result = await dispatch(
      'exarchos_event',
      {
        action: 'append',
        stream: featureId,
        event: { type: 'task.assigned', data: { taskId: 'T-01', title: 'guard' } },
      },
      {
        stateDir,
        eventStore,
        enableTelemetry: false,
        capabilityResolver: resolver,
        rootsClient,
        cwd: workspace,
      },
    );

    // The precise pre-fix failure: INVALID_INPUT naming a parameter the
    // caller never supplied.
    const message = result.error?.message ?? '';
    expect(
      message,
      `dispatch refused a parameter it injected itself: ${message}`,
    ).not.toMatch(/unrecognized parameter\(s\).*featureId/);
    expect(result.success, `append failed: ${message}`).toBe(true);
  });
});

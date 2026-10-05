/**
 * Outcome tests for the gate on roots inference of `featureId`.
 *
 * Dispatch must merge an inferred `featureId` only into an action whose schema declares the field.
 * A strict schema that does not declare it refuses the call for a parameter the caller did not
 * send. The defect shows only when roots resolution succeeds, so the dispatch tests use a workspace
 * that resolves.
 *
 * The registry tests assert breadth through `actionAcceptsInferredValue`, and they call no
 * handler. Actions such as `merge_pr`, `create_pr` and `create_issue` have side effects that a
 * guard must not cause.
 */

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
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/** The temp workspaces of this suite. `afterEach` removes them. */
const created: string[] = [];

async function mkWorkspace(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), label));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await rmrfAsync(dir);
  }
});

/** The actions that skip `featureId` inference for latency, from `INFERRABLE_FIELDS`. */
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
  /**
   * The count assertions come first, because a loop over an empty list passes. The counts are lower
   * bounds, so a new action does not break them. `exposed` holds the actions that omit `featureId`
   * and are not on the latency skip list.
   */
  it('RootsInference_ActionOmittingFeatureId_IsNeverEligibleForInjection', () => {
    const { declaring, omitting } = partitionRegistry();

    expect(omitting.length).toBeGreaterThanOrEqual(60);
    expect(declaring.length).toBeGreaterThanOrEqual(55);
    expect(omitting.length + declaring.length).toBe(
      TOOL_REGISTRY.reduce((n, t) => n + t.actions.length, 0),
    );

    const exposed = omitting.filter((r) => !LATENCY_SKIP.has(r.action));
    expect(exposed.length).toBeGreaterThanOrEqual(55);

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

  /**
   * Names six actions that must not receive an inferred `featureId`, so a wrong predicate fails on
   * a named action and not inside a count. `exarchos_workflow` `get` must stay eligible, or the
   * predicate disables inference for every action.
   */
  it('RootsInference_NamedRegressionVictims_AreIneligible', () => {
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

    const beneficiary = TOOL_REGISTRY.find((t) => t.name === 'exarchos_workflow')?.actions.find(
      (a) => a.name === 'get',
    );
    expect(beneficiary).toBeDefined();
    expect(actionAcceptsInferredValue(beneficiary!, 'featureId')).toBe(true);
  });

  /**
   * The registry tests prove the predicate, not that `dispatch` calls it. This test dispatches each
   * `exarchos_view` action that omits `featureId` and is not on the skip list. `READ_ONLY_ACTIONS`
   * marks each `exarchos_view` action as read-only, so the dispatch changes nothing. A call can
   * fail for other reasons. It must not fail because dispatch refused a `featureId` that dispatch
   * added. The population must hold at least 20 actions, or the loop proves nothing.
   */
  it('Dispatch_EveryReadOnlyVictimUnderResolvingRoots_IsNotRefusedForInjectedFeatureId', async () => {
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

    expect(victims.length).toBeGreaterThanOrEqual(20);

    const refused: string[] = [];
    for (const action of victims) {
      const result = await dispatch('exarchos_view', { action }, ctx);
      if (/unrecognized parameter\(s\).*featureId/.test(result.error?.message ?? '')) {
        refused.push(action);
      }
    }

    expect(
      refused,
      `dispatch injected featureId into ${refused.length} action(s) whose schema forbids it`,
    ).toEqual([]);
  }, 60_000);

  /**
   * The client declares roots and the root resolves, which is the condition for the defect. The
   * `append` call must succeed, and its error message must not report `featureId` as an
   * unrecognized parameter.
   */
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

    const message = result.error?.message ?? '';
    expect(
      message,
      `dispatch refused a parameter it injected itself: ${message}`,
    ).not.toMatch(/unrecognized parameter\(s\).*featureId/);
    expect(result.success, `append failed: ${message}`).toBe(true);
  });
});

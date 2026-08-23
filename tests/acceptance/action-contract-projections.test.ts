import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI_SURFACE_FILE,
  serializedCliSurfaceBaseline,
} from '../../src/contract/cli/cli-surface.js';
import {
  PROOF_FIXTURES_FILE,
  serializedProofBaseline,
} from '../../src/contract/compiler/generate.js';
import { EVENT_ANNOTATIONS } from '../../src/events/event-annotations.js';
import { TOOL_REGISTRY } from '../../src/registry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SNAPSHOT_FILE = path.join(REPO_ROOT, 'tools/audit/registered-actions-snapshot.json');

interface SnapshotTool {
  readonly name: string;
  readonly hidden: boolean;
  readonly actions: readonly string[];
}

interface SnapshotEvent {
  readonly type: string;
  readonly lifecycle: string;
  readonly tier: string;
  readonly rationale?: string;
}

interface RegisteredActionsSnapshot {
  readonly counts: {
    readonly tools: number;
    readonly visibleTools: number;
    readonly actions: number;
    readonly eventTypes: number;
  };
  readonly tools: readonly SnapshotTool[];
  readonly eventTypes: readonly SnapshotEvent[];
}

function liveTools(): SnapshotTool[] {
  return TOOL_REGISTRY.map((tool) => ({
    name: tool.name,
    hidden: tool.hidden === true,
    actions: tool.actions.map((action) => action.name).sort(),
  })).sort((left, right) => left.name.localeCompare(right.name));
}

function liveEvents(): SnapshotEvent[] {
  return Object.entries(EVENT_ANNOTATIONS)
    .map(([type, registration]) => {
      const event: SnapshotEvent = {
        type,
        lifecycle: registration.lifecycle,
        tier: registration.tier,
      };
      return 'rationale' in registration && typeof registration.rationale === 'string'
        ? { ...event, rationale: registration.rationale }
        : event;
    })
    .sort((left, right) => left.type.localeCompare(right.type));
}

function liveSnapshotShape(): Pick<RegisteredActionsSnapshot, 'counts' | 'tools' | 'eventTypes'> {
  const tools = liveTools();
  const eventTypes = liveEvents();
  return {
    counts: {
      tools: tools.length,
      visibleTools: tools.filter((tool) => !tool.hidden).length,
      actions: tools.reduce((count, tool) => count + tool.actions.length, 0),
      eventTypes: eventTypes.length,
    },
    tools,
    eventTypes,
  };
}

function readSnapshot(): RegisteredActionsSnapshot {
  return JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as RegisteredActionsSnapshot;
}

describe('generated contract projection rebuild', () => {
  it('GeneratedContract_Rebuild_IsIdempotent', () => {
    const proofFirst = serializedProofBaseline();
    const proofSecond = serializedProofBaseline();
    expect(proofFirst).toBe(proofSecond);
    expect(proofFirst).toBe(readFileSync(PROOF_FIXTURES_FILE, 'utf8'));

    const cliFirst = serializedCliSurfaceBaseline();
    const cliSecond = serializedCliSurfaceBaseline();
    expect(cliFirst).toBe(cliSecond);
    expect(cliFirst).toBe(readFileSync(CLI_SURFACE_FILE, 'utf8'));
  });
});

describe('registered-actions snapshot denominator', () => {
  it('RegisteredActionsSnapshot_EqualsLiveRegistry', () => {
    const live = liveSnapshotShape();
    const recorded = readSnapshot();

    expect(recorded.counts).toEqual(live.counts);
    expect(recorded.tools).toEqual(live.tools);
    expect(recorded.eventTypes).toEqual(live.eventTypes);
    expect(recorded.counts.visibleTools).toBe(4);
    expect(recorded.tools.filter((tool) => !tool.hidden).map((tool) => tool.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);

    const mutilated = {
      ...live,
      counts: { ...live.counts, actions: live.counts.actions - 1 },
      tools: live.tools.map((tool, index) =>
        index === 0 ? { ...tool, actions: tool.actions.slice(1) } : tool,
      ),
    };
    expect(mutilated.tools).not.toEqual(recorded.tools);
    expect(mutilated.counts.actions).not.toBe(recorded.counts.actions);
  });
});

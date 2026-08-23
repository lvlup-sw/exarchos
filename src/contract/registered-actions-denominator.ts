import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI_SURFACE_FILE,
  serializedCliSurfaceBaseline,
} from './cli/cli-surface.js';
import {
  PROOF_FIXTURES_FILE,
  serializedProofBaseline,
} from './compiler/generate.js';
import { EVENT_ANNOTATIONS } from '../events/event-annotations.js';
import { TOOL_REGISTRY } from '../registry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REGISTERED_ACTIONS_SNAPSHOT_FILE = path.join(
  REPO_ROOT,
  'tools/audit/registered-actions-snapshot.json',
);

const VISIBLE_TOOL_NAMES = [
  'exarchos_event',
  'exarchos_orchestrate',
  'exarchos_view',
  'exarchos_workflow',
] as const;

export interface SnapshotTool {
  readonly name: string;
  readonly hidden: boolean;
  readonly actions: readonly string[];
}

export interface SnapshotEvent {
  readonly type: string;
  readonly lifecycle: string;
  readonly tier: string;
  readonly rationale?: string;
}

export interface RegisteredActionsSnapshot {
  readonly counts: {
    readonly tools: number;
    readonly visibleTools: number;
    readonly actions: number;
    readonly eventTypes: number;
  };
  readonly tools: readonly SnapshotTool[];
  readonly eventTypes: readonly SnapshotEvent[];
}

function byName(left: string, right: string): number {
  return left.localeCompare(right);
}

export function measureLiveRegisteredActions(): Pick<
  RegisteredActionsSnapshot,
  'counts' | 'tools' | 'eventTypes'
> {
  const tools = TOOL_REGISTRY.map((tool) => ({
    name: tool.name,
    hidden: tool.hidden === true,
    actions: tool.actions.map((action) => action.name).sort(byName),
  })).sort((left, right) => byName(left.name, right.name));
  const eventTypes = Object.entries(EVENT_ANNOTATIONS)
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
    .sort((left, right) => byName(left.type, right.type));
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

export function readRegisteredActionsSnapshot(
  snapshotFile: string = REGISTERED_ACTIONS_SNAPSHOT_FILE,
): RegisteredActionsSnapshot {
  return JSON.parse(readFileSync(snapshotFile, 'utf8')) as RegisteredActionsSnapshot;
}

export function snapshotMatchesLiveRegistry(
  recorded: RegisteredActionsSnapshot = readRegisteredActionsSnapshot(),
  live: ReturnType<typeof measureLiveRegisteredActions> = measureLiveRegisteredActions(),
): boolean {
  return (
    JSON.stringify(recorded.counts) === JSON.stringify(live.counts) &&
    JSON.stringify(recorded.tools) === JSON.stringify(live.tools) &&
    JSON.stringify(recorded.eventTypes) === JSON.stringify(live.eventTypes) &&
    recorded.counts.visibleTools === 4 &&
    JSON.stringify(recorded.tools.filter((tool) => !tool.hidden).map((tool) => tool.name).sort(byName)) ===
      JSON.stringify([...VISIBLE_TOOL_NAMES].sort())
  );
}

export function generatedProjectionsMatchLive(): boolean {
  const proofFirst = serializedProofBaseline();
  const cliFirst = serializedCliSurfaceBaseline();
  return (
    proofFirst === serializedProofBaseline() &&
    proofFirst === readFileSync(PROOF_FIXTURES_FILE, 'utf8') &&
    cliFirst === serializedCliSurfaceBaseline() &&
    cliFirst === readFileSync(CLI_SURFACE_FILE, 'utf8')
  );
}

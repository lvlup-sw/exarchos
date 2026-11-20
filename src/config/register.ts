// RESERVED(issue: #1928, owner: exarchos, expires: 2027-02-28) — data-only startup removed the last production importer. The v3.0 migration deletes this registry.
/** Registers custom workflow and event data. It imports no checkout module and stores no guard command. */
import { registerWorkflowType, unregisterWorkflowType } from '../workflow/state-machine.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../workflow/schemas.js';
import { registerEventType, unregisterEventType } from '../events/schemas.js';
import type { ExarchosConfig, WorkflowDefinition } from './define.js';

export type { ExarchosConfig, WorkflowDefinition };

/**
 * Topologically sort workflow entries so parents register before children.
 * Workflows extending built-in types have no sibling dependency and sort first.
 */
function topoSortWorkflows(
  workflows: Record<string, WorkflowDefinition>,
): [string, WorkflowDefinition][] {
  const entries = Object.entries(workflows);
  const nameSet = new Set(entries.map(([n]) => n));
  const sorted: [string, WorkflowDefinition][] = [];
  const visited = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    const def = workflows[name];
    if (!def) return;
    if (def.extends && nameSet.has(def.extends)) {
      visit(def.extends);
    }
    sorted.push([name, def]);
  }

  for (const [name] of entries) {
    visit(name);
  }
  return sorted;
}

/**
 * Registers the custom workflows and events of an `ExarchosConfig`. For each
 * workflow, it registers the HSM definition and extends the type schema. It
 * stores no guard command, so a command guard fails closed at its transition.
 * A parent workflow registers before a child that extends it.
 * On a failure, it undoes all registrations of this call and throws.
 */
export function registerCustomWorkflows(config: ExarchosConfig): void {
  if (!config.workflows && !config.events) return;

  const registeredWorkflows: string[] = [];
  const extendedTypes: string[] = [];
  const registeredEvents: string[] = [];

  try {
    if (config.workflows) {
      for (const [name, definition] of topoSortWorkflows(config.workflows)) {
        registerWorkflowType(name, definition);
        registeredWorkflows.push(name);

        extendWorkflowTypeEnum(name);
        extendedTypes.push(name);
      }
    }

    if (config.events) {
      for (const [name, eventDef] of Object.entries(config.events)) {
        registerEventType(name, eventDef);
        registeredEvents.push(name);
      }
    }
  } catch (error) {
    for (const name of registeredEvents) {
      unregisterEventType(name);
    }
    for (const name of extendedTypes) {
      unextendWorkflowTypeEnum(name);
    }
    for (const name of registeredWorkflows) {
      unregisterWorkflowType(name);
    }
    throw new Error(
      `Failed to register custom workflows: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

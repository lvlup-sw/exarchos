import { vacuityWaiver } from '../output-schema-declaration.js';
import type { VacuityWaiverId } from '../output-schema-vacuity-allowlist.js';
import { z } from 'zod';
import { none, withActionContract } from './action-contract.js';
import { READ_ONLY_LOCAL } from './annotations.js';
import { DESCRIBE_ECONOMY_BUDGET_TOKENS, EVENT_DESCRIBE_ECONOMY_BUDGET_TOKENS } from './hints.js';
import { ALL_PHASES, ROLE_ANY } from './phases.js';
import type { BuiltinToolAction } from './types.js';

const DESCRIBE_CONTRACT = {
  requires: none('describe is a read-only schema query with no admission obligations'),
  ensures: none('describe returns ephemeral schema text with no durable postcondition'),
  needs: none('describe inspects in-process registry state'),
  touches: {
    frame: 'single-machine' as const,
    resources: none('describe does not touch streams, paths, worktrees, or git refs'),
  },
  executionAuthority: { kind: 'local' as const },
  replay: { kind: 'safe-repeat' as const },
  emissions: none('describe emits no catalog events'),
};

// ─── Describe Action ────────────────────────────────────────────────────────

const describeSchema = z.object({
  actions: z.array(z.string()).min(1).max(10)
    .describe('Action names to describe. Returns full schema + description for each.'),
});

/** Creates a shared describe action definition for composite tools. */
export function makeDescribeAction(waiverId: VacuityWaiverId): BuiltinToolAction {
  return withActionContract(
    {
      name: 'describe',
      description: 'Return full schemas, descriptions, gate metadata, and phase/role info for specific actions',
      schema: describeSchema,
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      // DR-1: verbose-by-design detail path — full per-action JSON schemas.
      economy: { budgetTokens: DESCRIBE_ECONOMY_BUDGET_TOKENS },
      outputSchema: vacuityWaiver(waiverId),
      annotations: READ_ONLY_LOCAL,
    },
    DESCRIBE_CONTRACT,
    { annotations: READ_ONLY_LOCAL },
  ) as BuiltinToolAction;
}

/** Workflow-specific describe schema: supports actions, topology, playbooks, and config. */
const workflowDescribeSchema = z.object({
  actions: z.array(z.string()).min(1).max(10)
    .describe('Action names to describe. Returns full schema + description for each.')
    .optional(),
  topology: z.string()
    .describe('Workflow type to return HSM topology for. Use "all" to list all types.')
    .optional(),
  playbook: z.string()
    .describe('Workflow type for phase playbooks. "all" lists types.')
    .optional(),
  config: z.boolean()
    .describe('When true, returns annotated project config showing values and sources (default vs .exarchos.yml).')
    .optional(),
});

/** Creates a workflow-specific describe action with topology, playbook, and config support. */
export function makeWorkflowDescribeAction(waiverId: VacuityWaiverId): BuiltinToolAction {
  return withActionContract(
    {
      name: 'describe',
      description: 'Return full schemas, descriptions, gate metadata, and phase/role info for specific actions. Optionally return HSM topology, phase playbooks, or annotated project config.',
      schema: workflowDescribeSchema,
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      // DR-1: verbose-by-design detail path — schemas + topology/playbooks/config.
      economy: { budgetTokens: DESCRIBE_ECONOMY_BUDGET_TOKENS },
      outputSchema: vacuityWaiver(waiverId),
      annotations: READ_ONLY_LOCAL,
    },
    DESCRIBE_CONTRACT,
    { annotations: READ_ONLY_LOCAL },
  ) as BuiltinToolAction;
}

const eventDescribeSchema = z.object({
  actions: z.array(z.string()).min(1).max(10)
    .describe('Action names to describe. Returns full schema + description for each.')
    .optional(),
  eventTypes: z.array(z.string()).min(1).max(20)
    .describe('Event type names to describe. Returns data schema, emission source, and built-in status for each.')
    .optional(),
  emissionGuide: z.boolean().optional()
    .describe('When true, returns the full event emission catalog grouped by source'),
});

/** Creates a describe action for the event tool that supports both actions, eventTypes, and emissionGuide. */
export function makeEventDescribeAction(waiverId: VacuityWaiverId): BuiltinToolAction {
  return withActionContract(
    {
      name: 'describe',
      description: 'Return schemas for actions and/or event types, or the emission guide. At least one of actions, eventTypes, or emissionGuide must be provided.',
      schema: eventDescribeSchema,
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      // DR-1: verbose-by-design detail path whose budget accounts for the
      // `emissionGuide` param path (the full event catalog), which is a param
      // of this one describe action — not a separate action.
      economy: { budgetTokens: EVENT_DESCRIBE_ECONOMY_BUDGET_TOKENS },
      outputSchema: vacuityWaiver(waiverId),
      annotations: READ_ONLY_LOCAL,
    },
    DESCRIBE_CONTRACT,
    { annotations: READ_ONLY_LOCAL },
  ) as BuiltinToolAction;
}

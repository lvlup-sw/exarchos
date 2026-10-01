/**
 * Handler for the `verify_delegation_saga` action. It checks the order of the `team.*` saga steps in a delegation event file.
 * The rules:
 * 1. `team.spawned` comes before `team.task.planned` and `team.teammate.dispatched`.
 * 2. `team.task.planned` comes before `team.teammate.dispatched`.
 * 3. Every dispatched task id is planned.
 * 4. After `team.disbanded`, every team event other than `team.spawned` is a violation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveStateDir } from '../../utils/paths.js';
import type { ToolResult } from '../../format.js';

interface VerifyDelegationSagaArgs {
  readonly featureId: string;
  readonly stateDir?: string;
}

interface SagaEvent {
  readonly type: string;
  readonly sequence: number;
  readonly data?: {
    readonly taskId?: string;
    readonly taskIds?: readonly string[];
    readonly assignedTaskIds?: readonly string[];
  };
}

export function handleVerifyDelegationSaga(args: VerifyDelegationSagaArgs): ToolResult {
  if (!args.featureId || args.featureId.trim().length === 0) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'featureId must be a non-empty string',
      },
    };
  }
  if (args.featureId.includes('/') || args.featureId.includes('..') || args.featureId.startsWith('/')) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `featureId contains invalid path characters: ${args.featureId}`,
      },
    };
  }

  const stateDir = args.stateDir ?? resolveStateDir();
  const eventFile = join(stateDir, `${args.featureId}.events.jsonl`);

  if (!existsSync(eventFile)) {
    return {
      success: false,
      error: {
        code: 'FILE_NOT_FOUND',
        message: `Event file not found: ${eventFile}`,
      },
    };
  }

  let content: string;
  try {
    content = readFileSync(eventFile, 'utf-8');
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'READ_ERROR',
        message: `Failed to read event file: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (content.trim().length === 0) {
    return {
      success: false,
      error: {
        code: 'EMPTY_FILE',
        message: `Event file is empty: ${eventFile}`,
      },
    };
  }

  let events: SagaEvent[];
  try {
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    events = lines.map((line) => JSON.parse(line) as SagaEvent);
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'PARSE_ERROR',
        message: `Failed to parse event file: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const teamEvents = events.filter((e) => e.type.startsWith('team.'));

  if (teamEvents.length === 0) {
    return {
      success: true,
      data: {
        passed: true,
        violations: [],
        report: `No team events found in event stream. Skipping saga validation.`,
      },
    };
  }

  const violations: string[] = [];
  let hasSpawned = false;
  let hasPlanned = false;
  let hasDisbanded = false;
  let disbandedSequence = 0;

  const plannedTaskIds = new Set<string>();
  const dispatchedTaskIds: string[] = [];

  for (const event of teamEvents) {
    const seq = event.sequence;

    switch (event.type) {
      case 'team.spawned':
        hasSpawned = true;
        break;

      case 'team.task.planned':
        if (!hasSpawned) {
          violations.push(
            `VIOLATION: team.task.planned (seq ${seq}) appeared before team.spawned`,
          );
        }

        if (hasDisbanded) {
          violations.push(
            `VIOLATION: team.task.planned (seq ${seq}) appeared after team.disbanded (seq ${disbandedSequence})`,
          );
        }

        if (event.data?.taskIds && Array.isArray(event.data.taskIds)) {
          for (const tid of event.data.taskIds) {
            plannedTaskIds.add(tid);
          }
        }
        if (event.data?.taskId) {
          plannedTaskIds.add(event.data.taskId);
        }

        hasPlanned = true;
        break;

      case 'team.teammate.dispatched':
        if (!hasSpawned) {
          violations.push(
            `VIOLATION: team.teammate.dispatched (seq ${seq}) appeared before team.spawned`,
          );
        }

        if (!hasPlanned) {
          violations.push(
            `VIOLATION: team.teammate.dispatched (seq ${seq}) appeared before any team.task.planned`,
          );
        }

        if (hasDisbanded) {
          violations.push(
            `VIOLATION: team.teammate.dispatched (seq ${seq}) appeared after team.disbanded (seq ${disbandedSequence})`,
          );
        }

        if (event.data?.assignedTaskIds && Array.isArray(event.data.assignedTaskIds)) {
          for (const tid of event.data.assignedTaskIds) {
            dispatchedTaskIds.push(tid);
          }
        }
        break;

      case 'team.disbanded':
        if (hasDisbanded) {
          violations.push(
            `VIOLATION: team.disbanded (seq ${seq}) appeared after team.disbanded (seq ${disbandedSequence})`,
          );
        }
        hasDisbanded = true;
        disbandedSequence = seq;
        break;

      default:
        if (hasDisbanded) {
          violations.push(
            `VIOLATION: ${event.type} (seq ${seq}) appeared after team.disbanded (seq ${disbandedSequence})`,
          );
        }
        break;
    }
  }

  for (const dispatched of dispatchedTaskIds) {
    if (!plannedTaskIds.has(dispatched)) {
      violations.push(
        `VIOLATION: Dispatched task '${dispatched}' was never planned (no team.task.planned event with this taskId)`,
      );
    }
  }

  const passed = violations.length === 0;
  const report = passed
    ? `## Delegation Saga Validation\n\n**Status:** PASSED for feature \`${args.featureId}\``
    : [
        `## Delegation Saga Validation`,
        ``,
        `**Status:** FAILED for feature \`${args.featureId}\``,
        ``,
        `### Violations`,
        ``,
        ...violations.map((v) => `- ${v}`),
        ``,
        `**Total:** ${violations.length} violation(s) found.`,
      ].join('\n');

  return {
    success: true,
    data: { passed, violations, report },
  };
}

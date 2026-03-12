// ─── Verify Delegation Saga Handler ──────────────────────────────────────────
//
// Validates saga step ordering in delegation event streams. Ported from
// scripts/verify-delegation-saga.sh — same 4 rules, same semantics,
// deterministic pure-function implementation.
//
// Rules:
//   1. team.spawned must appear before team.task.planned and team.teammate.dispatched
//   2. team.task.planned must appear before team.teammate.dispatched
//   3. All dispatched task IDs must have been planned
//   4. team.disbanded must be the last team event (nothing after it)
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolResult } from '../format.js';

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Handler ─────────────────────────────────────────────────────────────────

export function handleVerifyDelegationSaga(args: VerifyDelegationSagaArgs): ToolResult {
  const stateDir = args.stateDir ?? join(homedir(), '.claude', 'workflow-state');
  const eventFile = join(stateDir, `${args.featureId}.events.jsonl`);

  // Guard: file existence
  if (!existsSync(eventFile)) {
    return {
      success: false,
      error: {
        code: 'FILE_NOT_FOUND',
        message: `Event file not found: ${eventFile}`,
      },
    };
  }

  // Read and validate non-empty
  const content = readFileSync(eventFile, 'utf-8');
  if (content.trim().length === 0) {
    return {
      success: false,
      error: {
        code: 'EMPTY_FILE',
        message: `Event file is empty: ${eventFile}`,
      },
    };
  }

  // Parse JSONL lines
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const events: SagaEvent[] = lines.map((line) => JSON.parse(line) as SagaEvent);

  // Filter to team.* events only
  const teamEvents = events.filter((e) => e.type.startsWith('team.'));

  // No team events → nothing to validate
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

  // ─── Sequential validation ───────────────────────────────────────────────

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
        // Rule 1: team.spawned must appear before any team.task.planned
        if (!hasSpawned) {
          violations.push(
            `VIOLATION: team.task.planned (seq ${seq}) appeared before team.spawned`,
          );
        }

        // Rule 4: nothing after team.disbanded
        if (hasDisbanded) {
          violations.push(
            `VIOLATION: team.task.planned (seq ${seq}) appeared after team.disbanded (seq ${disbandedSequence})`,
          );
        }

        // Track planned task IDs — support both single taskId and batched taskIds[]
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
        // Rule 1: team.spawned must appear before dispatch
        if (!hasSpawned) {
          violations.push(
            `VIOLATION: team.teammate.dispatched (seq ${seq}) appeared before team.spawned`,
          );
        }

        // Rule 2: team.task.planned must appear before any team.teammate.dispatched
        if (!hasPlanned) {
          violations.push(
            `VIOLATION: team.teammate.dispatched (seq ${seq}) appeared before any team.task.planned`,
          );
        }

        // Rule 4: nothing after team.disbanded
        if (hasDisbanded) {
          violations.push(
            `VIOLATION: team.teammate.dispatched (seq ${seq}) appeared after team.disbanded (seq ${disbandedSequence})`,
          );
        }

        // Track dispatched task IDs
        if (event.data?.assignedTaskIds && Array.isArray(event.data.assignedTaskIds)) {
          for (const tid of event.data.assignedTaskIds) {
            dispatchedTaskIds.push(tid);
          }
        }
        break;

      case 'team.disbanded':
        hasDisbanded = true;
        disbandedSequence = seq;
        break;

      default:
        // Other team.* events — check disbanded constraint
        if (hasDisbanded) {
          violations.push(
            `VIOLATION: ${event.type} (seq ${seq}) appeared after team.disbanded (seq ${disbandedSequence})`,
          );
        }
        break;
    }
  }

  // ─── Rule 3: All dispatched task IDs must have been planned ──────────────

  for (const dispatched of dispatchedTaskIds) {
    if (!plannedTaskIds.has(dispatched)) {
      violations.push(
        `VIOLATION: Dispatched task '${dispatched}' was never planned (no team.task.planned event with this taskId)`,
      );
    }
  }

  // ─── Build result ────────────────────────────────────────────────────────

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

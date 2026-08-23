// ─── Runbook Handler ─────────────────────────────────────────────────────────
//
// This surface PROJECTS a plan; it never executes one. Registry entries carry
// declarations only — a schema, a description, gate metadata — with no callable
// attached, so there is nothing here to dispatch and no step outcome to react
// to. Whoever reads the projection is the one who runs the steps.
//
// Two modes:
// - List mode (no `id`): returns summary of all runbooks, optionally filtered by phase.
// - Detail mode (`id` provided): returns the full resolved runbook with schemas
//   resolved from the registry at serve-time.
// ────────────────────────────────────────────────────────────────────────────

import { zodToJsonSchema } from '../utils/json-schema.js';
import type { ToolResult } from '../format.js';
import { findActionInRegistry } from '../registry.js';
import { ALL_RUNBOOKS } from './definitions.js';
import type { ResolvedRunbookStep } from './types.js';

interface RunbookArgs {
  readonly phase?: string;
  readonly id?: string;
}

const FAILURE_POLICIES: ReadonlySet<string> = new Set(['stop', 'continue']);

// Stated once per runbook rather than repeated on every step. Without it the
// projected `onFail` values read as enforcement the projector does not perform,
// which is how a chain ordering came to be described as a guarantee.
const ON_FAIL_CONTRACT =
  "Advisory. These steps are a plan for you to run — Exarchos projects them and never dispatches one, so no step is halted on your behalf. A step's onFail tells you what to do if that step fails: 'stop' means run none of the steps after it, 'continue' means carry on.";

/**
 * Handles the `runbook` action on exarchos_orchestrate.
 *
 * List mode: returns `{ id, phase, description, stepCount }` for each runbook.
 * Detail mode: returns a fully resolved runbook with schemas from the registry.
 */
export async function handleRunbook(args: RunbookArgs): Promise<ToolResult> {
  // ─── List mode ────────────────────────────────────────────────────────
  if (!args.id) {
    let runbooks = ALL_RUNBOOKS;
    if (args.phase) {
      runbooks = runbooks.filter(r => r.phase === args.phase);
    }

    return {
      success: true,
      data: runbooks.map(r => ({
        id: r.id,
        phase: r.phase,
        description: r.description,
        stepCount: r.steps.length,
      })),
    };
  }

  // ─── Detail mode ──────────────────────────────────────────────────────
  const runbook = ALL_RUNBOOKS.find(r => r.id === args.id);
  if (!runbook) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_RUNBOOK',
        message: `Unknown runbook id: '${args.id}'`,
        validTargets: ALL_RUNBOOKS.map(r => r.id),
      },
    };
  }

  const resolvedSteps: ResolvedRunbookStep[] = [];
  for (let index = 0; index < runbook.steps.length; index++) {
    const step = runbook.steps[index];
    if (step === undefined) continue;

    // The union already rejects an unknown policy in `definitions.ts`, which
    // the compiler checks. This catches one that arrives past a cast, and is
    // the only form of the rule a test can observe.
    if (!FAILURE_POLICIES.has(step.onFail)) {
      return {
        success: false,
        error: {
          code: 'INVALID_FAILURE_POLICY',
          message: `Step ${index + 1} of runbook '${runbook.id}' declares onFail '${String(step.onFail)}'; only 'stop' and 'continue' exist`,
        },
      };
    }

    const isNative = step.tool.startsWith('native:');
    const isDecision = step.tool === 'none';

    let schema: unknown = null;
    let description: string | undefined;
    let gate: { readonly blocking: boolean; readonly dimension?: string } | null = null;

    if (!isNative && !isDecision) {
      const action = findActionInRegistry(step.tool, step.action);
      if (action) {
        schema = zodToJsonSchema(action.schema);
        description = action.description;
        gate = action.gate ?? null;
      } else {
        return {
          success: false,
          error: {
            code: 'UNRESOLVED_STEP',
            message: `Step ${index + 1} references unregistered action '${step.action}' on tool '${step.tool}' in runbook '${runbook.id}'`,
          },
        };
      }
    }

    if (isDecision) {
      description = step.decide?.question;
    }

    const agentName = isNative
      ? (step.params as Record<string, unknown> | undefined)?.agent
      : undefined;

    resolvedSteps.push({
      seq: index + 1,
      tool: step.tool,
      action: step.action,
      onFail: step.onFail,
      ...(step.params !== undefined ? { params: step.params } : {}),
      ...(step.note !== undefined ? { note: step.note } : {}),
      schema,
      description,
      gate,
      ...(typeof agentName === 'string'
        ? {
            platformHint: {
              claudeCode: `Uses native agent definition exarchos-${agentName}`,
              generic: `Call agent_spec("${agentName}") to get system prompt and tool restrictions`,
            },
          }
        : {}),
      ...(step.decide !== undefined ? { decide: step.decide } : {}),
    });
  }

  return {
    success: true,
    data: {
      id: runbook.id,
      phase: runbook.phase,
      description: runbook.description,
      onFailContract: ON_FAIL_CONTRACT,
      templateVars: runbook.templateVars,
      autoEmits: runbook.autoEmits,
      steps: resolvedSteps,
    },
  };
}

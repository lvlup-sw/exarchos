// ─── The intent compiler ────────────────────────────────────────────────────
//
// Runbooks stay pure data. This module is the only thing that reads one as
// something to EXECUTE, and it refuses anything it cannot close over: a step
// naming an agent-side tool, a decision point the model owes an answer to, an
// action no registry declares, or one whose authority is not local.
//
// Every refusal here happens before the first effect. That ordering is the
// whole point of separating compilation from execution — a segment that cannot
// finish is one that never starts.
//
// The registry is reached through the published root module rather than the
// declaration directory: the verb layer is allowed the shared root surface and
// not the registry's internals, and the seam census reads the difference.

import type { z } from 'zod';

import { findActionInRegistry, type ActionContract, type ToolAction } from '../../registry.js';
import { ALL_RUNBOOKS } from '../../runbooks/definitions.js';
import type { RunbookDefinition, RunbookStep } from '../../runbooks/types.js';
import { INTENT_ARG_SCHEMAS, type IntentArgSchemas } from './arg-schemas.js';
import type { CompiledLeaf, CompileOutcome, CompileRefusal } from './types.js';

/** The compiler's injected collaborators. Production defaults below. */
export interface CompileDeps {
  readonly runbookTable: readonly RunbookDefinition[];
  readonly findAction: (tool: string, action: string) => ToolAction | undefined;
  readonly argSchemas: IntentArgSchemas;
}

export const PRODUCTION_COMPILE_DEPS: CompileDeps = {
  runbookTable: ALL_RUNBOOKS,
  findAction: findActionInRegistry,
  argSchemas: INTENT_ARG_SCHEMAS,
};

/** Subject identity: one stream, spelled `featureId` or `streamId` per leaf. */
export interface IntentSubject {
  readonly streamId: string;
}

const PLACEHOLDER = /^<([A-Za-z0-9_]+)>$/;

function refuse(refusal: CompileRefusal): CompileOutcome {
  return { ok: false, refusal };
}

/**
 * Resolve a step's static params against the validated intent arguments.
 *
 * A `<var>` placeholder becomes the TYPED value the intent schema produced, so
 * a boolean stays a boolean rather than arriving at the leaf as the string it
 * was spelled with in the runbook. A placeholder with nothing to bind to drops
 * out entirely: leaving it in would hand the leaf's schema a literal `<var>`
 * where it expects a value. Every other literal — `'auto'` above all — passes
 * through untouched, because the runbook meant it.
 */
function resolveParams(
  params: Readonly<Record<string, unknown>> | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string') {
      const match = PLACEHOLDER.exec(value);
      if (match !== null) {
        const bound = args[match[1] as string];
        if (bound !== undefined) resolved[key] = bound;
        continue;
      }
    }
    resolved[key] = value;
  }
  return resolved;
}

/**
 * Build one leaf's arguments and hand them to the leaf's OWN registered schema.
 *
 * Runbook params are partial by design — `task_complete`'s step carries none at
 * all while its schema needs a task and a stream — so the candidate is
 * assembled from three sources and then validated by the action itself. Running
 * the action's schema here is what restores the validation chokepoint the
 * dispatch layer would otherwise be the only holder of.
 */
function buildLeafArgs(
  step: RunbookStep,
  declaration: ToolAction,
  subject: IntentSubject,
  args: Record<string, unknown>,
): { readonly ok: true; readonly args: Record<string, unknown> } | { readonly ok: false; readonly detail: string } {
  const shape: z.ZodRawShape = declaration.schema.shape;
  const declaredKeys = new Set(Object.keys(shape));
  const candidate: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && declaredKeys.has(key)) candidate[key] = value;
  }
  if (declaredKeys.has('featureId')) candidate.featureId = subject.streamId;
  if (declaredKeys.has('streamId')) candidate.streamId = subject.streamId;
  Object.assign(candidate, resolveParams(step.params, args));

  const parsed = declaration.schema.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return { ok: false, detail };
  }
  return { ok: true, args: parsed.data as Record<string, unknown> };
}

function contractOf(declaration: ToolAction): ActionContract | undefined {
  return declaration.actionContract;
}

/**
 * Compile a named intent into an executable segment, or refuse.
 *
 * @param intent      Runbook id the caller named.
 * @param subject     The stream every leaf addresses.
 * @param rawArgs     Caller arguments, before the intent's typed schema sees them.
 */
export function compileIntent(
  intent: string,
  subject: IntentSubject,
  rawArgs: Record<string, unknown>,
  deps: CompileDeps = PRODUCTION_COMPILE_DEPS,
): CompileOutcome {
  const runbook = deps.runbookTable.find((entry) => entry.id === intent);
  if (runbook === undefined) {
    return refuse({
      code: 'INTENT_UNKNOWN',
      message: `no runbook declares the intent '${intent}'`,
    });
  }

  const argSchema = deps.argSchemas[intent];
  if (argSchema === undefined) {
    return refuse({
      code: 'INTENT_NOT_COMPILABLE',
      message:
        `the intent '${intent}' has no registered argument schema, so it cannot be ` +
        'compiled into an executable segment',
    });
  }

  const parsedArgs = argSchema.safeParse(rawArgs);
  if (!parsedArgs.success) {
    const detail = parsedArgs.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return refuse({
      code: 'INTENT_ARGS_INVALID',
      message: `args did not satisfy the '${intent}' argument schema (${detail})`,
    });
  }
  const args = parsedArgs.data as Record<string, unknown>;

  const leaves: CompiledLeaf[] = [];
  for (const [index, step] of runbook.steps.entries()) {
    const where = `${index}:${step.action}`;

    if (step.tool === 'none' || step.decide !== undefined) {
      return refuse({
        code: 'INTENT_HOST_OBLIGATION',
        step: where,
        message:
          `step ${where} of '${intent}' is a decision point, not a call. The choice is the ` +
          'host or model obligation; the executor will not make it on their behalf.',
      });
    }
    if (step.tool.startsWith('native:')) {
      return refuse({
        code: 'INTENT_NOT_CLOSED',
        step: where,
        message:
          `step ${where} of '${intent}' names the agent-side tool '${step.tool}'. The segment ` +
          'is not closed over actions this process can execute.',
      });
    }
    if (step.onFail === 'retry') {
      return refuse({
        code: 'INTENT_RETRY_UNSUPPORTED',
        step: where,
        message: `step ${where} of '${intent}' asks for retry-on-failure, which the executor does not implement`,
      });
    }

    const declaration = deps.findAction(step.tool, step.action);
    if (declaration === undefined) {
      return refuse({
        code: 'INTENT_ACTION_UNREGISTERED',
        step: where,
        message: `step ${where} of '${intent}' names '${step.tool}.${step.action}', which no registered tool declares`,
      });
    }

    const contract = contractOf(declaration);
    if (contract === undefined || contract.executionAuthority.kind !== 'local') {
      return refuse({
        code: 'INTENT_ACTION_NOT_LOCAL',
        step: where,
        message:
          `step ${where} of '${intent}' names '${step.tool}.${step.action}', whose execution ` +
          'authority is not local — the executor may only invoke locally-authoritative actions',
      });
    }

    const built = buildLeafArgs(step, declaration, subject, args);
    if (!built.ok) {
      return refuse({
        code: 'INTENT_LEAF_ARGS_INVALID',
        step: where,
        message:
          `arguments built for step ${where} of '${intent}' were rejected by ` +
          `'${step.tool}.${step.action}' (${built.detail})`,
      });
    }

    leaves.push({
      index,
      tool: step.tool,
      action: step.action,
      onFail: step.onFail,
      args: built.args,
      declaration,
      contract,
    });
  }

  return {
    ok: true,
    segment: { intent, streamId: subject.streamId, args, leaves },
  };
}

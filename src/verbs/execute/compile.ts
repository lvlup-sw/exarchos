/**
 * The intent compiler. Runbooks stay pure data, and this module reads one as a segment to execute.
 *
 * It refuses each step that it cannot close over. Examples are a decision point, an agent-side
 * tool, an unregistered action, an action without local authority, and a missing handler. Each
 * refusal happens before the first effect, so a segment that cannot finish never starts.
 *
 * The verb layer can use the shared root surface but not the internals of the registry. This
 * module thus imports the registry from the root module, and the seam census reads the difference.
 */

import type { z } from 'zod';

import { observationStreamId } from '../../dispatch/core/interceptors/emission-verifier.js';
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
  /**
   * The table that invokes the leaves, keyed by bare action name. A caller that only inspects a
   * segment needs no table. When the table is present, compilation refuses a step that the table
   * cannot invoke, before any leaf runs. This module only reads which keys are present.
   */
  readonly handlers?: Readonly<Record<string, unknown>>;
  /**
   * The tool that owns `handlers`. Bare action-name keys cannot show which tool minted them.
   * Without an owner, a step on another tool with a colliding action name runs the wrong handler
   * under the wrong contract. It must be present when `handlers` is present.
   */
  readonly handlerTool?: string;
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

interface UnboundVar {
  /** The runbook parameter whose value was the placeholder. */
  readonly param: string;
  /** The template variable name inside the placeholder. */
  readonly variable: string;
}

type ResolvedParams =
  | { readonly ok: true; readonly params: Record<string, unknown> }
  | { readonly ok: false; readonly unbound: UnboundVar };

/**
 * Resolves the static params of a step against the validated intent arguments.
 *
 * A `<var>` placeholder becomes the typed value from the intent schema, so a boolean stays a
 * boolean. Every other literal, `'auto'` included, passes through unchanged.
 *
 * A placeholder with no bound value is refused, not dropped, because a runbook that names a
 * variable in a step requires it. A dropped value lets a gate that routes on the risk tier run
 * without a tier.
 */
function resolveParams(
  params: Readonly<Record<string, unknown>> | undefined,
  args: Record<string, unknown>,
): ResolvedParams {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string') {
      const match = PLACEHOLDER.exec(value);
      if (match !== null) {
        const variable = value.slice(1, -1);
        const bound = args[variable];
        if (bound === undefined) return { ok: false, unbound: { param: key, variable } };
        resolved[key] = bound;
        continue;
      }
    }
    resolved[key] = value;
  }
  return { ok: true, params: resolved };
}

/**
 * Builds the arguments of one leaf and validates them with the registered schema of that leaf.
 *
 * Runbook params are partial by design. The `task_complete` step has no params, but its schema
 * needs a task and a stream. The candidate thus merges the declared intent arguments, the
 * resolved step params, and the subject identity.
 *
 * The subject identity goes in last, so it overrides a step param or argument with the same name.
 * Otherwise the leaf can commit to one stream while the emission check watches another.
 */
function buildLeafArgs(
  step: RunbookStep,
  declaration: ToolAction,
  subject: IntentSubject,
  args: Record<string, unknown>,
):
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly detail: string }
  | { readonly ok: false; readonly unbound: UnboundVar } {
  const shape: z.ZodRawShape = declaration.schema.shape;
  const declaredKeys = new Set(Object.keys(shape));
  const candidate: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && declaredKeys.has(key)) candidate[key] = value;
  }
  const resolved = resolveParams(step.params, args);
  if (!resolved.ok) return { ok: false, unbound: resolved.unbound };
  Object.assign(candidate, resolved.params);

  if (declaredKeys.has('featureId')) candidate.featureId = subject.streamId;
  if (declaredKeys.has('streamId')) candidate.streamId = subject.streamId;

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
 * Compiles a named intent into an executable segment, or refuses.
 *
 * A registered local action is not always invokable. When `handlers` is present, compilation
 * fails closed unless `handlerTool` names the owner and matches the tool of the step. Each leaf
 * resolves its observation stream with the same function as the dispatch path. The fallback is
 * the subject stream.
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

    if (deps.handlers !== undefined) {
      if (deps.handlerTool === undefined) {
        return refuse({
          code: 'INTENT_HANDLER_TABLE_UNOWNED',
          step: where,
          message:
            `step ${where} of '${intent}' would be checked against a handler table, but the ` +
            'compile deps name no tool that table belongs to. A table with no declared owner ' +
            'cannot be trusted to belong to the tool a step names, so compilation refuses rather ' +
            'than assuming it does.',
        });
      }
      if (step.tool !== deps.handlerTool) {
        return refuse({
          code: 'INTENT_HANDLER_TOOL_MISMATCH',
          step: where,
          message:
            `step ${where} of '${intent}' names tool '${step.tool}', but the injected handler ` +
            `table belongs to '${deps.handlerTool}'. An action name that happens to match one in ` +
            "that table would resolve this step's declaration correctly and then invoke the " +
            "wrong tool's handler for it — refused before that can happen.",
        });
      }
    }
    if (deps.handlers !== undefined && !(step.action in deps.handlers)) {
      return refuse({
        code: 'INTENT_NOT_CLOSED',
        step: where,
        message:
          `step ${where} of '${intent}' names '${step.tool}.${step.action}', which no handler ` +
          'in the executor table can invoke. The segment is not closed over actions this ' +
          'process can execute.',
      });
    }

    const built = buildLeafArgs(step, declaration, subject, args);
    if (!built.ok && 'unbound' in built) {
      return refuse({
        code: 'INTENT_TEMPLATE_VAR_UNBOUND',
        step: where,
        message:
          `step ${where} of '${intent}' passes '<${built.unbound.variable}>' as ` +
          `'${built.unbound.param}', and the validated args carry no ` +
          `'${built.unbound.variable}'. A runbook that names a variable in a step ` +
          'requires it: supply it, or the leaf would run without the value the ' +
          'step exists to hand it.',
      });
    }
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
      observationStreamId: observationStreamId(built.args, contract) ?? subject.streamId,
      declaration,
      contract,
    });
  }

  return {
    ok: true,
    segment: { intent, streamId: subject.streamId, args, leaves },
  };
}

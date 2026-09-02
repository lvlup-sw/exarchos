// ─── The intent compiler ────────────────────────────────────────────────────
//
// Runbooks stay pure data. This module is the only thing that reads one as
// something to EXECUTE, and it refuses anything it cannot close over: a step
// naming an agent-side tool, a decision point the model owes an answer to, an
// action no registry declares, one whose authority is not local, or one the
// caller's own handler table has no way to invoke.
//
// Every refusal here happens before the first effect. That ordering is the
// whole point of separating compilation from execution — a segment that cannot
// finish is one that never starts.
//
// The registry is reached through the published root module rather than the
// declaration directory: the verb layer is allowed the shared root surface and
// not the registry's internals, and the seam census reads the difference.

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
   * The table the leaves will be invoked through, keyed by bare action name.
   * Optional so a caller compiling to INSPECT a segment need not own one; when
   * it is present, a step naming an action the table cannot invoke is refused
   * here rather than discovered at that leaf's turn — after every leaf before
   * it has already run.
   *
   * Typed as an opaque record because this module only asks whether a key is
   * present. The executor's own handler type narrows it.
   */
  readonly handlers?: Readonly<Record<string, unknown>>;
  /**
   * The tool `handlers` belongs to. A table keyed by bare action name cannot
   * say which tool minted its keys, so a step on a DIFFERENT tool whose
   * action name happens to collide with one in the table would resolve a
   * declaration from its own tool here and then, at that leaf's turn, run the
   * other tool's handler under the wrong contract. Naming the owner turns
   * that collision into a refusal before any effect, instead of a silent
   * misroute discovered only by what ran.
   *
   * Optional for the same reason `handlers` is: a caller compiling only to
   * INSPECT a segment owns no table and names no owner for one.
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
 * Resolve a step's static params against the validated intent arguments.
 *
 * A `<var>` placeholder becomes the TYPED value the intent schema produced, so
 * a boolean stays a boolean rather than arriving at the leaf as the string it
 * was spelled with in the runbook. Every other literal — `'auto'` above all —
 * passes through untouched, because the runbook meant it.
 *
 * A placeholder with nothing to bind to is REFUSED rather than dropped.
 * Dropping it silently made the runbook's own reference to a variable
 * unenforceable: the gate whose routing depends on the risk tier was
 * dispatched with no tier at all, ran tierless, and reported an advisory skip
 * as if adequacy had been assessed. A runbook that names a variable in a step
 * is a runbook that requires it, and the refusal happens before any effect.
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
        // The pattern is anchored at both ends, so the whole param value IS the
        // placeholder and the name is what sits inside the angle brackets.
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

  // Subject identity is written LAST, so it is authoritative over anything a
  // runbook step or an intent argument spells the same way. Written earlier, a
  // step param named `streamId`/`featureId` would overwrite it and the leaf
  // would commit to one stream while the emission check watched another — the
  // exact misdirection the two-spellings refusal upstream exists to prevent.
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

    // Registered and local is not the same as invokable. The leaves run through
    // ONE table — the orchestrate composite's — so a step on another composite
    // tool resolves a declaration here and then finds no handler at its turn.
    // For a segment whose earlier leaves reach a remote, that discovery arrives
    // after an effect it cannot take back.
    //
    // A table's keys alone cannot say which tool minted them, so this asks
    // FIRST whether the table names an owner at all, and fails closed if it
    // does not: an optional owner that a caller could simply omit would leave
    // the fence below silently inert in exactly the callers that must exercise
    // it, rather than refusing to compile.
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
      // Resolved through the SAME function the dispatch path resolves its
      // observation stream with, so a leaf run here and the same action
      // dispatched directly are never checked against different streams. The
      // fallback is the segment's subject: an action that declares no
      // infrastructure stream and carries no subject argument is still a leaf
      // of this segment, and the segment's stream is where its records would
      // have to be.
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

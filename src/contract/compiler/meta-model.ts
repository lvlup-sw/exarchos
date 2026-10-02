/**
 * The typed meta-model that the contract compiler reads, derived from the live `TOOL_REGISTRY`. An
 * entry describes one action: its ActionId, its input and output schemas, its bound error codes
 * and output kinds, and its ten policy dimensions.
 *
 * The Zod schemas are the admission gate of the compiler. An entry with a missing policy field, or
 * a code or kind outside the contract surface, fails in `compile.ts` with a typed diagnostic. The
 * module reads no clock, file, or absolute path, so `deriveMetaModel()` is byte-stable.
 *
 * `registry.ts` is the declaration authority and this module projects it. The running server does
 * not read `compile()` output. A guard that compares this output with `TOOL_REGISTRY` is a
 * tautology. `runtime-authority.ts` audits the model against the shipped runtime surface instead.
 * Read its header before you change a `derive*` function.
 */

import { z } from 'zod';
import {
  ActionContractError,
  normalizeActionContract,
  TOOL_REGISTRY,
  resolveEconomyBudget,
  type ActionContract,
  type CompositeTool,
  type ToolAction,
} from '../../registry.js';
import { zodToJsonSchema } from '../../utils/json-schema.js';
import { CONTRACT_SURFACE_VERSION } from '../compatibility.js';
import { OUTPUT_KINDS } from '../envelope.js';
import { layerCodes } from '../error-families.js';
import { canonicalizeText } from '../authority-digest.js';

/** A projected JSON Schema fragment (draft-2020-12). This module does not read its structure. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The action safety class, the same as the registry `ActionAnnotations.safety`. */
export const ACTION_SAFETY = [
  'read-only',
  'local-mutation',
  'remote-mutation',
  'compensable',
] as const;
export type ActionSafety = (typeof ACTION_SAFETY)[number];

/** The ten policy dimensions every compiled action must declare, in order. */
export const POLICY_DIMENSIONS = [
  'execution',
  'authorization',
  'evidence',
  'effect',
  'cache',
  'task',
  'cancellation',
  'economy',
  'compatibility',
  'presentation',
] as const;
export type PolicyDimension = (typeof POLICY_DIMENSIONS)[number];

const GateSpecSchema = z
  .object({
    blocking: z.boolean(),
    dimension: z.string().nullable(),
    gateClass: z.string().nullable(),
  })
  .strict();

const AutoEmitSpecSchema = z
  .object({
    event: z.string(),
    condition: z.enum(['always', 'conditional']),
  })
  .strict();

const ExecutionPolicySchema = z
  .object({
    longRunning: z.boolean(),
    deprecated: z.boolean(),
    surface: z.literal('worktree').nullable(),
  })
  .strict();

const AuthorizationPolicySchema = z
  .object({
    safety: z.enum(ACTION_SAFETY),
    readOnly: z.boolean(),
    destructive: z.boolean(),
    idempotent: z.boolean(),
    openWorld: z.boolean(),
    posture: z.string().nullable(),
    roles: z.array(z.string()),
    phases: z.array(z.string()),
    gate: GateSpecSchema.nullable(),
  })
  .strict();

const EvidencePolicySchema = z
  .object({
    autoEmits: z.array(AutoEmitSpecSchema),
  })
  .strict();

const EffectPolicySchema = z
  .object({
    mutates: z.boolean(),
    compensable: z.boolean(),
    openWorld: z.boolean(),
  })
  .strict();

const CachePolicySchema = z
  .object({
    cacheable: z.boolean(),
  })
  .strict();

const TaskPolicySchema = z
  .object({
    taskAugmentable: z.boolean(),
    ttlSuggestionMs: z.number().nullable(),
  })
  .strict();

const CancellationPolicySchema = z
  .object({
    cancellable: z.boolean(),
    idempotentReplay: z.boolean(),
  })
  .strict();

const EconomyPolicySchema = z
  .object({
    budgetTokens: z.number(),
    compactByDefault: z.boolean(),
  })
  .strict();

const CompatibilityPolicySchema = z
  .object({
    surfaceVersion: z.string(),
    deprecated: z.boolean(),
  })
  .strict();

const PresentationPolicySchema = z
  .object({
    cliAlias: z.string().nullable(),
    cliGroup: z.string().nullable(),
    cliFormat: z.enum(['table', 'json', 'tree']).nullable(),
    topLevel: z.string().nullable(),
    compactByDefault: z.boolean(),
  })
  .strict();

function admitActionContract(value: unknown): ActionContract {
  return normalizeActionContract(value);
}

function actionContractIssueMessage(error: unknown): string {
  return error instanceof ActionContractError ? `${error.code}: ${error.message}` : 'invalid action contract';
}

/**
 * The admission schema for a declared action contract. It uses the registry normalizer and its
 * emission catalog, so this module has no second catalog. Nested sets come out canonical.
 */
export const ActionContractModelSchema: z.ZodType<ActionContract> = z.unknown().transform((value, ctx) => {
  try {
    return admitActionContract(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: actionContractIssueMessage(error) });
    return z.NEVER;
  }
});

/** The total policy record. All ten dimensions are required. */
export const ActionPolicySchema = z
  .object({
    execution: ExecutionPolicySchema,
    authorization: AuthorizationPolicySchema,
    evidence: EvidencePolicySchema,
    effect: EffectPolicySchema,
    cache: CachePolicySchema,
    task: TaskPolicySchema,
    cancellation: CancellationPolicySchema,
    economy: EconomyPolicySchema,
    compatibility: CompatibilityPolicySchema,
    presentation: PresentationPolicySchema,
    actionContract: ActionContractModelSchema.optional(),
  })
  .strict();

/** A JSON Schema fragment: any object. Surface-compatibility is checked in `compile`. */
const JsonSchemaSchema = z.record(z.string(), z.unknown());

/** One action's full meta-model entry. */
export const ActionMetaModelSchema = z
  .object({
    actionId: z.string(),
    tool: z.string(),
    action: z.string(),
    description: z.string(),
    surfaceVersion: z.string(),
    inputSchema: JsonSchemaSchema,
    outputSchema: JsonSchemaSchema,
    errorCodes: z.array(z.string()),
    outputKinds: z.array(z.string()),
    policy: ActionPolicySchema,
    actionContract: ActionContractModelSchema.optional(),
  })
  .strict();

/** The whole compiler input: a surface version and a set of action entries. */
export const MetaModelSchema = z
  .object({
    surfaceVersion: z.string(),
    actions: z.array(ActionMetaModelSchema),
  })
  .strict();

export type GateSpec = z.infer<typeof GateSpecSchema>;
export type AutoEmitSpec = z.infer<typeof AutoEmitSpecSchema>;
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;
export type AuthorizationPolicy = z.infer<typeof AuthorizationPolicySchema>;
export type EvidencePolicy = z.infer<typeof EvidencePolicySchema>;
export type EffectPolicy = z.infer<typeof EffectPolicySchema>;
export type CachePolicy = z.infer<typeof CachePolicySchema>;
export type TaskPolicy = z.infer<typeof TaskPolicySchema>;
export type CancellationPolicy = z.infer<typeof CancellationPolicySchema>;
export type EconomyPolicy = z.infer<typeof EconomyPolicySchema>;
export type CompatibilityPolicy = z.infer<typeof CompatibilityPolicySchema>;
export type PresentationPolicy = z.infer<typeof PresentationPolicySchema>;
export type ActionPolicy = z.infer<typeof ActionPolicySchema>;
export type ActionMetaModel = z.infer<typeof ActionMetaModelSchema>;
export type MetaModel = z.infer<typeof MetaModelSchema>;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Remove duplicates from a list of strings and sort it. */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(byString);
}

function readDeclaredActionContract(action: ToolAction): unknown {
  if (!('actionContract' in action)) return undefined;
  return Reflect.get(action, 'actionContract');
}

/**
 * Project a declared registry contract into the compiler model. A missing contract stays missing.
 * Annotations and top-level `autoEmits` do not create one.
 */
export function projectActionContract(action: ToolAction): ActionContract | undefined {
  const declared = readDeclaredActionContract(action);
  if (declared === undefined) return undefined;
  return normalizeActionContract(declared, { annotations: action.annotations });
}

function evidenceFromContract(contract: ActionContract): EvidencePolicy {
  if (contract.emissions.kind === 'none') return { autoEmits: [] };
  const autoEmits = contract.emissions.values
    .map((emission) => ({ event: emission.event, condition: emission.condition }))
    .sort((left, right) => byString(left.event, right.event) || byString(left.condition, right.condition));
  return { autoEmits };
}

/**
 * The stable error codes that an action is bound to. Each action gets the protocol, authorization,
 * handler, output, and presenter families. The task-layer codes are added only when the action is
 * task-suitable or long-running.
 */
export function deriveErrorCodes(action: ToolAction): string[] {
  const codes: string[] = [
    ...layerCodes('protocol'),
    ...layerCodes('authorization'),
    ...layerCodes('handler'),
    ...layerCodes('output'),
    ...layerCodes('presenter'),
  ];
  const taskBound = action.dispatch?.taskSuitable === true || action.longRunning === true;
  if (taskBound) codes.push(...layerCodes('task'));
  return sortedUnique(codes);
}

function deriveExecutionPolicy(action: ToolAction): ExecutionPolicy {
  return {
    longRunning: action.longRunning ?? false,
    deprecated: action.deprecated ?? false,
    surface: action.surface ?? null,
  };
}

function deriveAuthorizationPolicy(action: ToolAction): AuthorizationPolicy {
  const a = action.annotations;
  return {
    safety: a.safety,
    readOnly: a.readOnly,
    destructive: a.destructive,
    idempotent: a.idempotent,
    openWorld: a.openWorld,
    posture: action.posture ?? null,
    roles: [...action.roles].sort(byString),
    phases: [...action.phases].sort(byString),
    gate: action.gate
      ? {
          blocking: action.gate.blocking,
          dimension: action.gate.dimension ?? null,
          gateClass: action.gate.gateClass ?? null,
        }
      : null,
  };
}

function deriveEvidencePolicy(
  _action: ToolAction,
  contract: ActionContract | undefined,
): EvidencePolicy {
  if (contract !== undefined) return evidenceFromContract(contract);
  return { autoEmits: [] };
}

function deriveEffectPolicy(action: ToolAction): EffectPolicy {
  const a = action.annotations;
  return {
    mutates: !a.readOnly,
    compensable: a.safety === 'compensable',
    openWorld: a.openWorld,
  };
}

function deriveCachePolicy(action: ToolAction): CachePolicy {
  const a = action.annotations;
  return { cacheable: a.readOnly && a.idempotent };
}

function deriveTaskPolicy(action: ToolAction): TaskPolicy {
  return {
    taskAugmentable: action.dispatch?.taskSuitable ?? false,
    ttlSuggestionMs: action.dispatch?.taskTtlSuggestionMs ?? null,
  };
}

function deriveCancellationPolicy(action: ToolAction): CancellationPolicy {
  const cancellable = (action.longRunning ?? false) || (action.dispatch?.taskSuitable ?? false);
  return { cancellable, idempotentReplay: action.annotations.idempotent };
}

function deriveEconomyPolicy(action: ToolAction): EconomyPolicy {
  return {
    budgetTokens: resolveEconomyBudget(action),
    compactByDefault: action.economy?.compactByDefault ?? false,
  };
}

function deriveCompatibilityPolicy(action: ToolAction): CompatibilityPolicy {
  return {
    surfaceVersion: CONTRACT_SURFACE_VERSION,
    deprecated: action.deprecated ?? false,
  };
}

function derivePresentationPolicy(action: ToolAction): PresentationPolicy {
  return {
    cliAlias: action.cli?.alias ?? null,
    cliGroup: action.cli?.group ?? null,
    cliFormat: action.cli?.format ?? null,
    topLevel: action.cli?.topLevel ?? null,
    compactByDefault: action.economy?.compactByDefault ?? false,
  };
}

/** Derive the total ten-dimension policy record for one action. */
export function derivePolicy(action: ToolAction): ActionPolicy {
  const actionContract = projectActionContract(action);
  return {
    execution: deriveExecutionPolicy(action),
    authorization: deriveAuthorizationPolicy(action),
    evidence: deriveEvidencePolicy(action, actionContract),
    effect: deriveEffectPolicy(action),
    cache: deriveCachePolicy(action),
    task: deriveTaskPolicy(action),
    cancellation: deriveCancellationPolicy(action),
    economy: deriveEconomyPolicy(action),
    compatibility: deriveCompatibilityPolicy(action),
    presentation: derivePresentationPolicy(action),
    ...(actionContract === undefined ? {} : { actionContract }),
  };
}

/**
 * Call `derivePolicy` and add the ActionId to an `ActionContractError`. `derivePolicy` sees only
 * the bare `ToolAction`, so its error names no action. `admitActionContract` in
 * `registry/annotations.ts` wraps the error the same way at registration.
 */
function derivePolicyNamingAction(actionId: string, action: ToolAction): ActionPolicy {
  try {
    return derivePolicy(action);
  } catch (error) {
    if (error instanceof ActionContractError) {
      throw new ActionContractError(error.code, `Action '${actionId}' has invalid actionContract: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Derive the meta-model entry of one action from its registry descriptor. The description gets
 * normalized line endings, so CRLF and LF checkouts derive the same bytes.
 */
export function deriveActionMetaModel(tool: CompositeTool, action: ToolAction): ActionMetaModel {
  const actionId = `${tool.name}.${action.name}`;
  const policy = derivePolicyNamingAction(actionId, action);
  return {
    actionId,
    tool: tool.name,
    action: action.name,
    description: canonicalizeText(action.description),
    surfaceVersion: CONTRACT_SURFACE_VERSION,
    inputSchema: zodToJsonSchema(action.schema) as JsonSchema,
    outputSchema: zodToJsonSchema(action.outputSchema) as JsonSchema,
    errorCodes: deriveErrorCodes(action),
    outputKinds: [...OUTPUT_KINDS].sort(byString),
    policy,
    ...(policy.actionContract === undefined ? {} : { actionContract: policy.actionContract }),
  };
}

/** Derive the whole meta-model from the live `TOOL_REGISTRY` or a supplied registry, sorted by ActionId. */
export function deriveMetaModel(
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): MetaModel {
  const actions: ActionMetaModel[] = [];
  for (const tool of registry) {
    for (const action of tool.actions) {
      actions.push(deriveActionMetaModel(tool, action));
    }
  }
  actions.sort((a, b) => byString(a.actionId, b.actionId));
  return { surfaceVersion: CONTRACT_SURFACE_VERSION, actions };
}

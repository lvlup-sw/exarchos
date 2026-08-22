// ─── Contract meta-model (P03-03) ────────────────────────────────────────────
//
// PROGRAM-03, API-003. The typed meta-model the contract COMPILER consumes.
// One deterministic generation pipeline (design authority: "shared workflow
// semantics and Exarchos product semantics are separate authoritative inputs to
// one deterministic generation pipeline") — this module is that pipeline's
// INPUT model, DERIVED from the live `TOOL_REGISTRY` rather than hand-duplicated.
//
// A meta-model entry is a total description of ONE Exarchos action:
//   • its stable ActionId (`<tool>.<action>`),
//   • its input JSON schema + its output/error/capped carrier schemas
//     (projected from the registry + the P03-02 closed contract surface),
//   • the stable error codes and output kinds it is bound to (⊆ the frozen
//     `contract-surface`), and
//   • its ten POLICY dimensions — execution / authorization / evidence / effect
//     / cache / task / cancellation / economy / compatibility / presentation.
//
// The Zod schemas here are the compiler's admission gate: a hand-built meta-
// model missing a required policy field, or carrying an error code / output
// kind / surface version that is not part of the declared contract surface,
// fails compilation with a typed diagnostic (`compile.ts`) rather than silently
// emitting a partial descriptor.
//
// This module is PURE apart from reading the in-memory `TOOL_REGISTRY`; it holds
// no clock, no filesystem, and no absolute paths, so `deriveMetaModel()` is
// byte-stable across machines and runs.
//
// AUTHORITY DIRECTION (DR-11 / T-16). `registry.ts` is the DECLARATION
// authority; this module is a PROJECTION of it, and the running server does not
// consume `compile()` output. That means a guard comparing this module's output
// back against `TOOL_REGISTRY` the way it was derived from `TOOL_REGISTRY` is a
// tautology and cannot see a wrong projection here. The guard that can is
// `runtime-authority.ts`, which audits the derived model against the SHIPPED
// runtime surface (`buildRegistrationSchema` / `buildToolDescription` /
// `handleDescribe`) — read that file's header for exactly what it does and does
// not catch before adding or changing a `derive*` function below.
// ────────────────────────────────────────────────────────────────────────────

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

// ─── Shared primitives ───────────────────────────────────────────────────────

/** A projected JSON Schema fragment (draft-2020-12). Structure is opaque here. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The action safety class (mirrors the registry `ActionAnnotations.safety`). */
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

// ─── Policy Zod schemas (the admission gate) ─────────────────────────────────

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
 * Admission schema for a declared action contract. Validation reuses the
 * registry algebra (including the existing emission catalog) so this module
 * does not author a second catalog. Nested sets are canonicalized.
 */
export const ActionContractModelSchema: z.ZodType<ActionContract> = z.unknown().transform((value, ctx) => {
  try {
    return admitActionContract(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: actionContractIssueMessage(error) });
    return z.NEVER;
  }
});

/** The total policy record — every one of the ten dimensions is required. */
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

/** The whole compiler input: a surface version + a set of action entries. */
export const MetaModelSchema = z
  .object({
    surfaceVersion: z.string(),
    actions: z.array(ActionMetaModelSchema),
  })
  .strict();

// ─── Inferred types ──────────────────────────────────────────────────────────

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

// ─── Deterministic sorting helpers ───────────────────────────────────────────

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Dedupe + sort a list of strings (order-independent, byte-stable). */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(byString);
}

function readDeclaredActionContract(action: ToolAction): unknown {
  if (!('actionContract' in action)) return undefined;
  return Reflect.get(action, 'actionContract');
}

/**
 * Project a declared registry contract into the compiler model.
 * Missing live contracts stay missing — annotations and top-level `autoEmits`
 * are not an independent source for inventing one.
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

// ─── Derivation from the live registry ───────────────────────────────────────

/**
 * The stable error codes an action is BOUND to. Every action can surface the
 * protocol / authorization / handler / output / presenter families; the durable
 * TASK-layer codes (`WAIT_TIMEOUT`, `IDEMPOTENCY_*`, …) are reachable ONLY when
 * the action is task-augmentable or long-running. This ties the action's `task`
 * policy to its error surface rather than asserting a flat, identical set for
 * every action — a task-suitable action's contract legitimately spans more codes.
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

function deriveEvidencePolicy(action: ToolAction, contract: ActionContract | undefined): EvidencePolicy {
  if (contract !== undefined) return evidenceFromContract(contract);
  const autoEmits = (action.autoEmits ?? [])
    .map((e) => ({ event: e.event, condition: e.condition }))
    .sort((x, y) => byString(x.event, y.event) || byString(x.condition, y.condition));
  return { autoEmits };
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

/** Derive the total, ten-dimension policy record for one action. */
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

/** Derive one action's meta-model entry from its registry descriptor. */
export function deriveActionMetaModel(tool: CompositeTool, action: ToolAction): ActionMetaModel {
  const policy = derivePolicy(action);
  return {
    actionId: `${tool.name}.${action.name}`,
    tool: tool.name,
    action: action.name,
    // Line-ending-normalized so a CRLF working tree and an LF CI checkout
    // derive a byte-identical meta-model (mirrors `canonicalizeText` in the
    // P03-01 digest layer).
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

/**
 * Derive the whole meta-model from the live `TOOL_REGISTRY` (or an injected
 * registry). Deterministic: actions are sorted by ActionId, every set is
 * sorted, and no clock/path/locale leaks in — so `deriveMetaModel()` is
 * byte-stable across machines.
 */
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

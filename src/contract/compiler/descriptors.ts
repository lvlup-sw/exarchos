/**
 * Compiles a validated meta-model entry into a deterministic runtime descriptor. The MCP bindings,
 * the CLI client, and the oracle read these descriptors. A descriptor `digest` is a `sha256:` over
 * its canonical JSON.
 *
 * The bundle projects the shared carrier schemas once into its `surface` map. Each descriptor
 * refers to them by a stable key, so the contract holds one copy of the envelope shape.
 * `canonicalJson` sets the key order, and no clock, absolute path, or locale goes into the output.
 */

import { z } from 'zod';
import { digestText } from '../authority-digest.js';
import { canonicalJson } from '../request-context.js';
import { zodToJsonSchema } from '../../utils/json-schema.js';
import { ErrorEnvelopeSchema, CappedDataSchema, SuccessEnvelopeSchema } from '../envelope.js';
import type { ActionMetaModel, ActionPolicy, JsonSchema } from './meta-model.js';

/** The stable keys of the shared carrier schemas in the bundle `surface` map. */
export const SURFACE_ERROR_SCHEMA_REF = 'surface:error-envelope';
export const SURFACE_CAPPED_SCHEMA_REF = 'surface:capped-data';
export const SURFACE_SUCCESS_SCHEMA_REF = 'surface:success-envelope';

/** The shared carrier type names that each action descriptor refers to. */
export const SHARED_ERROR_TYPE = 'ContractErrorEnvelope';
export const SHARED_CAPPED_TYPE = 'CappedData';
export const SHARED_SUCCESS_TYPE = 'SuccessEnvelope';

export function actionInputSchemaRef(actionId: string): string {
  return `action:${actionId}:input`;
}

export function actionOutputSchemaRef(actionId: string): string {
  return `action:${actionId}:output`;
}

/**
 * Derive a stable PascalCase type stem from an ActionId, so `exarchos_workflow.init` gives
 * `ExarchosWorkflowInit`. It splits on each non-alphanumeric run and capitalizes each token. The
 * generators derive the per-action type names from this stem.
 */
export function pascalCase(actionId: string): string {
  return actionId
    .split(/[^a-zA-Z0-9]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join('');
}

export interface ActionTypeNames {
  readonly input: string;
  readonly output: string;
  readonly error: string;
  readonly capped: string;
}

export function deriveTypeNames(actionId: string): ActionTypeNames {
  const stem = pascalCase(actionId);
  return {
    input: `${stem}Input`,
    output: `${stem}Output`,
    error: SHARED_ERROR_TYPE,
    capped: SHARED_CAPPED_TYPE,
  };
}

export interface SchemaRefs {
  readonly input: string;
  readonly output: string;
  readonly error: string;
  readonly capped: string;
}

export type ProjectedActionContract = NonNullable<ActionMetaModel['actionContract']>;

export interface ActionDescriptor {
  readonly actionId: string;
  readonly tool: string;
  readonly action: string;
  readonly description: string;
  readonly surfaceVersion: string;
  readonly policy: ActionPolicy;
  readonly errorCodes: readonly string[];
  readonly outputKinds: readonly string[];
  readonly schemaRefs: SchemaRefs;
  readonly types: ActionTypeNames;
  /**
   * The declared action contract, when present. An absent contract stays absent and is not built
   * from annotations or `autoEmits`. Dispatch does not use compiled descriptors as runtime authority.
   */
  readonly actionContract?: ProjectedActionContract;
  /** The `sha256:` content address of the canonical descriptor body. */
  readonly digest: string;
}

/**
 * The declared contract that the descriptor digest covers. It uses the entry-level copy first, then
 * the policy copy. It returns undefined when both are absent.
 */
export function projectedActionContract(
  entry: ActionMetaModel,
): ProjectedActionContract | undefined {
  return entry.actionContract ?? entry.policy.actionContract;
}

/**
 * Compile a validated meta-model entry into its runtime descriptor. The digest covers all fields
 * except the digest itself, over canonical JSON. A present action contract is in the digest, so a
 * contract change moves the digest.
 */
export function compileDescriptor(entry: ActionMetaModel): ActionDescriptor {
  const actionContract = projectedActionContract(entry);
  const body = {
    actionId: entry.actionId,
    tool: entry.tool,
    action: entry.action,
    description: entry.description,
    surfaceVersion: entry.surfaceVersion,
    policy: entry.policy,
    errorCodes: entry.errorCodes,
    outputKinds: entry.outputKinds,
    schemaRefs: {
      input: actionInputSchemaRef(entry.actionId),
      output: actionOutputSchemaRef(entry.actionId),
      error: SURFACE_ERROR_SCHEMA_REF,
      capped: SURFACE_CAPPED_SCHEMA_REF,
    },
    types: deriveTypeNames(entry.actionId),
    ...(actionContract === undefined ? {} : { actionContract }),
  };
  return { ...body, digest: digestText(canonicalJson(body)) };
}

export interface SchemaBundle {
  /** The carrier schemas, projected once and shared by all actions. */
  readonly surface: Readonly<Record<string, JsonSchema>>;
  /** The input and output JSON schemas of each action, keyed by ActionId. */
  readonly actions: Readonly<Record<string, { input: JsonSchema; output: JsonSchema }>>;
}

/** Project the shared carrier schemas. The same Zod definitions give the same JSON Schema on each run. */
export function buildSurfaceSchemas(): Readonly<Record<string, JsonSchema>> {
  return {
    [SURFACE_ERROR_SCHEMA_REF]: zodToJsonSchema(ErrorEnvelopeSchema) as JsonSchema,
    [SURFACE_CAPPED_SCHEMA_REF]: zodToJsonSchema(CappedDataSchema) as JsonSchema,
    [SURFACE_SUCCESS_SCHEMA_REF]: zodToJsonSchema(SuccessEnvelopeSchema(z.unknown())) as JsonSchema,
  };
}

/** Assemble the schema bundle from validated entries and the shared carriers. */
export function buildSchemaBundle(entries: readonly ActionMetaModel[]): SchemaBundle {
  const actions: Record<string, { input: JsonSchema; output: JsonSchema }> = {};
  for (const entry of entries) {
    actions[entry.actionId] = { input: entry.inputSchema, output: entry.outputSchema };
  }
  return { surface: buildSurfaceSchemas(), actions };
}

export interface ActionTypeEntry {
  readonly actionId: string;
  readonly input: string;
  readonly output: string;
  readonly error: string;
  readonly capped: string;
}

export interface TypeManifest {
  readonly surfaceVersion: string;
  readonly sharedTypes: readonly string[];
  readonly actions: readonly ActionTypeEntry[];
}

/** Build the deterministic type manifest that the generators take type names from. */
export function buildTypeManifest(
  surfaceVersion: string,
  entries: readonly ActionMetaModel[],
): TypeManifest {
  const actions: ActionTypeEntry[] = entries.map((entry) => ({
    actionId: entry.actionId,
    ...deriveTypeNames(entry.actionId),
  }));
  return {
    surfaceVersion,
    sharedTypes: [SHARED_CAPPED_TYPE, SHARED_ERROR_TYPE, SHARED_SUCCESS_TYPE].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
    actions,
  };
}

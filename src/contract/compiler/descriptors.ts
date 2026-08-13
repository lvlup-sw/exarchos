// ─── Compiled runtime descriptors + type/schema bundles (P03-03) ─────────────
//
// PROGRAM-03, API-003. Turns a VALIDATED meta-model entry into the deterministic
// runtime descriptor a downstream projection (P03-04 MCP bindings, P03-05 CLI
// client, P03-09 oracle) consumes. A descriptor is content-addressed: its
// `digest` is a `sha256:` over its canonical JSON, so any structural change is
// visible and byte-diffable.
//
// Schemas are HOISTED: the four total carrier schemas from P03-02 (success /
// error / capped) are projected ONCE into the bundle's `surface` map and every
// descriptor references them by a stable key, so the emitted contract does not
// duplicate the envelope shape 120× and a single carrier change is one diff.
//
// Determinism discipline (design authority "one deterministic generation
// pipeline"): key order is normalized by `canonicalJson`, every list is
// pre-sorted upstream, and no clock / absolute path / locale leaks in.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { digestText } from '../authority-digest.js';
import { canonicalJson } from '../request-context.js';
import { zodToJsonSchema } from '../../adapters/json-schema.js';
import { ErrorEnvelopeSchema, CappedDataSchema, SuccessEnvelopeSchema } from '../envelope.js';
import type { ActionMetaModel, ActionPolicy, JsonSchema } from './meta-model.js';

// ─── Stable schema-reference keys ────────────────────────────────────────────

export const SURFACE_ERROR_SCHEMA_REF = 'surface:error-envelope';
export const SURFACE_CAPPED_SCHEMA_REF = 'surface:capped-data';
export const SURFACE_SUCCESS_SCHEMA_REF = 'surface:success-envelope';

/** Shared P03-02 carrier type names every action's descriptor references. */
export const SHARED_ERROR_TYPE = 'ContractErrorEnvelope';
export const SHARED_CAPPED_TYPE = 'CappedData';
export const SHARED_SUCCESS_TYPE = 'SuccessEnvelope';

export function actionInputSchemaRef(actionId: string): string {
  return `action:${actionId}:input`;
}

export function actionOutputSchemaRef(actionId: string): string {
  return `action:${actionId}:output`;
}

// ─── Type-name derivation ────────────────────────────────────────────────────

/**
 * Derive a stable PascalCase type stem from an ActionId (`exarchos_workflow.init`
 * → `ExarchosWorkflowInit`). Deterministic and total: split on any non-
 * alphanumeric run, capitalize each token. Downstream generators derive input/
 * output/error type identifiers from this stem so type names never drift apart.
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

// ─── The runtime descriptor ──────────────────────────────────────────────────

export interface SchemaRefs {
  readonly input: string;
  readonly output: string;
  readonly error: string;
  readonly capped: string;
}

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
  /** `sha256:` content address over the descriptor's canonical body. */
  readonly digest: string;
}

/**
 * Compile a validated meta-model entry into its runtime descriptor. The digest
 * covers everything EXCEPT itself (a self-referential digest would never
 * stabilize), computed over the canonical JSON so key order is irrelevant.
 */
export function compileDescriptor(entry: ActionMetaModel): ActionDescriptor {
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
  };
  return { ...body, digest: digestText(canonicalJson(body)) };
}

// ─── Schema bundle ───────────────────────────────────────────────────────────

export interface SchemaBundle {
  /** The P03-02 carrier schemas, projected once and shared by every action. */
  readonly surface: Readonly<Record<string, JsonSchema>>;
  /** Per-action input + output JSON schemas, keyed by ActionId. */
  readonly actions: Readonly<Record<string, { input: JsonSchema; output: JsonSchema }>>;
}

/**
 * Project the shared P03-02 carrier schemas. Byte-stable: the same Zod
 * definitions project to the same JSON Schema on every run.
 */
export function buildSurfaceSchemas(): Readonly<Record<string, JsonSchema>> {
  return {
    [SURFACE_ERROR_SCHEMA_REF]: zodToJsonSchema(ErrorEnvelopeSchema) as JsonSchema,
    [SURFACE_CAPPED_SCHEMA_REF]: zodToJsonSchema(CappedDataSchema) as JsonSchema,
    [SURFACE_SUCCESS_SCHEMA_REF]: zodToJsonSchema(SuccessEnvelopeSchema(z.unknown())) as JsonSchema,
  };
}

/** Assemble the schema bundle from validated entries + the shared carriers. */
export function buildSchemaBundle(entries: readonly ActionMetaModel[]): SchemaBundle {
  const actions: Record<string, { input: JsonSchema; output: JsonSchema }> = {};
  for (const entry of entries) {
    actions[entry.actionId] = { input: entry.inputSchema, output: entry.outputSchema };
  }
  return { surface: buildSurfaceSchemas(), actions };
}

// ─── Type manifest ───────────────────────────────────────────────────────────

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

/** Build the deterministic type manifest downstream generators name types from. */
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

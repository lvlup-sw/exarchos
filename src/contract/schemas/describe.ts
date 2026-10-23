/**
 * The output schema of the event `describe` action. The registry declares
 * `EventDescribeOutputSchema` through `withCappedShape(...)`.
 *
 * The schema is not beside the handler in `describe/`, because the layer rules do not let the
 * registry import `describe/`.
 *
 * The MCP adapter replaces a reply that does not parse with an `INTERNAL_ERROR`. Thus each object
 * uses `.passthrough()`, and no field is required that a success path of the handler omits.
 */

import { z } from 'zod';
import { EnvelopeSchema } from './envelope.js';

/**
 * An object with any keys. A field of this type holds a JSON Schema, a gate, an emission or a
 * contract, which this module does not restate.
 */
const OpaqueObjectSchema = z.object({}).passthrough();

/**
 * One action entry of a `describe` response, as `handleDescribe` builds it. The optional keys
 * appear only when the action declares the matching field.
 */
const DescribedActionDataSchema = z
  .object({
    description: z.string(),
    schema: OpaqueObjectSchema,
    gate: OpaqueObjectSchema.nullable(),
    phases: z.array(z.string()),
    roles: z.array(z.string()),
    autoEmits: z.array(OpaqueObjectSchema).optional(),
    deprecated: z.boolean().optional(),
    dispatch: OpaqueObjectSchema.optional(),
    economyBudgetTokens: z.number(),
    outputSchema: OpaqueObjectSchema.optional(),
    outputSchemaJson: OpaqueObjectSchema.optional(),
    actionContract: OpaqueObjectSchema.optional(),
    actionContractDigest: z.string().optional(),
    actionContractCompact: OpaqueObjectSchema.optional(),
  })
  .passthrough();

/** One event type entry of the event `describe` response, as `handleEventTypeDescribe` builds it. */
const DescribedEventTypeDataSchema = z
  .object({
    schema: OpaqueObjectSchema.nullable(),
    source: z.string().nullable(),
    isBuiltIn: z.boolean(),
  })
  .passthrough();

/** The event catalog that `serializeEventCatalog` returns for `emissionGuide`. */
const EventCatalogDataSchema = z
  .object({
    types: z.record(
      z.string(),
      z
        .object({
          source: z.string(),
          isBuiltIn: z.boolean(),
          hasSchema: z.boolean(),
        })
        .passthrough(),
    ),
    bySource: z.record(z.string(), z.array(z.string())),
    totalCount: z.number(),
  })
  .passthrough();

/**
 * The success data of `exarchos_event.describe`. Each key is present only when the request asks
 * for it, and the handler refuses a request that asks for none.
 */
const EventDescribeDataSchema = z
  .object({
    actions: z.record(z.string(), DescribedActionDataSchema).optional(),
    eventTypes: z.record(z.string(), DescribedEventTypeDataSchema).optional(),
    emissionGuide: EventCatalogDataSchema.optional(),
  })
  .passthrough();

/** The `outputSchema` of `exarchos_event.describe`. */
export const EventDescribeOutputSchema = EnvelopeSchema(EventDescribeDataSchema);

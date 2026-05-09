// ─── AgentSpec Zod schema (#1259 DR-6) ─────────────────────────────────────
//
// Runtime-validated AgentSpec surface. Consumers that accept inbound specs
// (loaders, MCP tools, tests) parse through `AgentSpecSchema` so the trust
// boundary is enforced once, structurally.
//
// The TypeScript shape lives in `types.ts` (interface). This module is the
// validator. Keep them in sync — a `posture` field added here must be
// reflected in the interface.
//
// Per DR-6: posture and capabilities[] are mutually exclusive (single
// source of truth per spec). Specs declaring legacy capabilities[] emit
// `spec.legacy_capabilities_array` at validation time.

import { z } from 'zod';
import { Capability } from './capabilities.js';
import { EVENT_DATA_SCHEMAS } from '../event-store/schemas.js';

/** Three canonical capability postures. See `capabilities/posture-mapping.ts`. */
export const AgentPosture = z.enum(['read-only', 'task-isolated', 'shared-mutating']);
export type AgentPosture = z.infer<typeof AgentPosture>;

const AgentSkillSchema = z.object({
  name: z.string(),
  content: z.string(),
});

const AgentValidationRuleSchema = z.object({
  trigger: z.string(),
  rule: z.string(),
  command: z.string().optional(),
});

const AgentSpecIdSchema = z.enum(['implementer', 'fixer', 'reviewer', 'scaffolder']);

/**
 * Zod schema for `AgentSpec`. Mirrors the TypeScript interface in `types.ts`.
 *
 * `posture` is optional during the v2.10 migration window so legacy
 * `capabilities[]` specs still parse. After v2.11 cuts, posture becomes
 * required (DR-6 follow-up issue).
 */
export const AgentSpecSchema = z
  .object({
    id: AgentSpecIdSchema,
    description: z.string(),
    systemPrompt: z.string(),
    posture: AgentPosture.optional(),
    capabilities: z.array(Capability).optional(),
    disallowedTools: z.array(z.string()).optional(),
    model: z.enum(['opus', 'sonnet', 'haiku', 'inherit']),
    effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
    color: z.string().optional(),
    isolation: z.literal('worktree').optional(),
    skills: z.array(AgentSkillSchema),
    validationRules: z.array(AgentValidationRuleSchema),
    resumable: z.boolean(),
    memoryScope: z.enum(['user', 'project', 'local']).optional(),
    maxTurns: z.number().optional(),
    mcpServers: z.array(z.string()).optional(),
  })
  // DR-6: posture and capabilities[] are mutually exclusive — a spec must
  // pick one source of truth for capability declaration. Specs declaring
  // both are rejected so silent precedence rules can't widen the trust
  // boundary unintentionally.
  .refine(
    (spec) => !(spec.posture !== undefined && spec.capabilities !== undefined),
    {
      message:
        'AgentSpec cannot declare both posture and capabilities — pick one. ' +
        'Use posture for new specs; capabilities[] is deprecated and removed in v2.11.',
      path: ['posture'],
    },
  );

export type AgentSpecParsed = z.infer<typeof AgentSpecSchema>;

/**
 * Deprecation envelope surfaced in consumer responses for specs that still
 * use the legacy `capabilities[]` shape (DR-6).
 *
 * `since` marks the release in which the deprecation took effect; `removeIn`
 * marks the release in which the legacy path is removed; `replacement`
 * names the field consumers should migrate to.
 */
export interface DeprecationEnvelope {
  readonly since: string;
  readonly removeIn: string;
  readonly replacement: string;
}

/**
 * Structured event payload emitted when a spec uses the legacy
 * `capabilities[]` shape. Mirrors `SpecLegacyCapabilitiesArrayData` in
 * `event-store/schemas.ts` so the consumer can flow the payload through
 * `AtomicAppender.append` directly.
 */
export interface LegacyCapabilitiesEvent {
  readonly type: 'spec.legacy_capabilities_array';
  readonly data: {
    readonly specName: string;
    readonly capabilities: readonly string[];
  };
}

export interface ValidateAgentSpecResult {
  readonly spec: AgentSpecParsed;
  readonly events: readonly LegacyCapabilitiesEvent[];
  readonly _meta?: { readonly deprecation: DeprecationEnvelope };
}

/**
 * Validate an inbound spec, surfacing deprecation telemetry as structured
 * data. The caller (host facade, MCP tool, etc.) is responsible for routing
 * `result.events` through the canonical `AtomicAppender.append` path —
 * this function does not bypass the appender by emitting events directly.
 *
 * Throws if the spec fails Zod validation; the structured error is the
 * Zod issues array.
 */
export function validateAgentSpec(input: unknown): ValidateAgentSpecResult {
  const spec = AgentSpecSchema.parse(input);

  const events: LegacyCapabilitiesEvent[] = [];
  let _meta: ValidateAgentSpecResult['_meta'];

  if (spec.capabilities !== undefined && spec.posture === undefined) {
    const data = {
      specName: spec.id,
      capabilities: [...spec.capabilities],
    };

    // Canonical event-emission path: validate the payload against the
    // registered `spec.legacy_capabilities_array` schema before handing it
    // off. This makes any future drift between the spec validator and the
    // event store fail fast at validation, not at AtomicAppender.append
    // time. The validator does not bypass the appender — it returns the
    // structured event for the caller to flow through the appender.
    const eventSchema = EVENT_DATA_SCHEMAS['spec.legacy_capabilities_array'];
    if (!eventSchema) {
      throw new Error(
        'Event schema "spec.legacy_capabilities_array" is not registered in EVENT_DATA_SCHEMAS — ' +
          'this indicates the schema registry was not initialized correctly (INV-1: every event type must have a registered schema).',
      );
    }
    eventSchema.parse(data);

    events.push({
      type: 'spec.legacy_capabilities_array',
      data,
    });
    _meta = {
      deprecation: {
        since: '2.10.0',
        removeIn: '2.11.0',
        replacement: 'posture',
      },
    };
  }

  return _meta ? { spec, events, _meta } : { spec, events };
}

/**
 * Wrap a consumer response with `_meta.deprecation` if the upstream spec
 * validation produced a deprecation envelope. Pure function — does not
 * mutate the input response.
 *
 * Use this at every consumer-response boundary that ingested a possibly-
 * legacy spec, so the deprecation is surfaced uniformly across CLI / MCP
 * carriers.
 */
export function wrapResponseWithDeprecation<T extends object>(
  response: T,
  validation: ValidateAgentSpecResult,
): T | (T & { _meta: { deprecation: DeprecationEnvelope } }) {
  if (validation._meta?.deprecation === undefined) {
    return response;
  }
  return { ...response, _meta: { deprecation: validation._meta.deprecation } };
}

// ─── AgentSpec Zod schema (#1259 DR-6, v2.11 substrate-cut) ───────────────
//
// Runtime-validated AgentSpec surface. Consumers that accept inbound specs
// (loaders, MCP tools, tests) parse through `AgentSpecSchema` so the trust
// boundary is enforced once, structurally.
//
// The TypeScript shape lives in `types.ts` (interface). This module is the
// validator for inbound declarations. Keep them in sync — a `posture`
// field added here must be reflected in the interface.
//
// v2.11 hard-cut (DR-6): the legacy `capabilities: [...]` declaration shape
// is no longer accepted. Specs must declare `posture`; the resolver derives
// the effective capability set from posture + runtime handshake. The
// `spec.legacy_capabilities_array` deprecation event/envelope path that
// existed in the v2.10 migration window has been removed (the event type
// remains historically registered in `events/schemas.ts` for archival
// replay, but is no longer emitted).

import { z } from 'zod';

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
 * Zod schema for inbound `AgentSpec` declarations. Mirrors the TypeScript
 * interface in `types.ts` for the declaration surface — note that the
 * runtime `AgentSpec` interface keeps `capabilities` as the rendered
 * projection consumed by adapters, while this schema rejects `capabilities`
 * as an inbound declaration (DR-6 hard-cut).
 *
 * `posture` is the only authoritative declarative source for a spec's
 * capability surface in v2.11+. Specs that still pass `capabilities: [...]`
 * are rejected with a typed error pointing operators at `posture`.
 */
export const AgentSpecSchema = z
  .object({
    id: AgentSpecIdSchema,
    description: z.string(),
    systemPrompt: z.string(),
    // v2.11 (DR-6): posture is the only declarative authority on a spec's
    // capability surface. Required at the trust boundary so a spec cannot
    // declare neither `capabilities` (rejected below) nor `posture`,
    // leaving the resolver with no input to derive from.
    posture: AgentPosture,
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
  // `.passthrough()` is load-bearing: by default Zod v3 strips keys that
  // aren't declared in the object schema before handing the value to
  // `superRefine`. Without passthrough the legacy `capabilities` key would
  // silently disappear and the refine below would never see it. Passthrough
  // keeps the raw shape intact so the refine can fire a typed error.
  .passthrough()
  // Reject any object that carries a legacy `capabilities` key with a
  // typed, operator-friendly error pointing at the replacement field.
  // v2.10's accept-and-warn path (deprecation event + `_meta.deprecation`
  // envelope) has been removed — legacy declarations are now a hard error.
  // The refine targets the raw input shape so the message is more useful
  // than a generic "unrecognized key".
  .superRefine((spec, ctx) => {
    if ((spec as Record<string, unknown>).capabilities !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities'],
        message:
          'AgentSpec.capabilities[] is removed in v2.11 (DR-6). ' +
          'Declare a posture instead: posture: "read-only" | "task-isolated" | "shared-mutating". ' +
          'The resolver derives the effective capability set from posture ⊕ runtime handshake.',
      });
    }
  });

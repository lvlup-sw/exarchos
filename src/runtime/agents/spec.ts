/**
 * The Zod schema for inbound `AgentSpec` declarations. Loaders, MCP tools, and tests parse inbound specs
 * through `AgentSpecSchema`, so one schema enforces the trust boundary.
 *
 * The TypeScript interface lives in `types.ts`. A field added here must also go into that interface. A
 * spec declares `posture`, and the capability resolver derives the capability set from it.
 */

import { z } from 'zod';

/** The three capability postures. See `workflow/capabilities/posture-mapping.ts`. */
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
 * Zod schema for inbound `AgentSpec` declarations. `posture` is required, so the resolver always has an
 * input. A spec that declares `capabilities: [...]` fails with a typed error that points at `posture`.
 *
 * `.passthrough()` is necessary. By default Zod strips undeclared keys before `superRefine` runs, so the
 * `capabilities` key disappears and the refine never sees it.
 */
export const AgentSpecSchema = z
  .object({
    id: AgentSpecIdSchema,
    description: z.string(),
    systemPrompt: z.string(),
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
  .passthrough()
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

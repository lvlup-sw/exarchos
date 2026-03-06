import { z } from 'zod';

// ─── Built-in Workflow Names ───────────────────────────────────────────────

export const BUILTIN_WORKFLOW_TYPES = ['feature', 'debug', 'refactor'] as const;

// ─── Zod Schemas ───────────────────────────────────────────────────────────

export const guardDefinitionSchema = z.object({
  command: z.string().min(1, 'Guard command must not be empty'),
  timeout: z.number().int().positive().optional(),
  description: z.string().optional(),
}).strict();

export const transitionDefinitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  event: z.string().min(1),
  guard: z.string().optional(),
}).strict();

export const workflowDefinitionSchema = z.object({
  extends: z.string().optional(),
  phases: z.array(z.string().min(1)).min(1, 'Workflow must have at least one phase'),
  initialPhase: z.string().min(1),
  transitions: z.array(transitionDefinitionSchema),
  guards: z.record(z.string(), guardDefinitionSchema).optional(),
}).strict().superRefine((workflow, ctx) => {
  // Declared phases: valid for initialPhase and transition sources (from)
  const declaredPhases = new Set(workflow.phases);
  // Reachable phases: includes implicit terminal states for transition targets (to)
  const reachablePhases = new Set([...workflow.phases, 'cancelled', 'completed']);

  // initialPhase must be a declared phase (not a terminal state)
  if (!declaredPhases.has(workflow.initialPhase)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `initialPhase "${workflow.initialPhase}" is not in phases: [${workflow.phases.join(', ')}]`,
      path: ['initialPhase'],
    });
  }

  // Validate transition from/to reference valid phases
  for (let i = 0; i < workflow.transitions.length; i++) {
    const t = workflow.transitions[i];
    if (!declaredPhases.has(t.from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Transition from "${t.from}" references unknown phase. Valid phases: [${workflow.phases.join(', ')}]`,
        path: ['transitions', i, 'from'],
      });
    }
    if (!reachablePhases.has(t.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Transition to "${t.to}" references unknown phase. Valid phases: [${workflow.phases.join(', ')}]`,
        path: ['transitions', i, 'to'],
      });
    }

    // Validate guard references exist in guards object
    if (t.guard) {
      const guardExists = workflow.guards?.[t.guard];
      if (!guardExists) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Transition guard "${t.guard}" is not defined in guards`,
          path: ['transitions', i, 'guard'],
        });
      }
    }
  }
});

export const exarchosConfigSchema = z.object({
  workflows: z.record(z.string(), workflowDefinitionSchema)
    .optional()
    .superRefine((workflows, ctx) => {
      if (!workflows) return;

      const knownWorkflowNames = new Set<string>([
        ...BUILTIN_WORKFLOW_TYPES,
        ...Object.keys(workflows),
      ]);

      for (const [name, workflow] of Object.entries(workflows)) {
        if ((BUILTIN_WORKFLOW_TYPES as readonly string[]).includes(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Workflow name "${name}" conflicts with built-in type. Built-in types: [${BUILTIN_WORKFLOW_TYPES.join(', ')}]`,
            path: [name],
          });
        }

        if (workflow.extends && !knownWorkflowNames.has(workflow.extends)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Workflow "${name}" extends unknown workflow "${workflow.extends}"`,
            path: [name, 'extends'],
          });
        }

        if (workflow.extends === name) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Workflow "${name}" cannot extend itself`,
            path: [name, 'extends'],
          });
        }
      }

      // Detect cycles in extends chains
      for (const name of Object.keys(workflows)) {
        const visited = new Set<string>();
        let current: string | undefined = name;
        while (current && workflows[current]?.extends) {
          if (visited.has(current)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Circular extends chain detected: ${[...visited, current].join(' → ')}`,
              path: [name, 'extends'],
            });
            break;
          }
          visited.add(current);
          current = workflows[current].extends;
        }
      }
    }),
}).strict();

// ─── Validation Function ───────────────────────────────────────────────────

export interface ValidationResult {
  success: boolean;
  data?: z.infer<typeof exarchosConfigSchema>;
  errors?: string[];
}

/**
 * Validates an ExarchosConfig object against the schema.
 * Returns a result with either validated data or error messages.
 */
export function validateConfig(config: unknown): ValidationResult {
  const result = exarchosConfigSchema.safeParse(config);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });

  return { success: false, errors };
}

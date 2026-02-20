import { z, type ZodSchema } from 'zod';
import type { GradeResult, IGrader } from '../types.js';

// ─── Built-in schemas ───────────────────────────────────────────────────

const taskDecompositionSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  status: z.string(),
});

const reviewFindingSchema = z.object({
  severity: z.string(),
  category: z.string(),
  message: z.string(),
});

// ─── Schema Registry ────────────────────────────────────────────────────

const builtInSchemas = new Map<string, ZodSchema>([
  ['task-decomposition', taskDecompositionSchema],
  ['review-finding', reviewFindingSchema],
]);

/**
 * Validates output against a named Zod schema.
 * Score: 1.0 if valid, 0.0 if invalid.
 */
export class SchemaGrader implements IGrader {
  readonly name = 'schema';
  readonly type = 'schema';

  private readonly schemas: Map<string, ZodSchema>;

  constructor(extraSchemas?: Map<string, ZodSchema>) {
    this.schemas = new Map(builtInSchemas);
    if (extraSchemas) {
      for (const [name, schema] of extraSchemas) {
        this.schemas.set(name, schema);
      }
    }
  }

  async grade(
    _input: Record<string, unknown>,
    output: Record<string, unknown>,
    _expected: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<GradeResult> {
    const schemaName = config?.schema as string | undefined;
    if (!schemaName) {
      throw new Error('SchemaGrader requires config.schema');
    }

    const schema = this.schemas.get(schemaName);
    if (!schema) {
      throw new Error(`Unknown schema: ${schemaName}`);
    }

    const strict = config?.strict === true;
    const targetSchema = strict && schema instanceof z.ZodObject ? schema.strict() : schema;

    const parseResult = targetSchema.safeParse(output);

    if (parseResult.success) {
      return { passed: true, score: 1.0, reason: 'Output matches schema' };
    }

    const firstError = parseResult.error.issues[0];
    const fieldPath = firstError.path.join('.');
    const reason = fieldPath
      ? `Validation failed at ${fieldPath}: ${firstError.message}`
      : `Validation failed: ${firstError.message}`;

    return { passed: false, score: 0.0, reason };
  }
}

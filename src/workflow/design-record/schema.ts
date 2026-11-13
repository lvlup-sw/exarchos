/** The closed file format for an authored plan. Graph rules belong to the snapshot validators. */
import { z } from 'zod';
import { SharedStableIdSchema } from '../../contract/ir/admission-ir.js';

const TextSchema = z.string().refine((value) => value.trim().length > 0, 'Expected nonempty text');
const RequirementSchema = z.string().regex(/^DR-[1-9][0-9]*$/);
const FileSchema = TextSchema.refine(
  (value) => !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every((part) => part !== '..'),
  'Expected a relative POSIX file path',
);

/** Reject repeated array values without changing their spelling or order. */
function unique<T extends z.ZodType>(item: T) {
  return z.array(item).refine((items) => new Set(items).size === items.length, 'Repeated array value');
}

export const DesignTaskSchema = z.object({
  id: SharedStableIdSchema,
  title: TextSchema,
  implements: unique(RequirementSchema),
  blockedBy: unique(SharedStableIdSchema),
  files: unique(FileSchema).min(1),
  testFiles: unique(FileSchema),
  riskTier: z.enum(['low', 'medium', 'high']),
  boundaryTouching: z.boolean(),
  testLayer: z.enum(['acceptance', 'integration', 'unit', 'property']).optional(),
  acceptance: unique(TextSchema).min(1),
  instructions: TextSchema,
  parallelizable: z.boolean(),
}).strict().superRefine((task, ctx) => {
  if (task.riskTier === 'high' && task.testFiles.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['testFiles'], message: 'High-risk tasks require test files' });
  }
});

export const DesignPlanSchema = z.object({
  version: z.literal(1),
  requirements: unique(RequirementSchema).min(1),
  tasks: z.array(DesignTaskSchema).min(1).refine(
    (tasks) => new Set(tasks.map((task) => task.id)).size === tasks.length,
    'Repeated task id',
  ),
}).strict();

export type DesignTask = z.infer<typeof DesignTaskSchema>;

/** Offsets count UTF-16 code units, with an exclusive end. Lines start at one. */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
}

export interface RequirementDefinition {
  readonly id: string;
  readonly title: string;
  readonly span: SourceSpan;
}

type Immutable<T> = T extends readonly (infer V)[] ? readonly Immutable<V>[]
  : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

export interface DesignRecordSnapshot {
  readonly reference: string;
  readonly digest: string;
  readonly rawBytes: readonly number[];
  readonly version: 1;
  readonly requirements: readonly string[];
  readonly tasks: readonly (Immutable<DesignTask> & { readonly span: SourceSpan })[];
  readonly definitions: readonly RequirementDefinition[];
  readonly planSpan: SourceSpan;
}

export type DesignRecordReadResult =
  | { readonly kind: 'legacy'; readonly reference: string }
  | { readonly kind: 'invalid'; readonly reference: string; readonly message: string }
  | { readonly kind: 'typed'; readonly snapshot: DesignRecordSnapshot };

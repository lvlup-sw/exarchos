import { z } from 'zod';

const identifier = z.string().max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/);
const binding = z.string().max(200).regex(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/);
const ticks = z.string().max(20).regex(/^(?:0|-?[1-9][0-9]{0,18})(?![\s\S])/).refine(
  (value) => {
    if (!/^(?:0|-?[1-9][0-9]{0,18})(?![\s\S])/.test(value)) return false;
    const n = BigInt(value);
    return n >= -(1n << 63n) && n < (1n << 63n);
  },
  'Expected a signed 64-bit decimal integer.',
);
const vector = z.array(ticks).min(1).max(8);
export const supportedFramework = { framework: 'tunit', frameworkVersion: '1.2.11' } as const;
export const frameworkSelection = z.object({
  framework: z.string().min(1).max(50),
  frameworkVersion: z.string().min(1).max(50),
});
const common = {
  framework: z.literal(supportedFramework.framework),
  frameworkVersion: z.literal(supportedFramework.frameworkVersion),
  target: z.strictObject({
    project: z.string().max(240).regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.csproj(?![\s\S])/)
      .refine((path) => path.split('/').every((part) => !part.endsWith('.')), 'Use portable path segments.'),
    path: z.string().max(240).regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.cs(?![\s\S])/)
      .refine((path) => path.split('/').every((part) => !part.endsWith('.')), 'Use portable path segments.'),
    namespace: z.string().max(200).regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?![\s\S])/),
    className: identifier,
    observe: binding,
    precondition: binding,
  }),
  propertyRef: z.string().min(1).max(250),
  assumptions: z.array(z.string().min(1).max(400)).max(20),
  cases: z.array(vector).min(1).max(256),
  boundaryAxes: z.array(z.strictObject({ index: z.number().int().min(0).max(7), min: ticks, max: ticks })).max(8).optional(),
};

export const propertyInput = z.strictObject({ ...common, predicate: binding });
export const metamorphicInput = z.strictObject({ ...common, transform: binding, relation: binding });
export type TestInput = z.infer<typeof propertyInput> | z.infer<typeof metamorphicInput>;

const errorCode = z.enum(['INVALID_INPUT', 'UNSUPPORTED_FRAMEWORK', 'INTERNAL_ERROR']);
export type ErrorCode = z.infer<typeof errorCode>;
export const errors = {
  INVALID_INPUT: 2,
  UNSUPPORTED_FRAMEWORK: 3,
  INTERNAL_ERROR: 1,
} as const;

export const resultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    contractVersion: z.literal(1),
    generatorVersion: z.literal('tunit/1'),
    patch: z.string().min(1),
    fixture: z.strictObject({
      version: z.literal(1),
      cases: z.array(vector).min(1).max(256),
    }),
    propertyRefs: z.array(z.string()).min(1),
    assumptions: z.array(z.string()),
    unresolvedObligations: z.array(z.string()),
    validation: z.strictObject({
      executable: z.literal('dotnet'),
      args: z.array(z.string()).min(1),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({ code: errorCode, message: z.string() }),
  }),
]);

export type GenerationResult = z.infer<typeof resultSchema>;
export type Success = Extract<GenerationResult, { ok: true }>;

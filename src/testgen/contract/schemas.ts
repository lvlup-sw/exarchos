import { z } from 'zod';
import { typedSuccess } from './typed.js';
import { binding, tunit, tsPath, frameworkVersions } from './targets.js';
export { frameworkSelection, frameworkVersions } from './targets.js';

const ticks = z.string().max(20).regex(/^(?:0|-?[1-9][0-9]{0,18})(?![\s\S])/).refine(
  (value) => {
    if (!/^(?:0|-?[1-9][0-9]{0,18})(?![\s\S])/.test(value)) return false;
    const n = BigInt(value);
    return n >= -(1n << 63n) && n < (1n << 63n);
  },
  'Expected a signed 64-bit decimal integer.',
);
const vector = z.array(ticks).min(1).max(8);
const common = {
  propertyRef: z.string().min(1).max(250),
  assumptions: z.array(z.string().min(1).max(400)).max(20),
  cases: z.array(vector).min(1).max(256),
  boundaryAxes: z.array(z.strictObject({ index: z.number().int().min(0).max(7), min: ticks, max: ticks })).max(8).optional(),
};

const tunitProperty = z.strictObject({ ...common, ...tunit, predicate: binding });
const vitestInput = z.strictObject({
  ...common,
  framework: z.literal('vitest'),
  frameworkVersion: z.literal(frameworkVersions.vitest),
  target: z.strictObject({
    path: tsPath.refine((path) => path.endsWith('.test.ts'), 'Use a .test.ts file.'),
    bindingModule: tsPath.refine((path) => !path.endsWith('.d.ts'), 'Use a runtime binding module.'),
  }),
});
export const propertyInput = z.discriminatedUnion('framework', [tunitProperty, vitestInput]);
export const metamorphicInput = z.discriminatedUnion('framework', [
  z.strictObject({ ...common, ...tunit, transform: binding, relation: binding }),
  vitestInput,
]);
export type TestKind = 'property' | 'metamorphic';
export type TestInput = z.infer<typeof propertyInput> | z.infer<typeof metamorphicInput>;

const errorCode = z.enum(['INVALID_INPUT', 'UNSUPPORTED_FRAMEWORK', 'INTERNAL_ERROR']);
export type ErrorCode = z.infer<typeof errorCode>;
export const errors = {
  INVALID_INPUT: 2,
  UNSUPPORTED_FRAMEWORK: 3,
  INTERNAL_ERROR: 1,
} as const;

const legacyResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    contractVersion: z.literal(1),
    generatorVersion: z.enum(['tunit/1', 'vitest/1']),
    patch: z.string().min(1),
    fixture: z.strictObject({
      version: z.literal(1),
      cases: z.array(vector).min(1).max(256),
    }),
    propertyRefs: z.array(z.string()).min(1),
    assumptions: z.array(z.string()),
    unresolvedObligations: z.array(z.string()),
    validation: z.strictObject({
      executable: z.enum(['dotnet', 'npm']),
      args: z.array(z.string()).min(1),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({ code: errorCode, message: z.string() }),
  }),
]);

export const resultSchema = z.union([legacyResultSchema, typedSuccess]);

export type GenerationResult = z.infer<typeof resultSchema>;
export type Success = Extract<z.infer<typeof legacyResultSchema>, { ok: true }>;

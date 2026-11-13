import { z } from 'zod';
import { domainSchema, jsonValueSchema } from '../domains/schema.js';
import { binding, frameworkVersions, tsPath, tunit } from './targets.js';

const generation = z.strictObject({
  seed: z.number().int().min(0).max(4294967295),
  count: z.number().int().min(1).max(256),
  maxAttempts: z.number().int().min(1).max(4096),
});
const common = {
  contractVersion: z.literal(2),
  propertyRef: z.string().min(1).max(250),
  assumptions: z.array(z.string().min(1).max(400)).max(20),
  domain: domainSchema,
  cases: z.array(jsonValueSchema).max(256),
  generation: generation.optional(),
};
export const typedInput = z.discriminatedUnion('framework', [
  z.strictObject({
    ...common,
    framework: z.literal('tunit'),
    frameworkVersion: z.literal(frameworkVersions.tunit),
    target: tunit.target.omit({ observe: true, precondition: true }).extend({ binding }),
  }),
  z.strictObject({
    ...common,
    framework: z.literal('vitest'),
    frameworkVersion: z.literal(frameworkVersions.vitest),
    target: z.strictObject({
      path: tsPath.refine((path) => path.endsWith('.test.ts'), 'Use a .test.ts file.'),
      bindingModule: tsPath.refine((path) => !path.endsWith('.d.ts'), 'Use a runtime binding module.'),
    }),
  }),
]);
export type TypedInput = z.infer<typeof typedInput>;
export type TypedMethod = 'property' | 'metamorphic' | 'differential';

export const typedSuccess = z.strictObject({
  ok: z.literal(true),
  contractVersion: z.literal(2),
  generatorVersion: z.enum(['tunit/2', 'vitest/2']),
  patch: z.string().min(1),
  fixture: z.strictObject({
    version: z.literal(2),
    domain: domainSchema,
    cases: z.array(jsonValueSchema).min(1).max(256),
  }),
  generation: z.strictObject({
    seed: z.number().int().min(0).max(4294967295).nullable(),
    requested: z.number().int().min(1).max(256),
    attempts: z.number().int().min(0).max(4096),
    duplicates: z.number().int().min(0).max(4096),
    exhausted: z.boolean(),
  }),
  propertyRefs: z.array(z.string()).min(1),
  assumptions: z.array(z.string()),
  unresolvedObligations: z.array(z.string()),
  validation: z.strictObject({ executable: z.enum(['dotnet', 'npm']), args: z.array(z.string()).min(1) }),
});
export type TypedSuccess = z.infer<typeof typedSuccess>;

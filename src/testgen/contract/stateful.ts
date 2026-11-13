import { z } from 'zod';
import { domainSchema, jsonValueSchema } from '../domains/schema.js';
import { frameworkVersions } from './targets.js';
import { typedInput } from './typed.js';

const operationName = z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_.-]*(?![\s\S])/);
export const stepSchema = z.strictObject({ operation: operationName, args: jsonValueSchema });
const operationsSchema = z.array(z.strictObject({ name: operationName, domain: domainSchema })).min(1).max(16);
const historySchema = z.array(stepSchema).max(64);
const common = {
  contractVersion: z.literal(2),
  propertyRef: z.string().min(1).max(250),
  assumptions: z.array(z.string().min(1).max(400)).max(20),
  operations: operationsSchema,
  histories: z.array(historySchema).max(64),
  generation: z.strictObject({
    seed: z.number().int().min(0).max(4294967295),
    count: z.number().int().min(1).max(64),
    maxSteps: z.number().int().min(1).max(64),
    maxAttempts: z.number().int().min(1).max(256),
  }).optional(),
  reduction: z.strictObject({ maxAttempts: z.number().int().min(0).max(256) }).optional(),
};
export const statefulInput = z.discriminatedUnion('framework', [
  z.strictObject({
    ...common, framework: z.literal('tunit'), frameworkVersion: z.literal(frameworkVersions.tunit),
    target: typedInput.options[0].shape.target,
  }),
  z.strictObject({
    ...common, framework: z.literal('vitest'), frameworkVersion: z.literal(frameworkVersions.vitest),
    target: typedInput.options[1].shape.target,
  }),
]);
export type StatefulInput = z.infer<typeof statefulInput>;
export type Step = z.infer<typeof stepSchema>;
export const scenarioSchema = z.strictObject({
  mode: z.enum(['exact', 'enabled']),
  steps: z.array(stepSchema).max(256),
  requiredSteps: z.number().int().min(0).max(64),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export const statefulSuccess = z.strictObject({
  ok: z.literal(true),
  contractVersion: z.literal(2),
  generatorVersion: z.enum(['tunit/stateful-1', 'vitest/stateful-1']),
  patch: z.string().min(1),
  fixture: z.strictObject({ version: z.literal(2), operations: operationsSchema, scenarios: z.array(scenarioSchema).min(1).max(64) }),
  propertyRefs: z.array(z.string()).min(1),
  assumptions: z.array(z.string()),
  unresolvedObligations: z.array(z.string()),
  validation: z.strictObject({ executable: z.enum(['dotnet', 'npm']), args: z.array(z.string()).min(1) }),
});
export type StatefulSuccess = z.infer<typeof statefulSuccess>;

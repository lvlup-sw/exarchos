import { z } from 'zod';
import { domainSchema, jsonValueSchema, canonicalJson } from '../domains/schema.js';
import { typedInput } from './typed.js';
import { statefulInput } from './stateful.js';

const common = {
  version: z.literal(2), propertyRef: z.string().min(1).max(250), signature: z.string().min(1).max(250),
};
export const replayRecord = z.union([
  z.object({ ...common, method: z.enum(['property', 'metamorphic', 'differential']),
    domain: domainSchema, cases: z.array(jsonValueSchema).min(1).max(256) }),
  z.object({ ...common, method: z.literal('stateful'),
    operations: statefulInput.options[0].shape.operations,
    histories: statefulInput.options[0].shape.histories.min(1) }),
]);
export const replayInput = z.strictObject({
  request: z.union([typedInput, statefulInput]),
  fixture: replayRecord,
});
export type ReplayInput = z.infer<typeof replayInput>;

export function replayRequest(input: ReplayInput) {
  const { request, fixture } = input;
  if (request.propertyRef !== fixture.propertyRef) return { problem: 'The replay property reference differs from the request.' };
  const { generation: _generation, ...base } = request;
  if ('histories' in request && fixture.method === 'stateful') {
    if (canonicalJson(request.operations) !== canonicalJson(fixture.operations)) return { problem: 'The replay operation domains differ from the request.' };
    const signatures = ['stateful/initial-state', ...request.operations.map(({ name }) => `stateful/${name}/state-mismatch`)];
    if (!signatures.includes(fixture.signature)) return { problem: 'The replay failure signature is unsupported.' };
    return { operation: 'generate_stateful_tests', request: { ...base, histories: fixture.histories, reduction: { maxAttempts: 0 } } };
  }
  if ('domain' in request && fixture.method !== 'stateful') {
    if (canonicalJson(request.domain) !== canonicalJson(fixture.domain)) return { problem: 'The replay domain differs from the request.' };
    if (fixture.signature !== `${fixture.method}/oracle-false`) return { problem: 'The replay failure signature is unsupported.' };
    return { operation: `generate_${fixture.method}_tests`, request: { ...base, cases: fixture.cases, reduction: { maxAttempts: 0 } } };
  }
  return { problem: 'The replay method and request shape differ.' };
}

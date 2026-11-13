import { z } from 'zod';
import { expandCases } from '../generators/cases.js';
import { emitVitest } from '../emitters/vitest/emit.js';
import { emitTUnit } from '../emitters/tunit/emit.js';
import { errors, frameworkSelection, metamorphicInput, propertyInput, resultSchema, frameworkVersions } from './schemas.js';
import type { ErrorCode, GenerationResult, TestInput } from './schemas.js';

export const operations = {
  generate_property_tests: {
    description: 'Emit TUnit or Vitest tests for a supplied predicate and finite integer cases.',
    input: propertyInput,
  },
  generate_metamorphic_tests: {
    description: 'Emit paired TUnit tests for a supplied transformation, precondition, and relation.',
    input: metamorphicInput,
  },
} as const;

export type Emitter = (input: TestInput) => unknown;

export function describeOperations() {
  return {
    errors,
    operations: Object.entries(operations).map(([name, definition]) => ({
      name,
      description: definition.description,
      inputSchema: z.toJSONSchema(definition.input),
      outputSchema: z.toJSONSchema(resultSchema),
    })),
  };
}

export function failure(code: ErrorCode, message: string): GenerationResult {
  return { ok: false, error: { code, message } };
}

const emitForTarget: Emitter = (input) => input.framework === 'vitest' ? emitVitest(input) : emitTUnit(input);

export function dispatch(name: string, input: unknown, emit: Emitter = emitForTarget): GenerationResult {
  const operation = Object.entries(operations).find(([key]) => key === name)?.[1];
  if (!operation) return failure('INVALID_INPUT', 'Unknown operation.');
  const parsed = operation.input.safeParse(input);
  if (!parsed.success) {
    const selection = frameworkSelection.safeParse(input);
    if (selection.success) {
      const { framework, frameworkVersion } = selection.data;
      const supported = framework === 'tunit' && frameworkVersion === frameworkVersions.tunit
        || name === 'generate_property_tests' && framework === 'vitest' && frameworkVersion === frameworkVersions.vitest;
      if (!supported) {
        return failure('UNSUPPORTED_FRAMEWORK', 'Use a framework and version listed by describe for this operation.');
      }
    }
    const details = parsed.error.issues.map(({ path, message }) => `${path.join('.') || 'request'}: ${message}`);
    return failure('INVALID_INPUT', details.join('; '));
  }

  const request = parsed.data;
  if (request.framework === 'tunit') {
    const parent = request.target.project.slice(0, request.target.project.lastIndexOf('/') + 1);
    if (!request.target.path.startsWith(parent)) {
      return failure('INVALID_INPUT', 'The test file must be under the test project directory.');
    }
  } else if (request.target.path === request.target.bindingModule) {
    return failure('INVALID_INPUT', 'The test file and binding module must be different.');
  }
  const width = request.cases[0]?.length ?? 0;
  if (request.cases.some((row) => row.length !== width)) {
    return failure('INVALID_INPUT', 'All cases must have the same arity.');
  }
  if (new Set(request.cases.map((row) => row.join(','))).size !== request.cases.length) {
    return failure('INVALID_INPUT', 'Duplicate cases are not allowed.');
  }

  if (request.boundaryAxes?.some(({ index, min, max }) => index >= width || BigInt(min) > BigInt(max))) {
    return failure('INVALID_INPUT', 'Each boundary axis needs a valid index and ordered bounds.');
  }
  const cases = expandCases(request);
  if (cases.length > 256) return failure('INVALID_INPUT', 'The expanded case count exceeds 256.');

  try {
    const result = resultSchema.safeParse(emit({ ...request, cases }));
    if (result.success) return result.data;
    return failure('INTERNAL_ERROR', 'Emitter result violates the output schema.');
  } catch {
    return failure('INTERNAL_ERROR', 'Emitter failed.');
  }
}

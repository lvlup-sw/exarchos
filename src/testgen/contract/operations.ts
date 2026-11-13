import { z } from 'zod';
import { typedInput } from './typed.js';
import type { TypedInput, TypedMethod } from './typed.js';
import { emitTyped, inputWithinBudget, typedRequestProblem } from './typed-dispatch.js';
import { expandCases } from '../generators/cases.js';
import { emitVitest } from '../emitters/vitest/emit.js';
import { emitTUnit } from '../emitters/tunit/emit.js';
import { errors, frameworkSelection, metamorphicInput, propertyInput, resultSchema, frameworkVersions } from './schemas.js';
import type { ErrorCode, GenerationResult, TestInput } from './schemas.js';

export const operations = {
  generate_property_tests: {
    description: 'Emit native property tests from reviewed predicates and integer or typed-domain cases.',
    kind: 'property',
    input: z.union([propertyInput, typedInput]),
  },
  generate_metamorphic_tests: {
    description: 'Emit paired TUnit or Vitest tests for a supplied transformation, precondition, and relation.',
    kind: 'metamorphic',
    input: z.union([metamorphicInput, typedInput]),
  },
  generate_differential_tests: {
    description: 'Compare independent implementations using reviewed equivalence and typed-domain cases.',
    kind: 'differential',
    input: typedInput,
  },
} as const;

export type Emitter = (input: TestInput | TypedInput, kind: TypedMethod) => unknown;

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

const emitForTarget: Emitter = (input, kind) => {
  if ('contractVersion' in input) return emitTyped(input, kind);
  if (kind === 'differential') throw new Error('Differential generation requires contractVersion 2.');
  return input.framework === 'vitest' ? emitVitest(input, kind) : emitTUnit(input);
};

export function dispatch(name: string, input: unknown, emit: Emitter = emitForTarget): GenerationResult {
  const operation = Object.entries(operations).find(([key]) => key === name)?.[1];
  if (!operation) return failure('INVALID_INPUT', 'Unknown operation.');
  if (!inputWithinBudget(input)) return failure('INVALID_INPUT', 'Request exceeds structural budgets, contains a cycle or non-scalar Unicode, or uses the reserved __proto__ key.');
  const parsed = operation.input.safeParse(input);
  if (!parsed.success) {
    const selection = frameworkSelection.safeParse(input);
    if (selection.success) {
      const { framework, frameworkVersion } = selection.data;
      const supported = framework === 'tunit' && frameworkVersion === frameworkVersions.tunit
        || framework === 'vitest' && frameworkVersion === frameworkVersions.vitest;
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
  if ('contractVersion' in request) {
    const problem = typedRequestProblem(request);
    if (problem) return failure('INVALID_INPUT', problem);
    return validatedEmission(() => emit(request, operation.kind));
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

  return validatedEmission(() => emit({ ...request, cases }, operation.kind));
}

function validatedEmission(emit: () => unknown): GenerationResult {
  try {
    const result = resultSchema.safeParse(emit());
    if (result.success) return result.data;
    return failure('INTERNAL_ERROR', 'Emitter result violates the output schema.');
  } catch {
    return failure('INTERNAL_ERROR', 'Emitter failed.');
  }
}

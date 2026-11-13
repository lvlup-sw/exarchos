import { z } from 'zod';
import { domainSchema } from '../domains/schema.js';
import { scaffoldInput, scaffold, scaffoldProblem } from './scaffold.js';
import { replayInput, replayRequest } from './replay.js';
import { statefulInput } from './stateful.js';
import type { StatefulInput } from './stateful.js';
import { statefulRequestProblem } from '../generators/histories.js';
import { emitStateful } from './stateful-dispatch.js';
import { typedInput } from './typed.js';
import type { TypedInput, TypedMethod } from './typed.js';
import { emitTyped, inputWithinBudget, typedRequestProblem } from './typed-dispatch.js';
import { expandCases } from '../generators/cases.js';
import { emitVitest } from '../emitters/vitest/emit.js';
import { emitTUnit } from '../emitters/tunit/emit.js';
import { errors, frameworkSelection, metamorphicInput, propertyInput, resultSchema, frameworkVersions } from './schemas.js';
import type { ErrorCode, GenerationResult, TestInput } from './schemas.js';

export type GenerationMethod = TypedMethod | 'stateful';
type GenerationInput = TestInput | TypedInput | StatefulInput;
export type Emitter = (input: GenerationInput, kind: GenerationMethod) => unknown;

function defineOperation<T>(description: string, input: z.ZodType<T>, execute: (request: T, emit: Emitter) => unknown) {
  return {
    description, input,
    invoke(raw: unknown, emit: Emitter): unknown {
      const parsed = input.safeParse(raw);
      if (!parsed.success) return invalidInput(raw, parsed.error);
      return execute(parsed.data, emit);
    },
  };
}

function generationOperation(kind: GenerationMethod, description: string, input: z.ZodType<GenerationInput>) {
  return { ...defineOperation(description, input, (request, emit) => generate(request, kind, emit)), kind };
}

const generationOperations = {
  generate_property_tests: generationOperation('property',
    'Emit native property tests from reviewed predicates and integer or typed-domain cases.', z.union([propertyInput, typedInput])),
  generate_metamorphic_tests: generationOperation('metamorphic',
    'Emit paired native tests for a reviewed transformation, precondition, and relation.', z.union([metamorphicInput, typedInput])),
  generate_differential_tests: generationOperation('differential',
    'Compare independent implementations using reviewed equivalence and typed-domain cases.', typedInput),
  generate_stateful_tests: generationOperation('stateful',
    'Emit model-based histories with native precondition filtering, fresh reset, and replay.', statefulInput),
};

export const operations = {
  ...generationOperations,
  scaffold_tests: defineOperation('Propose a request and throwing binding stubs for a native test suite.', scaffoldInput, (request) => {
    const problem = scaffoldProblem(request);
    if (problem) return failure('INVALID_INPUT', problem);
    const result = scaffold(request);
    return 'problem' in result ? failure('INVALID_INPUT', result.problem) : result;
  }),
  replay_tests: defineOperation('Rebuild a native suite from a matching request and concrete failure record.', replayInput, (request, emit) => {
    const result = replayRequest(request);
    return result.problem ? failure('INVALID_INPUT', result.problem) : dispatch(result.operation!, result.request, emit);
  }),
};

export function describeOperations() {
  const domain = z.toJSONSchema(domainSchema);
  return {
    errors,
    capabilities: {
      frameworks: Object.entries(frameworkVersions).map(([framework, version]) => ({ framework, version })),
      methods: Object.entries(generationOperations).map(([operation, definition]) => ({ operation, method: definition.kind })),
      domains: (domain.oneOf ?? domain.anyOf ?? []).flatMap((variant) => {
        const kind = variant.properties?.kind;
        return typeof kind === 'object' && 'const' in kind ? [kind.const] : [];
      }),
      contractVersions: [1, 2],
      execution: 'repository-native',
      limitations: [
        'Version 1 supports signed integer vectors. Differential and stateful generation require version 2.',
        'Bindings supply accepted semantics, independent oracles or models, and deterministic reset.',
        'Inspect each operation schema for generation, reduction, and structural budgets.',
      ],
    },
    operations: Object.entries(operations).map(([name, definition]) => ({
      name, description: definition.description,
      inputSchema: z.toJSONSchema(definition.input),
      outputSchema: z.toJSONSchema(resultSchema),
    })),
  };
}

export function failure(code: ErrorCode, message: string): GenerationResult {
  return { ok: false, error: { code, message } };
}

const emitForTarget: Emitter = (input, kind) => {
  if ('histories' in input) return emitStateful(input);
  if (kind === 'stateful') throw new Error('Stateful generation requires histories.');
  if ('contractVersion' in input) return emitTyped(input, kind);
  if (kind === 'differential') throw new Error('Differential generation requires contractVersion 2.');
  return input.framework === 'vitest' ? emitVitest(input, kind) : emitTUnit(input);
};

export function dispatch(name: string, input: unknown, emit: Emitter = emitForTarget): GenerationResult {
  const operation = Object.entries(operations).find(([key]) => key === name)?.[1];
  if (!operation) return failure('INVALID_INPUT', 'Unknown operation.');
  if (!inputWithinBudget(input)) return failure('INVALID_INPUT', 'Request exceeds structural budgets, contains a cycle or non-scalar Unicode, or uses the reserved __proto__ key.');
  return validatedEmission(() => operation.invoke(input, emit));
}

function invalidInput(input: unknown, error: z.ZodError): GenerationResult {
  const selection = frameworkSelection.safeParse(input);
  if (selection.success) {
    const { framework, frameworkVersion } = selection.data;
    const supported = framework === 'tunit' && frameworkVersion === frameworkVersions.tunit
      || framework === 'vitest' && frameworkVersion === frameworkVersions.vitest;
    if (!supported) return failure('UNSUPPORTED_FRAMEWORK', 'Use a framework and version listed by describe for this operation.');
  }
  const details = error.issues.map(({ path, message }) => `${path.join('.') || 'request'}: ${message}`);
  return failure('INVALID_INPUT', details.join('; '));
}

function generate(request: GenerationInput, kind: GenerationMethod, emit: Emitter): unknown {
  if (request.framework === 'tunit') {
    const parent = request.target.project.slice(0, request.target.project.lastIndexOf('/') + 1);
    if (!request.target.path.startsWith(parent)) {
      return failure('INVALID_INPUT', 'The test file must be under the test project directory.');
    }
  } else if (request.target.path === request.target.bindingModule) {
    return failure('INVALID_INPUT', 'The test file and binding module must be different.');
  }
  if ('contractVersion' in request) {
    const problem = 'histories' in request ? statefulRequestProblem(request) : typedRequestProblem(request);
    if (problem) return failure('INVALID_INPUT', problem);
    return emit(request, kind);
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

  return emit({ ...request, cases }, kind);
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

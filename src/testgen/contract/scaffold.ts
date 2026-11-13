import { posix } from 'node:path';
import { z } from 'zod';
import { domainSchema, domainProblem } from '../domains/schema.js';
import type { Domain } from '../domains/schema.js';
import { simplest } from '../domains/generate.js';
import { frameworkVersions, identifier, tunit } from './targets.js';
import { typedInput } from './typed.js';
import { statefulInput } from './stateful.js';

const directory = z.string().max(180).regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*)(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*(?![\s\S])/)
  .refine((path) => path.split('/').every((part) => !part.endsWith('.')), 'Use portable path segments.');
const common = {
  name: identifier.max(70),
  method: z.enum(['property', 'metamorphic', 'differential', 'stateful']).default('property'),
  propertyRef: z.string().min(1).max(250).default('TODO/accepted-property'),
  directory: directory.optional(),
  domain: domainSchema.optional(),
  operations: statefulInput.options[0].shape.operations.optional(),
};
export const scaffoldInput = z.discriminatedUnion('framework', [
  z.strictObject({
    ...common, framework: z.literal('vitest'), frameworkVersion: z.literal(frameworkVersions.vitest).default(frameworkVersions.vitest),
  }),
  z.strictObject({
    ...common, framework: z.literal('tunit'), frameworkVersion: z.literal(frameworkVersions.tunit).default(frameworkVersions.tunit),
    project: tunit.target.shape.project,
    namespace: tunit.target.shape.namespace.default('Testgen.Generated'),
  }),
]);
export type ScaffoldInput = z.infer<typeof scaffoldInput>;
export const scaffoldSuccess = z.strictObject({
  ok: z.literal(true),
  contractVersion: z.literal(2),
  patch: z.string().min(1),
  request: z.union([typedInput, statefulInput]),
  files: z.array(z.strictObject({ path: z.string(), role: z.enum(['request', 'binding']) })).length(2),
  next: z.strictObject({ operation: z.string(), requestPath: z.string() }),
  unresolvedObligations: z.array(z.string()).min(1),
});
export type ScaffoldSuccess = z.infer<typeof scaffoldSuccess>;

export function scaffoldProblem(input: ScaffoldInput): string | undefined {
  if (input.operations && input.method !== 'stateful') return 'Operation domains require the stateful method.';
  if (input.operations && input.domain) return 'Supply operation domains or a default domain.';
  for (const domain of [input.domain, ...input.operations?.map((operation) => operation.domain) ?? []]) {
    if (domain) {
      const problem = domainProblem(domain);
      if (problem) return problem;
    }
  }
  if (input.operations && new Set(input.operations.map((operation) => operation.name)).size !== input.operations.length) {
    return 'Operation names must be unique.';
  }
  if (input.framework === 'tunit' && input.directory) {
    const parent = input.project.slice(0, input.project.lastIndexOf('/') + 1);
    if (!`${input.directory}/`.startsWith(parent)) return 'The scaffold must be under the test project directory.';
  }
  return undefined;
}

function newFile(path: string, source: string): string {
  const lines = source.trimEnd().split('\n');
  return [
    `diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), '',
  ].join('\n');
}

function typescriptBinding(method: ScaffoldInput['method']): string {
  const signatures = method === 'stateful' ? [
    'createModel(): Promise<unknown>',
    'createSystem(): Promise<unknown>',
    'disposeSystem(_system: unknown): Promise<void>',
    'isEnabled(_model: unknown, _operation: string, _args: unknown): boolean',
    'transition(_model: unknown, _operation: string, _args: unknown): Promise<unknown>',
    'execute(_system: unknown, _operation: string, _args: unknown): Promise<void>',
    'observe(_system: unknown): Promise<unknown>',
    'equivalent(_model: unknown, _observed: unknown): Promise<boolean>',
  ] : [
    'isValid(_input: unknown): boolean',
    'observe(_input: unknown): Promise<unknown>',
    ...{
      property: ['predicate(_input: unknown, _observed: unknown): Promise<boolean>'],
      metamorphic: [
        'transform(_input: unknown): Promise<unknown>',
        'relation(_source: unknown, _follow: unknown, _before: unknown, _after: unknown): Promise<boolean>',
      ],
      differential: [
        'reference(_input: unknown): Promise<unknown>',
        'equivalent(_input: unknown, _actual: unknown, _expected: unknown): Promise<boolean>',
      ],
    }[method],
  ];
  return signatures.map((signature) => `export function ${signature} {\n  throw new Error('Implement the reviewed ${signature.slice(0, signature.indexOf('('))} binding.');\n}`).join('\n\n');
}

function csharpBinding(input: Extract<ScaffoldInput, { framework: 'tunit' }>): string {
  const signatures = input.method === 'stateful' ? [
    'Task<JsonElement> CreateModel()',
    'Task<object> CreateSystem()',
    'Task DisposeSystem(object system)',
    'bool IsEnabled(JsonElement model, string operation, JsonElement args)',
    'Task<JsonElement> Transition(JsonElement model, string operation, JsonElement args)',
    'Task Execute(object system, string operation, JsonElement args)',
    'Task<JsonElement> Observe(object system)',
    'Task<bool> Equivalent(JsonElement model, JsonElement observed)',
  ] : [
    'bool IsValid(JsonElement input)',
    'Task<JsonElement> Observe(JsonElement input)',
    ...{
      property: ['Task<bool> Predicate(JsonElement input, JsonElement observed)'],
      metamorphic: [
        'Task<JsonElement> Transform(JsonElement input)',
        'Task<bool> Relation(JsonElement source, JsonElement follow, JsonElement before, JsonElement after)',
      ],
      differential: [
        'Task<JsonElement> Reference(JsonElement input)',
        'Task<bool> Equivalent(JsonElement input, JsonElement actual, JsonElement expected)',
      ],
    }[input.method],
  ];
  return `using System;
using System.Text.Json;
using System.Threading.Tasks;

namespace ${input.namespace.split('.').map((part) => `@${part}`).join('.')};

internal static class ${input.name}Binding
{
${signatures.map((signature) => `    public static ${signature}\n        => throw new NotImplementedException("Implement the reviewed binding.");`).join('\n\n')}
}
`;
}

export function scaffold(input: ScaffoldInput): ScaffoldSuccess | { problem: string } {
  const domain: Domain = input.domain ?? { kind: 'string', alphabet: 'ab', minLength: 0, maxLength: 16 };
  const parent = input.framework === 'tunit' ? posix.dirname(input.project) : 'tests';
  const folder = input.directory ?? posix.join(parent, 'generated');
  const bindingPath = posix.join(folder, `${input.name}Binding.${input.framework === 'tunit' ? 'cs' : 'ts'}`);
  const requestPath = posix.join(folder, `${input.name}.testgen.json`);
  const base = {
    contractVersion: 2 as const,
    framework: input.framework,
    frameworkVersion: input.frameworkVersion,
    propertyRef: input.propertyRef,
    assumptions: [],
    target: input.framework === 'tunit'
      ? { project: input.project, path: posix.join(folder, `${input.name}Tests.cs`), namespace: input.namespace,
        className: `${input.name}Tests`, binding: `${input.namespace}.${input.name}Binding` }
      : { path: posix.join(folder, `${input.name}.test.ts`), bindingModule: bindingPath },
    reduction: { maxAttempts: 64 },
  };
  const request = input.method === 'stateful'
    ? { ...base, operations: input.operations ?? [{ name: 'operation', domain }], histories: [],
      generation: { seed: 1, count: 4, maxSteps: 8, maxAttempts: 64 } }
    : { ...base, domain, cases: [simplest(domain)], generation: { seed: 1, count: 16, maxAttempts: 128 } };
  const parsed = (input.method === 'stateful' ? statefulInput : typedInput).safeParse(request);
  if (!parsed.success) return { problem: 'The generated target exceeds the supported path, name, or binding limits.' };
  const bindingSource = input.framework === 'tunit' ? csharpBinding(input) : typescriptBinding(input.method);
  return {
    ok: true, contractVersion: 2,
    patch: newFile(requestPath, JSON.stringify(parsed.data, null, 2)) + newFile(bindingPath, bindingSource),
    request: parsed.data,
    files: [{ path: requestPath, role: 'request' }, { path: bindingPath, role: 'binding' }],
    next: { operation: `generate_${input.method}_tests`, requestPath },
    unresolvedObligations: [
      'Replace the placeholder property reference and review the domain, assumptions, and generation budgets.',
      'Implement every binding against the application and an independent accepted oracle or model. The supplied stubs throw.',
      'Review the patches, generate the suite, and compile and execute it with the native runner.',
    ],
  };
}
